// Packet loss through a TURN relay, the same way speed.cloudflare.com does it:
// two RTCPeerConnections in this tab talk to each other over an unreliable,
// unordered data channel, with ICE forced onto UDP relay candidates so every
// message actually traverses the network to the relay and back.

function isUdpCandidate(c) {
  let protocol = c.protocol || '';
  if (!protocol && c.candidate) {
    const parts = c.candidate.split(' ');
    if (parts.length >= 3) protocol = parts[2];
  }
  return protocol.toLowerCase() === 'udp';
}

export class LoopbackConnection {
  constructor({ iceServers }) {
    const rtcCfg = { iceServers, iceTransportPolicy: 'relay' };
    this.sender = new RTCPeerConnection(rtcCfg);
    this.receiver = new RTCPeerConnection(rtcCfg);
    this.onMessage = () => {};
    this.senderDc = this.sender.createDataChannel('loss', { ordered: false, maxRetransmits: 0 });
    this.opened = new Promise((resolve, reject) => {
      this.senderDc.onopen = resolve;
      this.senderDc.onerror = (e) => reject(e.error || new Error('data channel error'));
      this.sender.oniceconnectionstatechange = () => {
        if (this.sender.iceConnectionState === 'failed') reject(new Error('ICE failed: TURN relay unreachable'));
      };
    });
    this.receiver.ondatachannel = (e) => {
      this.receiverDc = e.channel;
      this.receiverDc.onmessage = (msg) => this.onMessage(msg.data);
    };
    this.sender.onicecandidate = (e) => { if (e.candidate && isUdpCandidate(e.candidate)) this.receiver.addIceCandidate(e.candidate).catch(() => {}); };
    this.receiver.onicecandidate = (e) => { if (e.candidate && isUdpCandidate(e.candidate)) this.sender.addIceCandidate(e.candidate).catch(() => {}); };
    this.negotiated = (async () => {
      const offer = await this.sender.createOffer();
      await this.sender.setLocalDescription(offer);
      await this.receiver.setRemoteDescription(offer);
      const answer = await this.receiver.createAnswer();
      await this.receiver.setLocalDescription(answer);
      await this.sender.setRemoteDescription(answer);
    })();
  }

  async open(timeoutMs, signal) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TURN connection timed out')), timeoutMs); });
    const aborted = new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    try {
      await Promise.race([Promise.all([this.negotiated, this.opened]), timeout, aborted]);
    } finally {
      clearTimeout(timer);
    }
  }

  send(msg) { this.senderDc.send(String(msg)); }

  close() {
    for (const x of [this.senderDc, this.receiverDc, this.sender, this.receiver]) { try { x?.close(); } catch { /* ignore */ } }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** Returns { sent, received, lossRatio, durationMs }. Throws on connection failure. */
export async function measurePacketLoss({
  iceServers, numPackets = 1000, batchSize = 10, batchWaitTime = 10,
  responsesWaitTime = 3000, connectionTimeout = 5000, signal, onProgress,
}) {
  const conn = new LoopbackConnection({ iceServers });
  const received = new Set();
  let sent = 0;
  conn.onMessage = (data) => {
    received.add(Number(data));
    onProgress?.({ sent, received: received.size, total: numPackets });
  };
  const t0 = performance.now();
  try {
    await conn.open(connectionTimeout, signal);
    while (sent < numPackets) {
      for (let j = 0; j < batchSize && sent < numPackets; j++) conn.send(sent++);
      onProgress?.({ sent, received: received.size, total: numPackets });
      await sleep(batchWaitTime, signal);
    }
    await sleep(responsesWaitTime, signal);
  } finally {
    conn.close();
  }
  return { sent, received: received.size, lossRatio: sent ? 1 - received.size / sent : undefined, durationMs: performance.now() - t0 };
}
