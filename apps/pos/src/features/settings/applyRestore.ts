import { ipc, IpcError } from '../../ipc/client';
import { askConfirm } from '../../components/confirm/ConfirmHost';

/**
 * Drop a staged copy the owner did not go ahead with. The main process also
 * throws away an unconfirmed copy at the next start, so a failure here is
 * harmless.
 */
export async function cancelStagedRestore(): Promise<void> {
  try {
    await ipc.backup.cancelStagedRestore();
  } catch {
    // discarded at the next start anyway
  }
}

/**
 * Apply a staged restore. The till uploads a cloud safety copy of today's data
 * first; if that fails it refuses, and the owner decides here whether to go on
 * without one (the data is still archived on this PC either way).
 *
 * Returns true when the app is restarting onto the copy, false when the owner
 * backed out. Whenever it does not restart, the staged copy is dropped so it
 * can never replace the data later on its own.
 */
export async function applyRestore(): Promise<boolean> {
  try {
    await ipc.backup.applyAndRelaunch();
    return true;
  } catch (e) {
    if (e instanceof IpcError && e.details?.['safetyCopyFailed']) {
      const reason = String(e.details['reason'] ?? 'unknown error');
      const ok = await askConfirm(
        'Restore without an online safety copy?\n' +
          `Today's data could not be copied online first (${reason}).\n\n` +
          'It is still saved on this computer before the restore (a before-restore copy), ' +
          'but there will be no copy of it online.',
      );
      if (!ok) {
        await cancelStagedRestore();
        return false;
      }
      try {
        await ipc.backup.applyAndRelaunch({ withoutSafetyCopy: true });
        return true;
      } catch (e2) {
        await cancelStagedRestore();
        throw e2;
      }
    }
    await cancelStagedRestore();
    throw e;
  }
}

/**
 * The whole restore, in the safe order: ask first, then fetch and stage the
 * copy, then apply it. Nothing is staged unless the owner said yes.
 * Returns true when the app is restarting onto the copy.
 */
export async function confirmAndRestore(
  question: string,
  stage: () => Promise<{ staged: boolean }>,
): Promise<boolean> {
  if (!(await askConfirm(question))) return false;
  const r = await stage();
  if (!r.staged) return false;
  return applyRestore();
}
