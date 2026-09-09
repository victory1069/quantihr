/**
 * Append-only audit trail.
 *
 * `audit_log` has UPDATE and DELETE revoked from `quanti_app` at the database
 * level, so this module can only ever add rows. Writes happen inside the same
 * transaction as the change they describe: if the change rolls back, so does its
 * audit entry, and the log never claims something happened that didn't.
 */

import { auditLog } from '../db/schema.js'
import type { Tx } from '../db/client.js'

export type AuditAction =
  | 'employee.created'
  | 'employee.updated'
  | 'employee.imported'
  | 'leave_request.submitted'
  | 'leave_request.approved'
  | 'leave_request.declined'
  | 'leave_request.cancelled'
  | 'leave_balance.adjusted'
  | 'attendance.checked_in'
  | 'attendance.rejected'
  | 'attendance.disputed'
  | 'device.registered'
  | 'device.review_requested'
  | 'device.approved'
  | 'document.uploaded'
  | 'document.viewed'
  | 'document.acknowledged'
  | 'config.updated'
  | 'auth.logged_in'
  | 'auth.phone_verified'
  | 'payroll.run_created'
  | 'payroll.run_approved'
  | 'payroll.run_paid'
  | 'meeting.created'
  | 'meeting.recording_started'
  | 'meeting.reviewed'
  | 'meeting.dispute_resolved'

export interface AuditEntry {
  orgId: string
  actorUserId: string | null
  action: AuditAction
  entityType: string
  entityId: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
}

export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before === undefined ? null : (entry.before as object),
    after: entry.after === undefined ? null : (entry.after as object),
    ip: entry.ip ?? null,
  })
}

/**
 * Strips values that should not be duplicated into the audit trail.
 *
 * The log is read by more people than the source tables are, and a leave reason
 * can be medical. Keep the shape, drop the sensitive text.
 */
export function redact<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const REDACTED = new Set(['reason', 'decisionNote', 'pushToken', 'tokenHash', 'phone'])
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, REDACTED.has(k) && v ? '[redacted]' : v]),
  )
}
