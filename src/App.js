/**
 * MeshLink TUI — Minimal, flat terminal UI.
 * Inspired by Claude Code / Codex CLI style: simple text, no heavy borders.
 * Uses React.createElement — no JSX, no build step.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';

const h = React.createElement;

function App({ nodeId, lanIP, wsPort, peers, chatMessages, networkEvents, sendMessage, setTuiUpdateCallback }) {
  const [inputValue, setInputValue] = useState('');
  const [tick, setTick] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const rows = stdout?.rows || 24;

  // Re-render callback for mesh engine state changes
  useEffect(() => {
    setTuiUpdateCallback(() => setTick(t => t + 1));
    return () => setTuiUpdateCallback(null);
  }, [setTuiUpdateCallback]);

  const handleSubmit = useCallback((value) => {
    const text = value.trim();
    if (!text) return;
    setInputValue('');
    if (text.startsWith('/sos')) {
      sendMessage(text.slice(4).trim() || 'EMERGENCY', 'SOS');
    } else {
      sendMessage(text, 'CHAT');
    }
  }, [sendMessage]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      process.exit(0);
    }
  });

  // Build compact peer summary
  const peerSummary = [];
  for (const [id, p] of peers) {
    const lat = p.latency !== null ? `${p.latency}ms` : '?';
    peerSummary.push(`${id}(${lat})`);
  }

  // Visible messages — fill available space
  // Reserve: 1 header + 1 peer line + 1 event line + 1 blank + 1 input = 5 lines overhead
  const maxMessages = Math.max(5, rows - 5);
  const visibleMessages = chatMessages.slice(-maxMessages);

  // Last 2 events
  const recentEvents = networkEvents.slice(-2);

  return h(Box, { flexDirection: 'column', width: '100%' },

    // ── Header ──
    h(Text, { bold: true, color: 'cyan' },
      `⬡ MeshLink  ${nodeId}  ${lanIP}:${wsPort}`),

    // ── Chat Messages ──
    h(Box, { flexDirection: 'column', flexGrow: 1, paddingLeft: 0, marginTop: 0 },
      visibleMessages.length === 0
        ? h(Text, { dimColor: true }, '  waiting for messages...')
        : visibleMessages.map((msg, i) => {
            if (msg.type === 'SOS') {
              return h(Text, { key: i, color: 'red', bold: true, wrap: 'truncate' },
                `  🚨 ${msg.fromNodeId} (${msg.hops}h): ${msg.text}`);
            }
            const isMe = msg.fromNodeId === nodeId;
            return h(Text, { key: i, wrap: 'truncate' },
              h(Text, { color: isMe ? 'green' : 'cyan', dimColor: !isMe },
                `  ${isMe ? 'you' : msg.fromNodeId}`),
              h(Text, { dimColor: true }, ` (${msg.hops}h) `),
              h(Text, null, msg.text));
          })
    ),

    // ── Status bar: peers + events ──
    h(Text, { color: 'magenta', dimColor: true, wrap: 'truncate' },
      `  ${peers.size} peers: ${peerSummary.join(' · ') || 'none'}`),

    recentEvents.length > 0
      ? h(Text, { color: 'yellow', dimColor: true, wrap: 'truncate' },
          `  ${recentEvents[recentEvents.length - 1]}`)
      : null,

    // ── Input ──
    h(Box, { marginTop: 0 },
      h(Text, { color: 'green', bold: true }, '❯ '),
      h(TextInput, {
        value: inputValue,
        onChange: setInputValue,
        onSubmit: handleSubmit,
        placeholder: 'message (/sos for emergency)',
      })
    )
  );
}

export default App;
