import type { ApiErrorPayload, ErrorCode, FieldIssue } from '../../shared/api.ts';

/** The only error type services should throw intentionally. Anything else becomes INTERNAL. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toPayload(): ApiErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const notFound = (what: string, id?: unknown): AppError =>
  new AppError('NOT_FOUND', id === undefined ? `${what} not found` : `${what} not found: ${String(id)}`);

export const conflict = (message: string, details?: unknown): AppError => new AppError('CONFLICT', message, details);

export const rule = (message: string, details?: unknown): AppError => new AppError('BUSINESS_RULE', message, details);

export const forbidden = (message = 'You do not have permission to perform this action'): AppError =>
  new AppError('FORBIDDEN', message);

export const validation = (issues: FieldIssue[]): AppError =>
  new AppError('VALIDATION', issues.length === 1 ? issues[0].message : `${issues.length} fields are invalid`, issues);

/** Convert any thrown value to a safe payload. Internal errors never leak stack traces to the renderer. */
export function toErrorPayload(err: unknown): ApiErrorPayload {
  if (err instanceof AppError) return err.toPayload();
  return { code: 'INTERNAL', message: 'An unexpected error occurred. Details have been written to the application log.' };
}
