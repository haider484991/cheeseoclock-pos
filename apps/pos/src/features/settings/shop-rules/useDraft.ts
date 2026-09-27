import { useEffect, useState } from 'react';

/**
 * The form for one Settings card, kept in step with what is saved until the
 * owner starts typing (a Save here, or one from the other till, shows at
 * once); `reset` hands it back to the saved value after a Save.
 */
export function useDraft<V, F>(saved: V, toForm: (v: V) => F) {
  const [form, setForm] = useState<F>(() => toForm(saved));
  const [touched, setTouched] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    // Keyed on the saved value's JSON (a new object with the same values is no change).
    if (!touched) setForm(toForm(saved));
  }, [savedKey, touched]);
  return {
    form,
    touched,
    set: (f: F) => {
      setTouched(true);
      setForm(f);
    },
    reset: () => setTouched(false),
  };
}
