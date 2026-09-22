package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

const turnRealm = "flash"

// turnRelay is the embedded TURN server the browser uses for packet-loss
// measurement. The browser opens a loopback WebRTC data channel between two
// local peer connections, both forced onto UDP relay candidates, so every
// message crosses the network to this relay and back.
type turnRelay struct {
	server   *turn.Server
	publicIP string
	port     int
	ttl      time.Duration
	secret   []byte
}

// credentials mints a short-lived TURN REST style credential pair:
// username = "<unix expiry>:<nonce>", credential = base64(HMAC-SHA1(secret, username)).
func (t *turnRelay) credentials(now time.Time) (username, credential string) {
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	username = strconv.FormatInt(now.Add(t.ttl).Unix(), 10) + ":" + hex.EncodeToString(nonce[:])
	return username, hmacB64(t.secret, username)
}

// authKey validates a username minted by credentials and returns the
// long-term key pion expects. It rejects malformed or expired usernames.
func (t *turnRelay) authKey(username string, now time.Time) ([]byte, bool) {
	expiryStr, _, ok := strings.Cut(username, ":")
	if !ok {
		return nil, false
	}
	expiry, err := strconv.ParseInt(expiryStr, 10, 64)
	if err != nil || now.Unix() > expiry {
		return nil, false
	}
	return turn.GenerateAuthKey(username, turnRealm, hmacB64(t.secret, username)), true
}

func hmacB64(secret []byte, msg string) string {
	mac := hmac.New(sha1.New, secret)
	mac.Write([]byte(msg))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// detectPublicIP returns the IP of the interface that owns the default route.
// A UDP "dial" sends no packets; it only asks the kernel which source it would use.
func detectPublicIP() (string, error) {
	conn, err := net.Dial("udp4", "1.1.1.1:53")
	if err != nil {
		return "", err
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP == nil {
		return "", fmt.Errorf("could not determine local address")
	}
	return addr.IP.String(), nil
}

func startTurn(cfg config) (*turnRelay, error) {
	publicIP := cfg.TurnPublicIP
	if publicIP == "" {
		ip, err := detectPublicIP()
		if err != nil {
			return nil, fmt.Errorf("TURN_PUBLIC_IP unset and auto-detect failed: %w", err)
		}
		publicIP = ip
	}
	relayIP := net.ParseIP(publicIP)
	if relayIP == nil {
		return nil, fmt.Errorf("TURN_PUBLIC_IP %q is not an IP address", publicIP)
	}
	if cfg.TurnRelayMinPort == 0 || cfg.TurnRelayMaxPort < cfg.TurnRelayMinPort {
		return nil, fmt.Errorf("invalid relay port range %d-%d", cfg.TurnRelayMinPort, cfg.TurnRelayMaxPort)
	}

	secret := []byte(cfg.TurnSecret)
	if len(secret) == 0 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
	}

	relay := &turnRelay{publicIP: publicIP, port: cfg.TurnPort, ttl: cfg.TurnCredTTL, secret: secret}

	listener, err := net.ListenPacket("udp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(cfg.TurnPort)))
	if err != nil {
		return nil, fmt.Errorf("listen udp/%d: %w", cfg.TurnPort, err)
	}
	if ua, ok := listener.LocalAddr().(*net.UDPAddr); ok {
		relay.port = ua.Port // resolves the real port when TurnPort was 0
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm:              turnRealm,
		LoggerFactory:      logging.NewDefaultLoggerFactory(),
		AllocationLifetime: 2 * time.Minute,
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			key, ok := relay.authKey(ra.Username, time.Now())
			if !ok {
				return "", nil, false
			}
			return ra.Username, key, true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: relayIP,
				Address:      "0.0.0.0",
				MinPort:      cfg.TurnRelayMinPort,
				MaxPort:      cfg.TurnRelayMaxPort,
			},
			// Loopback only: peers may only be this relay's own public address,
			// which is what the browser's second peer connection appears as.
			PermissionHandler: func(_ net.Addr, peerIP net.IP) bool {
				return peerIP.Equal(relayIP)
			},
		}},
	})
	if err != nil {
		listener.Close()
		return nil, err
	}
	relay.server = server
	return relay, nil
}

func (t *turnRelay) Close() error {
	if t == nil || t.server == nil {
		return nil
	}
	return t.server.Close()
}
