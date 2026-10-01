/**
 * "This computer" on screen (Settings → Online orders, v0.7.33), rendered to
 * static markup (react-dom/server, no browser; nothing calls the till): the
 * two choices with the owner's words, "this till only", what the till is
 * doing now, and "Turn it back on" only when Windows has the start-up entry
 * switched off or missing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PC_POWER,
  type PcPowerSetting,
  type StartWithWindowsState,
  type TillPowerStatus,
  type TillSettingCard,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { POWER_STATUS_KEY, ThisComputerCard } from '../ThisComputerCard';
import { TILL_SETTINGS_KEY } from './useTillSetting';
import { PC_POWER_LID_TIP, PC_POWER_NEVER_CHANGED } from './tillSettingsForm';

vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function card(value: PcPowerSetting, isDefault: boolean): TillSettingCard<'pc.power'> {
  return {
    key: 'pc.power',
    value,
    defaultValue: { ...DEFAULT_PC_POWER },
    isDefault,
    readOnly: false,
    lastChanged: isDefault ? null : { at: '2026-10-01T09:02:00.000Z', byName: 'Test Owner', onThisTill: true },
    notOnOtherTillYet: false,
    history: [],
  };
}

function status(over: Partial<TillPowerStatus> = {}): TillPowerStatus {
  return { keepAwake: 'on', startWithWindows: 'on', openedAt: '2026-10-01T09:00:00.000Z', lastSleep: null, ...over };
}

function screen(value: PcPowerSetting, isDefault: boolean, st: TillPowerStatus | null): string {
  const seed: Array<[readonly unknown[], unknown]> = [[[...TILL_SETTINGS_KEY, 'pc.power'], card(value, isDefault)]];
  if (st) seed.push([POWER_STATUS_KEY, st]);
  return render(<ThisComputerCard />, seed);
}

describe('This computer: the card', () => {
  it('by default: both on, this till only, the owner’s words, and what never changed means', () => {
    const markup = screen(DEFAULT_PC_POWER, true, status());
    const words = text(markup);
    expect(words).toContain('This computer');
    expect(words).toContain('Default');
    expect(words).toContain('This till only: the other till keeps its own.');
    expect(words).toContain('A till that is asleep or closed takes no website orders: the website closes by itself within 3 minutes.');
    expect(words).toContain('Keep this computer awake while it takes website orders');
    expect(words).toContain(
      'While this till takes website orders (a shift is open and online orders are on), the screen stays on and the computer does not go to sleep. Closing a laptop’s lid or pressing the power button still puts it to sleep.',
    );
    expect(words).toContain('Start the till with Windows');
    expect(words).toContain(PC_POWER_NEVER_CHANGED);
    expect(words).toContain(PC_POWER_LID_TIP);
    // Both "Yes" answers are the ones picked.
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>Yes — while it takes website orders/);
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>Yes — by itself/);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(words).not.toContain('Turn it back on');
  });

  it('the status line says whether it is held awake right now', () => {
    expect(text(screen(DEFAULT_PC_POWER, true, status({ keepAwake: 'on' })))).toContain(
      'Awake now: this till is taking website orders, so Windows won’t let the screen or the computer sleep.',
    );
    expect(text(screen(DEFAULT_PC_POWER, true, status({ keepAwake: 'idle' })))).toContain(
      'Not held awake now: this till is not taking website orders (no shift open, or online orders off).',
    );
  });

  it('"Turn it back on" only when Windows has the entry switched off or missing', () => {
    const shown: Record<string, boolean> = {};
    for (const s of ['on', 'off', 'offInWindows', 'missing', 'notInstalled'] as StartWithWindowsState[]) {
      shown[s] = text(screen(DEFAULT_PC_POWER, true, status({ startWithWindows: s }))).includes('Turn it back on');
    }
    expect(shown).toEqual({ on: false, off: false, offInWindows: true, missing: true, notInstalled: false });
    expect(text(screen(DEFAULT_PC_POWER, true, status({ startWithWindows: 'offInWindows' })))).toContain(
      'Windows has this switched off (Task Manager → Startup apps).',
    );
  });

  it('a test build or a dev run says only the installed till can start with Windows', () => {
    expect(text(screen(DEFAULT_PC_POWER, true, status({ startWithWindows: 'notInstalled' })))).toContain(
      'Only the installed till can start with Windows.',
    );
  });

  it('both switched off by the owner: the "No" answers are picked, last changed is shown', () => {
    const markup = screen({ keepAwake: false, startWithWindows: false }, false, status({ keepAwake: 'off', startWithWindows: 'off' }));
    const words = text(markup);
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>No — Windows decides/);
    expect(markup).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>No — someone opens it/);
    expect(words).toContain('Windows may put this computer to sleep.');
    expect(words).toContain('The till does not start with Windows.');
    expect(words).toContain('Last changed by Test Owner on this till');
  });

  it('never asks with window.confirm, alert or prompt ("Put back the default" uses the app’s own dialog)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['../ThisComputerCard.tsx', 'tillSettingsForm.ts']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect({ f, native: /\b(window\.)?(confirm|alert|prompt)\(/.test(src) }).toEqual({ f, native: false });
    }
  });

  it('before the till answers: the choices, and no status line yet', () => {
    const words = text(screen(DEFAULT_PC_POWER, true, null));
    expect(words).toContain('Keep this computer awake while it takes website orders');
    expect(words).not.toContain('Awake now');
    expect(words).not.toContain('Starts with Windows: yes.');
  });
});
