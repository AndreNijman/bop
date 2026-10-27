// Client networking.
//
// One websocket, JSON frames, no dependencies. The relay owns the world; this
// layer just forwards intent at a fixed rate and hands decoded messages to the
// game. Reconnect is deliberately not automatic: a physics round cannot be
// rejoined halfway in any meaningful way, so a dropped socket returns you to
// the lobby screen with the reason on it.

import { NetPing } from './netping.js';

const RELAY_FALLBACK = 'https://bop-relay.tung-tung-tung-sahur.workers.dev';

export function relayBase() {
  const override = new URLSearchParams(location.search).get('relay');
  if (override) return override.replace(/\/$/, '');
  if (window.BOP_RELAY_URL) return String(window.BOP_RELAY_URL).replace(/\/$/, '');
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return location.origin;
  return RELAY_FALLBACK;
}

export function lobbyListUrl() {
  const base = relayBase();
  // Same-origin proxy when we are behind the games guard, so the session cookie
  // travels with the request. Falls back to the relay directly everywhere else.
  if (location.hostname === 'bop.andrenijman.com') return new URL('/_guard/bop-lobbies', location.origin).toString();
  return `${base.replace(/^ws/, 'http')}/lobbies`;
}

export function createNet(handlers) {
  let socket = null;
  let sendTimer = 0;
  let pinger = null;
  let pingTimer = 0;
  let latency = 0;
  let closedReason = '';

  function open(action, room, options = {}) {
    close();
    const base = relayBase().replace(/^http/, 'ws');
    const url = new URL(`${base}/ws`);
    url.searchParams.set('room', room);
    socket = new WebSocket(url.toString());
    pinger = new NetPing();
    pingTimer = 0;
    const guard = setTimeout(() => { if (socket && socket.readyState !== 1) socket.close(); }, 12000);
    socket.onopen = () => {
      clearTimeout(guard);
      send({
        t: action, room, name: options.name || 'bopl',
        password: options.password || '',
        settings: options.settings || {},
      });
      handlers.onOpen?.();
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'pong') { const rtt = pinger?.pong(message.c) ?? -1; if (rtt >= 0) latency = rtt; return; }
      handlers.onMessage?.(message);
    };
    socket.onclose = event => {
      clearTimeout(guard);
      socket = null;
      pinger?.stop();
      pinger = null;
      handlers.onClose?.(closedReason || event.reason || '');
      closedReason = '';
    };
    socket.onerror = () => { closedReason = closedReason || 'connection failed'; };
  }

  function send(message) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  function close() {
    if (!socket) return;
    const old = socket;
    socket = null;
    pinger?.stop();
    pinger = null;
    old.onclose = null;
    old.close();
  }

  // Called every animation frame; throttles to TUNE.inputHz internally. A
  // ping goes once a second with this client's ping and frame rate, for the
  // relay's lag log.
  function pump(dt, input, interval) {
    pingTimer -= dt;
    if (pingTimer <= 0 && pinger) {
      pingTimer = 1;
      send({ t: 'ping', ...pinger.next() });
    }
    sendTimer -= dt;
    if (sendTimer > 0) return;
    sendTimer = interval;
    send({ t: 'input', mx: input.mx, my: input.my, jump: input.jump, ax: input.ax, ay: input.ay, ab: input.ab });
  }

  return {
    open, send, close, pump,
    connected: () => !!socket && socket.readyState === 1,
    latency: () => latency,
  };
}

export async function fetchLobbies() {
  try {
    const response = await fetch(lobbyListUrl(), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.lobbies) ? data.lobbies : [];
  } catch { return []; }
}
