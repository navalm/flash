# flash

Self-hosted internet speed test in a single 13 MB static Go binary. Same
methodology as [speed.cloudflare.com](https://speed.cloudflare.com) (its
open-source client, [cloudflare/speedtest](https://github.com/cloudflare/speedtest)):

- Download and upload ladder from 100 kB to 250 MB, one request at a time,
  timed with the browser's `PerformanceResourceTiming`, server processing time
  subtracted via `Server-Timing`. Throughput is the 90th percentile of samples.
- Unloaded latency (median of 20+ pings) and jitter (mean consecutive delta).
- Loaded latency: pings every 400 ms while downloads and uploads are in flight.
- Packet loss: 1000 UDP messages through an embedded TURN relay
  ([pion/turn](https://github.com/pion/turn)) using a loopback WebRTC data channel.
- AIM quality scores for streaming, gaming and video chat using Cloudflare's
  published thresholds.

No frameworks, no build step, no database. Frontend is vanilla HTML/CSS/JS
embedded in the binary. Results stay in the browser (last 20 runs in
localStorage) with copy/download as JSON or a text summary.

## Run it

```sh
make build
./flash                              # http://localhost:8080
```

Or with Go directly: `go run .`

By default the app serves from the root. Set `BASE_PATH` to serve under a URL
prefix instead, e.g. `BASE_PATH=/speedtest ./flash` for
`http://localhost:8080/speedtest` — useful if you're putting this behind a
reverse proxy at a subpath.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `BASE_PATH` | `` (root) | URL prefix all routes are served under, e.g. `/speedtest` |
| `MAX_BYTES` | `1000000000` | Cap per download/upload request |
| `SERVER_NAME` | hostname | Label shown in the UI |
| `TRUSTED_PROXY` | `false` | Honor `X-Forwarded-For` / `X-Real-IP` for the client IP |
| `TURN_ENABLED` | `true` | Start the embedded TURN relay |
| `TURN_PORT` | `3478` | UDP port the relay listens on |
| `TURN_PUBLIC_IP` | auto-detected | IP browsers use to reach the relay. **Set this in Docker.** |
| `TURN_RELAY_MIN_PORT` / `MAX_PORT` | `49160` / `49200` | UDP relay port range (must be reachable too) |
| `TURN_SECRET` | random per start | HMAC secret for short-lived TURN credentials |
| `TURN_CRED_TTL` | `120s` | Credential lifetime |

### Endpoints (under `BASE_PATH`)

| Route | Purpose |
|---|---|
| `GET /` | The app |
| `GET /healthz` | `{"status":"ok"}` |
| `GET /__down?bytes=N` | N zero bytes (`bytes=0` for latency pings) |
| `POST /__up` | Discards the body |
| `GET /__meta` | Client IP, reverse DNS, server name, protocol |
| `GET /__turn` | Short-lived TURN credentials for the packet-loss test |

`__down` and `__up` are CORS-open with `Timing-Allow-Origin: *`, so any page can
measure against this server. The UI's endpoint switch also lets you run the
identical test against Cloudflare's public edge for comparison.

## Docker

```sh
cp .env.example .env    # set TURN_PUBLIC_IP to an address clients can reach
make up                 # docker compose up -d --build
```

This runs the container standalone, published on `${HOST_PORT:-8080}` with no
reverse proxy required. It's a single stateless container; replace it at any
time.

### Behind a reverse proxy

The app can serve itself under a URL prefix (see `BASE_PATH` above), so a
proxy can route a subpath straight through with no path-rewriting /
strip-prefix middleware — just forward `BASE_PATH` and everything under it to
the container's port. If the proxy sets `X-Forwarded-For` / `X-Real-IP`, also
set `TRUSTED_PROXY=true` so `/__meta` reports the real client IP instead of
the proxy's.

Two things to plan around:

- **Throughput ceiling.** A proxy in front forwards every byte, so results
  through it are capped by whatever the proxy can push. Publish the
  container's port directly (bypassing the proxy) for the highest numbers on
  fast LANs.
- **Packet loss over UDP.** Most reverse proxies only handle HTTP, so the TURN
  relay's ports (`3478/udp` and the `49160-49200/udp` range) need to be
  published directly on the host, not proxied. The browser's two peers talk to
  each other through the relay, so the relay must be able to send to its own
  published address — this can fail under Docker's default bridge networking
  (hairpin NAT). If the packet-loss tile reads "n/a" from other devices on the
  network, try `network_mode: host` instead.

## Development

```sh
make fmt vet test   # gofmt, go vet, go test, node --test static/
```

`static/stats.js` holds the pure math (percentiles, jitter, AIM tables) and is
covered by `static/stats.test.mjs`. Go tests cover the HTTP handlers and the
TURN relay, including a loopback allocation through pion's client.
