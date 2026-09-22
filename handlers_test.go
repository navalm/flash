package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func testApp(t *testing.T, base string) *httptest.Server {
	t.Helper()
	a := newApp(config{BasePath: base, MaxBytes: 1_000_000, ServerName: "test-box"})
	srv := httptest.NewServer(a.routes())
	t.Cleanup(srv.Close)
	return srv
}

func TestDownStreamsExactByteCount(t *testing.T) {
	srv := testApp(t, "/speed")
	for _, n := range []int{0, 1, 65535, 65536, 100_000, 1_000_000} {
		resp, err := http.Get(srv.URL + "/speed/__down?bytes=" + strconv.Itoa(n))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("bytes=%d: status %d", n, resp.StatusCode)
		}
		if len(body) != n {
			t.Fatalf("bytes=%d: got %d bytes", n, len(body))
		}
		if cl := resp.Header.Get("Content-Length"); cl != strconv.Itoa(n) {
			t.Fatalf("bytes=%d: Content-Length %q", n, cl)
		}
		if st := resp.Header.Get("Server-Timing"); !strings.HasPrefix(st, "cfRequestDuration;dur=") {
			t.Fatalf("bytes=%d: Server-Timing %q", n, st)
		}
		for _, h := range []string{"Access-Control-Allow-Origin", "Timing-Allow-Origin"} {
			if resp.Header.Get(h) != "*" {
				t.Fatalf("bytes=%d: missing %s", n, h)
			}
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("bytes=%d: Cache-Control %q", n, resp.Header.Get("Cache-Control"))
		}
	}
}

func TestDownAcceptsExponentAndRejectsBadInput(t *testing.T) {
	srv := testApp(t, "")
	cases := map[string]int{
		"1e5":     200,
		"":        200,
		"1000001": 400,
		"-1":      400,
		"abc":     400,
		"1.5":     400,
	}
	for q, want := range cases {
		resp, err := http.Get(srv.URL + "/__down?bytes=" + q)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("bytes=%q: status %d, want %d", q, resp.StatusCode, want)
		}
	}
}

func TestUpDiscardsBodyAndEnforcesLimit(t *testing.T) {
	srv := testApp(t, "/speed")
	resp, err := http.Post(srv.URL+"/speed/__up", "application/octet-stream", bytes.NewReader(make([]byte, 500_000)))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || strings.TrimSpace(string(body)) != "ok 500000" {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	if !strings.HasPrefix(resp.Header.Get("Server-Timing"), "cfRequestDuration;dur=") {
		t.Fatalf("Server-Timing %q", resp.Header.Get("Server-Timing"))
	}

	resp, err = http.Post(srv.URL+"/speed/__up", "application/octet-stream", bytes.NewReader(make([]byte, 1_000_001)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize upload: status %d", resp.StatusCode)
	}
}

func TestPreflight(t *testing.T) {
	srv := testApp(t, "")
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/__up", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("status %d headers %v", resp.StatusCode, resp.Header)
	}
}

func TestIndexHealthAndBasePathRouting(t *testing.T) {
	srv := testApp(t, "/speed")
	get := func(p string) (int, string) {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}
	for _, p := range []string{"/speed", "/speed/"} {
		if code, body := get(p); code != 200 || !strings.Contains(body, "/speed/static/") {
			t.Fatalf("%s: status %d, body lacks base-path asset links", p, code)
		}
	}
	if code, body := get("/speed/healthz"); code != 200 || !strings.Contains(body, `"ok"`) {
		t.Fatalf("healthz: %d %s", code, body)
	}
	for _, p := range []string{"/", "/speed/nope", "/__down?bytes=1"} {
		if code, _ := get(p); code != 404 {
			t.Fatalf("%s: status %d, want 404", p, code)
		}
	}
	if code, _ := get("/speed/static/stats.js"); code != 200 {
		t.Fatalf("static asset: status %d", code)
	}
}

func TestMetaHonoursProxyHeadersOnlyWhenTrusted(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		a := newApp(config{MaxBytes: 1, TrustedProxy: trusted, ServerName: "s"})
		srv := httptest.NewServer(a.routes())
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/__meta", nil)
		req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		srv.Close()
		got := strings.Contains(string(b), `"ip":"203.0.113.9"`)
		if got != trusted {
			t.Fatalf("trusted=%v: body %s", trusted, b)
		}
		if !strings.Contains(string(b), `"turn":false`) {
			t.Fatalf("expected turn:false, got %s", b)
		}
	}
}

func TestTurnDisabledResponse(t *testing.T) {
	srv := testApp(t, "")
	resp, err := http.Get(srv.URL + "/__turn")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), `"enabled":false`) {
		t.Fatalf("body %s", b)
	}
}
