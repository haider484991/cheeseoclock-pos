/** Anything a keypress should be left alone in. */
export function isTypingField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * Should Enter on this element be left to the element itself? Yes for a text
 * box, and for a button or link reached with Tab. A button that only has
 * focus because it was just tapped (a choice, the + on a line) does not get
 * Enter: at the till, Enter means "go on" — it must not repeat the last tap.
 */
export function ownsEnter(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') {
    try {
      return el.matches(':focus-visible');
    } catch {
      return true;
    }
  }
  return false;
}
