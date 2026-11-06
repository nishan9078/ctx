export const errorCodes = ['INVALID_INPUT', 'UNSUPPORTED_SCHEMA', 'INVALID_TRANSITION', 'NOT_FOUND', 'CONFLICT', 'UNAUTHORIZED', 'APPROVAL_REQUIRED', 'RATE_LIMIT', 'AUTH_REQUIRED', 'HARNESS_UNAVAILABLE', 'BUILD_FAILED', 'TEST_FAILED', 'SECURITY_FAILED', 'ENVIRONMENT_UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'BUDGET_EXHAUSTED', 'INTERNAL'] as const;
export type ErrorCode = typeof errorCodes[number];

/** Public diagnostics contain field paths and stable codes, never rejected values. */
export class CtxError extends Error {
  override readonly name: string = 'CtxError';
  constructor(readonly code: ErrorCode, message: string, readonly retryable = false) { super(message); }
  toJSON(): { code: ErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
export class ValidationError extends CtxError {
  override readonly name = 'ValidationError';
  constructor(readonly path: string, requirement: string, code: 'INVALID_INPUT' | 'UNSUPPORTED_SCHEMA' = 'INVALID_INPUT') {
    super(code, `${path}: ${requirement}`);
  }
}
export class InvalidTransitionError extends CtxError {
  override readonly name = 'InvalidTransitionError';
  constructor() { super('INVALID_TRANSITION', 'Invalid task transition; consult the allowed transition table'); }
}
