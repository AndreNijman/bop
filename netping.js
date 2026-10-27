// netping.js v1 (canonical copy: games-site shared/net/).
//
// Client half of the lag log: measures this player's round trip to the relay
// and their frame rate, and reports both about once a second. The relay
// answers each ping with a pong carrying the same `c`, and keeps the reports
// in its NetStats (netstats.js). Shared, unchanged, by every game client.

export class NetPing {
  constructor() {
    this.rtt = -1;
    this.sentAt = new Map();
    this.frames = 0;
    this.frameMax = 0;
    this.lastFrame = 0;
    this.windowStart = performance.now();
    this.raf = 0;
    const frame = (now) => {
      if (this.lastFrame && !document.hidden) this.frameMax = Math.max(this.frameMax, now - this.lastFrame);
      this.lastFrame = now;
      this.frames++;
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** The next ping's fields: `c` to echo back, plus the last round trip and frame stats since the last ping. */
  next() {
    const now = performance.now();
    const c = Math.round(now);
    this.sentAt.set(c, now);
    if (this.sentAt.size > 20) this.sentAt.delete(this.sentAt.keys().next().value);
    const span = now - this.windowStart;
    // A hidden tab draws nothing; its frame rate says nothing about lag.
    const fps = !document.hidden && span > 200 ? Math.round((this.frames * 10000) / span) / 10 : undefined;
    const frameMax = fps ? Math.round(this.frameMax) : undefined;
    this.frames = 0;
    this.frameMax = 0;
    this.windowStart = now;
    return { c, rtt: this.rtt >= 0 ? this.rtt : undefined, fps, frameMax };
  }

  /** A pong arrived carrying `c`; returns the round trip in ms, or -1 if `c` is not ours. */
  pong(c) {
    const at = this.sentAt.get(c);
    if (at === undefined) return -1;
    this.sentAt.delete(c);
    this.rtt = Math.round(performance.now() - at);
    return this.rtt;
  }

  stop() { cancelAnimationFrame(this.raf); }
}
