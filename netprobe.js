// netprobe.js v1 (canonical copy: games-site shared/net/).
//
// Client half of room placement: this player's ping to every Cloudflare
// region, timed against games-guard's probes (/_guard/probe/<region>, one
// Durable Object per region) and kept for the browser session. The client
// sends the results to its relay, which uses them to move a mixed group's
// room somewhere fairer (netplace.js). pingUrl() times one room directly, for
// the lobby list. Shared, unchanged, by every game client.

export const REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];

export const REGION_NAMES = {
  wnam: 'US West', enam: 'US East', sam: 'South America', weur: 'Western Europe', eeur: 'Eastern Europe',
  apac: 'Asia', oc: 'Oceania', afr: 'Africa', me: 'Middle East',
};

const KEY = 'games.netprobe.v1';
const MAX_AGE = 10 * 60 * 1000;
let pending = null;

// The probes live on every game host games-guard serves; elsewhere (local
// dev, file://, a mirror) there is nothing to time.
function defaultBase() {
  return typeof location !== 'undefined' && location.protocol === 'https:' && /(^|\.)andrenijman\.com$/.test(location.hostname)
    ? '/_guard/probe/' : '';
}

function read() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return saved && Date.now() - saved.at < MAX_AGE ? saved.ms : null;
  } catch { return null; }
}

function write(ms) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ms })); } catch { /* private mode */ }
}

/**
 * Round trip to `url` in ms (e.g. a relay's room ping endpoint), or null if
 * it can't be reached. Three requests; the first wakes the Durable Object and
 * warms the connection, the faster of the other two counts.
 */
export async function pingUrl(url) {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const start = performance.now();
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      await response.arrayBuffer();
      if (!response.ok) return null;
    } catch {
      return best;
    } finally {
      clearTimeout(timer);
    }
    const ms = performance.now() - start;
    if (i > 0) best = best === null ? ms : Math.min(best, ms);
  }
  return best === null ? null : Math.max(1, Math.round(best));
}

/**
 * This player's ping to each region in ms, e.g. { weur: 38, apac: 290 }, or
 * null where probing is unavailable. Cached for the session; concurrent
 * callers share one run (about a second, all regions at once).
 */
export function probeRegions(base = defaultBase()) {
  if (!base) return Promise.resolve(null);
  const cached = read();
  if (cached) return Promise.resolve(cached);
  pending ||= Promise.all(REGIONS.map(async (region) => [region, await pingUrl(base + region)]))
    .then((results) => {
      const ms = Object.fromEntries(results.filter(([, t]) => t !== null));
      if (!Object.keys(ms).length) return null;
      write(ms);
      return ms;
    })
    .catch(() => null)
    .finally(() => { pending = null; });
  return pending;
}

/** "Asia · 120 ms" for a room in `region` with a measured ping; just the region name without one. */
export function regionLabel(region, ms) {
  const name = REGION_NAMES[region] || region || '';
  return ms > 0 ? `${name} · ${Math.round(ms)} ms` : name;
}
