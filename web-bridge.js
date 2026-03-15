/**
 * web-bridge.js — Bridges the MeshLink mesh engine to browser clients.
 *
 * Creates an HTTP server that serves the built React UI and a WebSocket
 * endpoint for real-time state sync with browser clients.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function startWebBridge({ nodeId, lanIP, wsPort, peers, chatMessages, networkEvents, sendMessage }) {
  const WEB_PORT = 8080;
  const distPath = path.join(__dirname, 'web', 'dist');

  // ── HTTP Server: serve built React app ──────────────────────────────────
  const server = http.createServer((req, res) => {
    // CORS headers for development
    res.setHeader('Access-Control-Allow-Origin', '*');

    let urlPath = req.url.split('?')[0]; // strip query params
    let filePath = path.join(distPath, urlPath === '/' ? 'index.html' : urlPath);
    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback — serve index.html for client-side routing
        fs.readFile(path.join(distPath, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  // ── WebSocket Server: real-time state sync ──────────────────────────────
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send full state immediately on connect
    ws.send(JSON.stringify({
      type: 'STATE_UPDATE',
      data: getState(),
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'SEND_MESSAGE') {
          sendMessage(msg.text, msg.msgType || 'CHAT');
        }
      } catch {
        // ignore malformed
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // ── State snapshot builder ──────────────────────────────────────────────
  function getState() {
    const peerList = [];
    for (const [id, p] of peers) {
      peerList.push({
        id,
        ip: p.ip,
        port: p.port,
        latency: p.latency,
        connectedAt: p.connectedAt,
      });
    }
    return {
      nodeId,
      lanIP,
      wsPort,
      peers: peerList,
      chatMessages: chatMessages.slice(-200),
      networkEvents: networkEvents.slice(-50),
    };
  }

  // ── Push state to all browser clients every 250ms (if changed) ─────────
  let lastStateSerialized = '';
  setInterval(() => {
    if (clients.size === 0) return;
    const state = getState();
    const serialized = JSON.stringify({ type: 'STATE_UPDATE', data: state });
    if (serialized === lastStateSerialized) return; // no change
    lastStateSerialized = serialized;
    for (const client of clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(serialized);
      }
    }
  }, 250);

  server.listen(WEB_PORT, () => {
    console.log(`  🌐 Web UI → http://localhost:${WEB_PORT}`);
  });
}
