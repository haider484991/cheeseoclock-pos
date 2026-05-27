/**
 * The IPC envelope. Every main-process handler returns ApiResult<T>;
 * never throws across the IPC boundary.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Additional structured info (e.g. field validation errors). */
  details?: Record<string, unknown>;
  /** True if the same call might succeed on retry (e.g. transient network/printer issue). */
  retryable?: boolean;
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'hardware_error'
  | 'printer_offline'
  | 'fbr_submission_failed'
  | 'database_error'
  | 'internal_error';

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export const err = (error: ApiError): ApiResult<never> => ({ ok: false, error });
