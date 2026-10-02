import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn, NumberPad } from '@cheeseoclock/ui';
import { Banknote, BookOpenCheck, ChevronRight, Clock, History, Inbox, Lock, PauseCircle, ShieldCheck, Wallet, X } from 'lucide-react';
import { cashCountText, cashCountTotalCents, formatCents } from '@cheeseoclock/pos-domain';
import type {
  CashCount,
  IpcRequest,
  OpeningFloatPrefill,
  RefusedItemRefundOwed,
  ShiftCloseCheck,
  ShiftSummary,
  UnpaidOrderAtClose,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { useSessionStore } from '../../stores/sessionStore';
import { openShiftHistory } from '../costing/deepLinks';
import { isTypingField, ownsEnter } from '../checkout/keys';
import { CashMovementDialog } from './CashMovementDialog';
import { drawerResultToast } from './drawerToast';
import { PAGE_ACCESS } from './navAccess';
import { SecretInput } from '../../components/secret/SecretInput';
import { fmtWhen } from '../reports/reportFormat';
import { refusedItemOwedLine } from '../orders/refusedItemWords';
import { ALERT_WATCH_KEY, useWebOrdersPause } from '../notifications/useAlertWatch';
import { CLEAR_ALL_QUESTION, NOTE_COUNTER_FIRST_ROW, NoteCounter, noteCounterKeyAction } from './NoteCounter';
import {
  noteCounterCell,
  noteCounterClear,
  noteCounterInitial,
  noteCounterKey,
  noteCounterMaxDigits,
  noteCounterOtherIsLarge,
  noteCounterPad,
  noteCounterSelect,
  noteCounterStarted,
  noteCounterToCount,
  type NoteCounterState,
} from './noteCounterState';
import {
  dismissShiftCloseOutcome,
  outcomeFor,
  showShiftCloseOutcome,
  useShiftCloseOutcome,
  type ShiftCloseOutcome,
} from './shiftCloseOutcome';
import {
  CLOSE_PAUSES_WEBSITE_NOTE,
  CLOSE_PAUSES_WEBSITE_TEXT,
  OPEN_RESUMES_WEBSITE_TEXT,
  showWebOrdersPaused,
  WEB_PAUSED_PILL,
  WEB_PAUSED_PILL_TITLE,
} from './webOrdersPause';

/**
 * What a cashier who taps the shift pill is told (a touch screen has no mouse
 * to hover for the old tooltip, so the tap used to do nothing at all).
 */
export const CASHIER_CANNOT_CLOSE =
  'Only a manager or the owner can close the shift. Ask them to sign in and count the drawer.';
/**
 * The manager can close it right here, on the cashier's login: they type
 * their PIN or password (the same approval box as a refund or a cash out),
 * then count the drawer, and the shift is closed in their name (owner,
 * 2026-09-27). Signing in on the till themselves still works too.
 */
export const CASHIER_CLOSE_HOW =
  'A manager can close it here: tap “A manager closes the shift”, and they type their own PIN or password and count the drawer. The shift is closed in their name.';
/** The button that hands the close to the manager standing at the till. */
export const MANAGER_CLOSES_LABEL = 'A manager closes the shift';
/**
 * Under the result of a close by a manager's PIN: it is on the cashier's
 * login, so it does not stay (shiftCloseOutcome.ts, PIN_CLOSE_RESULT_MS).
 */
export const PIN_CLOSE_RESULT_NOTE =
  'This is the cashier’s login, so this box closes by itself after a minute. Write the result in the shift book now.';

/**
 * TopBar shift widget. Shows current shift status.
 *  - No shift open → grey pill "Open shift" → opens OpenShiftDialog (anyone,
 *    cashiers included). When that paused website orders on this till, an
 *    amber "Website paused" pill beside it opens the same box.
 *  - Shift open → green pill with elapsed time; only a manager or the owner
 *    can close it (count the drawer). A cashier's tap says so, and who to ask.
 *  - The close result (Expected, Counted, Over / Short) stays up until Done,
 *    whatever the shift status says by then (shiftCloseOutcome.ts).
 *  - "Shift history", for whoever sees Reports (the owner): Reports → Team &
 *    leakage, the last 7 days, at the shift history.
 */
export function ShiftWidget() {
  const can = useSessionStore((s) => s.can);
  const user = useSessionStore((s) => s.user);
  const canOpen = can('shift.open');
  const canClose = can('shift.close');
  const [openDlg, setOpenDlg] = useState<'open' | 'close' | 'cash' | 'why' | null>(null);
  // A manager's PIN typed on a cashier's login, and what the till said to it:
  // the close box then closes in that manager's name.
  const [managerClose, setManagerClose] = useState<{ pin: string; check: ShiftCloseCheck } | null>(null);
  const closeDialogs = () => {
    setOpenDlg(null);
    setManagerClose(null);
  };
  const outcome = outcomeFor(
    useShiftCloseOutcome((s) => s.outcome),
    user,
  );

  const shiftQ = useQuery({
    queryKey: ['shifts', 'current'],
    queryFn: () => ipc.shifts.current(),
    refetchInterval: 30_000,
  });
  const shift = shiftQ.data;
  const pause = useWebOrdersPause();

  // In every branch below: closing refreshes the shift status, and the
  // result must not go with the "shift open" pill (audit 2026-09-27).
  const closeResult = outcome && <CloseShiftResultDialog outcome={outcome} onDone={dismissShiftCloseOutcome} />;

  if (shiftQ.isLoading) {
    return (
      <>
        <span className="flex items-center gap-1.5 rounded-xl bg-stone-100 px-3 py-1.5 text-xs text-stone-500 dark:bg-stone-800">
          <Clock className="h-3.5 w-3.5" />
          …
        </span>
        <ShiftHistoryButton />
        {closeResult}
      </>
    );
  }

  if (!shift) {
    return (
      <>
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => setOpenDlg('open')}
          title={canOpen ? 'Open a shift to start tracking cash' : 'Manager must open the shift'}
          className={cn(
            'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
            'bg-stone-100 text-stone-600 hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:hover:bg-amber-950 dark:hover:text-amber-200',
            !canOpen && 'cursor-not-allowed opacity-60 hover:bg-stone-100 hover:text-stone-600',
          )}
        >
          <Clock className="h-3.5 w-3.5" />
          Open shift
        </button>
        {showWebOrdersPaused(pause) && (
          <button
            type="button"
            onClick={() => canOpen && setOpenDlg('open')}
            title={WEB_PAUSED_PILL_TITLE}
            className="flex items-center gap-1.5 rounded-xl bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-300 transition-colors hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700 dark:hover:bg-amber-900"
          >
            <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {WEB_PAUSED_PILL}
          </button>
        )}
        <ShiftHistoryButton />
        {openDlg === 'open' && <OpenShiftDialog onClose={() => setOpenDlg(null)} />}
        {closeResult}
      </>
    );
  }

  const elapsed = formatElapsed(shift.openedAt);

  return (
    <>
      <button
        type="button"
        // A cashier's tap explains itself: it used to be disabled, with the
        // reason only in a hover title that a touch screen never shows.
        onClick={() => setOpenDlg(canClose ? 'close' : 'why')}
        aria-haspopup="dialog"
        title={canClose ? 'Close shift + count cash' : 'Only a manager or the owner can close the shift'}
        className={cn(
          'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
          'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/60',
          !canClose && 'hover:bg-emerald-100 dark:hover:bg-emerald-950/50',
        )}
      >
        <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
        Shift {elapsed}
        {canClose && <ChevronRight className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={() => setOpenDlg('cash')}
        title="Cash in / out of the drawer (not a sale)"
        aria-label="Drawer cash in or out"
        className="flex items-center rounded-xl bg-stone-100 px-2 py-1.5 text-stone-600 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-amber-950 dark:hover:text-amber-200"
      >
        <Wallet className="h-3.5 w-3.5" />
      </button>
      <ShiftHistoryButton />
      {openDlg === 'cash' && (
        <CashMovementDialog shiftId={shift.id} onClose={() => setOpenDlg(null)} />
      )}
      {openDlg === 'close' && (canClose || managerClose) && (
        <CloseShiftDialog
          shiftId={shift.id}
          onClose={closeDialogs}
          {...(managerClose ? { approverPin: managerClose.pin, check: managerClose.check } : {})}
        />
      )}
      {openDlg === 'why' && (
        <CloseShiftNotAllowedDialog
          shiftId={shift.id}
          onClose={closeDialogs}
          onManagerApproved={(pin, check) => {
            setManagerClose({ pin, check });
            setOpenDlg('close');
          }}
        />
      )}
      {closeResult}
    </>
  );
}

/**
 * A cashier tapped the shift pill. First why they cannot close it and who
 * can; then, if a manager is there, "A manager closes the shift": the
 * manager types their PIN or password, the till checks it (lockout rules and
 * all, in the main process), and only then does the close box open — so the
 * cashier never sees anything of the count before the manager's PIN.
 */
export function CloseShiftNotAllowedDialog({
  shiftId,
  onClose,
  onManagerApproved,
  initialStep = 'why',
}: {
  shiftId: string;
  onClose: () => void;
  onManagerApproved: (pin: string, check: ShiftCloseCheck) => void;
  initialStep?: 'why' | 'pin';
}) {
  const [step, setStep] = useState<'why' | 'pin'>(initialStep);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const checkMut = useMutation({
    mutationFn: (approverPin: string) => ipc.shifts.closeCheck({ shiftId, approverPin }),
    onSuccess: (check, approverPin) => onManagerApproved(approverPin, check),
    onError: (e) => {
      setPin('');
      setError(e instanceof Error ? e.message : 'Manager approval failed');
    },
  });
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          {step === 'why' ? (
            <>
              <header className="mb-3 flex items-start gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
                  <Lock className="h-4 w-4" />
                </span>
                <Dialog.Title className="pt-1.5 text-lg font-semibold">Closing the shift</Dialog.Title>
              </header>
              <Dialog.Description className="text-base font-medium text-stone-800 dark:text-stone-100">
                {CASHIER_CANNOT_CLOSE}
              </Dialog.Description>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">{CASHIER_CLOSE_HOW}</p>
              <div className="mt-5 flex gap-2">
                <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
                  OK
                </Button>
                <Button variant="primary" size="md" className="flex-1" onClick={() => setStep('pin')}>
                  <ShieldCheck className="h-4 w-4" />
                  {MANAGER_CLOSES_LABEL}
                </Button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pin.trim() && !checkMut.isPending) {
                  setError(null);
                  checkMut.mutate(pin);
                }
              }}
            >
              <header className="mb-3 flex items-start gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <Dialog.Title className="pt-1.5 text-lg font-semibold">{MANAGER_CLOSES_LABEL}</Dialog.Title>
              </header>
              <Dialog.Description className="text-sm text-stone-600 dark:text-stone-300">
                Manager: type your PIN or password. Then you count the drawer, and the shift is closed in your name.
              </Dialog.Description>
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                <div className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">Manager approval required</div>
                <SecretInput
                  autoFocus
                  value={pin}
                  onChange={setPin}
                  aria-label="Manager PIN or password"
                  placeholder="Manager PIN or password"
                  className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono tracking-widest dark:border-amber-700 dark:bg-stone-900"
                />
              </div>
              {error && (
                <p role="alert" className="mt-2 text-sm font-medium text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              <div className="mt-5 flex gap-2">
                <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="md" className="flex-1" disabled={!pin.trim() || checkMut.isPending}>
                  {checkMut.isPending ? 'Checking…' : 'Count the drawer'}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Past shifts and their drawer counts (the owner, 2026-09-27: "I can't see
 * the shift history"). Only for whoever may open Reports — the owner; a
 * manager or a cashier sees nothing here (the till refuses them anyway).
 */
function ShiftHistoryButton() {
  const canSeeHistory = useSessionStore((s) => s.can(PAGE_ACCESS['/reports'].capability));
  const navigate = useNavigate();
  if (!canSeeHistory) return null;
  return (
    <button
      type="button"
      onClick={() => openShiftHistory(navigate)}
      title="Past shifts: who opened and closed them, and what each drawer counted (Reports → Team & leakage)"
      className="flex items-center gap-1.5 rounded-xl bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-600 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-amber-950 dark:hover:text-amber-200"
    >
      <History className="h-3.5 w-3.5" />
      Shift history
    </button>
  );
}

function formatElapsed(openedAtIso: string): string {
  const ms = Date.now() - new Date(openedAtIso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min - h * 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// ---------------------------------------------------------------------------
// Open shift dialog
// ---------------------------------------------------------------------------

/** The line over the Open shift box: where its starting figure came from. Null when it starts at 0 (a first shift). */
export function openingFloatNote(start: OpeningFloatPrefill): string | null {
  switch (start.from) {
    case 'last_count':
      return start.lastCount
        ? `The last shift closed with ${formatCents(start.lastCount.countedCashCents)} in the drawer. Count it again and change this if it is different.`
        : null;
    case 'fixed':
      return `This till starts each shift with ${formatCents(start.prefillCents ?? 0)} (Settings). Count the drawer and change this if it is different.`;
    default:
      return null;
  }
}

/**
 * What the Open shift box shows until someone types: the starting figure in
 * rupees (the owner's fixed float, or the last count), or 0 on a first shift
 * and while the till has not answered yet.
 */
export function openingFloatBoxStart(start: OpeningFloatPrefill | undefined): string {
  return start && start.prefillCents !== null ? String(start.prefillCents / 100) : '0';
}

/** Count the float and open a shift: the top bar's "Open shift", and the no-shift banner's. */
export function OpenShiftDialog({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();
  // The float starts from what the last shift on this till counted — the cash
  // that stayed in the drawer overnight — or, when the owner set one for this
  // till, a fixed float (Settings → Staff & kitchen). Typed in fresh every
  // morning, it was routinely left at 0 and the whole float showed up as
  // "over" at close. Only a starting figure: the float is still counted here.
  const floatQ = useQuery({ queryKey: ['shifts', 'openingFloat'], queryFn: () => ipc.shifts.openingFloat() });
  const start = floatQ.data;
  // Until someone types, the box shows the starting figure (worked out from
  // the till's answer on every render, not copied in by an effect); once
  // typed, what was typed — a late answer never overwrites it.
  const [typed, setTyped] = useState<string | null>(null);
  const opening = typed ?? openingFloatBoxStart(start);
  const startNote = start ? openingFloatNote(start) : null;
  // Closing the last shift paused website orders on this till; opening starts them again.
  const resumes = showWebOrdersPaused(useWebOrdersPause());

  const openMut = useMutation({
    // `wasPaused`: what the box said when Open was pressed (the pause is lifted by the open itself).
    mutationFn: (_wasPaused: boolean) =>
      ipc.shifts.open({
        openingCashCents: Math.round((parseFloat(opening) || 0) * 100),
        notes: notes.trim() || null,
      }),
    onSuccess: (_shift, wasPaused) => {
      toast({
        title: 'Shift opened',
        description: `New orders go on this shift. The cash drawer opens for the float.${wasPaused ? ' Website orders are on again.' : ''}`,
      });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Could not open shift',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
                <BookOpenCheck className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Open shift</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Count the cash in the drawer right now — this is the opening float.
                </Dialog.Description>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="space-y-3">
            {resumes && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {OPEN_RESUMES_WEBSITE_TEXT}
              </p>
            )}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Opening cash (Rs)
              </span>
              {startNote && <span className="mb-1 block text-xs text-stone-500">{startNote}</span>}
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Opening note (optional)
              </span>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Morning shift, Ali on register…"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="success"
              size="md"
              className="flex-1"
              onClick={() => openMut.mutate(resumes)}
              disabled={openMut.isPending}
            >
              {openMut.isPending ? 'Opening…' : 'Open shift'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Close shift dialog
// ---------------------------------------------------------------------------

/**
 * What the close box sends. The count goes note by note (the owner: always
 * by note) with the total it adds up to; the till checks the two agree and
 * keeps both (shift-repo closeShift). The ids of the unpaid orders it showed
 * go with it (none shown: an empty list), so the till refuses a close that
 * would carry over an order that came in during the count on a reason the
 * manager gave for the others — or with no reason asked at all (shift-repo).
 */
export function closeShiftRequest(p: {
  shiftId: string;
  count: CashCount;
  notes: string;
  unpaid: readonly UnpaidOrderAtClose[];
  carryOverReason: string;
  approverPin?: string | undefined;
}): IpcRequest<'shifts:close'> {
  return {
    shiftId: p.shiftId,
    countedCashCents: cashCountTotalCents(p.count),
    countedNotes: p.count,
    notes: p.notes.trim() || null,
    ...(p.unpaid.length > 0 ? { carryOverReason: p.carryOverReason.trim() } : {}),
    carryOverOrderIds: p.unpaid.map((o) => o.orderId),
    ...(p.approverPin !== undefined ? { approverPin: p.approverPin } : {}),
  };
}

/** The till now lists an unpaid order the close box had not shown: the reason must be given again. */
export function hasNewUnpaid(shown: readonly UnpaidOrderAtClose[], now: ShiftCloseCheck): boolean {
  const seen = new Set(shown.map((o) => o.orderId));
  return now.unpaidOrders.some((o) => !seen.has(o.orderId));
}

/** The words under the Close shift title: the count is by note, and the till adds it up. */
export const CLOSE_SHIFT_DESCRIPTION = 'Count the notes in the drawer, row by row. The till adds them up.';

/** The footer's hints, beside Cancel and Close shift (closeShiftHint). */
export const CLOSE_HINT_NOT_STARTED = 'Type a count in at least one row (0 if the drawer is empty).';
export const CLOSE_HINT_CHECKING = 'Checking the orders on this till…';
export const CLOSE_HINT_REASON = 'Give a reason for the unpaid orders (below the count).';
export const CLOSE_HINT_COINS_LARGE = 'Rs 1,000 or more in coins and other: count the notes in their own rows.';

/**
 * The one hint the close box's footer shows, first match wins: nothing typed
 * yet; the till still checking this till's orders; no reason for the unpaid
 * orders; then, amber and never in the way, a large 'Coins and other' (notes
 * belong in their own rows). Null when there is nothing to say. The first
 * three are why Close shift is not ready.
 */
export function closeShiftHint(p: {
  started: boolean;
  checked: boolean;
  reasonMissing: boolean;
  otherIsLarge: boolean;
}): { text: string; amber: boolean } | null {
  if (!p.started) return { text: CLOSE_HINT_NOT_STARTED, amber: false };
  if (!p.checked) return { text: CLOSE_HINT_CHECKING, amber: false };
  if (p.reasonMissing) return { text: CLOSE_HINT_REASON, amber: false };
  if (p.otherIsLarge) return { text: CLOSE_HINT_COINS_LARGE, amber: true };
  return null;
}

/** What leaving the box asks once a count is typed (never the browser's own confirm()). */
export const STOP_CLOSING_QUESTION = 'Stop closing the shift? The count you typed is not kept.';

/**
 * Leaving the close box (Cancel, the X, Escape, a tap outside), all one way:
 * - while the close is saving, nothing happens (the reply is on its way: the
 *   box would go, and the shift close anyway behind the manager's back);
 * - once something is typed, it asks first, with "Keep counting" as the safe
 *   answer: a slip of the hand must not throw a half-done count away;
 * - otherwise the box just closes.
 */
export async function leaveCloseShift(p: { saving: boolean; started: boolean; onClose: () => void }): Promise<void> {
  if (p.saving) return;
  if (p.started) {
    const stop = await askConfirm(STOP_CLOSING_QUESTION, { safeDefault: true, yesLabel: 'Stop', noLabel: 'Keep counting' });
    if (!stop) return;
  }
  p.onClose();
}

/** 'Clear all' asks first, with "Keep counting" as the safe answer; true means clear. */
export function confirmClearAll(): Promise<boolean> {
  return askConfirm(CLEAR_ALL_QUESTION, { safeDefault: true, yesLabel: 'Clear all', noLabel: 'Keep counting' });
}

/**
 * The close box: open the drawer, count it note by note (blind), a closing
 * note, and — when orders on this till are still unpaid — the list of them
 * and the manager's reason for carrying them over to the next shift.
 * `approverPin` and `check`: a manager's PIN typed on a cashier's login
 * (already checked by CloseShiftNotAllowedDialog); every call below carries
 * it again and the main process checks it again.
 *
 * It fits a 1024 × 700 till (1011 × 663 inside the window) with the website
 * pause line on: the header (with that line) and the footer (the hint,
 * Cancel and Close shift) stay put, and only the middle scrolls when the
 * unpaid orders make it long. The count is always by note (the owner: no
 * "type the total"); the Open shift box keeps its one figure.
 */
export function CloseShiftDialog({
  shiftId,
  onClose,
  approverPin,
  check: givenCheck,
}: {
  shiftId: string;
  onClose: () => void;
  approverPin?: string;
  check?: ShiftCloseCheck;
}) {
  const [count, setCount] = useState(noteCounterInitial);
  const [notes, setNotes] = useState('');
  const [carryOverReason, setCarryOverReason] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();
  const sessionId = useSessionStore((s) => s.user?.sessionId ?? null);
  const viaPin = approverPin !== undefined;

  // A blind count: what the drawer should hold is shown only once the count
  // is in (CloseShiftResultDialog). Showing it first let a cashier type the
  // expected figure and hide a shortage (audit 2026-09-25). On a cashier's
  // login (a manager's PIN) the shift's totals are not fetched at all.
  const summaryQ = useQuery({
    queryKey: ['shifts', 'summary', shiftId],
    queryFn: () => ipc.shifts.summary(shiftId),
    enabled: !viaPin,
  });
  const summary = viaPin ? undefined : summaryQ.data;
  // Who closes, and the unpaid orders the close carries over.
  const checkQ = useQuery({
    queryKey: ['shifts', 'closeCheck', shiftId],
    queryFn: () => ipc.shifts.closeCheck({ shiftId }),
    enabled: !givenCheck,
  });
  // Asked again after a refused close (on a manager's PIN, with the PIN).
  const [recheck, setRecheck] = useState<ShiftCloseCheck | null>(null);
  const check = recheck ?? givenCheck ?? checkQ.data;
  const unpaid = check?.unpaidOrders ?? [];
  const needsReason = unpaid.length > 0;
  // This shift's refused items still to refund: why the drawer is short. Said, never a gate.
  const refundsOwed = check?.refusedItemRefundsOwed ?? [];
  // This close leaves no shift open on this till with the owner's switch on:
  // website orders pause until a shift is opened (said before, not a gate).
  const pausesWebsite = check?.pausesWebsiteOrders === true;

  // A refused close (most often: an order came in unpaid during the count):
  // the list is asked for again, so the new order and the reason box show,
  // and a reason given for the others is typed again for the new list.
  async function refreshCheck(): Promise<void> {
    const shown = unpaid;
    try {
      let next: ShiftCloseCheck | undefined;
      if (approverPin !== undefined) {
        next = await ipc.shifts.closeCheck({ shiftId, approverPin });
        setRecheck(next);
      } else {
        next = (await checkQ.refetch()).data;
      }
      if (next && hasNewUnpaid(shown, next)) setCarryOverReason('');
    } catch {
      // The close's own error is already on screen.
    }
  }

  // Pulses the drawer so it can be counted; the count itself stays blind.
  const countMut = useMutation({
    mutationFn: () => ipc.shifts.openDrawer({ kind: 'count', ...(viaPin ? { approverPin } : {}) }),
    onSuccess: (r) => {
      const t = drawerResultToast(r);
      toast({ ...t, ...(t.variant === 'success' ? {} : { duration: 15_000 }) });
    },
    onError: (e) =>
      toast({
        title: 'Could not open the drawer',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const closeMut = useMutation({
    mutationFn: (request: IpcRequest<'shifts:close'>) => ipc.shifts.close(request),
    onSuccess: (shift) => {
      toast({
        title: 'Shift closed',
        description: pausesWebsite
          ? 'Cash drawer reconciliation saved. Website orders are paused until a shift is opened.'
          : 'Cash drawer reconciliation saved.',
      });
      // The result first, then the refresh that turns the pill to "Open
      // shift": the result is kept outside the pill (shiftCloseOutcome.ts),
      // so it stays up until Done. On a manager's PIN (a cashier's login)
      // the till sends no expected cash, and none is shown.
      if (sessionId) {
        showShiftCloseOutcome({
          sessionId,
          shiftId,
          expectedCents: viaPin ? null : (shift.expectedCashCents ?? 0),
          countedCents: shift.countedCashCents ?? 0,
          countedNotes: shift.countedNotes ?? null,
          varianceCents: shift.varianceCents ?? 0,
          summary: summary ?? null,
          closedByName: shift.closedByName ?? check?.closerName ?? null,
          carriedUnpaidCount: shift.carriedUnpaidCount ?? 0,
          viaManagerPin: viaPin,
        });
      }
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY });
      onClose();
    },
    onError: (e) => {
      toast({
        title: 'Could not close shift',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
      void refreshCheck();
    },
  });

  const saving = closeMut.isPending;
  const started = noteCounterStarted(count);
  const reasonMissing = needsReason && !carryOverReason.trim();
  const hint = closeShiftHint({ started, checked: !!check, reasonMissing, otherIsLarge: noteCounterOtherIsLarge(count) });

  // While the close is saving the count stays as it was sent.
  const changeCount = (change: (s: NoteCounterState) => NoteCounterState) => {
    if (!saving) setCount(change);
  };
  const confirmLeave = () => void leaveCloseShift({ saving, started, onClose });
  const clearAll = async () => {
    if (await confirmClearAll()) changeCount(noteCounterClear);
  };

  // The keyboard types into the chosen row, like the pad beside it.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const action = noteCounterKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      repeat: e.repeat,
      isComposing: e.nativeEvent.isComposing,
      typing: isTypingField(target),
      ownsEnter: ownsEnter(target),
      onRow: target.dataset['noteRow'] !== undefined,
    });
    if (action === null) return;
    e.preventDefault();
    if (action === 'count') changeCount((s) => noteCounterKey(s, e.key));
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && confirmLeave()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          // The keyboard starts on the Rs 5,000 row, not on the X.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(NOTE_COUNTER_FIRST_ROW)?.focus();
          }}
          // Escape and a tap outside go the same way as Cancel: asked first once counting started.
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            confirmLeave();
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            confirmLeave();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[780px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-white shadow-soft-lg outline-none dark:bg-stone-900"
        >
          <div className="shrink-0 p-5 pb-3">
            <CloseShiftHeader onClose={confirmLeave} closeDisabled={saving} description={CLOSE_SHIFT_DESCRIPTION} className="" />
            {pausesWebsite && (
              <p
                role="note"
                className="mt-1 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
              >
                <PauseCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <b>{CLOSE_PAUSES_WEBSITE_TEXT}</b> {CLOSE_PAUSES_WEBSITE_NOTE}
                </span>
              </p>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
            {((viaPin && check) || summary || needsReason) && (
              <p className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-stone-600 dark:text-stone-300">
                {viaPin && check && (
                  <span>
                    Closing as <span className="font-semibold">{check.closerName}</span> (manager's PIN).
                  </span>
                )}
                {summary && (
                  <span>
                    Paid orders {summary.paidOrderCount} · Refunds {summary.refundedOrderCount}
                  </span>
                )}
                {needsReason && (
                  <span className="rounded-full bg-amber-100 px-2 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    {unpaid.length === 1 ? '1 unpaid order' : `${unpaid.length} unpaid orders`}: give a reason below
                  </span>
                )}
              </p>
            )}

            <div className="grid grid-cols-[1fr_260px] gap-5">
              <NoteCounter
                state={count}
                onSelect={(row) => changeCount((s) => noteCounterSelect(s, row))}
                onClear={() => void clearAll()}
              />
              <div className="space-y-3">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={countMut.isPending}
                  onClick={() => countMut.mutate()}
                >
                  <Inbox className="h-4 w-4" />
                  {countMut.isPending ? 'Opening…' : 'Open drawer to count'}
                </Button>
                <NumberPad
                  value={noteCounterCell(count)}
                  onChange={(next) => changeCount((s) => noteCounterPad(s, next))}
                  onSubmit={() => changeCount((s) => noteCounterKey(s, 'Enter'))}
                  maxLength={noteCounterMaxDigits(count.active)}
                  showDisplay={false}
                  enterLabel="Next"
                  keyClassName="h-14"
                  keyTabIndex={-1}
                  label="Number pad for the note count"
                />
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Closing note (optional)</span>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Variance reason, cashier handover, etc."
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  />
                </label>
              </div>
            </div>

            {(needsReason || refundsOwed.length > 0 || (!check && checkQ.isError)) && (
              <div className="mt-3 space-y-3">
                {needsReason && (
                  <UnpaidCarryOver orders={unpaid} reason={carryOverReason} onReason={setCarryOverReason} />
                )}
                {refundsOwed.length > 0 && <RefusedItemsOwed orders={refundsOwed} />}
                {!check && checkQ.isError && (
                  <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
                    {checkQ.error instanceof Error ? checkQ.error.message : 'Could not check the orders on this till'}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-stone-200 px-5 pb-5 pt-3 dark:border-stone-800">
            <p
              className={cn(
                'min-w-0 flex-1 text-xs',
                hint?.amber ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-stone-500 dark:text-stone-400',
              )}
            >
              {hint?.text}
            </p>
            <Button variant="ghost" size="md" className="w-28" onClick={confirmLeave} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              className="w-40"
              onClick={() =>
                closeMut.mutate(
                  closeShiftRequest({ shiftId, count: noteCounterToCount(count), notes, unpaid, carryOverReason, approverPin }),
                )
              }
              disabled={saving || !started || !check || reasonMissing}
            >
              {saving ? 'Closing…' : 'Close shift'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Orders on this till still unpaid at the close (from any day): they stay
 * unpaid and carry over to the next shift, with one reason for all of them,
 * approved by the manager closing (owner, 2026-09-27).
 */
export function UnpaidCarryOver({
  orders,
  reason,
  onReason,
}: {
  orders: readonly UnpaidOrderAtClose[];
  reason: string;
  onReason: (reason: string) => void;
}) {
  const n = orders.length;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="font-semibold">
        {n === 1 ? '1 order on this till is not paid yet.' : `${n} orders on this till are not paid yet.`}
      </p>
      <p className="mt-0.5 text-xs">
        {n === 1 ? 'It stays' : 'They stay'} unpaid and carr{n === 1 ? 'ies' : 'y'} over to the next shift; the money goes to whichever shift takes it.
      </p>
      <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto text-xs">
        {orders.map((o) => (
          <li key={o.orderId} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              <span className="font-mono font-semibold">#{o.orderNumber.split('-').pop()}</span> · {fmtWhen(o.createdAt)} · {o.takenBy}
            </span>
            <span className="shrink-0 font-mono">{formatCents(o.totalCents)}</span>
          </li>
        ))}
      </ul>
      <label className="mt-2 block">
        <span className="mb-1 block text-xs font-semibold">Why are they carried over? (required)</span>
        <input
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          maxLength={300}
          placeholder="Rider still out, customer pays tomorrow…"
          aria-label="Reason for carrying the unpaid orders over"
          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-amber-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </label>
    </div>
  );
}

/** Under the list in the close box: why the drawer is short, and that the close still goes ahead. */
export const REFUSED_ITEMS_OWED_NOTE = 'The drawer is short by each refused item until it is refunded. You can still close the shift.';

/**
 * This shift's deliveries with "Customer refused an item" whose part refund
 * is not done yet (shifts:closeCheck): the rider brought less than the bill,
 * so the drawer is short by each item. Listed so the manager sees why; the
 * close is never held up for them.
 */
export function RefusedItemsOwed({ orders }: { orders: readonly RefusedItemRefundOwed[] }) {
  return (
    <div
      role="note"
      className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-100"
    >
      <ul className="max-h-20 space-y-0.5 overflow-y-auto font-semibold">
        {orders.map((o) => (
          <li key={o.orderId}>{refusedItemOwedLine(o.orderNumber)}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs">{REFUSED_ITEMS_OWED_NOTE}</p>
    </div>
  );
}

/**
 * The title of the close box and of its result. `description`: the words
 * under the title (the result keeps its own). `closeDisabled`: the X waits
 * while the close is saving. `className`: the space under it ('mb-4'; the
 * close box has its own padding).
 */
function CloseShiftHeader({
  onClose,
  closeLabel = 'Close',
  description = 'Count cash in the drawer and enter the actual total below.',
  closeDisabled = false,
  className = 'mb-4',
}: {
  onClose: () => void;
  closeLabel?: string;
  description?: string;
  closeDisabled?: boolean;
  className?: string;
}) {
  return (
    <header className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <Banknote className="h-4 w-4" />
        </span>
        <div>
          <Dialog.Title className="text-lg font-semibold">Close shift</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-stone-500">{description}</Dialog.Description>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        disabled={closeDisabled}
        className="rounded p-1 text-stone-400 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-stone-800"
        aria-label={closeLabel}
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

/**
 * The cash taken out of the drawer this shift, as the close result shows it
 * (v0.7.34). ridersCents: what the drawer paid outside riders — a delivery
 * charge he kept, or a trip (the order cancelled or refused at the door
 * after he went, or an add-on that went alone): the payouts linked to an
 * order. The owner found a shortage at close because of these (2 Oct 2026),
 * so they get a row of their own; tripsCount says how many were trips (it
 * read "Delivery charges kept by riders (5 orders)" with a cancelled order's
 * trip among them; e2e, 2 Oct 2026). takenOutCents: the rest, cash out typed
 * by hand and rider tips, so "Cash taken out" means what it always meant.
 * Both are already in the expected cash: nothing is taken off twice. A
 * summary without the rider figures counts them as 0.
 */
export function closeResultCashOut(
  summary: Pick<ShiftSummary, 'cashOutCents' | 'riderChargesCents' | 'riderChargeCount' | 'riderTripCount'>,
): { takenOutCents: number; ridersCents: number; ridersCount: number; tripsCount: number } {
  const ridersCents = Math.max(0, summary.riderChargesCents ?? 0);
  const ridersCount = summary.riderChargeCount ?? 0;
  return {
    takenOutCents: Math.max(0, summary.cashOutCents - ridersCents),
    ridersCents,
    ridersCount,
    tripsCount: Math.min(ridersCount, Math.max(0, summary.riderTripCount ?? 0)),
  };
}

/**
 * The riders' row: "Paid to outside riders (5): 4 delivery charges kept, 1
 * trip" — every payout counted once, as what it was. Shift history's note
 * names them in the same words (shiftHistoryNote).
 */
export function ridersPaidLabel(count: number, trips: number): string {
  const kept = Math.max(0, count - trips);
  const parts = [
    kept > 0 ? `${kept} ${kept === 1 ? 'delivery charge' : 'delivery charges'} kept` : null,
    trips > 0 ? `${trips} ${trips === 1 ? 'trip' : 'trips'}` : null,
  ].filter((p): p is string => p !== null);
  return `Paid to outside riders (${count})${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * The close box once the count is in: the shift's cash, Expected, Counted and
 * the Variance (Matches expected / Over / Short), until Done — the same box
 * the close always meant to show, now kept up after the shift status turns
 * to "no shift open". Shown only to the login that closed the shift.
 *
 * Done (or the X, labelled Done) is the only way out: a tap on the dimmed
 * area or Escape used to throw the numbers away before they were written in
 * the shift book, and a manager has no other screen to find them again.
 * On a manager's PIN (a cashier's login): no expected cash, and it goes by
 * itself after a minute (shiftCloseOutcome.ts).
 */
export function CloseShiftResultDialog({ outcome, onDone }: { outcome: ShiftCloseOutcome; onDone: () => void }) {
  const { summary } = outcome;
  const cashOut = summary ? closeResultCashOut(summary) : null;
  const variance = outcome.varianceCents;
  // The notes counted, on one line under Counted (both closes; none for a count of nothing).
  const notesLine = outcome.countedNotes ? cashCountText(outcome.countedNotes) : null;
  const keepOpen = (e: Event) => e.preventDefault();
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onPointerDownOutside={keepOpen}
          onInteractOutside={keepOpen}
          onEscapeKeyDown={keepOpen}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-24px)] w-[460px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900"
        >
          <CloseShiftHeader onClose={onDone} closeLabel="Done" />

          <div className="mb-3 rounded-xl bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
            <dl className="space-y-0.5 text-emerald-900 dark:text-emerald-100">
              {summary && (
                <>
                  <Row k="Paid orders" v={String(summary.paidOrderCount)} />
                  <Row k="Refunds" v={String(summary.refundedOrderCount)} />
                  {/* The float first, so the money rows on screen add up to Expected cash (e2e, 2 Oct 2026). */}
                  {typeof summary.openingCashCents === 'number' && (
                    <Row k="Opening float" v={formatCents(summary.openingCashCents)} />
                  )}
                  <Row k="Cash sales" v={formatCents(summary.cashSalesCents)} />
                  <Row k="Cash refunds" v={`− ${formatCents(summary.cashRefundsCents)}`} />
                  {summary.cashInCents > 0 && <Row k="Cash put in" v={`+ ${formatCents(summary.cashInCents)}`} />}
                  {cashOut && cashOut.takenOutCents > 0 && (
                    <Row k="Cash taken out" v={`− ${formatCents(cashOut.takenOutCents)}`} />
                  )}
                  {cashOut && cashOut.ridersCents > 0 && (
                    <Row k={ridersPaidLabel(cashOut.ridersCount, cashOut.tripsCount)} v={`− ${formatCents(cashOut.ridersCents)}`} />
                  )}
                </>
              )}
              {outcome.expectedCents !== null && (
                <div className="mt-1 flex justify-between border-t border-emerald-200 pt-1 font-bold dark:border-emerald-800">
                  <dt>Expected cash</dt>
                  <dd className="font-mono">{formatCents(outcome.expectedCents)}</dd>
                </div>
              )}
              <Row k="Counted" v={formatCents(outcome.countedCents)} />
              {notesLine && (
                <div className="text-xs text-emerald-800 dark:text-emerald-200">
                  <dt className="sr-only">Notes counted</dt>
                  {/* A long count wraps between its parts, never inside one ("coins and other Rs | 35"). */}
                  <dd>
                    {notesLine.split(' · ').map((part, i) => (
                      <span key={i}>
                        {i > 0 && ' · '}
                        <span className="whitespace-nowrap">{part}</span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div
            className={cn(
              'rounded-lg p-3 text-sm',
              variance === 0
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100'
                : variance > 0
                ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
                : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-100',
            )}
          >
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">Variance</span>
              <span className="font-mono text-xl">
                {variance > 0 ? '+' : ''}
                {formatCents(variance)}
              </span>
            </div>
            <div className="mt-0.5 text-xs">
              {variance === 0
                ? 'Matches expected'
                : variance > 0
                ? 'Over (more than expected)'
                : 'Short (less than expected)'}
            </div>
          </div>

          {(outcome.closedByName || outcome.carriedUnpaidCount > 0) && (
            <p className="mt-3 text-xs text-stone-600 dark:text-stone-300">
              {outcome.closedByName && <>Closed by {outcome.closedByName}.</>}
              {outcome.carriedUnpaidCount > 0 && (
                <>
                  {' '}
                  {outcome.carriedUnpaidCount === 1
                    ? '1 unpaid order was carried over to the next shift.'
                    : `${outcome.carriedUnpaidCount} unpaid orders were carried over to the next shift.`}
                </>
              )}
            </p>
          )}

          {outcome.viaManagerPin && (
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{PIN_CLOSE_RESULT_NOTE}</p>
          )}

          <div className="mt-5 flex">
            <Button variant="primary" size="md" className="flex-1" onClick={onDone}>
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <dt>{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
