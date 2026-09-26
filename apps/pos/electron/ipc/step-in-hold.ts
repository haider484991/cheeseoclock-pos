import { STEP_IN_HELD, type ApiError } from '@cheeseoclock/shared-types';
import { getHeldStepIn } from '../services/auth-service.js';

/** Channels whose "not logged in" is about the secret typed, never a held login. */
const SIGN_IN_CHANNELS: ReadonlySet<string> = new Set(['auth:login', 'auth:keepStepIn']);

/**
 * A stepping-in login that is held (auth-service STEP_IN_MAX_MS) is "not
 * logged in" to every guard. Say so on the answer (`details.stepIn`), so the
 * screen asks for that person's PIN over the page it is on, instead of
 * dropping to the PIN pad and losing what was being typed there. Applied to
 * every channel by defineHandler (registry.ts).
 */
export function markHeldStepIn<R>(channel: string, answer: R): R {
  const a = answer as { ok?: boolean; error?: ApiError } | null | undefined;
  if (!a || a.ok !== false || a.error?.code !== 'unauthenticated' || SIGN_IN_CHANNELS.has(channel)) return answer;
  if (!getHeldStepIn()) return answer;
  return { ...a, error: { ...a.error, details: { ...a.error.details, stepIn: STEP_IN_HELD } } } as R;
}
