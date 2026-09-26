/**
 * Plays the till's sounds with the Web Audio API: oscillators shaped by the
 * notes in tones.ts, through a limiter, so nothing clips at full volume.
 *
 * Built for a till that runs all day:
 *   - never throws and never blocks — no audio device, a broken driver or a
 *     missing AudioContext just means no sound (the banner still shows);
 *   - one AudioContext, made fresh after a quiet spell or when its clock has
 *     stopped: Windows can leave a long-lived context "running" on a speaker
 *     that went away (monitor asleep, USB speaker unplugged, sleep/resume),
 *     or "suspended" with a resume() that never settles;
 *   - on a paused clock only the newest sound waits: an hour of repeats
 *     never piles up into one blast when the speaker comes back;
 *   - `stop()` cuts a ringing chime at once (Seen / Esc);
 *   - every node is disconnected when its note ends, so an hour of repeats
 *     does not pile up audio nodes.
 *
 * Tests pass a fake context through `createContext` (audioEngine.test.ts).
 */
import { FADE_FLOOR, TONES, volumeToGain, type SoundId } from './tones';

export interface SoundPlayer {
  play(id: SoundId, volume: number): void;
  /** Silence everything playing now. */
  stop(): void;
}

/** The same sound again this soon is dropped (two events for one thing). */
export const SAME_SOUND_GAP_MS = 400;
/** After this long without a sound, start from a fresh AudioContext. */
export const STALE_CONTEXT_MS = 5 * 60_000;
/** Notes start this far ahead, so the first one is never cut. */
const START_DELAY_S = 0.03;

export interface WebAudioPlayerOptions {
  createContext?: () => AudioContext | null;
  now?: () => number;
  warn?: (message: string, detail?: unknown) => void;
}

function defaultContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  return AC ? new AC({ latencyHint: 'interactive' }) : null;
}

function quietly(fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      (r as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // audio is best-effort
  }
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

export function createWebAudioPlayer(opts: WebAudioPlayerOptions = {}): SoundPlayer {
  const createContext = opts.createContext ?? defaultContext;
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m: string, d?: unknown) => console.warn(m, d));

  let ctx: AudioContext | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let lastPlayWall = 0;
  let lastCheck: { wall: number; audio: number } | null = null;
  let warned = false;
  const lastById = new Map<SoundId, number>();
  const voices = new Set<Voice>();
  const playGains = new Set<GainNode>();

  function fail(message: string, e: unknown): void {
    if (warned) return;
    warned = true;
    warn(message, e);
  }

  function silenceAll(): void {
    for (const v of voices) {
      v.osc.onended = null;
      quietly(() => v.osc.stop());
      quietly(() => v.osc.disconnect());
      quietly(() => v.gain.disconnect());
    }
    voices.clear();
    for (const g of playGains) quietly(() => g.disconnect());
    playGains.clear();
  }

  function dropContext(): void {
    silenceAll();
    const old = ctx;
    ctx = null;
    limiter = null;
    lastCheck = null;
    if (old) quietly(() => old.close());
  }

  function ensureContext(): AudioContext | null {
    const wall = now();
    if (ctx) {
      const closed = ctx.state === 'closed';
      const idle = lastPlayWall > 0 && wall - lastPlayWall > STALE_CONTEXT_MS;
      // Its clock has not moved since the last sound, more than a second ago:
      // the output device went away. Whether it still says "running", or
      // "suspended"/"interrupted" after the resume() asked for last time,
      // it will not play — and a chime every 9 s keeps `idle` from ever
      // coming true, so this is what gets a working context back.
      const stuck = lastCheck !== null && wall - lastCheck.wall > 1_000 && ctx.currentTime === lastCheck.audio;
      if (closed || idle || stuck) dropContext();
    }
    if (!ctx) {
      const c = createContext();
      if (!c) return null;
      const lim = c.createDynamicsCompressor();
      // A limiter, not a compressor: only the loudest instants are held down.
      lim.threshold.value = -3;
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.002;
      lim.release.value = 0.1;
      lim.connect(c.destination);
      ctx = c;
      limiter = lim;
    }
    // Suspended (Windows audio session paused) or interrupted: ask it back.
    const c = ctx;
    if (c.state !== 'running') quietly(() => c.resume());
    lastCheck = { wall, audio: c.currentTime };
    return c;
  }

  return {
    play(id, volume) {
      try {
        const spec = TONES[id];
        if (!spec) return;
        const gainValue = volumeToGain(volume);
        if (gainValue <= 0) return;
        const wall = now();
        const last = lastById.get(id);
        if (last !== undefined && wall - last < SAME_SOUND_GAP_MS) return;
        const c = ensureContext();
        if (!c || !limiter) return;
        lastById.set(id, wall);
        lastPlayWall = wall;
        // A paused clock (resume asked for, not there yet): notes queued on it
        // all start together when it comes back. Keep only this one.
        if (c.state !== 'running') silenceAll();

        const t0 = c.currentTime + START_DELAY_S;
        const master = c.createGain();
        master.gain.value = gainValue;
        master.connect(limiter);
        playGains.add(master);
        let remaining = 0;

        for (const note of spec.notes) {
          const layers = [
            { ratio: 1, gain: 1, wave: note.wave },
            ...(note.partials ?? []).map((p) => ({ ratio: p.ratio, gain: p.gain, wave: 'sine' as const })),
          ];
          for (const layer of layers) {
            const osc = c.createOscillator();
            osc.type = layer.wave;
            osc.frequency.value = note.freq * layer.ratio;
            const g = c.createGain();
            const peak = note.peak * layer.gain;
            const start = t0 + note.at;
            const top = start + note.attack;
            const holdEnd = top + note.hold;
            const end = holdEnd + note.release;
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(peak, top);
            g.gain.setValueAtTime(peak, holdEnd);
            g.gain.exponentialRampToValueAtTime(Math.max(peak * FADE_FLOOR, 1e-5), end);
            osc.connect(g);
            g.connect(master);
            const voice: Voice = { osc, gain: g };
            voices.add(voice);
            remaining += 1;
            osc.onended = () => {
              voices.delete(voice);
              quietly(() => osc.disconnect());
              quietly(() => g.disconnect());
              remaining -= 1;
              if (remaining <= 0) {
                quietly(() => master.disconnect());
                playGains.delete(master);
              }
            };
            osc.start(start);
            osc.stop(end + 0.02);
          }
        }
      } catch (e) {
        fail('The till could not play a sound', e);
      }
    },

    stop() {
      try {
        silenceAll();
        lastById.clear();
      } catch (e) {
        fail('The till could not stop a sound', e);
      }
    },
  };
}

/** Plays nothing (tests, or a PC with no audio at all). */
export function createSilentPlayer(): SoundPlayer {
  return { play: () => undefined, stop: () => undefined };
}

let shared: SoundPlayer | null = null;

/** The one player the whole screen uses, made on first use. */
export function getSoundPlayer(): SoundPlayer {
  if (!shared) shared = createWebAudioPlayer();
  return shared;
}

/** Swap the shared player (tests). Null goes back to the real one. */
export function setSoundPlayerForTests(p: SoundPlayer | null): void {
  shared = p;
}
