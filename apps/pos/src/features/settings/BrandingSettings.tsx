import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Eye, Store } from 'lucide-react';
import {
  DEFAULT_FOOTER_LINE,
  logoBox,
  receiptHeadLines,
  receiptShopLines,
  type MonoRaster,
  type ReceiptBranding,
} from '@cheeseoclock/printer-core';
import { LogoPicker } from './LogoPicker';
import { darkLogoFix, receiptLogoUpToDate, saveReceiptLogo, type LogoPreview } from './receiptLogo';
import { PrintedLogo, useReceiptLogoPreview } from './ReceiptLogoPreview';
import { SidebarBrand } from '../shell/Sidebar';
import { LoginBrand } from '../auth/LoginPage';

const DEFAULT_NAME = 'Cheese O Clock';
/** The till refuses a longer one (printer-config.ts WEBSITE_MAX_CHARS). */
const WEBSITE_MAX_CHARS = 60;

export function BrandingSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });

  const [storeName, setStoreName] = useState('');
  const [storeTagline, setStoreTagline] = useState('');
  const [branchLine, setBranchLine] = useState('');
  const [phoneLine, setPhoneLine] = useState('');
  const [websiteLine, setWebsiteLine] = useState('');
  const [footerLine, setFooterLine] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  // Hydrate from the saved branding only. The printer cards on another tab
  // share this query; saving one of them must not wipe what is typed here.
  const saved = cfgQ.data?.branding;
  useEffect(() => {
    if (!saved) return;
    setStoreName(saved.storeName);
    setStoreTagline(saved.storeTagline ?? '');
    setBranchLine(saved.branchLine ?? '');
    setPhoneLine(saved.phoneLine ?? '');
    // A till that never set one reads the shop's own site here (printer-config.ts).
    setWebsiteLine(saved.websiteLine ?? '');
    setFooterLine(saved.footerLine ?? '');
    setLogoUrl(saved.logoUrl ?? null);
  }, [saved]);

  const dirty =
    !!saved &&
    (storeName !== saved.storeName ||
      storeTagline !== (saved.storeTagline ?? '') ||
      branchLine !== (saved.branchLine ?? '') ||
      phoneLine !== (saved.phoneLine ?? '') ||
      websiteLine !== (saved.websiteLine ?? '') ||
      footerLine !== (saved.footerLine ?? '') ||
      logoUrl !== (saved.logoUrl ?? null));

  const saveMut = useMutation({
    mutationFn: async () => {
      await ipc.printer.setBranding({
        storeName: storeName.trim() || DEFAULT_NAME,
        ...(storeTagline.trim() ? { storeTagline: storeTagline.trim() } : {}),
        ...(branchLine.trim() ? { branchLine: branchLine.trim() } : {}),
        ...(phoneLine.trim() ? { phoneLine: phoneLine.trim() } : {}),
        // Always sent: '' is "no website" (left out, the till would print its own site again).
        websiteLine: websiteLine.trim(),
        ...(footerLine.trim() ? { footerLine: footerLine.trim() } : {}),
        ...(logoUrl ? { logoUrl } : {}),
      });
      // The receipt printer's copy of a new logo. Receipts print (without the
      // logo) if this fails, and the till tries again on its own.
      if (logoUrl && !receiptLogoUpToDate(logoUrl, cfgQ.data?.logo.stored)) {
        await saveReceiptLogo(logoUrl).catch((e: unknown) => console.warn('Receipt logo not prepared', e));
      }
    },
    onSuccess: () => {
      toast({ title: 'Shop details saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
      // The sign-in screen reads the name and logo through its own query.
      void qc.invalidateQueries({ queryKey: ['system', 'branding'] });
    },
    onError: (e) =>
      toast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const shownName = storeName.trim() || DEFAULT_NAME;

  // The logo as this till's receipt printer would print it (on its paper width).
  const paper = cfgQ.data?.config.width ?? 48;
  const logoOn = cfgQ.data?.policy.logoOnReceipt ?? true;
  const printed = useReceiptLogoPreview(logoUrl, paper);
  const receiptLogo = logoOn && printed.state === 'ready' ? printed.raster : null;
  const note = logoNote(printed, logoOn, logoUrl);

  return (
    <>
      <Card>
        <div className="mb-1 flex items-center gap-2">
          <Store className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Shop details</h2>
        </div>
        <p className="mb-5 text-sm text-stone-500">
          Your logo and name show on the sign-in screen and in the menu bar. Customer receipts start
          with the logo in black and white and the tagline under it (see the preview below); the
          name prints there instead only when there is no logo to print. The address, phone and
          website go at the bottom, above the thank-you line. The name, tagline, address and phone
          also go to the website when you publish the menu.
        </p>

        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-stone-700 dark:text-stone-200">Logo</div>
            <LogoPicker value={logoUrl} onChange={setLogoUrl} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Shop name"
              hint="On receipts only when there is no logo to print: big and bold at the top."
              value={storeName}
              onChange={setStoreName}
              placeholder={DEFAULT_NAME}
            />
            <Field
              label="Tagline"
              hint="Optional. One short line under the logo."
              value={storeTagline}
              onChange={setStoreTagline}
              placeholder="Pizza · Burgers · Late-night delivery"
            />
            <Field
              label="Address"
              hint="At the bottom of receipts."
              value={branchLine}
              onChange={setBranchLine}
              placeholder="DHA Phase 6, Karachi"
            />
            <Field
              label="Phone"
              hint="At the bottom, under the address."
              value={phoneLine}
              onChange={setPhoneLine}
              placeholder="0300 9367865"
            />
            <Field
              label="Website"
              hint="At the bottom, under the phone. Leave empty for none."
              value={websiteLine}
              onChange={setWebsiteLine}
              placeholder="cheeseoclock.net"
              maxLength={WEBSITE_MAX_CHARS}
            />
          </div>
          <Field
            label="Thank-you line"
            hint="Printed at the very bottom of customer receipts and bills."
            value={footerLine}
            onChange={setFooterLine}
            placeholder="Thank you — order again on www.cheeseoclock.net"
          />

          <div className="flex items-center justify-end gap-3 border-t border-stone-200 pt-4 dark:border-stone-700">
            {dirty && (
              <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Not saved yet
              </span>
            )}
            <Button variant="primary" disabled={saveMut.isPending || !dirty} onClick={() => saveMut.mutate()}>
              {saveMut.isPending ? 'Saving…' : 'Save shop details'}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-1 flex items-center gap-2">
          <Eye className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Preview</h2>
        </div>
        <p className="mb-5 text-sm text-stone-500">
          Exactly how it will look, updated as you type. Press Save above to use it.
        </p>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            <PreviewFrame label="Menu bar (left side of the screen)">
              <div className="w-60 rounded-xl bg-white/90 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
                <SidebarBrand logoUrl={logoUrl} storeName={shownName} />
              </div>
            </PreviewFrame>
            <PreviewFrame label="Sign-in screen">
              <div className="w-full max-w-[400px] rounded-2xl bg-white/90 px-6 pt-6 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
                <LoginBrand logoUrl={logoUrl} storeName={shownName} tagline={storeTagline.trim() || null} />
              </div>
            </PreviewFrame>
          </div>
          <PreviewFrame label="Top and bottom of a printed receipt">
            <ReceiptPreview
              logo={receiptLogo}
              paperDots={logoBox(paper).maxWidth}
              branding={{ storeName: shownName, storeTagline, branchLine, phoneLine, websiteLine, footerLine }}
            />
            <p
              className={
                note.warn
                  ? 'mx-auto mt-2 max-w-[18rem] text-xs font-medium text-amber-700 dark:text-amber-400'
                  : 'mx-auto mt-2 max-w-[18rem] text-xs text-stone-500'
              }
            >
              {note.text}
            </p>
            {printed.state === 'ready' && printed.repaired && (
              <p className="mx-auto mt-1 max-w-[18rem] text-xs text-stone-500">
                The black background around your logo is left off on paper. For the sharpest
                print, upload a PNG with a see-through background.
              </p>
            )}
            {printed.state === 'ready' && printed.raster && (
              <div className="mt-3">
                <div className="mb-1 text-xs text-stone-500">Close-up of the printed logo</div>
                <div className="overflow-x-auto rounded bg-white p-2 ring-1 ring-stone-200">
                  <PrintedLogo raster={printed.raster} />
                </div>
              </div>
            )}
          </PreviewFrame>
        </div>
      </Card>
    </>
  );
}

function PreviewFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <div className="rounded-xl bg-stone-100 p-4 dark:bg-stone-800/60">{children}</div>
    </div>
  );
}

/** What the preview says about the logo on paper. */
function logoNote(p: LogoPreview, on: boolean, logoUrl: string | null): { text: string; warn: boolean } {
  switch (p.state) {
    case 'none':
      return { text: 'Add a logo and it prints at the top of customer receipts, in place of the shop name.', warn: false };
    case 'loading':
      return { text: 'Getting the logo ready for the printer…', warn: false };
    case 'error':
      return {
        text: "The till couldn't read this logo for the printer, so receipts print the shop name instead. Try uploading it again.",
        warn: true,
      };
    case 'blank':
      return {
        text: 'This logo is too light to print, so receipts print the shop name instead. A darker logo works better.',
        warn: true,
      };
    case 'too_dark':
      return {
        text: `This logo would print as a big black block, so receipts print the shop name instead. Upload ${darkLogoFix(logoUrl)}.`,
        warn: true,
      };
    case 'ready':
      return on
        ? {
            text: "Your logo prints in black and white at the top of customer receipts, like this, in place of the shop name. Kitchen tickets don't show it.",
            warn: false,
          }
        : {
            text: 'The logo is turned off for receipts, so they start with the shop name. Turn it on under Printers → What prints, and when.',
            warn: false,
          };
  }
}

/**
 * The top and bottom of a customer receipt as the printer lays them out, from
 * the same rules the receipt uses (printer-core receiptHeadLines /
 * receiptShopLines): the logo and the tagline on top — the name only when no
 * logo prints — and the address, phone, website and thank-you at the bottom.
 */
function ReceiptPreview({
  logo,
  paperDots,
  branding,
}: {
  logo: MonoRaster | null;
  paperDots: number;
  branding: ReceiptBranding;
}) {
  const head = receiptHeadLines(branding, logo !== null);
  const bottom = receiptShopLines(branding);
  const thanks = branding.footerLine?.trim() || DEFAULT_FOOTER_LINE;
  return (
    <div className="mx-auto w-[18rem] max-w-full bg-white px-4 py-5 text-center font-mono text-[11px] leading-snug text-stone-900 shadow-soft ring-1 ring-stone-200">
      {logo && (
        <div className="mb-2">
          <PrintedLogo raster={logo} paperDots={paperDots} />
        </div>
      )}
      {head.name && <div className="break-words text-lg font-bold leading-tight">{head.name}</div>}
      {head.tagline && <div className="mt-1 break-words">{head.tagline}</div>}
      <div className="mt-2 font-bold">RECEIPT</div>
      <div className="my-3 border-t border-dashed border-stone-400" />
      <div className="text-left text-stone-400">
        <div className="flex justify-between">
          <span>1x Your order</span>
          <span>0.00</span>
        </div>
        <div className="mt-1">…</div>
      </div>
      <div className="my-3 border-t border-dashed border-stone-400" />
      {bottom.map((line, i) => (
        <div key={i} className="break-words">
          {line}
        </div>
      ))}
      <div className="break-words">{thanks}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
      />
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}
