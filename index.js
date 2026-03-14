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
 */

import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import React from 'react';
import { render } from 'ink';
import App from './src/App.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG & NODE IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

const UDP_PORT = 41234;
const UDP_BROADCAST_INTERVAL = 2000; // 2 seconds
const SEEN_MSG_TTL = 60000;          // 60 seconds before purging seen msgIds
const DEFAULT_MSG_TTL = 10;          // default hop limit for messages
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;        // 2 seconds
const HEARTBEAT_INTERVAL = 5000;     // 5 seconds between heartbeat pings

// Generate unique node ID: "node-" + 6 random hex chars
const nodeId = 'node-' + crypto.randomBytes(3).toString('hex');

// Parse optional --port CLI argument
const cliPortArg = process.argv.find((a, i) => process.argv[i - 1] === '--port');
const WS_PORT = cliPortArg ? parseInt(cliPortArg, 10) : 3000 + Math.floor(Math.random() * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Get this machine's LAN IP
// ─────────────────────────────────────────────────────────────────────────────

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip loopback and non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // fallback
}

const lanIP = getLanIP();

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
// SEEN MESSAGES CLEANUP
// Periodically purge msgIds older than 60 seconds to prevent memory leak.
// ─────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [msgId, ts] of seenMessages) {
    if (now - ts > SEEN_MSG_TTL) {
      seenMessages.delete(msgId);
    }
  }
}, 10000); // run cleanup every 10 seconds

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
  if (seenMessages.has(msgId)) {
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

  for (const [peerId, peer] of sortedPeers) {
    // Don't send back to whoever sent it to us
    if (peerId === senderPeerId) continue;
    // Don't send to the original author
    if (peerId === fromNodeId) continue;
    // Don't send to nodes already in the path (they've seen it)
    if (newPath.includes(peerId)) continue;

    // Send to this peer
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(serialized);
    }
  }
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
  for (const [peerId, peer] of peers) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(serialized);
    }
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

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  addNetworkEvent(`WebSocket server listening on port ${WS_PORT}`);
});

wss.on('connection', (ws, req) => {
  let remotePeerId = null;

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
 * @param {string} ip        - The peer's IP address
 * @param {number} port      - The peer's WebSocket server port
 * @param {string} peerId    - The peer's nodeId
 * @param {number} attempt   - Current attempt number (for reconnection)
 */
function connectToPeer(ip, port, peerId, attempt = 1) {
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

    // Reset reconnect counter on success
    reconnectAttempts.delete(addr);

    addNetworkEvent(`Connected to ${peerId} at ${addr} (outbound) — ${peers.size} peers total`);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // Ignore malformed messages
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
          connectToPeer(ip, port, peerId, currentAttempt + 1);
        }
      }, RECONNECT_DELAY);
    } else {
      // Give up — remove from discovered so UDP can re-trigger later
      discoveredAddresses.delete(addr);
      reconnectAttempts.delete(addr);
    }
  });

  ws.on('error', () => {
    // Error events are followed by close events, so reconnection
    // logic is handled in the 'close' handler above.
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1: UDP DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────
//
// On startup, the node broadcasts a UDP packet every 2 seconds on
// 255.255.255.255:41234 containing its nodeId, LAN IP, and WS port.
// Simultaneously listens for UDP broadcasts from other nodes.
// When a new node is discovered (not in peers and not self), initiate
// a WebSocket client connection to it.
//

const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (data, rinfo) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return; // Ignore malformed packets
  }

  const { nodeId: remoteNodeId, ip: remoteIP, wsPort: remotePort } = msg;

  // Ignore our own broadcasts
  if (remoteNodeId === nodeId) return;

  const addr = `${remoteIP}:${remotePort}`;

  // If we haven't seen this address and don't already have this peer,
  // initiate a WebSocket connection.
  if (!discoveredAddresses.has(addr) && !peers.has(remoteNodeId)) {
    discoveredAddresses.add(addr);
    addNetworkEvent(`Discovered ${remoteNodeId} at ${addr} via UDP`);
    connectToPeer(remoteIP, remotePort, remoteNodeId);
  }
});

udpSocket.on('error', (err) => {
  addNetworkEvent(`UDP error: ${err.message}`);
});

udpSocket.bind(UDP_PORT, () => {
  udpSocket.setBroadcast(true);
  addNetworkEvent(`UDP discovery listening on port ${UDP_PORT}`);

  // Broadcast our presence every 2 seconds
  setInterval(() => {
    const announcement = JSON.stringify({
      nodeId,
      ip: lanIP,
      wsPort: WS_PORT,
    });

    udpSocket.send(announcement, 0, announcement.length, UDP_PORT, '255.255.255.255', () => {
      // Silently ignore broadcast errors
    });
  }, UDP_BROADCAST_INTERVAL);
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
