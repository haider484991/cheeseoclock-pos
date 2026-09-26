import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LOGO_RASTER_ALGO, logoFingerprint } from '@cheeseoclock/printer-core';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { darkLogoFix, receiptLogoUpToDate, saveReceiptLogo } from './receiptLogo';

/** A failed attempt is tried again after this long (or at the next login), never straight away. */
const RETRY_MS = 30 * 60_000;
const TICK_MS = 5 * 60_000;

/** Attempts per logo (fingerprint + conversion version), for this run of the app. */
const attempts = new Map<string, { at: number; userId: string; busy: boolean }>();

const NOTICE_PREFIX = 'receiptLogo.notice.';
const shownThisRun = new Set<string>();

/** True the first time `key` is asked about on this till (remembered across restarts when possible). */
function firstTime(key: string): boolean {
  if (shownThisRun.has(key)) return false;
  shownThisRun.add(key);
  try {
    if (localStorage.getItem(NOTICE_PREFIX + key)) return false;
    localStorage.setItem(NOTICE_PREFIX + key, new Date().toISOString());
  } catch {
    // No storage: once per run is the best we can do.
  }
  return true;
}

/**
 * Keeps the receipt printer's copy of the shop logo in step with the logo,
 * for any login that may make it (managers and the owner). Covers a logo
 * saved by an older version and a logo changed on another screen. Renders
 * nothing.
 *
 * Also says, once per till, when the logo starts printing on receipts —
 * nobody has seen it on paper yet, and a printer that can't print pictures
 * would put out symbols — and, to the owner, when the logo is too dark to
 * print at all.
 */
export function ReceiptLogoKeeper() {
  const userId = useSessionStore((s) => s.user?.id ?? null);
  const canPrinters = useSessionStore((s) => s.can('printer.manage'));
  const canShop = useSessionStore((s) => s.can('settings.manage'));
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
    staleTime: 60_000,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const logoUrl = cfgQ.data?.branding.logoUrl;
  const status = cfgQ.data?.logo;
  const printer = cfgQ.data?.config;

  useEffect(() => {
    if (!canPrinters || !userId || !logoUrl || !status) return;
    if (receiptLogoUpToDate(logoUrl, status.stored)) return;
    const key = `${logoFingerprint(logoUrl)}:${LOGO_RASTER_ALGO}`;
    const last = attempts.get(key);
    if (last && (last.busy || (last.userId === userId && now - last.at < RETRY_MS))) return;
    const attempt = { at: Date.now(), userId, busy: true };
    attempts.set(key, attempt);
    saveReceiptLogo(logoUrl)
      .then(() => qc.invalidateQueries({ queryKey: ['printer', 'config'] }))
      .catch((e: unknown) => console.warn('Receipt logo not prepared; will try again later', e))
      .finally(() => {
        attempt.busy = false;
      });
  }, [canPrinters, userId, logoUrl, status, now, qc]);

  useEffect(() => {
    if (!logoUrl || !status || !printer) return;
    if (canPrinters && status.state === 'ready' && status.enabled && !status.checked) {
      if (firstTime(`ready.${status.stored?.source ?? ''}.${logoFingerprint(JSON.stringify(printer))}`)) {
        toast({
          title: 'Receipts now print your logo',
          description:
            'Press Test print in Settings → Printers once to check it on paper. If it comes out as odd symbols, turn "Logo on receipts" off there.',
          variant: 'warning',
          duration: 30_000,
        });
      }
    } else if (canShop && status.state === 'too_dark') {
      if (firstTime(`dark.${logoFingerprint(logoUrl)}`)) {
        toast({
          title: 'Your logo is left off receipts',
          description: `It would print as a big black block. Upload ${darkLogoFix(logoUrl)} under Settings → Shop & logo.`,
          variant: 'warning',
          duration: 30_000,
        });
      }
    }
  }, [canPrinters, canShop, logoUrl, status, printer, toast]);

  return null;
}
