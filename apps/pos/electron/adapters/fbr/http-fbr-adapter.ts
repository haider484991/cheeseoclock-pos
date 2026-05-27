import log from 'electron-log/main';
import type {
  FbrAdapter,
  FbrAdapterConfig,
  FbrInvoicePayload,
  FbrMode,
  FbrSubmitResult,
  FbrValidationResult,
} from '@cheeseoclock/fbr-core';
import { FBR_PRODUCTION_ENDPOINT, FBR_VALIDATE_ENDPOINT } from '@cheeseoclock/fbr-core';

/**
 * Real HTTP adapter — used for both sandbox and production. The only thing
 * that varies is the endpoint URL (sandbox = configurable in settings,
 * production = the official FBR gateway).
 *
 * FBR responses have not been seen by this dev environment yet (no credentials),
 * so this maps a *best-effort* response shape: { invoiceNumber, qrPayload }
 * on success, error string otherwise. When real responses land, refine here.
 */
export class HttpFbrAdapter implements FbrAdapter {
  readonly mode: FbrMode;
  private endpoint: string;
  private validateEndpoint: string;
  private bearer: string;

  constructor(config: FbrAdapterConfig) {
    if (config.mode === 'noop') {
      throw new Error('HttpFbrAdapter cannot be used in noop mode');
    }
    this.mode = config.mode;
    if (!config.bearerToken) {
      throw new Error('Bearer token is required for FBR submission');
    }
    this.bearer = config.bearerToken;
    if (config.mode === 'production') {
      this.endpoint = FBR_PRODUCTION_ENDPOINT;
      this.validateEndpoint = FBR_VALIDATE_ENDPOINT;
    } else {
      // Sandbox endpoint is configurable — defaults to a local mock the dev
      // can spin up. PRAL publishes sandbox URLs only to registered SCO accounts.
      this.endpoint = config.endpoint ?? 'http://localhost:8787/di_data/v1/di/postinvoicedata';
      this.validateEndpoint =
        (config.endpoint ?? 'http://localhost:8787/di_data/v1/di')
          .replace(/\/postinvoicedata\/?$/, '') + '/validateinvoicedata';
    }
  }

  async validateInvoice(payload: FbrInvoicePayload): Promise<FbrValidationResult> {
    try {
      const res = await fetch(this.validateEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.bearer}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, errors: [`HTTP ${res.status}: ${text || res.statusText}`] };
      }
      const json = (await res.json().catch(() => ({}))) as { errors?: string[] };
      return { ok: !json.errors || json.errors.length === 0, errors: json.errors ?? [] };
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
  }

  async submitInvoice(payload: FbrInvoicePayload): Promise<FbrSubmitResult> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.bearer}`,
        },
        body: JSON.stringify(payload),
      });
      const rawText = await res.text();
      let raw: unknown = rawText;
      try {
        raw = JSON.parse(rawText);
      } catch {
        // FBR sometimes returns plain-text on error; keep as string
      }

      if (!res.ok) {
        log.warn('FBR submission failed', { status: res.status, raw });
        return {
          ok: false,
          rawResponse: raw,
          error: {
            code: `http_${res.status}`,
            message:
              typeof raw === 'string' ? raw : (raw as { message?: string })?.message ?? res.statusText,
            // 4xx are likely permanent (bad payload). 5xx and network errors are retryable.
            retryable: res.status >= 500,
          },
        };
      }

      // Documented response (per memory): { invoiceNumber, qrPayload }
      const j = raw as { invoiceNumber?: string; qrPayload?: string; irn?: string };
      const irn = j.invoiceNumber ?? j.irn;
      if (!irn) {
        return {
          ok: false,
          rawResponse: raw,
          error: {
            code: 'no_irn',
            message: 'FBR accepted but did not return an invoice number',
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        irn,
        ...(j.qrPayload ? { qrPayload: j.qrPayload } : {}),
        rawResponse: raw,
      };
    } catch (e) {
      return {
        ok: false,
        rawResponse: null,
        error: {
          code: 'network_error',
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        },
      };
    }
  }
}
