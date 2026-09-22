package main

import (
	"bytes"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestCredentialsRoundTripAndExpiry(t *testing.T) {
	r := &turnRelay{secret: []byte("s3cret"), ttl: time.Minute}
	now := time.Unix(1_700_000_000, 0)
	user, cred := r.credentials(now)

	key, ok := r.authKey(user, now)
	if !ok {
		t.Fatal("fresh credential rejected")
	}
	if want := turn.GenerateAuthKey(user, turnRealm, cred); !bytes.Equal(key, want) {
		t.Fatal("auth key does not match the credential handed to the client")
	}
	if _, ok := r.authKey(user, now.Add(61*time.Second)); ok {
		t.Fatal("expired credential accepted")
	}
	other := &turnRelay{secret: []byte("different"), ttl: time.Minute}
	if key2, _ := other.authKey(user, now); bytes.Equal(key, key2) {
		t.Fatal("different secrets produced the same key")
	}
	for _, bad := range []string{"", "nonsense", "abc:def", ":x"} {
		if _, ok := r.authKey(bad, now); ok {
			t.Fatalf("malformed username %q accepted", bad)
		}
	}
}

func TestDetectPublicIP(t *testing.T) {
	ip, err := detectPublicIP()
	if err != nil {
		t.Skipf("no default route: %v", err)
	}
	if net.ParseIP(ip) == nil {
		t.Fatalf("not an IP: %q", ip)
	}
}

// TestRelayLoopback allocates through the embedded relay with pion's client
// and sends a datagram to its own relayed address, which is exactly the
// traffic pattern the browser produces.
func TestRelayLoopback(t *testing.T) {
	relay, err := startTurn(config{
		TurnPort:         0, // any free port
		TurnPublicIP:     "127.0.0.1",
		TurnRelayMinPort: 40000,
		TurnRelayMaxPort: 40100,
		TurnCredTTL:      time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	port := strconv.Itoa(relay.port) // bound to a free port because TurnPort was 0

	user, cred := relay.credentials(time.Now())
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: net.JoinHostPort("127.0.0.1", port),
		TURNServerAddr: net.JoinHostPort("127.0.0.1", port),
		Conn:           conn,
		Username:       user,
		Password:       cred,
		Realm:          turnRealm,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	relayConn, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relayConn.Close()

	// Sending to our own relayed address exercises CreatePermission for the
	// relay IP (allowed) and the hairpin through the relay socket.
	payload := []byte("ping-1")
	if _, err := relayConn.WriteTo(payload, relayConn.LocalAddr()); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 1500)
	_ = relayConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, _, err := relayConn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("read back through relay: %v", err)
	}
	if !bytes.Equal(buf[:n], payload) {
		t.Fatalf("got %q", buf[:n])
	}

	// A peer outside the relay's own IP must be refused by the permission handler.
	if _, err := relayConn.WriteTo(payload, &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 9}); err == nil {
		t.Fatal("permission for a foreign peer was granted")
	}
}
