import { create } from 'zustand';

/**
 * "A manager's PIN or password is needed" — asked inside the app window
 * (ManagerApprovalHost), never with the browser's prompt(): a native dialog
 * leaves Electron's keyboard focus nowhere on Windows (see ConfirmHost).
 */

export interface ManagerAsk {
  /** Why approval is needed, as the till said it. */
  message: string;
  /** What went wrong with the last try (e.g. that was not a manager's PIN). */
  error: string | null;
  /**
   * Papers of this document printed before, as the till said (null: not
   * said). Printed by hand, the paper says DUPLICATE either way (the owner's
   * rule, 27 Sep 2026); 0 means it is the first paper of its kind.
   */
  printNo: number | null;
  /**
   * What the paper will say, when the asker knows better than printNo (the
   * shift report, v0.7.35); null: the receipt words (approvalPaperNote).
   */
  paperNote: string | null;
  resolve: (secret: string | null) => void;
}

export const useManagerApprovalStore = create<{ ask: ManagerAsk | null }>(() => ({ ask: null }));

/** Ask for a manager's PIN or password; resolves null when cancelled. */
export function askManagerSecret(
  message: string,
  error: string | null = null,
  printNo: number | null = null,
  paperNote: string | null = null,
): Promise<string | null> {
  return new Promise((resolve) => {
    // A second question replaces an open one; the first counts as cancelled.
    useManagerApprovalStore.getState().ask?.resolve(null);
    useManagerApprovalStore.setState({ ask: { message, error, printNo, paperNote, resolve } });
  });
}

/**
 * What the dialog promises about the paper — true for what the till will
 * print: a paper printed by hand always says DUPLICATE (the owner's rule).
 */
export function approvalPaperNote(printNo: number | null): string {
  if (printNo === 0) {
    return "Nothing was printed for it before, but a paper printed by hand always says DUPLICATE. It will show the manager's name.";
  }
  return "The paper will say DUPLICATE and show the manager's name.";
}

/** The dialog's answer: the secret typed, or null for Cancel. */
export function answerManagerSecret(secret: string | null): void {
  const ask = useManagerApprovalStore.getState().ask;
  if (!ask) return;
  useManagerApprovalStore.setState({ ask: null });
  ask.resolve(secret && secret.trim() ? secret : null);
}
