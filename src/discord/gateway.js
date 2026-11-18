// Minimal Discord gateway client: connects to the gateway websocket,
// identifies with the bot token, heartbeats, resumes after reconnects, and
// forwards INTERACTION_CREATE dispatches to the interaction handler.
// No library needed — Node >= 22 has a built-in WebSocket client.

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function startGateway({
  token,
  intents = 0,
  onInteraction,
  url = 'wss://gateway.discord.gg/?v=10&encoding=json',
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  minReconnectDelayMs = 1000,
  maxReconnectDelayMs = 30000,
}) {
  let ws = null;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let heartbeatTimer = null;
  let firstHeartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = minReconnectDelayMs;
  let ackReceived = true;
  let stopped = false;

  function send(payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function heartbeat() {
    if (!ackReceived) {
      logger.warn('[gateway] heartbeat ACK missing, reconnecting');
      ws?.close(4000);
      return;
    }
    ackReceived = false;
    send({ op: 3, d: seq });
  }

  function startHeartbeat(intervalMs) {
    clearTimeout(firstHeartbeatTimer);
    clearInterval(heartbeatTimer);
    firstHeartbeatTimer = setTimeout(() => {
      heartbeat();
      heartbeatTimer = setInterval(heartbeat, intervalMs);
    }, intervalMs * Math.random());
  }

  function identifyOrResume() {
    if (sessionId && resumeUrl) {
      send({ op: 6, d: { token, session_id: sessionId, seq } });
    } else {
      send({
        op: 2,
        d: {
          token,
          intents,
          properties: { os: 'linux', browser: 'archipelago-discord-bridge', device: 'archipelago-discord-bridge' },
          compress: false,
        },
      });
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelayMs);
  }

  function connect() {
    if (stopped) return;
    const target = sessionId && resumeUrl ? resumeUrl : url;
    logger.info(`[gateway] connecting to ${target}${sessionId ? ' (resume)' : ''}`);
    ws = new WebSocketImpl(target);
    ws.onopen = () => {
      reconnectDelay = minReconnectDelayMs;
      ackReceived = true; // fresh connection: don't inherit a stale missing-ACK state
    };
    ws.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch {
        return;
      }
      const { op, d, t, s } = payload;
      if (op === 0) {
        if (s !== null && s !== undefined) seq = s;
        if (t === 'READY') {
          sessionId = d.session_id;
          resumeUrl = d.resume_gateway_url;
          logger.info(`[gateway] ready (session ${sessionId})`);
        } else if (t === 'RESUMED') {
          logger.info('[gateway] resumed');
        } else if (t === 'INTERACTION_CREATE') {
          Promise.resolve(onInteraction(d)).catch((err) => logger.error('[gateway] interaction handler failed:', err));
        }
      } else if (op === 1) {
        heartbeat();
      } else if (op === 7) {
        logger.info('[gateway] reconnect requested by server');
        ws?.close(4000);
      } else if (op === 9) {
        if (!d && sessionId) sessionId = null;
        ws?.close(4000);
      } else if (op === 10) {
        ackReceived = true;
        startHeartbeat(d.heartbeat_interval);
        identifyOrResume();
      } else if (op === 11) {
        ackReceived = true;
      }
    };
    ws.onclose = (event) => {
      clearInterval(heartbeatTimer);
      clearTimeout(firstHeartbeatTimer);
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        logger.error(`[gateway] fatal close ${event.code} (${event.reason || 'no reason'}) — not reconnecting. Check the bot token / bot user.`);
        return;
      }
      logger.warn(`[gateway] closed (${event.code}), reconnecting`);
      scheduleReconnect();
    };
    ws.onerror = (err) => {
      logger.error('[gateway] websocket error:', err?.message || err);
    };
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      clearTimeout(firstHeartbeatTimer);
      clearTimeout(reconnectTimer);
      try { ws?.close(1000); } catch { /* ignore */ }
    },
  };
}
