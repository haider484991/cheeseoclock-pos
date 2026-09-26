import { describe, expect, it, vi } from 'vitest';
import { SAME_SOUND_GAP_MS, STALE_CONTEXT_MS, createSilentPlayer, createWebAudioPlayer } from './audioEngine';
import { TONES, type SoundId } from './tones';

/** Just enough of Web Audio to see what the engine asks for. */
class FakeParam {
  value = 0;
  events: Array<[string, number, number]> = [];
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['linear', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (!(v > 0)) throw new RangeError('exponential ramp needs a positive value');
    this.events.push(['exp', v, t]);
  }
}

class FakeNode {
  connected: unknown[] = [];
  disconnected = 0;
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {
    this.disconnected += 1;
  }
}

class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  started: number | null = null;
  stoppedAt: number | null = null;
  stopCalls = 0;
  onended: (() => void) | null = null;
  start(t: number) {
    this.started = t;
  }
  stop(t?: number) {
    this.stopCalls += 1;
    this.stoppedAt = t ?? 0;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeLimiter extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  /** False: a speaker that went away — resume() never settles and the state stays. */
  resumeWorks = true;
  currentTime = 0;
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  resumes = 0;
  closes = 0;
  createOscillator() {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    return new FakeLimiter();
  }
  resume() {
    this.resumes += 1;
    if (!this.resumeWorks) return new Promise<void>(() => undefined);
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.closes += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

function voicesIn(id: SoundId): number {
  return TONES[id].notes.reduce((n, note) => n + 1 + (note.partials?.length ?? 0), 0);
}

function setup(opts: { state?: FakeContext['state']; resumeWorks?: boolean } = {}) {
  let wall = 1_000_000;
  const contexts: FakeContext[] = [];
  const player = createWebAudioPlayer({
    createContext: () => {
      const c = new FakeContext();
      if (opts.state) c.state = opts.state;
      if (opts.resumeWorks === false) c.resumeWorks = false;
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    now: () => wall,
    warn: () => undefined,
  });
  return {
    player,
    contexts,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

describe('createWebAudioPlayer', () => {
  it('plays one oscillator per note and overtone, each shaped and scheduled', () => {
    const { player, contexts } = setup();
    player.play('newOrder:bell', 80);
    const ctx = contexts[0]!;
    expect(ctx.oscillators).toHaveLength(voicesIn('newOrder:bell'));
    for (const o of ctx.oscillators) {
      expect(o.started).not.toBeNull();
      expect(o.stoppedAt!).toBeGreaterThan(o.started!);
    }
    // The play's own volume: 80% → 0.64.
    expect(ctx.gains.some((g) => Math.abs(g.gain.value - 0.64) < 1e-9)).toBe(true);
  });

  it('asks a suspended context to resume', () => {
    const { player, contexts } = setup({ state: 'suspended' });
    player.play('waiting', 80);
    expect(contexts[0]!.resumes).toBe(1);
  });

  it('stop() silences everything at once', () => {
    const { player, contexts } = setup();
    player.play('importFailed', 80);
    player.play('printer', 80);
    const oscs = contexts[0]!.oscillators;
    player.stop();
    expect(oscs.every((o) => o.stopCalls === 2 && o.disconnected >= 1)).toBe(true);
  });

  it('drops the same sound again within 400 ms, not a different one', () => {
    const { player, contexts, advance } = setup();
    player.play('lowStock', 80);
    player.play('lowStock', 80);
    player.play('printer', 80);
    expect(contexts[0]!.oscillators).toHaveLength(voicesIn('lowStock') + voicesIn('printer'));
    advance(SAME_SOUND_GAP_MS);
    player.play('lowStock', 80);
    expect(contexts[0]!.oscillators).toHaveLength(2 * voicesIn('lowStock') + voicesIn('printer'));
  });

  it('volume 0 plays nothing (and makes no context)', () => {
    const { player, contexts } = setup();
    player.play('newOrder:rising', 0);
    expect(contexts).toHaveLength(0);
  });

  it('disconnects each note when it ends, so an hour of repeats does not pile up', () => {
    const { player, contexts } = setup();
    player.play('waiting', 80);
    const ctx = contexts[0]!;
    for (const o of ctx.oscillators) o.onended?.();
    expect(ctx.oscillators.every((o) => o.disconnected === 1)).toBe(true);
    // Every note's gain and the play's own gain are let go too.
    expect(ctx.gains.every((g) => g.disconnected === 1)).toBe(true);
  });

  it('starts a fresh context after a quiet spell (a speaker that went away)', () => {
    const { player, contexts, advance } = setup();
    player.play('waiting', 80);
    advance(STALE_CONTEXT_MS + 1);
    player.play('waiting', 80);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.closes).toBe(1);
  });

  it('starts a fresh context when the audio clock has stopped', () => {
    const { player, contexts, advance } = setup();
    player.play('waiting', 80);
    advance(5_000); // currentTime never moves in the fake: a dead output device
    player.play('printer', 80);
    expect(contexts).toHaveLength(2);
  });

  it('replaces a context stuck in "suspended" while the chime keeps ringing (resume never comes back)', () => {
    const { player, contexts, advance } = setup({ state: 'suspended', resumeWorks: false });
    player.play('newOrder:bell', 80);
    advance(9_000); // the next repeat: too soon for the 5-minute quiet-spell rule
    player.play('newOrder:bell', 80);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.closes).toBe(1);
    advance(9_000);
    player.play('newOrder:bell', 80);
    expect(contexts).toHaveLength(3);
  });

  it('on a paused clock only the newest sound waits — no pile-up that blasts out when the speaker comes back', () => {
    const { player, contexts, advance } = setup({ state: 'suspended', resumeWorks: false });
    player.play('newOrder:bell', 80);
    advance(SAME_SOUND_GAP_MS); // under a second: the same context
    player.play('newOrder:bell', 80);
    expect(contexts).toHaveLength(1);
    const oscs = contexts[0]!.oscillators;
    const n = voicesIn('newOrder:bell');
    expect(oscs).toHaveLength(2 * n);
    // The first one's notes were stopped; only the second is still queued.
    expect(oscs.slice(0, n).every((o) => o.stopCalls === 2)).toBe(true);
    expect(oscs.slice(n).every((o) => o.stopCalls === 1)).toBe(true);
  });

  it('keeps one context while the clock runs', () => {
    const { player, contexts, advance } = setup();
    player.play('waiting', 80);
    contexts[0]!.currentTime = 5;
    advance(5_000);
    player.play('printer', 80);
    expect(contexts).toHaveLength(1);
  });

  it('a closed context is replaced', () => {
    const { player, contexts } = setup();
    player.play('waiting', 80);
    contexts[0]!.state = 'closed';
    player.play('printer', 80);
    expect(contexts).toHaveLength(2);
  });

  it('never throws: no audio at all, or a context that breaks', () => {
    const none = createWebAudioPlayer({ createContext: () => null, warn: () => undefined });
    expect(() => none.play('newOrder:bell', 80)).not.toThrow();
    expect(() => none.stop()).not.toThrow();

    const warn = vi.fn();
    const throwing = createWebAudioPlayer({
      createContext: () => {
        throw new Error('no audio device');
      },
      warn,
    });
    expect(() => throwing.play('newOrder:bell', 80)).not.toThrow();
    expect(() => throwing.play('importFailed', 80)).not.toThrow();
    expect(() => throwing.stop()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unknown sound is ignored', () => {
    const { player, contexts } = setup();
    expect(() => player.play('siren' as SoundId, 80)).not.toThrow();
    expect(contexts).toHaveLength(0);
  });
});

describe('createSilentPlayer', () => {
  it('does nothing, safely', () => {
    const p = createSilentPlayer();
    expect(() => p.play('newOrder:bell', 100)).not.toThrow();
    expect(() => p.stop()).not.toThrow();
  });
});
