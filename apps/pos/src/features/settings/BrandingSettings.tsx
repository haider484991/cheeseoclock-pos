import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, ImagePicker } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Store } from 'lucide-react';

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

  useEffect(() => {
    if (!cfgQ.data) return;
    const b = cfgQ.data.branding;
    setStoreName(b.storeName);
    setStoreTagline(b.storeTagline ?? '');
    setBranchLine(b.branchLine ?? '');
    setPhoneLine(b.phoneLine ?? '');
    setFooterLine(b.footerLine ?? '');
    setLogoUrl(b.logoUrl ?? null);
  }, [cfgQ.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      ipc.printer.setBranding({
        storeName: storeName.trim() || 'Cheese O Clock',
        ...(storeTagline.trim() ? { storeTagline: storeTagline.trim() } : {}),
        ...(branchLine.trim() ? { branchLine: branchLine.trim() } : {}),
        ...(phoneLine.trim() ? { phoneLine: phoneLine.trim() } : {}),
        ...(footerLine.trim() ? { footerLine: footerLine.trim() } : {}),
        ...(logoUrl ? { logoUrl } : {}),
      }),
    onSuccess: () => {
      toast({ title: 'Branding saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Store className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Receipt branding</h2>
      </div>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
            Company logo
          </label>
          <ImagePicker
            value={logoUrl}
            onChange={setLogoUrl}
            rounded
            emptyLabel="Logo"
          />
          <div className="mt-1 text-[10px] text-stone-500">
            Shown in the sidebar, login screen, and receipt header.
          </div>
        </div>
        <Field label="Store name" value={storeName} onChange={setStoreName} placeholder="Cheese O Clock" />
        <Field
          label="Tagline"
          value={storeTagline}
          onChange={setStoreTagline}
          placeholder="Pakistani Pizza · Cafe"
        />
        <Field
          label="Branch / address"
          value={branchLine}
          onChange={setBranchLine}
          placeholder="F-10 Markaz, Islamabad"
        />
        <Field
          label="Phone"
          value={phoneLine}
          onChange={setPhoneLine}
          placeholder="+92 51 1234 5678"
        />
        <Field
          label="Footer"
          value={footerLine}
          onChange={setFooterLine}
          placeholder="Thank you — visit us again!"
        />
        <div className="flex justify-end border-t border-stone-200 pt-3 dark:border-stone-700">
          <Button variant="primary" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? 'Saving…' : 'Save branding'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
      />
    </div>
  );
}
