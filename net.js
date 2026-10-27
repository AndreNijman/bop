// Client networking.
//
// One websocket, JSON frames, no dependencies. The relay owns the world; this
// layer just forwards intent at a fixed rate and hands decoded messages to the
// game. Reconnect is deliberately not automatic: a physics round cannot be
// rejoined halfway in any meaningful way, so a dropped socket returns you to
// the lobby screen with the reason on it. The one exception is a room move
// ({t:'move'}, see worker.js): the relay hands over a ticket and the client
// reconnects to the room's new shard on its own.

import { NetPing } from './netping.js?v=20261027-1';
import { probeRegions, pingUrl } from './netprobe.js?v=20261027-1';

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
  let regions = null;
  let welcomed = false;
  let shard = '';

  // This player's ping to every region, for the relay's placement at match
  // start. Null off andrenijman.com, in which case nothing is sent.
  function sendRegions() {
    if (welcomed && regions) send({ t: 'regions', ms: regions });
  }

  function open(action, room, options = {}) {
    close();
    const base = relayBase().replace(/^http/, 'ws');
    const url = new URL(`${base}/ws`);
    url.searchParams.set('room', room);
    shard = options.shard || '';
    if (shard) url.searchParams.set('shard', shard);
    if (options.ticket) url.searchParams.set('ticket', options.ticket);
    const current = new WebSocket(url.toString());
    socket = current;
    welcomed = false;
    pinger = new NetPing();
    probeRegions().then(ms => { if (ms) { regions = ms; if (socket === current) sendRegions(); } });
    const guard = setTimeout(() => { if (socket && socket.readyState !== 1) socket.close(); }, 12000);
    socket.onopen = () => {
      clearTimeout(guard);
      send({
        t: action, room, name: options.name || 'bopl',
        password: options.password || '',
        settings: options.settings || {},
      });
      // Pings run from the lobby on, so the relay knows this player's ping
      // to the room before the match starts.
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (pinger) send({ t: 'ping', ...pinger.next() }); }, 1000);
      handlers.onOpen?.();
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'pong') {
        const rtt = pinger?.pong(message.c) ?? -1;
        if (rtt >= 0) { latency = rtt; handlers.onPong?.(rtt); }
        return;
      }
      if (message.t === 'move') {
        // Reconnect to the shard. A ticket takes back this player's seat; without
        // one (a late arrival) the client comes in as it did here.
        const shardRoom = String(message.shard || '');
        if (!shardRoom || shardRoom === shard) return;
        handlers.onMove?.(message);
        open(message.ticket ? 'join' : action, room, { ...options, shard: shardRoom, ticket: message.ticket || '' });
        return;
      }
      if (message.t === 'welcome') { welcomed = true; sendRegions(); }
      handlers.onMessage?.(message);
    };
    socket.onclose = event => {
      clearTimeout(guard);
      clearInterval(pingTimer);
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
    clearInterval(pingTimer);
    if (!socket) return;
    const old = socket;
    socket = null;
    pinger?.stop();
    pinger = null;
    old.onclose = null;
    old.close();
  }

  // Called every animation frame; throttles to TUNE.inputHz internally.
  // Pings (this client's ping and frame rate, for the relay's lag log and
  // placement) go once a second from their own timer.
  function pump(dt, input, interval) {
    sendTimer -= dt;
    if (sendTimer > 0) return;
    sendTimer = interval;
    send({ t: 'input', mx: input.mx, my: input.my, jump: input.jump, ax: input.ax, ay: input.ay, ab: input.ab });
  }

  return {
    open, send, close, pump,
    connected: () => !!socket && socket.readyState === 1,
    latency: () => latency,
    // The last measured round trip in ms, -1 before the first pong.
    rtt: () => pinger?.rtt ?? -1,
    get pinger() { return pinger; },
    shard: () => shard,
  };
}

// Where a room runs and this player's ms to it: { region, ms }, either null
// when unknown. Timed at most every 30 s per room (netprobe.js pingUrl).
const roomPings = new Map();
const ROOM_PING_MS = 30_000;

export function roomPing(room, shard = '') {
  const url = new URL(`${relayBase().replace(/^ws/, 'http')}/ping`);
  url.searchParams.set('room', room);
  if (shard) url.searchParams.set('shard', shard);
  const key = url.toString();
  const cached = roomPings.get(key);
  if (cached && Date.now() - cached.at < ROOM_PING_MS) return cached.result;
  const result = (async () => {
    try {
      const response = await fetch(key, { cache: 'no-store' });
      if (!response.ok) return { region: null, ms: null };
      const { region } = await response.json();
      return { region: region || null, ms: await pingUrl(key) };
    } catch { return { region: null, ms: null }; }
  })();
  roomPings.set(key, { at: Date.now(), result });
  return result;
}

export async function fetchLobbies() {
  try {
    const response = await fetch(lobbyListUrl(), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.lobbies) ? data.lobbies : [];
  } catch { return []; }
}
