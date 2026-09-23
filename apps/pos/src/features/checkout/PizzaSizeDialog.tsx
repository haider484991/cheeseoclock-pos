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

export function PizzaSizeDialog({ choice, onSelect, onClose, returnFocus }: Props) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="pizza-size-dialog"
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus?.focus(); }}
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
            {choice.variants.map((item) => (
              <button key={item.id} type="button" className="pizza-size-option" onClick={() => onSelect(item)}>
                <strong>{pizzaSize(item)}</strong>
                <span>{formatCents(item.basePriceCents)}</span>
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
