import { v7 as uuidv7 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type {
  FbrAdapter,
  FbrAdapterConfig,
  FbrInvoicePayload,
  FbrSubmitResult,
  FbrValidationResult,
} from '@cheeseoclock/fbr-core';

/**
 * Dry-run adapter: writes the payload to userData/fbr-noop/ and returns a
 * placeholder IRN ("NOOP-<uuid>"). Used until the user enters real PRAL creds.
 * Lets the rest of the system exercise the full queue + retry + receipt path
 * without touching FBR's servers.
 */
export class NoopFbrAdapter implements FbrAdapter {
  readonly mode = 'noop' as const;
  constructor(_config: FbrAdapterConfig) {}

  async validateInvoice(_payload: FbrInvoicePayload): Promise<FbrValidationResult> {
    return { ok: true, errors: [] };
  }

  async submitInvoice(payload: FbrInvoicePayload): Promise<FbrSubmitResult> {
    const irn = `NOOP-${uuidv7()}`;
    // A payload file per sale is a development aid only. A shop that never
    // switches FBR on would otherwise gain tens of thousands of files a year
    // (housekeeping removes old ones left by builds before v0.8).
    let filePath: string | null = null;
    if (!app.isPackaged) {
      const dir = path.join(app.getPath('userData'), 'fbr-noop');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      filePath = path.join(dir, `${stamp}_${payload.invoiceRefNo}.json`);
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    }
    log.info('FBR noop dry-run', { filePath, irn });
    return {
      ok: true,
      irn,
      qrPayload: `noop://${irn}`,
      rawResponse: { note: 'noop adapter — not actually submitted', filePath },
    };
  }
}
