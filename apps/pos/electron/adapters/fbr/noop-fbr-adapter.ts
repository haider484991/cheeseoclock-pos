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
    const dir = path.join(app.getPath('userData'), 'fbr-noop');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${stamp}_${payload.invoiceRefNo}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    const irn = `NOOP-${uuidv7()}`;
    log.info('FBR noop dry-run wrote payload', { filePath, irn });
    return {
      ok: true,
      irn,
      qrPayload: `noop://${irn}`,
      rawResponse: { note: 'noop adapter — not actually submitted', filePath },
    };
  }
}
