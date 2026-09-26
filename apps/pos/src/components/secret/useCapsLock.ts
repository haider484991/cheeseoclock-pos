import { useEffect, useState } from 'react';

/**
 * Is Caps Lock on? Passwords are case-sensitive, and Caps Lock is the usual
 * reason a right password is "wrong". Known from the first key press or
 * click (browsers can't read it before then); false until then.
 */
export function useCapsLock(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = (e: KeyboardEvent | MouseEvent) => {
      if (typeof e.getModifierState === 'function') setOn(e.getModifierState('CapsLock'));
    };
    window.addEventListener('keydown', read, true);
    window.addEventListener('keyup', read, true);
    window.addEventListener('mousedown', read, true);
    return () => {
      window.removeEventListener('keydown', read, true);
      window.removeEventListener('keyup', read, true);
      window.removeEventListener('mousedown', read, true);
    };
  }, []);
  return on;
}
