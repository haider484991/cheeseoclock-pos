/**
 * "Close the till?" on screen (v0.7.33): the question the till asks when X,
 * Alt+F4 or the taskbar's Close is pressed while website orders come in
 * through it (electron/services/till-close.ts). Rendered to static markup
 * (react-dom/server, no browser); the till's IPC is a stand-in that records
 * the answers.
 *
 *  - the words, and the website orders still on Live Orders;
 *  - "Keep the till open" has the focus; Esc, Enter and a tap outside keep
 *    the till open; the keys stay in the question, so the PIN screen behind
 *    it never takes Enter as "Sign in" or a digit as part of the PIN;
 *  - "Close the till" reads "Closing…" and cannot be pressed again; an
 *    answer the till no longer wants drops the question;
 *  - never the browser's own confirm() or alert().
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloseTillAsk } from '@cheeseoclock/shared-types';
import {
  CLOSE_TILL_CLOSE,
  CLOSE_TILL_CLOSING,
  CLOSE_TILL_KEEP,
  CLOSE_TILL_TITLE,
  CloseTillHost,
  CloseTillQuestion,
  closeTill,
  closeTillLines,
  closeTillRequested,
  keepTillOpen,
  useCloseTillStore,
} from './CloseTillHost';

// A server render has no portal: the dialog's parts render in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode; className?: string };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  const tag =
    (t: string, extra: Record<string, string> = {}) =>
    ({ children, className }: P) =>
      h(t, { className, ...extra }, children);
  return {
    Root: pass,
    Portal: pass,
    Overlay: () => null,
    Content: tag('div', { role: 'dialog' }),
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

// A server render reads a zustand store's INITIAL state; the till's window
// reads it as it is now, and so do these renders.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

const till = vi.hoisted(() => ({
  answers: [] as Array<[string, boolean]>,
  /** What the till answers "Close the till" with: closing true, false, or a failure. */
  closeReply: 'closing' as 'closing' | 'out-of-date' | 'fails',
}));
vi.mock('../../ipc/client', () => ({
  ipc: {
    system: {
      closeShown: async () => ({ pending: true }),
      closeAnswer: async (requestId: string, close: boolean) => {
        till.answers.push([requestId, close]);
        if (close && till.closeReply === 'fails') throw new Error('The app is restarting');
        return { closing: close && till.closeReply === 'closing' };
      },
    },
  },
  onCloseTillRequested: () => () => {},
}));


const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** One button's opening tag, found by its data-answer. */
const button = (markup: string, answer: 'keep' | 'close') =>
  markup.match(new RegExp(`<button[^>]*data-answer="${answer}"[^>]*>([^<]*)</button>`)) ?? null;

const ASK: CloseTillAsk = { requestId: 'ask-1', openWebOrders: 2 };
const noop = () => {};

/** The question's React elements, walked without rendering (the handlers Radix would call). */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}
function question(opts: { closing?: boolean; onKeep?: () => void } = {}) {
  const tree = elements(
    CloseTillQuestion({ ask: ASK, closing: opts.closing ?? false, onKeep: opts.onKeep ?? noop, onClose: noop }),
  );
  const root = tree[0]!.props as { onOpenChange: (open: boolean) => void };
  const content = tree.find((e) => (e.props as Record<string, unknown>)['data-close-till'] !== undefined);
  if (!content) throw new Error('no dialog content');
  return {
    root,
    content: content.props as {
      onKeyDown: (e: { stopPropagation: () => void }) => void;
      onOpenAutoFocus: (e: { preventDefault: () => void; currentTarget: unknown }) => void;
      onEscapeKeyDown: (e: { preventDefault: () => void }) => void;
    },
  };
}

beforeEach(() => {
  useCloseTillStore.setState({ ask: null, closing: false, nudge: 0 });
  till.answers.length = 0;
  till.closeReply = 'closing';
});

describe('the words', () => {
  it('what closing stops, and the website orders still on Live Orders', () => {
    expect(closeTillLines(0)).toEqual(['Website orders stop until the till is opened again.']);
    expect(closeTillLines(1)).toEqual([
      'Website orders stop until the till is opened again.',
      '1 website order is still on Live Orders.',
    ]);
    expect(closeTillLines(3)).toEqual([
      'Website orders stop until the till is opened again.',
      '3 website orders are still on Live Orders.',
    ]);
  });

  it('the question: its title, the lines, "Keep the till open" first and "Close the till" in red', () => {
    const markup = renderToStaticMarkup(<CloseTillQuestion ask={ASK} closing={false} onKeep={noop} onClose={noop} />);
    expect(markup).toContain('role="dialog"');
    expect(text(markup)).toBe(
      `${CLOSE_TILL_TITLE} Website orders stop until the till is opened again. 2 website orders are still on Live Orders. ${CLOSE_TILL_KEEP} ${CLOSE_TILL_CLOSE}`,
    );
    expect([CLOSE_TILL_TITLE, CLOSE_TILL_KEEP, CLOSE_TILL_CLOSE, CLOSE_TILL_CLOSING]).toEqual([
      'Close the till?',
      'Keep the till open',
      'Close the till',
      'Closing…',
    ]);
    const keep = button(markup, 'keep');
    const close = button(markup, 'close');
    expect(keep?.[1]).toBe('Keep the till open');
    expect(close?.[1]).toBe('Close the till');
    expect(close?.[0]).toContain('from-red-500');
    expect(close?.[0]).not.toContain('disabled=""');
    expect(markup.indexOf('data-answer="keep"')).toBeLessThan(markup.indexOf('data-answer="close"'));
  });

  it('while closing: "Closing…", and it cannot be pressed again', () => {
    const markup = renderToStaticMarkup(<CloseTillQuestion ask={ASK} closing onKeep={noop} onClose={noop} />);
    const close = button(markup, 'close');
    expect(close?.[1]).toBe(CLOSE_TILL_CLOSING);
    expect(close?.[0]).toContain('disabled=""');
    // "Keep the till open" can still be read; the till is already closing, so it does nothing.
    expect(button(markup, 'keep')?.[0]).not.toContain('disabled=""');
    expect(text(markup)).toBe(
      `${CLOSE_TILL_TITLE} Website orders stop until the till is opened again. 2 website orders are still on Live Orders. ${CLOSE_TILL_KEEP} ${CLOSE_TILL_CLOSING}`,
    );
  });
});

describe('the keys and the focus', () => {
  it('"Keep the till open" has the focus when the question opens', () => {
    const { content } = question();
    const focused: string[] = [];
    const preventDefault = vi.fn();
    content.onOpenAutoFocus({
      preventDefault,
      currentTarget: {
        querySelector: (sel: string) => (sel === '[data-answer="keep"]' ? { focus: () => focused.push(sel) } : null),
      },
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focused).toEqual(['[data-answer="keep"]']);
  });

  it('every key stays in the question: the PIN screen behind it never sees Enter or a digit', () => {
    const { content } = question();
    const stopPropagation = vi.fn();
    content.onKeyDown({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('Esc and a tap outside keep the till open; Esc does nothing while it is closing', () => {
    const onKeep = vi.fn();
    const open = question({ onKeep });
    open.root.onOpenChange(true);
    expect(onKeep).not.toHaveBeenCalled();
    open.root.onOpenChange(false);
    expect(onKeep).toHaveBeenCalledOnce();
    const esc = vi.fn();
    open.content.onEscapeKeyDown({ preventDefault: esc });
    expect(esc).not.toHaveBeenCalled();
    question({ closing: true }).content.onEscapeKeyDown({ preventDefault: esc });
    expect(esc).toHaveBeenCalledOnce();
  });
});

describe('the till asks, the person answers', () => {
  it('nothing on screen until the till asks', () => {
    expect(renderToStaticMarkup(<CloseTillHost />)).toBe('');
  });

  it('the till asks: the question shows; the same question again only nudges it; a new one replaces it', () => {
    closeTillRequested({ requestId: 'ask-1', openWebOrders: 1 });
    expect(text(renderToStaticMarkup(<CloseTillHost />))).toContain('1 website order is still on Live Orders.');
    closeTillRequested({ requestId: 'ask-1', openWebOrders: 1 });
    expect(useCloseTillStore.getState()).toMatchObject({ ask: { requestId: 'ask-1' }, nudge: 1 });
    closeTillRequested({ requestId: 'ask-2', openWebOrders: 0 });
    expect(useCloseTillStore.getState()).toEqual({ ask: { requestId: 'ask-2', openWebOrders: 0 }, closing: false, nudge: 0 });
  });

  it('"Keep the till open": the question goes and the till hears no', () => {
    closeTillRequested(ASK);
    keepTillOpen();
    expect(useCloseTillStore.getState().ask).toBeNull();
    expect(till.answers).toEqual([['ask-1', false]]);
  });

  it('"Close the till": "Closing…" stays up until the window goes; a second press or Keep does nothing', async () => {
    closeTillRequested(ASK);
    const pressed = closeTill();
    expect(useCloseTillStore.getState()).toMatchObject({ ask: ASK, closing: true });
    expect(text(renderToStaticMarkup(<CloseTillHost />))).toContain(CLOSE_TILL_CLOSING);
    await closeTill();
    keepTillOpen();
    await pressed;
    expect(till.answers).toEqual([['ask-1', true]]);
    expect(useCloseTillStore.getState()).toMatchObject({ ask: ASK, closing: true });
  });

  it('an answer the till no longer wants, or one that fails: the question goes, and the next X asks again', async () => {
    for (const reply of ['out-of-date', 'fails'] as const) {
      till.closeReply = reply;
      closeTillRequested(ASK);
      await closeTill();
      expect(useCloseTillStore.getState()).toEqual({ ask: null, closing: false, nudge: 0 });
    }
  });
});

describe('never the browser’s own question boxes', () => {
  it('no confirm(), alert() or prompt() in the close question', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'CloseTillHost.tsx'), 'utf8');
    expect(/\b(window\.)?(confirm|alert|prompt)\(/.test(src)).toBe(false);
  });
});
