import log from 'electron-log/main';
import type { PrinterAdapter, PrinterConnectionConfig } from '@cheeseoclock/printer-core';
import { NetworkPrinterAdapter } from './network-printer-adapter.js';
import { MockPrinterAdapter } from './mock-printer-adapter.js';
import { UsbPrinterAdapter } from './usb-printer-adapter.js';
import { isSystemPrintingSupported } from '../../services/system-printers.js';

/**
 * Pick the right adapter based on the transport in the config. USB goes
 * through the OS print queue (Windows only today — no native USB module
 * needed). Bluetooth and serial still ship as explicit "not yet" errors.
 */
export function makePrinterAdapter(config: PrinterConnectionConfig): PrinterAdapter {
  // Special-case: 'mock' transport is encoded as transport=network with host='mock'.
  // Keeps the type system simple while still giving us a way to develop without hardware.
  if (config.transport === 'network' && config.network?.host === 'mock') {
    log.info('Using MockPrinterAdapter (host=mock)');
    return new MockPrinterAdapter(config);
  }
  switch (config.transport) {
    case 'network':
      return new NetworkPrinterAdapter(config);
    case 'usb':
      if (!isSystemPrintingSupported()) {
        throw new PrinterUnsupportedError(
          'USB printers are supported on Windows only for now. Use Wi-Fi / LAN or No printer.',
        );
      }
      return new UsbPrinterAdapter(config);
    case 'bluetooth':
      throw new PrinterUnsupportedError(
        'Bluetooth printers ship in Phase 3.5. Use Network or Mock for now.',
      );
    case 'serial':
      throw new PrinterUnsupportedError(
        'Serial printers ship in Phase 3.5. Use Network or Mock for now.',
      );
    default:
      throw new PrinterUnsupportedError(
        `Unknown transport "${(config as { transport: string }).transport}"`,
      );
  }
}

export class PrinterUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrinterUnsupportedError';
  }
}
