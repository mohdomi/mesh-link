import React, { useState, useEffect, useRef, useCallback } from 'react';

function App() {
  const [state, setState] = useState({
    nodeId: '',
    lanIP: '',
    wsPort: 0,
    peers: [],
    chatMessages: [],
    networkEvents: [],
  });
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [justSent, setJustSent] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const reconnectTimer = useRef(null);
  const prevMsgCount = useRef(0);

  // ── WebSocket connection ─────────────────────────────────────────────
  useEffect(() => {
    let ws;
    let dead = false;

    function connect() {
      if (dead) return;
      const wsUrl = `ws://${window.location.hostname}:8080`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsRef.current = ws;       // ← only set ref when OPEN and ready to send
        setConnected(true);
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (!dead) {
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'STATE_UPDATE') {
            setState(msg.data);
          }
        } catch {}
      };
    }

    connect();
    return () => {
      dead = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (ws) ws.close();
    };
  }, []);

  // ── Auto-scroll on new messages ─────────────────────────────────────
  useEffect(() => {
    const count = state.chatMessages.length;
    if (count > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCount.current = count;
  }, [state.chatMessages.length]);

  // ── Send message ────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    // Make sure the WebSocket is connected and open
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      const isSos = text.toLowerCase().startsWith('/sos');
      ws.send(JSON.stringify({
        type: 'SEND_MESSAGE',
        text: isSos ? (text.slice(4).trim() || 'EMERGENCY') : text,
        msgType: isSos ? 'SOS' : 'CHAT',
      }));
      setInput('');
      setJustSent(true);
      setTimeout(() => setJustSent(false), 400);
    } catch {
      // send failed — connection may have dropped
    }
    inputRef.current?.focus();
  }, [input]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // ── Helpers ─────────────────────────────────────────────────────────
  function getLatencyClass(latency) {
    if (latency === null || latency === undefined) return '';
    if (latency < 50) return 'lat-fast';
    if (latency < 150) return 'lat-ok';
    return 'lat-slow';
  }

  function timeSince(connectedAt) {
    if (!connectedAt) return '';
    const diff = Math.floor((Date.now() - connectedAt) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    return `${Math.floor(diff / 3600)}h`;
  }

  const peerCount = state.peers.length;
  const msgCount = state.chatMessages.length;

  return (
    <div className="app">
      {/* ── Accent gradient line ─────────────────────────────────── */}
      <div className="accent-bar" />

      {/* ── HEADER ───────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <button
            className="sidebar-toggle"
            onClick={() => setShowSidebar(!showSidebar)}
            title="Toggle peer list"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <span className="logo-hex">⬡</span>
          <span className="brand">MeshLink</span>
          <span className="node-badge">{state.nodeId || '...'}</span>
        </div>
        <div className="header-right">
          <span className="addr-badge">{state.lanIP}:{state.wsPort}</span>
          <span className="peer-badge">
            {peerCount} peer{peerCount !== 1 ? 's' : ''}
          </span>
          <span className={`conn-dot ${connected ? 'dot-on' : 'dot-off'}`} />
        </div>
      </header>

      <div className="body">
        {/* ── SIDEBAR (always rendered, animated via CSS) ─────────── */}
        <aside className={`sidebar ${showSidebar ? 'sb-open' : 'sb-closed'}`}>
          <div className="sb-section">
            <div className="sb-label">
              <span>PEERS</span>
              <span className="sb-count">{peerCount}</span>
            </div>
            <div className="peer-list">
              {peerCount === 0 ? (
                <div className="peer-empty">
                  <div className="pulse-ring" />
                  <span>Scanning network…</span>
                </div>
              ) : (
                state.peers.map((peer, idx) => (
                  <div
                    key={peer.id}
                    className="peer-card"
                    style={{ animationDelay: `${idx * 60}ms` }}
                  >
                    <div className="peer-top">
                      <span className="peer-dot" />
                      <span className="peer-id">{peer.id}</span>
                    </div>
                    <div className="peer-bottom">
                      <span className="peer-addr">{peer.ip}:{peer.port}</span>
                      <span className={`peer-lat ${getLatencyClass(peer.latency)}`}>
                        {peer.latency !== null && peer.latency !== undefined
                          ? `${peer.latency}ms`
                          : '—'}
                      </span>
                      {peer.connectedAt && (
                        <span className="peer-age">{timeSince(peer.connectedAt)}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Events panel */}
          <div className="sb-section sb-events">
            <button
              className="sb-label sb-label-btn"
              onClick={() => setShowEvents(!showEvents)}
            >
              <span>EVENTS</span>
              <span className={`chevron ${showEvents ? 'chevron-open' : ''}`}>›</span>
            </button>
            {showEvents && (
              <div className="event-list">
                {state.networkEvents.length === 0 ? (
                  <div className="event-empty">No events yet</div>
                ) : (
                  state.networkEvents.slice(-20).map((evt, i) => (
                    <div
                      key={i}
                      className="event-row"
                      style={{ animationDelay: `${i * 30}ms` }}
                    >
                      {evt}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </aside>

        {/* ── CHAT AREA ──────────────────────────────────────────── */}
        <main className="chat">
          <div className="messages">
            {msgCount === 0 ? (
              <div className="chat-empty">
                <div className="empty-hex">⬡</div>
                <p className="empty-title">No messages yet</p>
                <p className="empty-sub">
                  Messages from the mesh network will appear here.
                  <br />
                  Type below to send a message to all connected peers.
                </p>
              </div>
            ) : (
              state.chatMessages.map((msg, i) => {
                const isMe = msg.fromNodeId === state.nodeId;
                const isSos = msg.type === 'SOS';
                const prev = i > 0 ? state.chatMessages[i - 1] : null;
                const grouped = prev && prev.fromNodeId === msg.fromNodeId && prev.type === msg.type;
                const senderChanged = prev && prev.fromNodeId !== msg.fromNodeId;

                return (
                  <div key={i}>
                    {senderChanged && <div className="msg-divider" />}
                    <div
                      className={
                        'msg' +
                        (isSos ? ' msg-sos' : isMe ? ' msg-me' : ' msg-other') +
                        (grouped ? ' msg-grouped' : '')
                      }
                    >
                      <div className="msg-bubble">
                        {!grouped && (
                          <div className="msg-head">
                            <span className={`msg-author ${isMe ? 'author-self' : ''}`}>
                              {isMe ? 'you' : msg.fromNodeId}
                            </span>
                            <span className="msg-meta">
                              {msg.hops === 0 ? 'direct' : `${msg.hops} hop${msg.hops > 1 ? 's' : ''}`}
                            </span>
                            {msg.timestamp && (
                              <span className="msg-time">{msg.timestamp}</span>
                            )}
                          </div>
                        )}
                        <div className="msg-body">
                          {isSos && <span className="sos-tag">SOS</span>}
                          <span>{msg.text}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* ── INPUT BAR ──────────────────────────────────────── */}
          <div className="input-bar">
            <input
              ref={inputRef}
              type="text"
              className="msg-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message…  ·  /sos for emergency"
              spellCheck={false}
              autoFocus
            />
            <button
              className={`send-btn ${justSent ? 'send-pop' : ''}`}
              onClick={handleSend}
              disabled={!input.trim() || !connected}
              title="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
            </button>
          </div>
        </main>
      </div>

      {/* ── Disconnected toast ───────────────────────────────────── */}
      {!connected && (
        <div className="disconnected-bar">
          <span className="disc-spinner" />
          Connecting to mesh node…
        </div>
      )}
    </div>
  );
}

export default App;
