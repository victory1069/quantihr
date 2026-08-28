/**
 * Error codes shared by the API and both clients.
 *
 * The offline outbox needs to tell a retryable failure from a permanent one, and
 * the UI needs to turn a rejection into an actionable message rather than a
 * generic error (spec §6). A string union does both jobs.
 */

export const ERROR_CODES = {
  // Auth
  AUTH_INVALID_TOKEN: 'auth/invalid-token',
  AUTH_EXPIRED_TOKEN: 'auth/expired-token',
  AUTH_MAGIC_LINK_USED: 'auth/magic-link-used',
  AUTH_UNKNOWN_EMAIL: 'auth/unknown-email',
  AUTH_FORBIDDEN: 'auth/forbidden',
  AUTH_DEVICE_MISMATCH: 'auth/device-mismatch',

  // Attendance
  CHECKIN_WINDOW_CLOSED: 'checkin/window-closed',
  CHECKIN_NOT_WORKING_DAY: 'checkin/not-a-working-day',
  CHECKIN_CODE_INVALID: 'checkin/code-invalid',
  CHECKIN_CODE_STALE: 'checkin/code-stale',
  CHECKIN_OUTSIDE_GEOFENCE: 'checkin/outside-geofence',
  CHECKIN_ACCURACY_TOO_LOW: 'checkin/accuracy-too-low',
  CHECKIN_MOCK_LOCATION: 'checkin/mock-location',
  CHECKIN_ALREADY_RECORDED: 'checkin/already-recorded',
  CHECKIN_NO_LOCATION: 'checkin/no-location-assigned',

  // Leave
  LEAVE_INSUFFICIENT_BALANCE: 'leave/insufficient-balance',
  LEAVE_BALANCE_CHANGED: 'leave/balance-changed',
  LEAVE_OVERLAPPING_REQUEST: 'leave/overlapping-request',
  LEAVE_NO_WORKING_DAYS: 'leave/no-working-days',
  LEAVE_DOCUMENT_REQUIRED: 'leave/document-required',
  LEAVE_NOT_PENDING: 'leave/not-pending',
  LEAVE_OVERRIDE_REASON_REQUIRED: 'leave/override-reason-required',
  LEAVE_INVALID_RANGE: 'leave/invalid-range',

  // Generic
  NOT_FOUND: 'common/not-found',
  VALIDATION_FAILED: 'common/validation-failed',
  IDEMPOTENCY_KEY_REUSED: 'common/idempotency-key-reused',
  RATE_LIMITED: 'common/rate-limited',
  INTERNAL: 'common/internal',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface ApiErrorBody {
  code: ErrorCode
  message: string
  /** Field-level detail for form errors. */
  details?: Record<string, unknown>
}

/**
 * Codes the outbox should stop retrying on.
 *
 * Anything absent from this set is treated as transient and retried with
 * backoff. Retrying a permanent rejection forever is how a stuck outbox
 * silently eats a leave request.
 */
export const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  ERROR_CODES.AUTH_FORBIDDEN,
  ERROR_CODES.AUTH_DEVICE_MISMATCH,
  ERROR_CODES.CHECKIN_WINDOW_CLOSED,
  ERROR_CODES.CHECKIN_NOT_WORKING_DAY,
  ERROR_CODES.CHECKIN_CODE_INVALID,
  ERROR_CODES.CHECKIN_CODE_STALE,
  ERROR_CODES.CHECKIN_OUTSIDE_GEOFENCE,
  ERROR_CODES.CHECKIN_ACCURACY_TOO_LOW,
  ERROR_CODES.CHECKIN_MOCK_LOCATION,
  ERROR_CODES.CHECKIN_ALREADY_RECORDED,
  ERROR_CODES.CHECKIN_NO_LOCATION,
  ERROR_CODES.LEAVE_INSUFFICIENT_BALANCE,
  ERROR_CODES.LEAVE_BALANCE_CHANGED,
  ERROR_CODES.LEAVE_OVERLAPPING_REQUEST,
  ERROR_CODES.LEAVE_NO_WORKING_DAYS,
  ERROR_CODES.LEAVE_DOCUMENT_REQUIRED,
  ERROR_CODES.LEAVE_NOT_PENDING,
  ERROR_CODES.LEAVE_INVALID_RANGE,
  ERROR_CODES.NOT_FOUND,
  ERROR_CODES.VALIDATION_FAILED,
])

export function isPermanent(code: string): boolean {
  return PERMANENT_ERROR_CODES.has(code)
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, ...(this.details && { details: this.details }) }
  }
}
