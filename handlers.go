package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed static
var staticFS embed.FS

// zeros is the shared payload source for downloads. Writing slices of one
// buffer keeps the download path allocation-free per request.
var zeros = make([]byte, 64<<10)

type app struct {
	cfg   config
	turn  *turnRelay // nil when the relay is disabled or failed to start
	index *template.Template
}

func newApp(cfg config) *app {
	src, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		log.Fatalf("index.html missing from embedded assets: %v", err)
	}
	return &app{
		cfg:   cfg,
		index: template.Must(template.New("index").Parse(string(src))),
	}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	b := a.cfg.BasePath

	mux.HandleFunc("GET "+b+"/{$}", a.handleIndex)
	if b != "" {
		mux.HandleFunc("GET "+b, a.handleIndex)
	}
	mux.HandleFunc("GET "+b+"/healthz", a.handleHealth)
	mux.HandleFunc("GET "+b+"/__down", a.handleDown)
	mux.HandleFunc("OPTIONS "+b+"/__down", handlePreflight)
	mux.HandleFunc("POST "+b+"/__up", a.handleUp)
	mux.HandleFunc("OPTIONS "+b+"/__up", handlePreflight)
	mux.HandleFunc("GET "+b+"/__meta", a.handleMeta)
	mux.HandleFunc("GET "+b+"/__turn", a.handleTurn)

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static assets: %v", err)
	}
	files := http.StripPrefix(b+"/static/", http.FileServerFS(sub))
	mux.HandleFunc("GET "+b+"/static/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	return mux
}

// --- helpers ---

func setCORS(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Access-Control-Expose-Headers", "Server-Timing")
	h.Set("Access-Control-Max-Age", "86400")
	h.Set("Timing-Allow-Origin", "*")
}

func handlePreflight(w http.ResponseWriter, _ *http.Request) {
	setCORS(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

// serverTiming formats the processing time the client subtracts from its
// measured TTFB. The metric name matches what the Cloudflare client parses.
func serverTiming(start time.Time) string {
	ms := float64(time.Since(start).Nanoseconds()) / 1e6
	if ms < 0.001 {
		ms = 0.001
	}
	return fmt.Sprintf("cfRequestDuration;dur=%.3f", ms)
}

// parseBytes accepts "100000" or "1e5"; empty means 0.
func parseBytes(s string, maxBytes int64) (int64, error) {
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		f, ferr := strconv.ParseFloat(s, 64)
		if ferr != nil || f != float64(int64(f)) {
			return 0, fmt.Errorf("bytes must be an integer")
		}
		n = int64(f)
	}
	if n < 0 {
		return 0, fmt.Errorf("bytes must not be negative")
	}
	if n > maxBytes {
		return 0, fmt.Errorf("bytes exceeds server limit of %d", maxBytes)
	}
	return n, nil
}

// transferDeadline gives a payload a generous budget: 60 s plus the time it
// would take at 1 Mbit/s, capped at 10 minutes.
func transferDeadline(n int64) time.Duration {
	d := 60*time.Second + time.Duration(n/125_000)*time.Second
	if d > 10*time.Minute {
		d = 10 * time.Minute
	}
	return d
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first, _, _ := strings.Cut(xff, ","); strings.TrimSpace(first) != "" {
				return strings.TrimSpace(first)
			}
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// --- handlers ---

func (a *app) handleIndex(w http.ResponseWriter, r *http.Request) {
	data := struct {
		BasePath    string
		ServerName  string
		TurnEnabled bool
	}{a.cfg.BasePath, a.cfg.ServerName, a.turn != nil}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if err := a.index.Execute(w, data); err != nil {
		log.Printf("render error: %v", err)
	}
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleDown streams N zero bytes. GET /__down?bytes=N (bytes=0 for latency).
func (a *app) handleDown(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	n, err := parseBytes(r.URL.Query().Get("bytes"), a.cfg.MaxBytes)
	h := w.Header()
	setCORS(h)
	h.Set("Cache-Control", "no-store")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(n, 10))
	h.Set("Server-Timing", serverTiming(start))
	w.WriteHeader(http.StatusOK)
	if n == 0 {
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(transferDeadline(n)))
	for remaining := n; remaining > 0; {
		chunk := int64(len(zeros))
		if remaining < chunk {
			chunk = remaining
		}
		wn, werr := w.Write(zeros[:chunk])
		remaining -= int64(wn)
		if werr != nil {
			return // client aborted; nothing useful to log per request
		}
	}
}

// handleUp discards the request body. POST /__up with any payload.
func (a *app) handleUp(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	setCORS(h)
	h.Set("Cache-Control", "no-store")
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(transferDeadline(a.cfg.MaxBytes)))
	n, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, a.cfg.MaxBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			http.Error(w, fmt.Sprintf("body exceeds server limit of %d bytes", a.cfg.MaxBytes), http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "incomplete upload", http.StatusBadRequest)
		return
	}
	// Only the work after the body is fully received counts as server time;
	// the body transfer itself is what the client is measuring.
	processed := time.Now()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Server-Timing", serverTiming(processed))
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "ok %d\n", n)
}

type metaResponse struct {
	IP       string `json:"ip"`
	Hostname string `json:"hostname,omitempty"`
	Server   string `json:"server"`
	Time     string `json:"time"`
	Protocol string `json:"protocol"`
	TLS      bool   `json:"tls"`
	Turn     bool   `json:"turn"`
}

func (a *app) handleMeta(w http.ResponseWriter, r *http.Request) {
	setCORS(w.Header())
	ip := clientIP(r, a.cfg.TrustedProxy)
	resp := metaResponse{
		IP:       ip,
		Server:   a.cfg.ServerName,
		Time:     time.Now().UTC().Format(time.RFC3339Nano),
		Protocol: r.Proto,
		TLS:      r.TLS != nil,
		Turn:     a.turn != nil,
	}
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Millisecond)
	defer cancel()
	if names, err := net.DefaultResolver.LookupAddr(ctx, ip); err == nil && len(names) > 0 {
		resp.Hostname = strings.TrimSuffix(names[0], ".")
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *app) handleTurn(w http.ResponseWriter, _ *http.Request) {
	setCORS(w.Header())
	if a.turn == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	user, cred := a.turn.credentials(time.Now())
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":    true,
		"urls":       []string{fmt.Sprintf("turn:%s:%d?transport=udp", a.turn.publicIP, a.turn.port)},
		"username":   user,
		"credential": cred,
		"ttl":        int(a.turn.ttl.Seconds()),
	})
}
