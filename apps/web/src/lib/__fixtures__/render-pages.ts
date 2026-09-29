/**
 * Server pages rendered to HTML in a test, as Next serves them: async server
 * components (the pages, and any child that reads the database itself) are
 * awaited first, everything else — client components included, as their
 * server render (effects do not run) — goes through React's static render.
 *
 * The caller mocks what only Next provides (next/navigation, next/font,
 * next/og, next/cache) and puts React in scope for the JSX (vitest compiles
 * it for React in scope, as Next does): see pages-golden.test.ts.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type AnyFn = (props: unknown) => unknown;

function isAsyncFunction(f: unknown): f is AnyFn {
  return typeof f === 'function' && Object.prototype.toString.call(f) === '[object AsyncFunction]';
}

/**
 * The element tree with every async server component replaced by what it
 * renders (recursively, into children too), ready for renderToStaticMarkup.
 */
export async function resolveServer(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!React.isValidElement(node)) return node;
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (isAsyncFunction(el.type)) {
    const out = await resolveServer(await (el.type as AnyFn)(el.props));
    // Keep the element's key on what replaces it (a keyed child of a list).
    return el.key !== null && React.isValidElement(out) ? React.cloneElement(out, { key: el.key }) : out;
  }
  const props = el.props ?? {};
  if (!('children' in props) || props['children'] === undefined) return el;
  const children = await resolveServer(props['children']);
  return React.cloneElement(el, { children } as Record<string, unknown>);
}

/** A server element (a page, or the root layout around one) as the HTML it renders. */
export async function renderServer(element: React.ReactElement): Promise<string> {
  const resolved = await resolveServer(element);
  return renderToStaticMarkup(resolved as React.ReactElement);
}

/** The footer's "© <year>": pinned so the goldens don't expire on New Year's Day. */
export function stableHtml(html: string): string {
  return html.replace(/© 20\d\d /g, '© YEAR ');
}
