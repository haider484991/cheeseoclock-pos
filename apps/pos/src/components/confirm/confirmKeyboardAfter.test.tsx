/**
 * The in-window question (never the browser's confirm()) hands the keyboard
 * back once it has gone, to where the asker says (e2e v0.7.35, 3 Oct 2026):
 * a tap OUTSIDE the close box's "Stop closing the shift?" answered "Keep
 * counting", but Chromium put the keyboard on the page as the question
 * went, after the answer had put it on the row. Radix calls the dialog's
 * onCloseAutoFocus once it has gone (after every answer: a button, Enter,
 * Escape, a tap outside); the question then runs the asker's keyboardAfter.
 *
 * Rendered to static markup (no browser); Radix's dialog and the answer
 * buttons are stood in for by plain elements that keep the handlers they
 * were given.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const radix = vi.hoisted(() => ({ root: {} as Record<string, unknown>, content: {} as Record<string, unknown> }));

vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  return {
    Root: (props: P & Record<string, unknown>) => {
      radix.root = props;
      return pass(props);
    },
    Portal: pass,
    Overlay: () => null,
    Content: (props: P & Record<string, unknown>) => {
      radix.content = props;
      return h('div', { role: 'dialog' }, props.children);
    },
    Title: ({ children }: P) => h('h2', null, children),
    Description: ({ children }: P) => h('p', null, children),
  };
});

// The answers' buttons, kept by their data-answer so a test can press one.
const buttons = vi.hoisted(() => ({ onClick: {} as Record<string, () => void> }));
vi.mock('@cheeseoclock/ui', async () => {
  const React = await import('react');
  return {
    Button: (props: { children?: ReactNode; onClick: () => void; 'data-answer': string }) => {
      buttons.onClick[props['data-answer']] = props.onClick;
      return React.createElement('button', { 'data-answer': props['data-answer'] }, props.children);
    },
  };
});

// A server render reads a zustand store's INITIAL state (no question); the
// till's window reads it as it is now, and so does this render.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

const { askConfirm, ConfirmHost } = await import('./ConfirmHost');

/** The question on screen (a server render of the host). */
const show = () => renderToStaticMarkup(<ConfirmHost />);
/** Radix: the question has gone; its event, and whether the question took the keyboard's next stop over. */
const gone = () => {
  const event = { preventDefault: vi.fn() };
  (radix.content['onCloseAutoFocus'] as (e: typeof event) => void)(event);
  return event.preventDefault.mock.calls.length > 0;
};

beforeEach(() => {
  radix.root = {};
  radix.content = {};
});

describe('the question hands the keyboard back once it has gone', () => {
  it('a tap outside it (Radix: open → false) answers No; once it has gone, keyboardAfter runs, after the answer', async () => {
    const order: string[] = [];
    const answer = askConfirm('Stop closing the shift? The count you typed is not kept.', {
      safeDefault: true,
      yesLabel: 'Stop',
      noLabel: 'Keep counting',
      keyboardAfter: () => order.push('keyboard'),
    });
    expect(show()).toContain('Keep counting');
    (radix.root['onOpenChange'] as (open: boolean) => void)(false);
    await expect(answer.then((ok) => (order.push(`answer ${String(ok)}`), ok))).resolves.toBe(false);
    expect(show()).toBe('');
    // Radix's own way (the trigger, none here) is set aside: the asker's place wins.
    expect(gone()).toBe(true);
    expect(order).toEqual(['answer false', 'keyboard']);
  });

  it('every other answer too: "Keep counting" and "Clear all" pressed run it once the question has gone', async () => {
    for (const [press, ok] of [
      ['no', false],
      ['yes', true],
    ] as const) {
      const keyboardAfter = vi.fn();
      const answer = askConfirm('Clear every row of this count?', { safeDefault: true, yesLabel: 'Clear all', noLabel: 'Keep counting', keyboardAfter });
      show();
      buttons.onClick[press]?.();
      await expect(answer).resolves.toBe(ok);
      expect(keyboardAfter, 'not before the question has gone').not.toHaveBeenCalled();
      expect(gone()).toBe(true);
      expect(keyboardAfter).toHaveBeenCalledTimes(1);
    }
  });

  it('asked without it: Radix keeps its own way (nothing set aside)', async () => {
    const answer = askConfirm('Print the bill again?');
    show();
    (radix.root['onOpenChange'] as (open: boolean) => void)(false);
    await expect(answer).resolves.toBe(false);
    expect(gone()).toBe(false);
  });
});
