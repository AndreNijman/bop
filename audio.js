// Sound. Everything is synthesised in WebAudio at runtime, so the game ships
// with no audio files and starts instantly.
//
// One shared master gain lets the mute toggle be a single ramp, and every voice
// is disposable: create oscillator, schedule an envelope, forget about it.

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let lastAt = new Map();

  function ensure() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
    return ctx;
  }

  function resume() { const c = ensure(); if (c && c.state === 'suspended') c.resume(); }

  // Rate limiter: a chain explosion should not stack forty identical clicks.
  function allow(key, gap) {
    const now = ctx ? ctx.currentTime : 0;
    if ((lastAt.get(key) || -1) + gap > now) return false;
    lastAt.set(key, now);
    return true;
  }

  function tone({ type = 'sine', from, to, time = 0.18, gain = 0.3, delay = 0, curve = 'exp', pan = 0 }) {
    const c = ensure();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to && to !== from) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + time);
      else osc.frequency.linearRampToValueAtTime(Math.max(1, to), t0 + time);
    }
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, time * 0.2));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + time);
    let node = amp;
    if (pan && c.createStereoPanner) {
      const panner = c.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      amp.connect(panner);
      node = panner;
    }
    osc.connect(amp);
    node.connect(master);
    osc.start(t0);
    osc.stop(t0 + time + 0.02);
  }

  function noise({ time = 0.25, gain = 0.3, from = 1800, to = 200, q = 1, delay = 0, type = 'lowpass' }) {
    const c = ensure();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const frames = Math.max(1, Math.floor(c.sampleRate * time));
    const buffer = c.createBuffer(1, frames, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + time);
    const amp = c.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + time);
    src.connect(filter); filter.connect(amp); amp.connect(master);
    src.start(t0);
  }

  const play = {
    jump: () => allow('jump', 0.05) && tone({ type: 'triangle', from: 300, to: 620, time: 0.11, gain: 0.16 }),
    land: () => allow('land', 0.08) && noise({ time: 0.1, gain: 0.12, from: 700, to: 120 }),
    blast: () => {
      if (!allow('blast', 0.05)) return;
      noise({ time: 0.5, gain: 0.45, from: 2200, to: 60 });
      tone({ type: 'sine', from: 160, to: 32, time: 0.45, gain: 0.4 });
    },
    flame: () => allow('flame', 0.04) && noise({ time: 0.35, gain: 0.3, from: 1400, to: 180 }),
    pop: () => {
      if (!allow('pop', 0.03)) return;
      tone({ type: 'square', from: 720, to: 90, time: 0.16, gain: 0.26 });
      noise({ time: 0.22, gain: 0.24, from: 2600, to: 300 });
    },
    throwSound: () => allow('throw', 0.05) && noise({ time: 0.14, gain: 0.13, from: 900, to: 2200, type: 'highpass' }),
    bow: () => allow('bow', 0.05) && tone({ type: 'sawtooth', from: 880, to: 220, time: 0.14, gain: 0.14 }),
    thud: () => allow('thud', 0.04) && noise({ time: 0.09, gain: 0.16, from: 480, to: 90 }),
    dash: () => allow('dash', 0.06) && noise({ time: 0.2, gain: 0.2, from: 400, to: 2600, type: 'highpass' }),
    gust: () => allow('gust', 0.06) && noise({ time: 0.32, gain: 0.26, from: 600, to: 2800, type: 'bandpass', q: 0.8 }),
    hook: () => allow('hook', 0.06) && tone({ type: 'square', from: 240, to: 520, time: 0.08, gain: 0.14 }),
    ray: () => allow('ray', 0.05) && tone({ type: 'sawtooth', from: 1400, to: 420, time: 0.16, gain: 0.12 }),
    beam: () => allow('beam', 0.18) && tone({ type: 'sawtooth', from: 180, to: 200, time: 0.22, gain: 0.09 }),
    rock: () => allow('rock', 0.1) && tone({ type: 'square', from: 90, to: 60, time: 0.3, gain: 0.2 }),
    roll: () => allow('roll', 0.1) && tone({ type: 'sawtooth', from: 120, to: 340, time: 0.35, gain: 0.16 }),
    meteor: () => allow('meteor', 0.1) && tone({ type: 'sawtooth', from: 700, to: 90, time: 0.45, gain: 0.2 }),
    slam: () => { if (!allow('slam', 0.08)) return; noise({ time: 0.4, gain: 0.4, from: 1200, to: 50 }); tone({ type: 'sine', from: 120, to: 30, time: 0.4, gain: 0.35 }); },
    prime: () => allow('prime', 0.1) && tone({ type: 'square', from: 1200, to: 1200, time: 0.05, gain: 0.1 }),
    coil: () => allow('coil', 0.1) && tone({ type: 'square', from: 400, to: 900, time: 0.12, gain: 0.12 }),
    tesla: () => allow('tesla', 0.1) && noise({ time: 0.2, gain: 0.2, from: 3000, to: 900, type: 'bandpass', q: 3 }),
    spike: () => allow('spike', 0.1) && tone({ type: 'sawtooth', from: 200, to: 1100, time: 0.16, gain: 0.16 }),
    hole: () => allow('hole', 0.1) && tone({ type: 'sine', from: 60, to: 240, time: 0.6, gain: 0.22 }),
    feed: () => allow('feed', 0.05) && tone({ type: 'sine', from: 500, to: 140, time: 0.1, gain: 0.08 }),
    collapse: () => allow('collapse', 0.1) && tone({ type: 'sine', from: 240, to: 40, time: 0.5, gain: 0.2 }),
    blink: () => allow('blink', 0.05) && tone({ type: 'triangle', from: 1500, to: 300, time: 0.1, gain: 0.13 }),
    dup: () => allow('dup', 0.08) && tone({ type: 'triangle', from: 400, to: 800, time: 0.14, gain: 0.13 }),
    warp: () => { if (!allow('warp', 0.08)) return; tone({ type: 'sine', from: 220, to: 1300, time: 0.2, gain: 0.16 }); },
    bubble: () => allow('bubble', 0.1) && tone({ type: 'sine', from: 900, to: 1500, time: 0.12, gain: 0.1 }),
    orb: () => allow('orb', 0.1) && tone({ type: 'sine', from: 600, to: 900, time: 0.22, gain: 0.12 }),
    revive: () => { tone({ type: 'sine', from: 400, to: 900, time: 0.25, gain: 0.2 }); tone({ type: 'sine', from: 600, to: 1200, time: 0.3, gain: 0.14, delay: 0.08 }); },
    eat: () => { if (!allow('eat', 0.1)) return; tone({ type: 'square', from: 200, to: 90, time: 0.18, gain: 0.2 }); noise({ time: 0.2, gain: 0.2, from: 900, to: 200 }); },
    resize: () => allow('resize', 0.05) && tone({ type: 'triangle', from: 700, to: 1100, time: 0.09, gain: 0.09 }),
    engine: () => allow('engine', 0.15) && noise({ time: 0.5, gain: 0.18, from: 300, to: 900, type: 'bandpass', q: 1.2 }),
    smoke: () => allow('smoke', 0.1) && noise({ time: 0.4, gain: 0.2, from: 900, to: 200 }),
    quarry: () => allow('quarry', 0.1) && noise({ time: 0.2, gain: 0.2, from: 700, to: 150 }),
    fling: () => allow('fling', 0.08) && noise({ time: 0.16, gain: 0.16, from: 500, to: 1800, type: 'highpass' }),
    grab: () => allow('grab', 0.1) && tone({ type: 'square', from: 300, to: 620, time: 0.1, gain: 0.11 }),
    freeze: () => { tone({ type: 'sine', from: 900, to: 120, time: 0.7, gain: 0.24 }); noise({ time: 0.5, gain: 0.14, from: 3000, to: 400, type: 'bandpass', q: 2 }); },
    thaw: () => tone({ type: 'sine', from: 140, to: 800, time: 0.4, gain: 0.18 }),
    go: () => { tone({ type: 'square', from: 660, to: 660, time: 0.1, gain: 0.24 }); tone({ type: 'square', from: 990, to: 990, time: 0.16, gain: 0.2, delay: 0.1 }); },
    count: () => tone({ type: 'square', from: 440, to: 440, time: 0.09, gain: 0.18 }),
    sudden: () => { for (let i = 0; i < 3; i++) tone({ type: 'sawtooth', from: 300, to: 140, time: 0.3, gain: 0.2, delay: i * 0.18 }); },
    round: () => { [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, to: f, time: 0.22, gain: 0.2, delay: i * 0.09 })); },
    win: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ type: 'triangle', from: f, to: f, time: 0.3, gain: 0.22, delay: i * 0.12 })); },
    lose: () => { [400, 340, 270, 190].forEach((f, i) => tone({ type: 'sawtooth', from: f, to: f * 0.9, time: 0.28, gain: 0.18, delay: i * 0.13 })); },
    ui: () => allow('ui', 0.03) && tone({ type: 'square', from: 620, to: 780, time: 0.05, gain: 0.09 }),
    pick: () => { tone({ type: 'triangle', from: 700, to: 1050, time: 0.12, gain: 0.16 }); },
  };

  const EVENT_SOUND = {
    blast: 'blast', flame: 'flame', pop: 'pop', jump: 'jump', dash: 'dash', gust: 'gust',
    throw: 'throwSound', bow: 'bow', thud: 'thud', hook: 'hook', ray: 'ray', rock: 'rock',
    roll: 'roll', meteor: 'meteor', slam: 'slam', prime: 'prime', coil: 'coil', spike: 'spike',
    hole: 'hole', feed: 'feed', collapse: 'collapse', blink: 'blink', dup: 'dup', warp: 'warp',
    bubble: 'bubble', orb: 'orb', revive: 'revive', eat: 'eat', resize: 'resize', engine: 'engine',
    smoke: 'smoke', quarry: 'quarry', fling: 'fling', grab: 'grab', freeze: 'freeze', thaw: 'thaw',
    go: 'go', sudden: 'sudden', round: 'round',
  };

  return {
    resume,
    play,
    feed(events) {
      for (const e of events) {
        const name = EVENT_SOUND[e.e];
        if (name && play[name]) play[name]();
      }
    },
    setMuted(value) {
      muted = value;
      if (master) master.gain.value = muted ? 0 : 0.55;
      return muted;
    },
    isMuted: () => muted,
  };
}
