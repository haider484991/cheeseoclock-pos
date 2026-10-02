import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellOff } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  QUIET_ALERT_VOLUME,
  newOrderSoundIsOff,
  shortOrderNumber,
  type AlertSoundSettings,
  type OrderSnapshot,
} from '@cheeseoclock/shared-types';
import {
  ipc,
  onAlertOpen,
  onLowStock,
  onPrinterFailed,
  onWebOrderImportFailed,
  onWebOrderReceived,
} from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { router } from '../../router';
import { AlertBanner } from './AlertBanner';
import { alerts, loadReminded, saveReminded, useAlertStore } from './alertStore';
import { dueRing, failureFromEvent, isLoud } from './alertState';
import { getSoundPlayer } from './audioEngine';
import {
  ACTIVE_ORDERS_FRESH_MS,
  ACTIVE_ORDERS_KEY,
  lowStockTone,
  planWaitingReminders,
  printerFailureEffect,
  toWaitingOrders,
} from './eventTones';
import { soundForEvent } from './tones';
import { useAlertSoundSettings } from './useAlertSoundSettings';
import { ALERT_WATCH_KEY, useAlertWatch } from './useAlertWatch';
import { boardUnusedText, describeReminders } from './waitingReminders';
import { notesSignedIn, planWatchTone, shownNotes, watchNotes, type WatchNote } from './watchNotes';
import { useKitchenTiming } from '../settings/shop-rules/useShopSetting';
import { orderTimeLabel } from '../orders/historyFilters';

/** While something is on the banner, check with the main process this often. */
const SYNC_EVERY_MS = 5_000;
const RING_TICK_MS = 1_000;
const REMIND_TICK_MS = 30_000;
/**
 * The saved sounds arrive in milliseconds. Should the main process never
 * answer, ring with the standard sounds after this long rather than not at all.
 */
const SETTINGS_WAIT_MS = 5_000;

let warned = false;
function warnOnce(message: string, e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(message, e);
}

/** An event handler that can never throw into Electron's IPC plumbing. */
function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (e) {
      warnOnce('Order alerts: a handler failed', e);
    }
  };
}

/** A popup (payment, discount, a drawer…) is open: Esc and taps belong to it. */
function popupOpen(): boolean {
  return document.querySelector('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]') !== null;
}

/** Watches for popups only while the banner is up. */
function usePopupOpen(active: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) {
      setOpen(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      setOpen(popupOpen());
    };
    check();
    const observer = new MutationObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(check);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active]);
  return open;
}

function soundOffText(s: AlertSoundSettings): string {
  if (!s.enabled) return 'Sounds are off on this till';
  if (!s.events.newOnlineOrder) return 'New-order sound is off';
  if (s.volume < QUIET_ALERT_VOLUME) return 'Sounds are very quiet';
  return '';
}

/**
 * Sounds and the alert banner for the whole till: new website orders (chime,
 * repeating until someone looks), website orders that did not come in
 * (alarm), orders waiting too long, printer problems and low stock.
 *
 * Mounted once at the root, next to the update banner, so it works on the
 * PIN screen too: a website order that arrives while nobody is logged in
 * still rings and shows, and anyone can tap Seen (like a doorbell). Printer,
 * low-stock and the signed-in waiting sounds play only with someone logged
 * in, because the notes that say why they rang are on the logged-in screen
 * — a sound never plays without something on screen saying why.
 *
 * It is also the one poller of the watch (alerts:getWatch, every 30 s), and
 * the banner shows its notes (watchNotes.ts). With nobody signed in (a held
 * step-in counts), the PIN screen keeps a note up for a kitchen ticket that
 * did not print, for orders waiting too long and for a website order the
 * website has not confirmed, and beeps again every 5 minutes until someone
 * signs in (orders waiting: only while a shift is open on this till); Seen
 * does not stop them, dealing with them does. Signed in, only the
 * not-confirmed note shows, low on the left, beeping once per order; Hide
 * puts it away until another order joins it. A note under a popup (the
 * banner is the small pill then) never beeps: it beeps once it shows.
 */
export function OrderAlerts() {
  return (
    <AlertsBoundary>
      <OrderAlertsInner />
    </AlertsBoundary>
  );
}

function OrderAlertsInner() {
  const { settings, loaded, settled } = useAlertSoundSettings();
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaitedOut(true), SETTINGS_WAIT_MS);
    return () => window.clearTimeout(t);
  }, []);
  // Nothing plays on the standard sounds while the saved ones are loading: a
  // till set to "off" or "quiet" would give one loud chime after a restart.
  const soundsReady = settled || waitedOut;
  const user = useSessionStore((s) => s.user);
  const loggedIn = user !== null;
  // For the watch's notes a held step-in is signed out: its guarded reads are refused.
  const signedIn = notesSignedIn(user);
  const canView = useSessionStore((s) => s.can('order.create'));
  const state = useAlertStore((s) => s.state);
  const hiddenNotes = useAlertStore((s) => s.hiddenNotes);
  const { toast } = useToast();
  const qc = useQueryClient();
  const player = getSoundPlayer();

  // The owner's reminder minutes (checkout:getRules; the released 10 / 30 until it answers).
  const kitchen = useKitchenTiming({ enabled: loggedIn });

  const settingsRef = useRef(settings);
  const readyRef = useRef(soundsReady);
  const loggedInRef = useRef(loggedIn);
  const canViewRef = useRef(canView);
  const kitchenRef = useRef(kitchen);
  useEffect(() => {
    kitchenRef.current = kitchen;
  }, [kitchen]);
  useEffect(() => {
    settingsRef.current = settings;
    readyRef.current = soundsReady;
  }, [settings, soundsReady]);
  useEffect(() => {
    loggedInRef.current = loggedIn;
    canViewRef.current = canView;
  }, [loggedIn, canView]);

  const ringIfDue = useCallback(() => {
    try {
      // Anything due stays due: it rings once the saved sounds are in.
      if (!readyRef.current) return;
      const now = Date.now();
      const s = settingsRef.current;
      const kind = dueRing(alerts.getState(), s, now);
      if (!kind) return;
      alerts.markRang(now);
      player.play(kind === 'importFailed' ? 'importFailed' : soundForEvent('newOnlineOrder', s), s.volume);
    } catch (e) {
      warnOnce('Order alerts: could not ring', e);
    }
  }, [player]);

  /** Take in what the main process kept (orders that came in before this screen started, or while it reloaded). */
  const syncFromMain = useCallback(async () => {
    const requestedAt = Date.now();
    try {
      const pending = await ipc.alerts.getPending();
      alerts.applySnapshot(pending, requestedAt);
      ringIfDue();
    } catch {
      // keep what the screen already has
    }
  }, [ringIfDue]);

  useEffect(() => {
    void syncFromMain();
  }, [syncFromMain]);

  // The saved sounds are in: ring for whatever arrived while they loaded.
  useEffect(() => {
    if (soundsReady) ringIfDue();
  }, [soundsReady, ringIfDue]);

  const hasPending = state.orders.length + state.failures.length > 0;
  const loud = isLoud(state);

  // While the banner is up, stay in step: an order started on the board (or
  // on the other till) stops the chime; a card closed elsewhere goes.
  useEffect(() => {
    if (!hasPending) return;
    const t = window.setInterval(() => void syncFromMain(), SYNC_EVERY_MS);
    return () => window.clearInterval(t);
  }, [hasPending, syncFromMain]);

  // The ringer: checks every second while something is ringing.
  useEffect(() => {
    if (!loud) {
      player.stop();
      return;
    }
    ringIfDue();
    const t = window.setInterval(ringIfDue, RING_TICK_MS);
    return () => window.clearInterval(t);
  }, [loud, ringIfDue, player]);

  useEffect(
    () =>
      onWebOrderReceived(
        guard((p) => {
          alerts.receiveOrder(p);
          ringIfDue();
          // The till prices it differently from what the website showed: the
          // customer expects the other amount. Stays until closed.
          if (p.totalMismatch) {
            toast({
              title: `Online order ${shortOrderNumber(p.orderNumber)}: the total changed`,
              description: `The website showed ${formatCents(p.totalMismatch.webTotalCents)}, the till bills ${formatCents(p.totalMismatch.tillTotalCents)}. Call ${p.customerName || 'the customer'} before it goes out — and publish the menu again (Settings → Online orders).`,
              variant: 'warning',
              duration: Infinity,
              // The shop's order, not the last login's: it stays for whoever signs in next.
              keepOnLogout: true,
            });
          }
        }),
      ),
    [ringIfDue, toast],
  );

  const retryNoted = useRef(new Set<string>());
  useEffect(
    () =>
      onWebOrderImportFailed(
        guard((p) => {
          const failure = failureFromEvent(p, Date.now());
          if (failure) {
            alerts.receiveFailure(failure);
            ringIfDue();
            return;
          }
          // Still retrying: no alarm, and no "call the customer" yet — that is
          // how an order that came in on the next try got cooked twice.
          if (retryNoted.current.has(p.webOrderId)) return;
          retryNoted.current.add(p.webOrderId);
          toast({
            title: `Website order from ${p.customerName || 'a customer'} is having trouble`,
            description: "The till is trying again by itself. Don't take it by phone yet — the till will say so if it does not come in.",
            variant: 'warning',
            duration: 20_000,
            keepOnLogout: true,
          });
        }),
      ),
    [ringIfDue, toast],
  );

  const lastPrinterTone = useRef(0);
  useEffect(
    () =>
      onPrinterFailed(
        guard((p) => {
          const now = Date.now();
          const s = settingsRef.current;
          const effect = printerFailureEffect(p, {
            loggedIn: loggedInRef.current,
            settings: s,
            now,
            lastToneAt: lastPrinterTone.current,
          });
          // Logged out, the banner is the only place that can say the kitchen
          // has no ticket — once the till has stopped retrying (eventTones.ts).
          // The PIN screen's "did not print" note reads the watch now, not
          // on its next round.
          if (effect.ticketFailedOrderId) {
            alerts.markTicketFailed(effect.ticketFailedOrderId);
            void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY });
          }
          if (!effect.tone || !readyRef.current) return;
          lastPrinterTone.current = now;
          player.play('printer', s.volume);
        }),
      ),
    [player, qc],
  );

  const lastLowStockTone = useRef(0);
  useEffect(
    () =>
      onLowStock(
        guard(() => {
          const now = Date.now();
          const s = settingsRef.current;
          if (!readyRef.current) return;
          if (!lowStockTone({ loggedIn: loggedInRef.current, settings: s, now, lastToneAt: lastLowStockTone.current })) return;
          lastLowStockTone.current = now;
          player.play('lowStock', s.volume);
        }),
      ),
    [player],
  );

  // A click on the Windows notice: the main process brought the till to the
  // front; with someone logged in, open Live Orders.
  useEffect(
    () =>
      onAlertOpen(
        guard((p) => {
          void syncFromMain().then(() => {
            if (p.kind !== 'newOrder' || !loggedInRef.current || !canViewRef.current) return;
            alerts.acknowledgeAllOrders();
            player.stop();
            void router.navigate('/orders');
          });
        }),
      ),
    [syncFromMain, player],
  );

  // Esc does what the Seen button on screen does (seenOnScreen: the alarm
  // shown, else the new orders — never an order hidden behind the alarm) —
  // first, before the page's own Esc (which would also step back in checkout
  // or clear a half-typed PIN). A popup keeps its Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      try {
        if (!isLoud(alerts.getState()) || popupOpen()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        alerts.seen();
        player.stop();
      } catch (err) {
        warnOnce('Order alerts: Esc failed', err);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [player]);

  // Orders waiting too long: reads the list the sidebar and the board already
  // keep fresh (every 15 s). Only if nobody has refreshed it for 2 minutes —
  // say its key changed — does this fetch it itself, so the reminder never
  // goes quiet unnoticed and never adds a polling loop of its own.
  const reminded = useRef<Set<string> | null>(null);
  const lastWaitTone = useRef(0);
  const boardUnusedNoted = useRef(false);
  useEffect(() => {
    if (!loggedIn || !canView) return;
    let stopped = false;
    const review = guard((snaps: OrderSnapshot[]) => {
      const now = Date.now();
      const s = settingsRef.current;
      if (!reminded.current) reminded.current = loadReminded();
      const ringing = new Set(alerts.getState().orders.map((o) => o.orderId));
      const timing = kitchenRef.current;
      const { due, boardUnused, tone } = planWaitingReminders(toWaitingOrders(snaps), {
        loggedIn: loggedInRef.current,
        settings: s,
        now,
        lastToneAt: lastWaitTone.current,
        reminded: reminded.current,
        ringing,
        timing,
      });
      if (boardUnused) {
        if (!boardUnusedNoted.current) {
          boardUnusedNoted.current = true;
          toast({
            title: 'Orders are not being moved along on Live Orders',
            description: boardUnusedText(timing),
            variant: 'info',
            duration: 15_000,
            keepOnLogout: true,
          });
        }
        return;
      }
      if (due.length === 0) return;
      for (const d of due) reminded.current.add(d.key);
      saveReminded(reminded.current);
      if (tone) {
        lastWaitTone.current = now;
        player.play('waiting', s.volume);
      }
      const text = describeReminders(due, timing);
      toast({ title: text.title, description: text.description, variant: 'warning', duration: 15_000, keepOnLogout: true });
    });
    const check = async () => {
      // The saved sounds are not in yet: nothing is marked, the next round has it.
      if (!readyRef.current) return;
      let snaps: OrderSnapshot[];
      try {
        snaps = await qc.fetchQuery({
          queryKey: ACTIVE_ORDERS_KEY,
          queryFn: () => ipc.orders.listActive(undefined),
          staleTime: ACTIVE_ORDERS_FRESH_MS,
        });
      } catch {
        return; // the till could not read its orders: try again next round
      }
      if (!stopped) review(snaps);
    };
    void check();
    const t = window.setInterval(() => void check(), REMIND_TICK_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [loggedIn, canView, qc, toast, player]);

  // The watch (alerts:getWatch): kitchen tickets that did not print, orders
  // waiting too long and website orders not confirmed, as notes on the
  // banner. A sign-in or sign-out reads it again, and until that answer is in
  // only the not-confirmed note shows and nothing beeps: a ticket reprinted
  // or an order started while signed in must not beep on the way out.
  const watch = useAlertWatch();
  const [allNotes, setNotes] = useState<WatchNote[]>([]);
  // What the banner shows: signed in, less the notes put away with Hide.
  const notes = shownNotes(allNotes, hiddenNotes, signedIn);
  const lastWatchTone = useRef(0);
  const announced = useRef<Set<string>>(new Set());
  const prevSignedIn = useRef(signedIn);
  const signedInChangedAt = useRef(0);
  useEffect(() => {
    if (prevSignedIn.current === signedIn) return;
    prevSignedIn.current = signedIn;
    signedInChangedAt.current = Date.now();
    // Hide lasts for one login: the next person sees every note.
    alerts.showHiddenNotes();
    void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY });
  }, [signedIn, qc]);
  useEffect(() => {
    const data = watch.data;
    if (!data) return;
    try {
      const now = Date.now();
      const fresh = watch.dataUpdatedAt >= signedInChangedAt.current;
      // The new-order row says it too, while the order rings.
      for (const t of data.ticketsNotPrinted) alerts.markTicketFailed(t.orderId);
      const next = watchNotes(data, {
        signedIn: signedIn || !fresh,
        includeCounter: settingsRef.current.waitingIncludesCounter,
        ringing: new Set(alerts.getState().orders.map((o) => o.orderId)),
        now,
        formatTime: (iso) => orderTimeLabel(iso, new Date(now)),
      });
      setNotes(next);
      // The saved sounds are not in yet: nothing is counted as heard, the next round beeps.
      if (!fresh || !readyRef.current) return;
      const s = settingsRef.current;
      // Only what the banner can show beeps: a hidden note is not on it, and
      // a popup shrinks the banner to the pill, which shows no note.
      const plan = planWatchTone(shownNotes(next, alerts.getHiddenNotes(), signedIn), {
        signedIn,
        settings: s,
        now,
        lastToneAt: lastWatchTone.current,
        announced: announced.current,
        chimeRinging: isLoud(alerts.getState()),
        notesOnScreen: !popupOpen(),
        shiftOpen: data.shiftOpen,
      });
      const shown = new Set(next.flatMap((n) => n.keys));
      announced.current = new Set([...[...announced.current].filter((k) => shown.has(k)), ...plan.announce]);
      if (plan.sound) {
        lastWatchTone.current = now;
        player.play(plan.sound, s.volume);
      }
    } catch (e) {
      warnOnce('Order alerts: the watch failed', e);
    }
  }, [watch.data, watch.dataUpdatedAt, signedIn, player]);

  // A note alone also shrinks the banner while a popup is open (it would cover a payment).
  const compact = usePopupOpen(hasPending || notes.length > 0);
  const offText = loaded && newOrderSoundIsOff(settings) ? soundOffText(settings) : '';

  return (
    <>
      <AlertBanner
        state={state}
        notes={notes}
        loggedIn={loggedIn}
        canView={loggedIn && canView}
        compact={compact}
        formatMoney={formatCents}
        onView={() => {
          alerts.acknowledgeAllOrders();
          player.stop();
          void router.navigate('/orders');
        }}
        onSeen={() => {
          alerts.seen();
          player.stop();
        }}
        onCloseFailure={(id) => alerts.closeFailure(id)}
        onHideNote={signedIn ? (n) => alerts.hideNote(n) : undefined}
      />
      {offText && (
        // Nobody can switch the order chime off unnoticed: every screen says so.
        <div
          role="status"
          className="pointer-events-none fixed bottom-2 left-2 z-[90] flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 shadow-soft-sm ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700"
        >
          <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
          {offText}
        </div>
      )}
    </>
  );
}

/**
 * A bug in the alerts must never blank the till mid-service: it shows
 * nothing and tries again half a minute later (a few times).
 */
class AlertsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  private retries = 0;
  private timer: number | undefined;

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.warn('Order alerts stopped; trying again shortly', error);
    if (this.retries >= 5) return;
    this.retries += 1;
    this.timer = window.setTimeout(() => this.setState({ failed: false }), 30_000);
  }

  override componentWillUnmount(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
