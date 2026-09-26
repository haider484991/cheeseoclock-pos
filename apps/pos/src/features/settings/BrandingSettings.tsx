import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Eye, Store } from 'lucide-react';
import { logoBox, type MonoRaster } from '@cheeseoclock/printer-core';
import { LogoPicker } from './LogoPicker';
import { darkLogoFix, receiptLogoUpToDate, saveReceiptLogo, type LogoPreview } from './receiptLogo';
import { PrintedLogo, useReceiptLogoPreview } from './ReceiptLogoPreview';
import { SidebarBrand } from '../shell/Sidebar';
import { LoginBrand } from '../auth/LoginPage';

const DEFAULT_NAME = 'Cheese O Clock';

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
    setFooterLine(saved.footerLine ?? '');
    setLogoUrl(saved.logoUrl ?? null);
  }, [saved]);

  const dirty =
    !!saved &&
    (storeName !== saved.storeName ||
      storeTagline !== (saved.storeTagline ?? '') ||
      branchLine !== (saved.branchLine ?? '') ||
      phoneLine !== (saved.phoneLine ?? '') ||
      footerLine !== (saved.footerLine ?? '') ||
      logoUrl !== (saved.logoUrl ?? null));

  const saveMut = useMutation({
    mutationFn: async () => {
      await ipc.printer.setBranding({
        storeName: storeName.trim() || DEFAULT_NAME,
        ...(storeTagline.trim() ? { storeTagline: storeTagline.trim() } : {}),
        ...(branchLine.trim() ? { branchLine: branchLine.trim() } : {}),
        ...(phoneLine.trim() ? { phoneLine: phoneLine.trim() } : {}),
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
          with the logo in black and white (see the preview below), then the name and the lines
          you fill in here. The name and lines also go to the website when you publish the menu.
        </p>

        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-stone-700 dark:text-stone-200">Logo</div>
            <LogoPicker value={logoUrl} onChange={setLogoUrl} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Shop name"
              hint="Big and bold at the top of receipts, under the logo."
              value={storeName}
              onChange={setStoreName}
              placeholder={DEFAULT_NAME}
            />
            <Field
              label="Tagline"
              hint="Optional. One short line under the name."
              value={storeTagline}
              onChange={setStoreTagline}
              placeholder="Pizza · Burgers · Late-night delivery"
            />
            <Field
              label="Address"
              value={branchLine}
              onChange={setBranchLine}
              placeholder="DHA Phase 6, Karachi"
            />
            <Field label="Phone" value={phoneLine} onChange={setPhoneLine} placeholder="0300 9367865" />
          </div>
          <Field
            label="Thank-you line"
            hint="Printed at the bottom of every receipt."
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
              name={shownName}
              tagline={storeTagline.trim()}
              address={branchLine.trim()}
              phone={phoneLine.trim()}
              footer={footerLine.trim() || 'Thank you — visit us again!'}
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
      return { text: 'Add a logo and it prints at the top of customer receipts.', warn: false };
    case 'loading':
      return { text: 'Getting the logo ready for the printer…', warn: false };
    case 'error':
      return {
        text: "The till couldn't read this logo for the printer, so receipts print without it. Try uploading it again.",
        warn: true,
      };
    case 'blank':
      return {
        text: 'This logo is too light to print, so receipts leave it out. A darker logo works better.',
        warn: true,
      };
    case 'too_dark':
      return {
        text: `This logo would print as a big black block, so receipts leave it out. Upload ${darkLogoFix(logoUrl)}.`,
        warn: true,
      };
    case 'ready':
      return on
        ? {
            text: "Your logo prints in black and white at the top of customer receipts, like this. Kitchen tickets don't show it.",
            warn: false,
          }
        : {
            text: 'The logo is turned off for receipts. Turn it on under Printers → What prints, and when.',
            warn: false,
          };
  }
}

/** The receipt header and footer as the printer lays them out (logo, centred text, big name). */
function ReceiptPreview(props: {
  logo: MonoRaster | null;
  paperDots: number;
  name: string;
  tagline: string;
  address: string;
  phone: string;
  footer: string;
}) {
  return (
    <div className="mx-auto w-[18rem] max-w-full bg-white px-4 py-5 text-center font-mono text-[11px] leading-snug text-stone-900 shadow-soft ring-1 ring-stone-200">
      {props.logo && (
        <div className="mb-2">
          <PrintedLogo raster={props.logo} paperDots={props.paperDots} />
        </div>
      )}
      <div className="break-words text-lg font-bold leading-tight">{props.name}</div>
      {props.tagline && <div className="mt-1 break-words">{props.tagline}</div>}
      {(props.address || props.phone) && <div className="mt-2" />}
      {props.address && <div className="break-words">{props.address}</div>}
      {props.phone && <div className="break-words">{props.phone}</div>}
      <div className="my-3 border-t border-dashed border-stone-400" />
      <div className="text-left text-stone-400">
        <div className="flex justify-between">
          <span>1x Your order</span>
          <span>0.00</span>
        </div>
        <div className="mt-1">…</div>
      </div>
      <div className="my-3 border-t border-dashed border-stone-400" />
      <div className="break-words">{props.footer}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
      />
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}
