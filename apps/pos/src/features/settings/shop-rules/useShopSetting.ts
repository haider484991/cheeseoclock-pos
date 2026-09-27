import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShopSettingKey, ShopSettingValues } from '@cheeseoclock/shared-types';
import { ipc, IpcError, onShopSettingsChanged, onSyncStatusChanged } from '../../../ipc/client';
import { useToast } from '../../../components/toast/ToastProvider';
import { discountRulesOf, kitchenTimingOf, type CounterDiscountRules, type CounterKitchenTiming } from './counterRules';

/** Every shop-rule query (Settings cards, the counter's rules) is under this key. */
export const SHOP_SETTINGS_KEY = ['shop-settings'] as const;
export const CHECKOUT_RULES_KEY = ['checkout-rules'] as const;

/**
 * Re-read the shop rules when they change — saved here or arrived from the
 * other till (main process 'shop-settings:changed'). Mount once per screen
 * that shows them.
 */
export function useShopSettingsLive(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      onShopSettingsChanged(() => {
        void qc.invalidateQueries({ queryKey: SHOP_SETTINGS_KEY });
        void qc.invalidateQueries({ queryKey: CHECKOUT_RULES_KEY });
      }),
    [qc],
  );
}

/**
 * What the counter needs (any signed-in login): the F3 approval limit and
 * buttons, the Live Orders timings, the foodpanda deal and Pay's checks.
 */
export function useCheckoutRules(opts: { enabled?: boolean } = {}) {
  useShopSettingsLive();
  return useQuery({
    queryKey: CHECKOUT_RULES_KEY,
    queryFn: () => ipc.checkout.getRules(),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/** The F3 screen's approval limit and buttons (the released ones until the till has answered). */
export function useDiscountRules(): CounterDiscountRules & { refetch: () => void } {
  const q = useCheckoutRules();
  return { ...discountRulesOf(q.data), refetch: () => void q.refetch() };
}

/**
 * The Live Orders colours and reminder minutes (the released ones until the
 * till has answered). `enabled: false` while nobody is signed in (the
 * reminders' loop is mounted on the PIN pad too; the till would refuse).
 */
export function useKitchenTiming(opts: { enabled?: boolean } = {}): CounterKitchenTiming {
  return kitchenTimingOf(useCheckoutRules(opts).data);
}

/**
 * While a card says "Not on the other till yet" it is read again every so
 * often (the sync worker's own pass re-reads it sooner): the note goes once
 * the save has reached the other till, without leaving the tab. Otherwise
 * it is not polled.
 */
export const WAITING_CARD_REFETCH_MS = 10_000;
export function waitingCardRefetchMs(card: { notOnOtherTillYet: boolean } | undefined): number | false {
  return card?.notOnOtherTillYet ? WAITING_CARD_REFETCH_MS : false;
}

/** One Settings card (owner only), with Save and "Put back the default". */
export function useShopSetting<K extends ShopSettingKey>(key: K) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: [...SHOP_SETTINGS_KEY, key],
    queryFn: () => ipc.settings.getBusiness(key),
    staleTime: 0,
    refetchInterval: (query) => waitingCardRefetchMs(query.state.data),
  });
  // Waiting for the other till: re-read after each sync pass (sync:status-changed).
  const waiting = q.data?.notOnOtherTillYet === true;
  useEffect(() => {
    if (!waiting) return;
    return onSyncStatusChanged(() => void qc.invalidateQueries({ queryKey: [...SHOP_SETTINGS_KEY, key] }));
  }, [waiting, qc, key]);
  const done = (what: string) => {
    toast({ title: what, description: 'On both tills once they are linked.', variant: 'success' });
    void qc.invalidateQueries({ queryKey: SHOP_SETTINGS_KEY });
    void qc.invalidateQueries({ queryKey: CHECKOUT_RULES_KEY });
    void qc.invalidateQueries({ queryKey: ['reports'] });
    void qc.invalidateQueries({ queryKey: ['costing'] });
  };
  const failed = (e: unknown) =>
    toast({ title: 'Not saved', description: e instanceof IpcError ? e.message : String(e), variant: 'error' });
  const save = useMutation({
    mutationFn: (value: ShopSettingValues[K]) => ipc.settings.setBusiness(key, value),
    onSuccess: (card) => {
      qc.setQueryData([...SHOP_SETTINGS_KEY, key], card);
      done('Saved');
    },
    onError: failed,
  });
  const putBack = useMutation({
    mutationFn: () => ipc.settings.putBackDefault(key),
    onSuccess: (card) => {
      qc.setQueryData([...SHOP_SETTINGS_KEY, key], card);
      done('Default put back');
    },
    onError: failed,
  });
  return { q, save, putBack };
}
