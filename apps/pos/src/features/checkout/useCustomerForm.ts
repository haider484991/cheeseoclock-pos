import { create } from 'zustand';
import {
  type CustomerFormState,
  makeEmptyCustomerForm,
} from './CustomerInlinePanel';

/**
 * Tiny Zustand store so OrderModeBar (which owns the inline customer panel)
 * and TenderDialog (which commits the form at tender time) can share the same
 * form state — without lifting it all the way up to CheckoutPage.
 */
interface CustomerFormStore {
  form: CustomerFormState;
  setForm: (next: CustomerFormState | ((prev: CustomerFormState) => CustomerFormState)) => void;
  reset: () => void;
}

const store = create<CustomerFormStore>((set, get) => ({
  form: makeEmptyCustomerForm(),
  setForm(next) {
    if (typeof next === 'function') {
      set({ form: (next as (p: CustomerFormState) => CustomerFormState)(get().form) });
    } else {
      set({ form: next });
    }
  },
  reset() {
    set({ form: makeEmptyCustomerForm() });
  },
}));

export function useCustomerForm() {
  return store();
}

/** Read the current form snapshot without subscribing — used by tender commit. */
export function getCustomerFormSnapshot(): CustomerFormState {
  return store.getState().form;
}

export function resetCustomerForm(): void {
  store.getState().reset();
}
