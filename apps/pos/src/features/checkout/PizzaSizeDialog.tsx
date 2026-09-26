import { useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { MenuItem } from '@cheeseoclock/shared-types';
import { X } from 'lucide-react';
import { pizzaSize, type MenuChoice } from './pizzaChoices';

interface Props {
  choice: MenuChoice;
  onSelect: (item: MenuItem) => void;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}

/** Keys for each size: M or 1 for Medium, L or 2 for Large. */
function sizeKey(item: MenuItem, index: number): string {
  return pizzaSize(item)?.charAt(0) ?? String(index + 1);
}

export function PizzaSizeDialog({ choice, onSelect, onClose, returnFocus }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="pizza-size-dialog"
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus?.focus(); }}
          // Medium is ready to go: Enter adds it, M / L (or 1 / 2) pick a size.
          onOpenAutoFocus={(event) => { event.preventDefault(); firstRef.current?.focus(); }}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            const key = event.key.toUpperCase();
            const hit = choice.variants.find((item, i) => sizeKey(item, i) === key || String(i + 1) === key);
            if (hit) {
              event.preventDefault();
              onSelect(hit);
            }
          }}
        >
          <header className="pizza-size-header">
            <div>
              <Dialog.Title className="pizza-size-title">{choice.name}</Dialog.Title>
              <Dialog.Description className="pizza-size-description">
                {choice.variants.length > 1 ? 'Choose a size to add to your order.' : `Available in ${pizzaSize(choice.variants[0]!)}. Tap to add to your order.`}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="pizza-size-close" aria-label="Cancel size selection"><X size={20} /></button>
            </Dialog.Close>
          </header>
          <div className="pizza-size-options">
            {choice.variants.map((item, i) => (
              <button key={item.id} ref={i === 0 ? firstRef : undefined} type="button" className="pizza-size-option" onClick={() => onSelect(item)} aria-keyshortcuts={sizeKey(item, i)}>
                <strong>{pizzaSize(item)}</strong>
                <span>{formatCents(item.basePriceCents)}</span>
                <kbd className="mt-1 rounded bg-stone-100 px-1.5 font-mono text-xs text-stone-500 dark:bg-stone-800">{sizeKey(item, i)}</kbd>
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
