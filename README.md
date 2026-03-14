# MeshLink — Serverless LAN Mesh Chat

A fully decentralized, self-healing mesh chat application for LAN. No central server. Every node is both a WebSocket server and client. Messages propagate via gossip flooding.

## Quick Start

```bash
npm install
node index.js
```

Run on each device (or terminal) on the same LAN. That's it — zero configuration.

## How It Works

1. **UDP Discovery** — Each node broadcasts its presence on `255.255.255.255:41234` every 2 seconds
2. **WebSocket Mesh** — Nodes connect to each other via WebSocket (random port 3000-3999)
3. **Gossip Flooding** — Messages flood to all peers with TTL (10 hops) and deduplication
4. **Priority Routing** — Peers sorted by measured latency (heartbeat RTT) for faster delivery
5. **Self-Healing** — When any node disconnects, the network automatically heals — gossip flooding IS the healing mechanism

## TUI Layout

```
┌─────────────────────────────────────────────┐
│  ⬡ MeshLink · node-abc123 · 192.168.1.5    │
├───────────────────────────┬─────────────────┤
│ 💬 Chat                   │ 📡 Peers (2)    │
│ [10:30] [node-def456]     │  node-def456    │
│ (1 hop) Hello!            │  192.168.1.6    │
│                           │  ⏱ 2ms  ↑45s   │
│ ┌───────────────────────┐ │                 │
│ │ ⚡ Events              │ │                 │
│ │ Node joined...        │ │                 │
│ └───────────────────────┘ │                 │
├───────────────────────────┴─────────────────┤
│ > Type a message...                         │
└─────────────────────────────────────────────┘
```

## Commands

| Command | Description |
|---------|-------------|
| `/sos <msg>` | Emergency broadcast (red, TTL 20, 🚨 prefix) |
| `Ctrl+C` | Exit |

Any other text is sent as a regular chat message.

## CLI Options

```bash
node index.js --port 3500   # Override WebSocket server port
```

## Requirements

- Node.js 18+
- Devices on the same LAN (UDP broadcast must be reachable)

## Architecture

```
┌──────────────────────────────────────┐
│              index.js                │
│  ┌─────────┐  ┌──────────────────┐  │
│  │   UDP    │  │   WS Server      │  │
│  │Discovery │  │ (inbound peers)  │  │
│  └────┬─────┘  └───────┬──────────┘  │
│       │                │             │
│  ┌────▼─────────────────▼──────────┐ │
│  │       Peer Manager              │ │
│  │  peers Map { nodeId → ws,       │ │
│  │    ip, port, latency }          │ │
│  └────────────┬────────────────────┘ │
│               │                      │
│  ┌────────────▼────────────────────┐ │
│  │       Gossip Router             │ │
│  │  dedup → deliver → TTL → flood  │ │
│  │  (priority-sorted by latency)   │ │
│  └─────────────────────────────────┘ │
│               │                      │
│  ┌────────────▼────────────────────┐ │
│  │       Ink TUI (src/App.js)      │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

## Testing Locally

Open 3 terminals on the same machine:

```bash
# Terminal 1
node index.js

# Terminal 2
node index.js

# Terminal 3
node index.js
```

1. All 3 discover each other within ~4 seconds
2. Type a message in Terminal 1 → appears in Terminals 2 and 3
3. Kill Terminal 2 (Ctrl+C) → Terminals 1 and 3 log the heal event

## License

MIT
