import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TillSettingKey, TillSettingValues } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../../ipc/client';
import { useToast } from '../../../components/toast/ToastProvider';

/** Every "this till" card's query is under this key. */
export const TILL_SETTINGS_KEY = ['till-settings'] as const;

/**
 * One "this till" Settings card (owner only): the receipt's extra lines,
 * the opening float. Saved on this till alone (never synced), with Save and
 * "Put back the default", like a shop rule's card.
 */
export function useTillSetting<K extends TillSettingKey>(key: K) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: [...TILL_SETTINGS_KEY, key],
    queryFn: () => ipc.settings.getTill(key),
    staleTime: 0,
  });
  const done = (what: string) => {
    toast({ title: what, description: 'On this till.', variant: 'success' });
    void qc.invalidateQueries({ queryKey: TILL_SETTINGS_KEY });
    // What reads them: the receipt branding (the extra lines) and the Open shift box (the float).
    void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
    void qc.invalidateQueries({ queryKey: ['shifts', 'openingFloat'] });
  };
  const failed = (e: unknown) =>
    toast({ title: 'Not saved', description: e instanceof IpcError ? e.message : String(e), variant: 'error' });
  const save = useMutation({
    mutationFn: (value: TillSettingValues[K]) => ipc.settings.setTill(key, value),
    onSuccess: (card) => {
      qc.setQueryData([...TILL_SETTINGS_KEY, key], card);
      done('Saved');
    },
    onError: failed,
  });
  const putBack = useMutation({
    mutationFn: () => ipc.settings.putBackTillDefault(key),
    onSuccess: (card) => {
      qc.setQueryData([...TILL_SETTINGS_KEY, key], card);
      done('Default put back');
    },
    onError: failed,
  });
  return { q, save, putBack };
}
