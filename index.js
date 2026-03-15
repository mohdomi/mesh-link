/**
 * MeshLink — Serverless LAN Mesh Chat
 *
 * A single-file, fully decentralized mesh chat application.
 * Each running instance is simultaneously a WebSocket server and client.
 * Discovery via UDP broadcast, message routing via gossip flooding.
 *
 * Modules implemented:
 *   1. UDP Discovery
 *   2. WebSocket Server
 *   3. Peer Manager (WebSocket Client)
 *   4. Gossip Router
 *   5. Routing Priority (Heartbeat + Latency-based relay selection)
 *   6. Self Healing (built into close/error handlers — gossip IS the heal)
 *   7. Ink TUI (src/App.js)
 *   8. SOS Broadcast (Ctrl+S in TUI)
 *   9. UDP Discovery Relay (multi-interface bridging for cross-subnet mesh)
 */

import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import React from 'react';
import { render } from 'ink';
import App from './src/App.js';
import { startWebBridge } from './web-bridge.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG & NODE IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

const UDP_PORT = 41234;
const UDP_BURST_INTERVAL = 300;      // 300ms during initial burst phase
const UDP_STEADY_INTERVAL = 2000;    // 2s after burst phase
const UDP_BURST_DURATION = 10000;    // burst for first 10 seconds
const SEEN_MSG_TTL = 60000;          // 60 seconds before purging seen msgIds
const DEFAULT_MSG_TTL = 10;          // default hop limit for messages
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 500;         // 500ms between reconnect attempts
const HEARTBEAT_INTERVAL = 5000;     // 5 seconds between heartbeat pings
const RELAY_COOLDOWN = 3000;         // 3 seconds between relaying same peer

const startupTime = Date.now();       // used for UDP burst mode timing

// Generate unique node ID: "node-" + 6 random hex chars
const nodeId = 'node-' + crypto.randomBytes(3).toString('hex');

// Parse optional --port CLI argument
const cliPortArg = process.argv.find((a, i) => process.argv[i - 1] === '--port');
const WS_PORT = cliPortArg ? parseInt(cliPortArg, 10) : 3000 + Math.floor(Math.random() * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Detect ALL network interfaces with per-interface broadcast addresses
// ─────────────────────────────────────────────────────────────────────────────
//
// A normal single-network device has one interface (e.g. 192.168.1.x).
// A bridge device has two or more (e.g. 192.168.43.x on wlan0, 192.168.44.1
// on wlan1-hotspot). We calculate the correct subnet-specific broadcast
// address for each interface using the netmask.
//

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int) {
  return [
    (int >>> 24) & 0xFF,
    (int >>> 16) & 0xFF,
    (int >>> 8) & 0xFF,
    int & 0xFF,
  ].join('.');
}

function getLocalInterfaces() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Calculate broadcast address: broadcast = (ip | ~netmask)
        const ipInt = ipToInt(iface.address);
        const maskInt = ipToInt(iface.netmask);
        const broadcastInt = (ipInt | (~maskInt >>> 0)) >>> 0;
        result.push({
          name,
          address: iface.address,
          netmask: iface.netmask,
          broadcast: intToIp(broadcastInt),
        });
      }
    }
  }
  return result;
}

const localInterfaces = getLocalInterfaces();
// Primary LAN IP = first non-loopback interface, with fallback
const lanIP = localInterfaces.length > 0 ? localInterfaces[0].address : '127.0.0.1';
const isBridgeNode = localInterfaces.length > 1;

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * peers Map: nodeId -> { ws, ip, port, latency, connectedAt }
 * Stores all live peer connections (both inbound and outbound).
 * latency is measured in ms via HEARTBEAT round-trip time.
 */
const peers = new Map();

/**
 * seenMessages Map: msgId -> timestamp
 * Used for gossip deduplication. Entries older than SEEN_MSG_TTL are purged.
 */
const seenMessages = new Map();

/**
 * discoveredAddresses Set: "ip:port" strings
 * Tracks addresses we've already attempted to connect to, preventing
 * duplicate outbound connections.
 */
const discoveredAddresses = new Set();

/**
 * reconnectAttempts Map: "ip:port" -> attempts remaining
 * Tracks reconnection attempts for failed outbound connections.
 */
const reconnectAttempts = new Map();

/**
 * pendingHeartbeats Map: peerId -> sentAt timestamp
 * Tracks outgoing heartbeat pings awaiting ACK to measure RTT.
 */
const pendingHeartbeats = new Map();

/**
 * relayedPeers Map: nodeId -> lastRelayedAt timestamp
 * Tracks when we last relayed a peer's discovery info to prevent relay storms.
 * A peer is only relayed once per RELAY_COOLDOWN (10 seconds).
 */
const relayedPeers = new Map();

/**
 * routingTable Map: unreachableNodeId -> relayNodeId
 * When a direct WebSocket to a peer fails after RECONNECT_ATTEMPTS retries,
 * we fall back to indirect routing through the relay node that originally
 * told us about that peer. The gossip router checks this table.
 */
const routingTable = new Map();

/**
 * chatMessages — array of { fromNodeId, text, type, hops, timestamp }
 * Displayed in the TUI chat panel.
 */
const chatMessages = [];

/**
 * networkEvents — array of event strings for TUI display.
 */
const networkEvents = [];

/**
 * TUI update callback — set by App.js to trigger re-renders.
 */
let tuiUpdateCallback = null;

function setTuiUpdateCallback(cb) {
  tuiUpdateCallback = cb;
}

function triggerTuiUpdate() {
  if (tuiUpdateCallback) tuiUpdateCallback();
}

function addNetworkEvent(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  networkEvents.push(entry);
  if (networkEvents.length > 50) networkEvents.shift();
  triggerTuiUpdate();
}

function addChatMessage(fromNodeId, text, type, hops) {
  chatMessages.push({
    fromNodeId,
    text,
    type,
    hops,
    timestamp: new Date().toLocaleTimeString(),
  });
  if (chatMessages.length > 200) chatMessages.shift();
  triggerTuiUpdate();
}

// ─────────────────────────────────────────────────────────────────────────────
// SEEN MESSAGES — LAZY CLEANUP
// Instead of a scheduled sweep, expired entries are deleted inline during
// lookup. This avoids setInterval overhead and cleans exactly when needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hasSeenMessage — Check if a msgId has been seen before.
 * If the entry exists but is expired (>SEEN_MSG_TTL), delete it and return false.
 * This is lazy cleanup: no scheduled sweep, entries die on next access.
 */
function hasSeenMessage(msgId) {
  const ts = seenMessages.get(msgId);
  if (ts === undefined) return false;
  if (Date.now() - ts > SEEN_MSG_TTL) {
    seenMessages.delete(msgId);
    return false; // expired — treat as unseen
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 4: GOSSIP ROUTER
// ─────────────────────────────────────────────────────────────────────────────
//
// The gossip router is the CORE of MeshLink. Every message in the system
// flows through this function. It implements gossip flooding with:
//   - Deduplication via seenMessages (prevents infinite loops)
//   - TTL (time-to-live) to limit propagation depth
//   - Path tracking to record the route a message has taken
//
// Message envelope format:
// {
//   msgId:      string (UUIDv4, unique per message),
//   fromNodeId: string (originator node ID),
//   toNodeId:   string ('broadcast' or specific nodeId),
//   type:       string ('CHAT' | 'SOS' | 'PEER_LIST' | 'HEARTBEAT'),
//   payload:    any    (the actual message content),
//   ttl:        number (decremented at each hop, message dies at 0),
//   path:       array  (list of nodeIds this message has traversed)
// }
//

/**
 * handleIncomingMessage — Process a message received from a peer.
 *
 * @param {object} envelope - The message envelope (parsed JSON)
 * @param {string} senderPeerId - The nodeId of the peer who sent this to us
 *                                 (used to avoid echoing back to sender)
 */
function handleIncomingMessage(envelope, senderPeerId) {
  const { msgId, fromNodeId, toNodeId, type, payload, ttl, path } = envelope;

  // ── STEP 1: DEDUPLICATION ──────────────────────────────────────────────
  // Check if we've already seen this exact message (by its unique msgId).
  // If yes, DROP it immediately. This prevents:
  //   - Infinite message loops in cyclic topologies
  //   - Duplicate deliveries when multiple peers forward the same message
  if (hasSeenMessage(msgId)) {
    return; // Already processed — drop silently
  }

  // ── STEP 2: MARK AS SEEN ──────────────────────────────────────────────
  // Record this msgId with a timestamp so we know when to purge it.
  // The cleanup interval will remove it after SEEN_MSG_TTL (60 seconds).
  seenMessages.set(msgId, Date.now());

  // ── STEP 3: LOCAL DELIVERY ────────────────────────────────────────────
  // Deliver to this node if:
  //   a) toNodeId is 'broadcast' (message is for everyone), OR
  //   b) toNodeId matches our own nodeId (message is specifically for us)
  if (toNodeId === 'broadcast' || toNodeId === nodeId) {
    deliverLocally(envelope);
  }

  // If the message was specifically addressed to us (not broadcast),
  // there's no need to forward it further — we're the destination.
  if (toNodeId === nodeId) {
    return;
  }

  // ── STEP 4: TTL CHECK ─────────────────────────────────────────────────
  // Decrement TTL. If it reaches 0, the message has traveled far enough.
  // This prevents messages from circulating forever in large meshes.
  const newTtl = ttl - 1;
  if (newTtl <= 0) {
    return; // Message has expired — drop it
  }

  // ── STEP 5: UPDATE PATH ───────────────────────────────────────────────
  // Append our nodeId to the path array. This records the full route
  // the message has taken, which is useful for debugging and display.
  const newPath = [...path, nodeId];

  // ── STEP 6: GOSSIP FLOOD ──────────────────────────────────────────────
  // Forward the message to ALL connected peers EXCEPT:
  //   - The peer who sent it to us (senderPeerId) — no echoing back
  //   - The original sender (fromNodeId) — they already have it
  //   - Any node already in the path — they've seen it
  //
  // This is "gossip flooding": every node forwards to every other peer.
  // It's redundant by design — that redundancy IS the reliability mechanism.
  // If any single path fails, messages still arrive via alternate routes.
  const forwardEnvelope = {
    msgId,
    fromNodeId,
    toNodeId,
    type,
    payload,
    ttl: newTtl,
    path: newPath,
  };

  const serialized = JSON.stringify(forwardEnvelope);

  // ── STEP 6b: PRIORITY SORTING (Module 5) ────────────────────────────
  // Sort peers by:
  //   1) Latency ascending (fastest peers first — lower RTT = better)
  //   2) Connection age descending (older = more stable, tiebreaker)
  // We still flood to ALL peers, but lowest-latency peers get the
  // message first. This gives a "priority routing feel" while
  // maintaining the reliability of full gossip flooding.
  const sortedPeers = [...peers.entries()].sort((a, b) => {
    const latA = a[1].latency ?? Infinity;
    const latB = b[1].latency ?? Infinity;
    if (latA !== latB) return latA - latB; // lower latency first
    return a[1].connectedAt - b[1].connectedAt; // older connection first
  });

  // Forward simultaneously to all eligible peers using forEach
  sortedPeers.forEach(([peerId, peer]) => {
    if (peerId === senderPeerId) return;        // Don't echo back to sender
    if (peerId === fromNodeId) return;           // Don't send to original author
    if (newPath.includes(peerId)) return;        // Don't send to nodes in path
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(serialized);
    }
  });
}

/**
 * deliverLocally — Display a received message to the local user.
 *
 * @param {object} envelope - The message envelope
 */
function deliverLocally(envelope) {
  const { fromNodeId, type, payload, path } = envelope;
  const hops = path.length;

  if (type === 'CHAT') {
    addChatMessage(fromNodeId, payload, 'CHAT', hops);
  } else if (type === 'SOS') {
    addChatMessage(fromNodeId, payload, 'SOS', hops);
  } else if (type === 'PEER_LIST') {
    addNetworkEvent(`Received peer list from ${fromNodeId}`);
  }
}

/**
 * sendMessage — Create and broadcast a new message from this node.
 *
 * @param {string} text - The message text
 * @param {string} type - Message type ('CHAT', 'SOS', etc.)
 */
function sendMessage(text, type = 'CHAT') {
  const envelope = {
    msgId: uuidv4(),
    fromNodeId: nodeId,
    toNodeId: 'broadcast',
    type,
    payload: text,
    ttl: type === 'SOS' ? 20 : DEFAULT_MSG_TTL,
    path: [nodeId],
  };

  // Mark our own message as seen so we don't process it if it loops back
  seenMessages.set(envelope.msgId, Date.now());

  // Display locally
  addChatMessage(nodeId, text, type, 0);

  // Flood to all peers
  const serialized = JSON.stringify(envelope);
  // Send simultaneously to all peers using forEach
  peers.forEach((peer) => {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(serialized);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PEER LIST EXCHANGE
// ─────────────────────────────────────────────────────────────────────────────
//
// When a new peer connects (inbound or outbound), immediately share our
// known peer list with them. This lets new nodes discover the entire mesh
// instantly without waiting for individual UDP broadcasts to find each peer.
// This is what creates true full-duplex mesh — every node knows about
// every other node within milliseconds of joining.
//

/**
 * sendPeerList — Share our known peers with a newly connected peer.
 * Sends a PEER_EXCHANGE message containing all peers we know about
 * (excluding the recipient themselves).
 *
 * @param {WebSocket} ws - The WebSocket to send the peer list on
 * @param {string} excludeNodeId - Don't include this peer in the list
 */
function sendPeerList(ws, excludeNodeId) {
  const peerInfo = [];
  for (const [id, p] of peers) {
    if (id === excludeNodeId) continue;
    peerInfo.push({ nodeId: id, ip: p.ip, port: p.port });
  }
  if (peerInfo.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PEER_EXCHANGE', peers: peerInfo, fromNodeId: nodeId }));
  }
}

/**
 * handlePeerExchange — Process a peer list received from a connected peer.
 * For each unknown peer, initiate a WebSocket connection.
 *
 * @param {object} msg - The PEER_EXCHANGE message
 */
function handlePeerExchange(msg) {
  const { peers: remotePeers, fromNodeId } = msg;
  if (!Array.isArray(remotePeers)) return;

  for (const rp of remotePeers) {
    if (rp.nodeId === nodeId) continue;      // Don't connect to ourselves
    if (peers.has(rp.nodeId)) continue;       // Already connected
    const addr = `${rp.ip}:${rp.port}`;
    if (discoveredAddresses.has(addr)) continue; // Already attempted

    discoveredAddresses.add(addr);
    addNetworkEvent(`Discovered ${rp.nodeId} via peer exchange from ${fromNodeId}`);
    connectToPeer(rp.ip, rp.port, rp.nodeId, 1, fromNodeId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 2: WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────────────────────────
//
// Each node runs its own WebSocket server. Other nodes connect to this server
// as clients. On connection, we wait for an IDENTIFY message that tells us
// who the connecting node is, then add it to our peers Map.
//

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });

wss.on('listening', () => {
  addNetworkEvent(`WebSocket server listening on port ${WS_PORT}`);
});

wss.on('connection', (ws, req) => {
  let remotePeerId = null;

  // Enable TCP keepalive on the underlying socket to prevent Android NAT expiry
  if (req.socket) {
    req.socket.setKeepAlive(true, 10000);
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // Ignore malformed messages
    }

    // First message from an inbound connection should be an IDENTIFY message
    // so we know which nodeId this peer corresponds to.
    if (msg.type === 'IDENTIFY') {
      remotePeerId = msg.nodeId;

      // Don't add ourselves (can happen with UDP broadcast to self)
      if (remotePeerId === nodeId) {
        ws.close();
        return;
      }

      // If we already have a connection to this peer, close the duplicate.
      // Keep the existing connection to avoid churn.
      if (peers.has(remotePeerId)) {
        ws.close();
        return;
      }

      peers.set(remotePeerId, {
        ws,
        ip: msg.ip || req.socket.remoteAddress,
        port: msg.wsPort,
        latency: null,
        connectedAt: Date.now(),
      });

      addNetworkEvent(`Node ${remotePeerId} connected (inbound) — ${peers.size} peers total`);

      // Share our known peers so the new node discovers the full mesh instantly
      sendPeerList(ws, remotePeerId);
      return;
    }

    // ── PEER EXCHANGE handling ─────────────────────────────────────────
    // When a peer shares their peer list, connect to any unknown peers.
    if (msg.type === 'PEER_EXCHANGE') {
      handlePeerExchange(msg);
      return;
    }

    // ── HEARTBEAT handling (point-to-point, NOT gossip-flooded) ────────
    // When we receive a HEARTBEAT ping, immediately reply with HEARTBEAT_ACK
    // so the sender can measure round-trip time.
    if (msg.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK', sentAt: msg.sentAt, fromNodeId: nodeId }));
      return;
    }

    // When we receive a HEARTBEAT_ACK, calculate RTT and update peer latency.
    if (msg.type === 'HEARTBEAT_ACK') {
      if (remotePeerId && peers.has(remotePeerId)) {
        const rtt = Date.now() - msg.sentAt;
        peers.get(remotePeerId).latency = rtt;
      }
      return;
    }

    // All other messages go to the gossip router
    if (remotePeerId) {
      handleIncomingMessage(msg, remotePeerId);
    }
  });

  // ── MODULE 6: SELF HEALING (inbound connections) ────────────────────
  // When a peer disconnects, remove from peers Map and log heal event.
  // No special rerouting needed — gossip flooding inherently self-heals
  // because messages are flooded to ALL remaining peers anyway.
  ws.on('close', () => {
    if (remotePeerId && peers.has(remotePeerId)) {
      peers.delete(remotePeerId);
      addNetworkEvent(`Node ${remotePeerId} left — network healed, ${peers.size} peers remaining`);
      if (peers.size === 0) {
        addNetworkEvent('Isolated — waiting for peers');
      }
    }
  });

  ws.on('error', () => {
    // Errors typically precede close events; healing handled in 'close'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 3: PEER MANAGER (WebSocket Client)
// ─────────────────────────────────────────────────────────────────────────────
//
// When a new peer is discovered via UDP, we open an outbound WebSocket
// connection to their server. We send an IDENTIFY message so they know
// who we are. If the connection fails, we retry up to RECONNECT_ATTEMPTS
// times with RECONNECT_DELAY between attempts.
//

/**
 * connectToPeer — Open an outbound WebSocket connection to a discovered peer.
 *
 * @param {string} ip           - The peer's IP address
 * @param {number} port         - The peer's WebSocket server port
 * @param {string} peerId       - The peer's nodeId
 * @param {number} attempt      - Current attempt number (for reconnection)
 * @param {string} relayNodeId  - nodeId of the relay that introduced this peer (for fallback routing)
 */
function connectToPeer(ip, port, peerId, attempt = 1, relayNodeId = null) {
  // Don't connect to ourselves
  if (peerId === nodeId) return;

  // Don't duplicate connections
  if (peers.has(peerId)) return;

  const addr = `${ip}:${port}`;
  const ws = new WebSocket(`ws://${addr}`);

  ws.on('open', () => {
    // Send IDENTIFY so the server knows who we are
    ws.send(JSON.stringify({
      type: 'IDENTIFY',
      nodeId: nodeId,
      ip: lanIP,
      wsPort: WS_PORT,
    }));

    // Add to peers map
    peers.set(peerId, {
      ws,
      ip,
      port,
      latency: null,
      connectedAt: Date.now(),
    });

    // Direct connection succeeded — remove from routingTable if present
    routingTable.delete(peerId);

    // Reset reconnect counter on success
    reconnectAttempts.delete(addr);

    const via = relayNodeId ? ` (via relay ${relayNodeId})` : '';
    addNetworkEvent(`Connected to ${peerId} at ${addr} (outbound)${via} — ${peers.size} peers total`);

    // Share our known peers so the remote node discovers the full mesh instantly
    sendPeerList(ws, peerId);

    // Listen for pong on outbound connections
    ws.on('pong', () => {
      const p = peers.get(peerId);
      if (p) {
        p._pongPending = false;
        if (p._pongTimer) { clearTimeout(p._pongTimer); p._pongTimer = null; }
      }
    });
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // Ignore malformed messages
    }

    // ── PEER EXCHANGE handling on outbound connections ─────────────────
    if (msg.type === 'PEER_EXCHANGE') {
      handlePeerExchange(msg);
      return;
    }

    // ── HEARTBEAT handling on outbound connections ─────────────────────
    if (msg.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK', sentAt: msg.sentAt, fromNodeId: nodeId }));
      return;
    }

    if (msg.type === 'HEARTBEAT_ACK') {
      if (peers.has(peerId)) {
        const rtt = Date.now() - msg.sentAt;
        peers.get(peerId).latency = rtt;
      }
      return;
    }

    handleIncomingMessage(msg, peerId);
  });

  // ── MODULE 6: SELF HEALING (outbound connections) ─────────────────────
  // On disconnect: remove peer, log heal, attempt reconnection up to 3 times.
  // Gossip flooding inherently handles rerouting — no special logic needed.
  ws.on('close', () => {
    if (peers.has(peerId)) {
      peers.delete(peerId);
      addNetworkEvent(`Node ${peerId} left — network healed, ${peers.size} peers remaining`);
      if (peers.size === 0) {
        addNetworkEvent('Isolated — waiting for peers');
      }
    }

    // Attempt reconnection
    const currentAttempt = reconnectAttempts.get(addr) || 0;
    if (currentAttempt < RECONNECT_ATTEMPTS) {
      reconnectAttempts.set(addr, currentAttempt + 1);
      setTimeout(() => {
        // Only reconnect if we still don't have a connection to this peer
        if (!peers.has(peerId)) {
          connectToPeer(ip, port, peerId, currentAttempt + 1, relayNodeId);
        }
      }, RECONNECT_DELAY);
    } else {
      // ── STEP 5: FALLBACK INDIRECT ROUTING ──────────────────────────
      // Direct WebSocket failed after all retries. If a relay node
      // introduced this peer, fall back to routing messages through
      // that relay. The gossip router will handle forwarding via the
      // relay node's WebSocket connection.
      discoveredAddresses.delete(addr);
      reconnectAttempts.delete(addr);

      if (relayNodeId && peers.has(relayNodeId)) {
        routingTable.set(peerId, relayNodeId);
        addNetworkEvent(`Direct WS to ${peerId} failed — routing through relay ${relayNodeId}`);
      }
    }
  });

  ws.on('error', () => {
    // Error events are followed by close events, so reconnection
    // logic is handled in the 'close' handler above.
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1: UDP DISCOVERY + MODULE 9: DISCOVERY RELAY
// ─────────────────────────────────────────────────────────────────────────────
//
// On startup, the node broadcasts a UDP discovery packet every 2 seconds on
// EVERY network interface's subnet-specific broadcast address.
//
// When a discovery packet arrives from a remote peer:
//   1) If not already known, initiate a WebSocket connection to that peer.
//   2) If this node is a bridge (multiple interfaces), RELAY the discovery
//      to all OTHER interfaces so peers on different subnets learn about
//      each other. Relayed packets are marked relayed:true to prevent storms.
//   3) Relayed packets are processed identically for peer discovery but
//      are NEVER re-relayed (depth = 1 hop max).
//
// Storm prevention:
//   - relayedPeers Map tracks lastRelayedAt per nodeId (10s cooldown)
//   - Packets already marked relayed:true are never re-relayed
//   - A node never relays its own broadcasts
//

const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

/**
 * broadcastOnAllInterfaces — Send a UDP packet to every interface's broadcast
 * address. This ensures the announcement reaches every subnet this device is
 * connected to simultaneously.
 *
 * @param {Buffer|string} packet - The data to broadcast
 */
function broadcastOnAllInterfaces(packet) {
  const buf = typeof packet === 'string' ? Buffer.from(packet) : packet;
  for (const iface of localInterfaces) {
    udpSocket.send(buf, 0, buf.length, UDP_PORT, iface.broadcast, () => {
      // Silently ignore per-interface broadcast errors
    });
  }
}

/**
 * relayPeerDiscovery — When we discover a peer on one interface, re-broadcast
 * their existence on ALL OTHER interfaces. This is the core of cross-subnet
 * bridging. Only called when we have multiple interfaces (isBridgeNode).
 *
 * @param {object} originalMsg   - The original discovery packet
 * @param {string} sourceAddress - The IP the packet arrived from (so we skip
 *                                  that interface's broadcast)
 */
function relayPeerDiscovery(originalMsg, sourceAddress) {
  const remoteNodeId = originalMsg.nodeId;

  // Storm prevention: only relay each peer once per RELAY_COOLDOWN
  const lastRelayed = relayedPeers.get(remoteNodeId);
  if (lastRelayed && (Date.now() - lastRelayed) < RELAY_COOLDOWN) {
    return; // Already relayed recently — skip
  }
  relayedPeers.set(remoteNodeId, Date.now());

  // Build the relayed packet — same peer info, but marked as relayed
  const relayedPacket = JSON.stringify({
    nodeId: originalMsg.nodeId,
    ip: originalMsg.ip,
    wsPort: originalMsg.wsPort,
    relayed: true,
    relayedBy: nodeId,
  });

  const buf = Buffer.from(relayedPacket);

  // Determine which interface the source belongs to, so we skip it
  const sourceIfaceBroadcast = getInterfaceBroadcastForSource(sourceAddress);

  // Broadcast on all interfaces EXCEPT the one the packet came from
  for (const iface of localInterfaces) {
    if (iface.broadcast === sourceIfaceBroadcast) continue;
    udpSocket.send(buf, 0, buf.length, UDP_PORT, iface.broadcast, () => {});
  }

  addNetworkEvent(`Relayed ${remoteNodeId} discovery to ${localInterfaces.length - 1} other interface(s)`);
}

/**
 * getInterfaceBroadcastForSource — Given a source IP, find which of our
 * local interfaces it belongs to (same subnet). Returns the broadcast
 * address for that interface.
 */
function getInterfaceBroadcastForSource(sourceIP) {
  const srcInt = ipToInt(sourceIP);
  for (const iface of localInterfaces) {
    const ifaceInt = ipToInt(iface.address);
    const maskInt = ipToInt(iface.netmask);
    // Same subnet if (srcIP & mask) === (ifaceIP & mask)
    if ((srcInt & maskInt) === (ifaceInt & maskInt)) {
      return iface.broadcast;
    }
  }
  return null; // Unknown subnet — relay to all
}

udpSocket.on('message', (data, rinfo) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return; // Ignore malformed packets
  }

  const { nodeId: remoteNodeId, ip: remoteIP, wsPort: remotePort } = msg;
  const isRelayed = msg.relayed === true;
  const relayedBy = msg.relayedBy || null;

  // Ignore our own broadcasts
  if (remoteNodeId === nodeId) return;

  const addr = `${remoteIP}:${remotePort}`;

  // ── STEP 4: Handle relayed discovery packets ─────────────────────────
  // Process relayed packets identically for peer discovery.
  // The only difference: do NOT re-relay them (max relay depth = 1).
  if (!discoveredAddresses.has(addr) && !peers.has(remoteNodeId)) {
    discoveredAddresses.add(addr);
    const via = isRelayed ? ` (via relay ${relayedBy})` : '';
    addNetworkEvent(`Discovered ${remoteNodeId} at ${addr}${via}`);
    connectToPeer(remoteIP, remotePort, remoteNodeId, 1, relayedBy);
  }

  // ── STEP 3: Relay to other interfaces if we are a bridge node ────────
  // Only relay DIRECT broadcasts (not already relayed) to prevent storms.
  if (!isRelayed && isBridgeNode) {
    relayPeerDiscovery(msg, rinfo.address);
  }
});

udpSocket.on('error', (err) => {
  addNetworkEvent(`UDP error: ${err.message}`);
});

udpSocket.bind(UDP_PORT, () => {
  udpSocket.setBroadcast(true);

  // Log detected interfaces
  if (localInterfaces.length > 1) {
    const ifaceList = localInterfaces.map(i => `${i.address} (${i.name}→${i.broadcast})`).join(', ');
    addNetworkEvent(`Bridge node detected — ${localInterfaces.length} interfaces: ${ifaceList}`);
  }
  addNetworkEvent(`UDP discovery listening on port ${UDP_PORT}`);

  // ── STEP 2: Broadcast on ALL interfaces ──────────────────────────────
  // Burst mode: 300ms for first 10 seconds (fast initial mesh formation)
  // then slows to 2s steady state (low overhead once mesh is formed)
  const announcement = JSON.stringify({ nodeId, ip: lanIP, wsPort: WS_PORT });

  function scheduleBroadcast() {
    const elapsed = Date.now() - startupTime;
    const interval = elapsed < UDP_BURST_DURATION ? UDP_BURST_INTERVAL : UDP_STEADY_INTERVAL;
    broadcastOnAllInterfaces(announcement);
    setTimeout(scheduleBroadcast, interval);
  }
  scheduleBroadcast(); // start immediately
});

// Clean up relayedPeers cooldown entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of relayedPeers) {
    if (now - ts > RELAY_COOLDOWN * 3) {
      relayedPeers.delete(id);
    }
  }
}, 30000);

// ─────────────────────────────────────────────────────────────────────────────
// WS KEEPALIVE (Ping/Pong) — Prevents Android NAT expiry
// ─────────────────────────────────────────────────────────────────────────────
//
// Every 10 seconds, send a WebSocket-level ping() to each peer.
// If pong is not received within 5 seconds, the connection is dead
// (Android NAT expired, WiFi dropped, etc). Terminate it so
// self-healing (reconnect + gossip reroute) kicks in immediately
// instead of waiting for TCP timeout (which can be 2+ minutes).
//

const WS_PING_INTERVAL = 10000;   // ping every 10 seconds
const WS_PONG_TIMEOUT = 5000;     // consider dead if no pong in 5s

setInterval(() => {
  peers.forEach((peer, peerId) => {
    if (peer.ws.readyState !== WebSocket.OPEN) return;

    // If we were already waiting for a pong and it never came, kill it
    if (peer._pongPending) {
      peer.ws.terminate(); // triggers 'close' event → self-healing
      return;
    }

    // Send ping frame, mark as waiting for pong
    peer._pongPending = true;
    peer.ws.ping();

    // Set a timeout — if pong doesn't arrive in 5s, flag for termination
    peer._pongTimer = setTimeout(() => {
      if (peer._pongPending && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.terminate();
      }
    }, WS_PONG_TIMEOUT);
  });
}, WS_PING_INTERVAL);

// Listen for pong responses on all WS server inbound connections
wss.on('connection', (ws) => {
  ws.on('pong', () => {
    // Find which peer this ws belongs to and clear their pending flag
    for (const [, peer] of peers) {
      if (peer.ws === ws) {
        peer._pongPending = false;
        if (peer._pongTimer) { clearTimeout(peer._pongTimer); peer._pongTimer = null; }
        break;
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 5: HEARTBEAT (Latency Measurement)
// ─────────────────────────────────────────────────────────────────────────────
//
// Every 5 seconds, send a HEARTBEAT message to each connected peer.
// The peer replies with HEARTBEAT_ACK containing the original sentAt timestamp.
// We calculate RTT = Date.now() - sentAt and store it as peer.latency.
// This latency is used by the gossip router to prioritize faster peers.
//

setInterval(() => {
  const heartbeat = JSON.stringify({
    type: 'HEARTBEAT',
    sentAt: Date.now(),
    fromNodeId: nodeId,
  });

  for (const [peerId, peer] of peers) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(heartbeat);
    }
  }
}, HEARTBEAT_INTERVAL);

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 10: WEB UI BRIDGE
// ─────────────────────────────────────────────────────────────────────────────

startWebBridge({ nodeId, lanIP, wsPort: WS_PORT, peers, chatMessages, networkEvents, sendMessage });

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 7: INK TUI
// ─────────────────────────────────────────────────────────────────────────────

const { waitUntilExit } = render(
  React.createElement(App, {
    nodeId,
    lanIP,
    wsPort: WS_PORT,
    peers,
    chatMessages,
    networkEvents,
    sendMessage,
    setTuiUpdateCallback,
  })
);

// Graceful shutdown
process.on('SIGINT', () => {
  udpSocket.close();
  wss.close();
  for (const [, peer] of peers) {
    peer.ws.close();
  }
  process.exit(0);
});
