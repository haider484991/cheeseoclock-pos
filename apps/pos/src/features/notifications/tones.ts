/**
 * The till's sounds, as notes the audio engine synthesises (Web Audio
 * oscillators — no sound files, nothing to license). Pure data plus the
 * envelope maths, so tones.test.ts can check every sound is well-formed,
 * never clips, and the alarm cannot be mistaken for a chime.
 *
 * Pitches sit in the 0.6–4 kHz range, where a small PC speaker is loudest
 * and a busy counter (fryer, extractor fan, traffic) masks least.
 */
import type { AlertSoundEvent, AlertSoundSettings, NewOrderTone } from '@cheeseoclock/shared-types';

export type SoundId =
  | 'newOrder:bell'
  | 'newOrder:rising'
  | 'newOrder:counterBell'
  | 'importFailed'
  | 'waiting'
  | 'printer'
  | 'lowStock';

export interface TonePartial {
  /** Frequency as a multiple of the note's. */
  ratio: number;
  /** Loudness relative to the note's own peak. */
  gain: number;
}

export interface ToneNote {
  /** Seconds from the start of the sound. */
  at: number;
  /** Hz. */
  freq: number;
  wave: 'sine' | 'triangle' | 'square';
  /** 0–1 before the volume setting. */
  peak: number;
  /** Seconds: straight rise from silence to the peak. */
  attack: number;
  /** Seconds at the peak. */
  hold: number;
  /** Seconds: exponential fall to FADE_FLOOR × peak (−60 dB). */
  release: number;
  /** Extra sine overtones that make a bell sound like a bell. */
  partials?: readonly TonePartial[];
}

export interface ToneSpec {
  label: string;
  notes: readonly ToneNote[];
}

/** Where a fading note ends: one thousandth of its peak (−60 dB). */
export const FADE_FLOOR = 0.001;

const BELL_PARTIALS: readonly TonePartial[] = [
  { ratio: 2, gain: 0.35 },
  { ratio: 3, gain: 0.12 },
];
const STRIKE_PARTIALS: readonly TonePartial[] = [{ ratio: 2.76, gain: 0.3 }];

function beep(at: number, freq: number, wave: ToneNote['wave'], peak: number, hold: number, release: number): ToneNote {
  return { at, freq, wave, peak, attack: 0.005, hold, release };
}

export const TONES: Readonly<Record<SoundId, ToneSpec>> = {
  // "Ding-dong": a door chime, two bell notes a major third apart.
  'newOrder:bell': {
    label: 'Ding-dong',
    notes: [
      { at: 0, freq: 1318.5, wave: 'sine', peak: 0.6, attack: 0.004, hold: 0.04, release: 1.6, partials: BELL_PARTIALS },
      { at: 0.45, freq: 1046.5, wave: 'sine', peak: 0.55, attack: 0.004, hold: 0.04, release: 1.9, partials: BELL_PARTIALS },
    ],
  },
  // Three notes going up, then a high one: bright and cheerful.
  'newOrder:rising': {
    label: 'Three notes',
    notes: [
      { at: 0, freq: 1046.5, wave: 'triangle', peak: 0.55, attack: 0.004, hold: 0.07, release: 0.45 },
      { at: 0.14, freq: 1318.5, wave: 'triangle', peak: 0.55, attack: 0.004, hold: 0.07, release: 0.45 },
      { at: 0.28, freq: 1568, wave: 'triangle', peak: 0.55, attack: 0.004, hold: 0.07, release: 0.45 },
      { at: 0.42, freq: 2093, wave: 'triangle', peak: 0.5, attack: 0.004, hold: 0.1, release: 0.9 },
    ],
  },
  // Two taps on a counter bell (the "ding! ding!" of a service bell).
  'newOrder:counterBell': {
    label: 'Counter bell',
    notes: [
      { at: 0, freq: 1760, wave: 'sine', peak: 0.6, attack: 0.002, hold: 0.02, release: 1.3, partials: STRIKE_PARTIALS },
      { at: 0.32, freq: 1760, wave: 'sine', peak: 0.6, attack: 0.002, hold: 0.02, release: 1.3, partials: STRIKE_PARTIALS },
    ],
  },
  // Urgent: a two-tone square-wave alarm, nothing like the chimes. A square
  // wave is loud for its peak (all of its energy sits at full height, plus
  // bright overtones), so 0.45 here is as loud as the chimes, with headroom.
  importFailed: {
    label: 'Alarm',
    notes: [0, 1, 2, 3, 4, 5].map((i) => beep(i * 0.18, i % 2 === 0 ? 987.8 : 740, 'square', 0.45, 0.13, 0.025)),
  },
  // A soft double tap: "someone is still waiting".
  waiting: {
    label: 'Soft reminder',
    notes: [beep(0, 784, 'sine', 0.6, 0.1, 0.2), beep(0.3, 784, 'sine', 0.6, 0.1, 0.2)],
  },
  // Problem: two notes going down.
  printer: {
    label: 'Printer problem',
    notes: [beep(0, 784, 'triangle', 0.6, 0.12, 0.1), beep(0.22, 587.3, 'triangle', 0.6, 0.12, 0.1)],
  },
  // Information: two notes going up, quieter.
  lowStock: {
    label: 'Running low',
    notes: [beep(0, 880, 'sine', 0.55, 0.1, 0.15), beep(0.2, 1174.7, 'sine', 0.55, 0.1, 0.15)],
  },
};

export const SOUND_IDS = Object.keys(TONES) as SoundId[];

export const NEW_ORDER_TONE_LABELS: Readonly<Record<NewOrderTone, string>> = {
  bell: TONES['newOrder:bell'].label,
  rising: TONES['newOrder:rising'].label,
  counterBell: TONES['newOrder:counterBell'].label,
};

/** When a note has faded out, in seconds from the start of the sound. */
export function noteEnd(n: ToneNote): number {
  return n.at + n.attack + n.hold + n.release;
}

/** Length of a whole sound, in seconds. */
export function toneLength(spec: ToneSpec): number {
  return spec.notes.reduce((m, n) => Math.max(m, noteEnd(n)), 0);
}

/** A note's loudness at time `t` (seconds from the start of the sound), before overtones. */
export function envelopeAt(n: ToneNote, t: number): number {
  const dt = t - n.at;
  if (dt < 0 || t >= noteEnd(n)) return 0;
  if (dt < n.attack) return n.attack > 0 ? (n.peak * dt) / n.attack : n.peak;
  if (dt < n.attack + n.hold) return n.peak;
  const r = (dt - n.attack - n.hold) / n.release;
  return n.peak * Math.pow(FADE_FLOOR, r);
}

/** Worst case (every oscillator in phase) of all notes and overtones together at time `t`. */
export function peakSumAt(spec: ToneSpec, t: number): number {
  let sum = 0;
  for (const n of spec.notes) {
    const overtones = (n.partials ?? []).reduce((s, p) => s + p.gain, 0);
    sum += envelopeAt(n, t) * (1 + overtones);
  }
  return sum;
}

/** The loudest instant of a sound (worst case), sampled every millisecond. */
export function maxPeakSum(spec: ToneSpec, stepS = 0.001): number {
  let max = 0;
  const end = toneLength(spec);
  for (let t = 0; t <= end; t += stepS) max = Math.max(max, peakSumAt(spec, t));
  return max;
}

/** The sound this till makes for an event. */
export function soundForEvent(event: AlertSoundEvent, settings: Pick<AlertSoundSettings, 'newOrderTone'>): SoundId {
  switch (event) {
    case 'newOnlineOrder':
      return `newOrder:${settings.newOrderTone}`;
    case 'importFailed':
      return 'importFailed';
    case 'waitingTooLong':
      return 'waiting';
    case 'printerProblem':
      return 'printer';
    case 'lowStock':
      return 'lowStock';
  }
}

/**
 * The volume slider (0–100) → a gain. Squared, because loudness is heard on
 * a curve: 50% on the slider then sounds about half as loud, not nearly full.
 */
export function volumeToGain(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const v = Math.min(100, volume) / 100;
  return v * v;
}
