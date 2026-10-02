/**
 * The shared NumberPad (packages/ui, which has no test runner) gained props
 * for the Close shift note count: showDisplay, enterLabel, keyClassName,
 * keyTabIndex and label. LoginPage and TenderDialog leave them out, and must
 * get exactly the markup they had: the GOLDEN_* strings below were captured
 * from NumberPad as released in v0.7.34, before the props were added, and
 * are never regenerated from the new code. Rendered to static markup
 * (react-dom/server, no browser).
 */
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NumberPad } from '@cheeseoclock/ui';

type NumberPadProps = Parameters<typeof NumberPad>[0];

const GOLDEN_PLAIN =
  '<div class="flex flex-col gap-4"><div class="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100" aria-label="PIN entry">12</div>' +
  '<div class="grid grid-cols-3 gap-3">' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">1</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">2</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">3</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">4</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">5</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">6</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">7</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">8</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">9</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100">←</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">0</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-amber-500 text-stone-900 hover:bg-amber-400">Enter</button></div></div>';

const GOLDEN_SUBMIT =
  '<div class="flex flex-col gap-4"><div class="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100" aria-label="PIN entry">12</div>' +
  '<div class="grid grid-cols-3 gap-3">' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">1</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">2</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">3</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">4</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">5</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">6</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">7</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">8</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">9</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100">←</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">0</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-amber-500 text-stone-900 hover:bg-amber-400">Enter</button></div></div>';

const GOLDEN_EMPTY =
  '<div class="flex flex-col gap-4"><div class="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100" aria-label="PIN entry"><span class="text-stone-400">_</span></div>' +
  '<div class="grid grid-cols-3 gap-3">' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">1</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">2</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">3</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">4</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">5</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">6</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">7</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">8</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">9</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100">←</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">0</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-amber-500 text-stone-900 hover:bg-amber-400">Enter</button></div></div>';

const GOLDEN_LOGIN =
  '<div class="flex flex-col gap-4 [@media(max-height:820px)]:gap-2"><div class="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100" aria-label="PIN entry">••</div>' +
  '<div class="grid grid-cols-3 gap-3">' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">1</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">2</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">3</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">4</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">5</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">6</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">7</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">8</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">9</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100">←</button>' +
  '<button type="button" class="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700">0</button>' +
  '<button type="button" class="h-16 rounded-lg text-xl font-semibold bg-amber-500 text-stone-900 hover:bg-amber-400">Enter</button></div></div>';

const noop = (): void => {};

/** The box above the keys in GOLDEN_PLAIN (value '12'). */
const DISPLAY_12 = GOLDEN_PLAIN.slice(
  '<div class="flex flex-col gap-4">'.length,
  GOLDEN_PLAIN.indexOf('<div class="grid grid-cols-3 gap-3">'),
);

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Every <button> NumberPad returns, with its props, so a test can press one. */
function buttonsOf(props: NumberPadProps): Array<{ text: string; onClick: () => void }> {
  const found: Array<{ text: string; onClick: () => void }> = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object' || !('props' in node)) return;
    const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (el.type === 'button' && el.props.onClick) {
      found.push({ text: String(el.props.children), onClick: el.props.onClick });
    }
    walk(el.props.children);
  };
  // NumberPad has no hooks, so calling it gives its element tree.
  walk(NumberPad(props));
  return found;
}

describe('NumberPad with the new props left out is byte for byte as released', () => {
  it("value '12' without onSubmit (the golden captured before the change)", () => {
    expect(renderToStaticMarkup(<NumberPad value="12" onChange={noop} />)).toBe(GOLDEN_PLAIN);
  });

  it("value '12' with onSubmit (TenderDialog)", () => {
    expect(renderToStaticMarkup(<NumberPad value="12" onChange={noop} onSubmit={noop} maxLength={8} />)).toBe(GOLDEN_SUBMIT);
  });

  it('nothing typed yet shows the _ placeholder', () => {
    expect(renderToStaticMarkup(<NumberPad value="" onChange={noop} />)).toBe(GOLDEN_EMPTY);
  });

  it('the PIN login: masked, its own maxLength and className', () => {
    expect(
      renderToStaticMarkup(
        <NumberPad value="12" onChange={noop} onSubmit={noop} mask maxLength={6} className="[@media(max-height:820px)]:gap-2" />,
      ),
    ).toBe(GOLDEN_LOGIN);
  });

  it('no tabindex, no role and no name on the keys anywhere', () => {
    for (const golden of [GOLDEN_PLAIN, GOLDEN_SUBMIT, GOLDEN_EMPTY, GOLDEN_LOGIN]) {
      expect(golden).not.toContain('tabindex');
      expect(golden).not.toContain('role=');
      expect(count(golden, 'aria-label=')).toBe(1); // the PIN entry box only
    }
  });
});

describe('the new props', () => {
  it("showDisplay false: the box above the keys is gone ('PIN entry' with it), nothing else changes", () => {
    const html = renderToStaticMarkup(<NumberPad value="12" onChange={noop} showDisplay={false} />);
    expect(html).not.toContain('PIN entry');
    expect(html).toBe(GOLDEN_PLAIN.replace(DISPLAY_12, ''));
    // true is the default
    expect(renderToStaticMarkup(<NumberPad value="12" onChange={noop} showDisplay />)).toBe(GOLDEN_PLAIN);
  });

  it('keyTabIndex -1 puts tabindex="-1" on all 12 keys and nowhere else', () => {
    const html = renderToStaticMarkup(<NumberPad value="12" onChange={noop} keyTabIndex={-1} />);
    expect(count(html, '<button ')).toBe(12);
    expect(count(html, '<button type="button" tabindex="-1" class=')).toBe(12);
    expect(count(html, 'tabindex')).toBe(12);
  });

  it("enterLabel 'Next' is the bottom-right key's words", () => {
    const html = renderToStaticMarkup(<NumberPad value="12" onChange={noop} enterLabel="Next" />);
    expect(html).toContain('hover:bg-amber-400">Next</button>');
    expect(html).not.toContain('>Enter<');
    expect(html).toBe(GOLDEN_PLAIN.replace('>Enter</button>', '>Next</button>'));
  });

  it("keyClassName 'h-14' sets the height of all 12 keys; the box above keeps its own", () => {
    const html = renderToStaticMarkup(<NumberPad value="12" onChange={noop} keyClassName="h-14" />);
    expect(count(html, 'class="h-14 rounded-lg')).toBe(12);
    expect(count(html, 'h-16')).toBe(1); // the box above the keys
    expect(html).toBe(GOLDEN_PLAIN.split('class="h-16 rounded-lg').join('class="h-14 rounded-lg'));
  });

  it('label names the keys as a group, only when given', () => {
    const html = renderToStaticMarkup(<NumberPad value="12" onChange={noop} label="Number pad for the note count" />);
    expect(html).toBe(
      GOLDEN_PLAIN.replace(
        '<div class="grid grid-cols-3 gap-3">',
        '<div class="grid grid-cols-3 gap-3" role="group" aria-label="Number pad for the note count">',
      ),
    );
  });

  it('the Close shift note count: all of them together', () => {
    const html = renderToStaticMarkup(
      <NumberPad
        value="7"
        onChange={noop}
        onSubmit={noop}
        maxLength={4}
        showDisplay={false}
        enterLabel="Next"
        keyClassName="h-14"
        keyTabIndex={-1}
        label="Number pad for the note count"
      />,
    );
    const expected = GOLDEN_PLAIN.replace(DISPLAY_12, '')
      .replace('<div class="grid grid-cols-3 gap-3">', '<div class="grid grid-cols-3 gap-3" role="group" aria-label="Number pad for the note count">')
      .split('<button type="button" class="h-16 rounded-lg')
      .join('<button type="button" tabindex="-1" class="h-14 rounded-lg')
      .replace('>Enter</button>', '>Next</button>');
    expect(html).toBe(expected);
  });
});

describe('pressing the keys works as before, whatever the new props', () => {
  const variants: Array<Partial<NumberPadProps>> = [
    {},
    { showDisplay: false, enterLabel: 'Next', keyClassName: 'h-14', keyTabIndex: -1, label: 'Number pad for the note count' },
  ];

  for (const extra of variants) {
    it(`a digit adds to the value, ← takes one off, the bottom-right key submits (${Object.keys(extra).length} new props)`, () => {
      const onChange = vi.fn<(next: string) => void>();
      const onSubmit = vi.fn<() => void>();
      const keys = buttonsOf({ value: '12', onChange, onSubmit, maxLength: 4, ...extra });
      expect(keys.map((k) => k.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', extra.enterLabel ?? 'Enter']);

      keys.find((k) => k.text === '7')?.onClick();
      keys.find((k) => k.text === '←')?.onClick();
      keys.at(-1)?.onClick();
      expect(onChange.mock.calls).toEqual([['127'], ['1']]);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it(`a digit at maxLength is not passed on (${Object.keys(extra).length} new props)`, () => {
      const onChange = vi.fn<(next: string) => void>();
      const keys = buttonsOf({ value: '1234', onChange, maxLength: 4, ...extra });
      keys.find((k) => k.text === '5')?.onClick();
      expect(onChange).not.toHaveBeenCalled();
    });
  }
});
