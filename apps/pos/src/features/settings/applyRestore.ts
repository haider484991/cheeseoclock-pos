import { ipc, IpcError } from '../../ipc/client';
import { askConfirm } from '../../components/confirm/ConfirmHost';

/**
 * Apply a staged restore. The till uploads a cloud safety copy of today's data
 * first; if that fails it refuses, and the owner decides here whether to go on
 * without one (the data is still archived on this PC either way).
 */
export async function applyRestore(): Promise<void> {
  try {
    await ipc.backup.applyAndRelaunch();
  } catch (e) {
    if (e instanceof IpcError && e.details?.['safetyCopyFailed']) {
      const reason = String(e.details['reason'] ?? 'unknown error');
      const ok = await askConfirm(
        `The safety copy of today's data could not be uploaded to the cloud (${reason}).\n\n` +
          'The current data is still archived on this PC (a before-restore-*.db file) before the restore, ' +
          'but there will be no copy of it in the cloud.\n\nRestore anyway?',
      );
      if (ok) await ipc.backup.applyAndRelaunch({ withoutSafetyCopy: true });
      return;
    }
    throw e;
  }
}
