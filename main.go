// Command flash is a self-hosted, single-binary internet speed test with the
// same measurement methodology as speed.cloudflare.com: HTTP download/upload
// ladders, unloaded and loaded latency, jitter, and packet loss via an
// embedded TURN relay.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	Port         string
	BasePath     string // URL prefix without trailing slash, "" for root
	MaxBytes     int64
	ServerName   string
	TrustedProxy bool

	TurnEnabled      bool
	TurnPort         int
	TurnPublicIP     string
	TurnRelayMinPort uint16
	TurnRelayMaxPort uint16
	TurnSecret       string
	TurnCredTTL      time.Duration
}

func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	v := envOr(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		log.Fatalf("%s: invalid integer %q", key, v)
	}
	return n
}

func envBool(key string, def bool) bool {
	v := envOr(key, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		log.Fatalf("%s: invalid boolean %q", key, v)
	}
	return b
}

func envDuration(key string, def time.Duration) time.Duration {
	v := envOr(key, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Fatalf("%s: invalid duration %q", key, v)
	}
	return d
}

func loadConfig() config {
	host, _ := os.Hostname()
	cfg := config{
		Port:             envOr("PORT", "8080"),
		BasePath:         strings.TrimSuffix(envOr("BASE_PATH", ""), "/"),
		MaxBytes:         envInt("MAX_BYTES", 1_000_000_000),
		ServerName:       envOr("SERVER_NAME", host),
		TrustedProxy:     envBool("TRUSTED_PROXY", false),
		TurnEnabled:      envBool("TURN_ENABLED", true),
		TurnPort:         int(envInt("TURN_PORT", 3478)),
		TurnPublicIP:     envOr("TURN_PUBLIC_IP", ""),
		TurnRelayMinPort: uint16(envInt("TURN_RELAY_MIN_PORT", 49160)),
		TurnRelayMaxPort: uint16(envInt("TURN_RELAY_MAX_PORT", 49200)),
		TurnSecret:       envOr("TURN_SECRET", ""),
		TurnCredTTL:      envDuration("TURN_CRED_TTL", 120*time.Second),
	}
	if cfg.BasePath != "" && !strings.HasPrefix(cfg.BasePath, "/") {
		cfg.BasePath = "/" + cfg.BasePath
	}
	return cfg
}

// healthcheck probes the running server and exits non-zero on failure.
// Used by the container healthcheck since the runtime image has no shell or curl.
func healthcheck(cfg config) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + cfg.Port + cfg.BasePath + "/healthz")
	if err != nil {
		log.Printf("healthcheck failed: %v", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck failed: status %d", resp.StatusCode)
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	cfg := loadConfig()
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		healthcheck(cfg)
	}

	a := newApp(cfg)

	if cfg.TurnEnabled {
		relay, err := startTurn(cfg)
		if err != nil {
			log.Printf("TURN relay disabled: %v", err)
		} else {
			a.turn = relay
			log.Printf("TURN relay on udp/%d advertising %s, relay ports %d-%d",
				cfg.TurnPort, relay.publicIP, cfg.TurnRelayMinPort, cfg.TurnRelayMaxPort)
		}
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           a.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No global read/write timeouts: bandwidth handlers set per-request
		// deadlines sized to the payload via http.ResponseController.
	}

	go func() {
		log.Printf("listening on :%s base path %q max bytes %d", cfg.Port, cfg.BasePath, cfg.MaxBytes)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	if a.turn != nil {
		if err := a.turn.Close(); err != nil {
			log.Printf("turn shutdown error: %v", err)
		}
	}
	log.Println("server stopped")
}
