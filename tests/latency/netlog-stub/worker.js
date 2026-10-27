// Stand-in for games-guard's NetLog entrypoint in the local latency test.
// Run as its own `wrangler dev`; the relay's NETLOG binding reaches it through
// wrangler's local dev registry. GET / returns every record it was sent.

import { WorkerEntrypoint } from 'cloudflare:workers';

const records = [];

export class NetLog extends WorkerEntrypoint {
  async record(game, record) {
    records.push({ game, record });
    return { ok: true };
  }
}

export default {
  fetch() { return Response.json(records); },
};
