/**
 * Drizzle table definitions.
 *
 * `ddl.sql` is authoritative — it owns the RLS policies, partial indexes and
 * role grants that a schema-diffing tool cannot express. This file mirrors it
 * for typed queries only. `test/schema-parity.test.ts` asserts the two agree, so
 * a column added in one place and forgotten in the other fails CI rather than
 * production.
 */

import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organisations.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const organisations = pgTable('organisations', {
  id: id(),
  name: text('name').notNull(),
  country: text('country').notNull().default('NG'),
  timezone: text('timezone').notNull().default('Africa/Lagos'),
  settings: jsonb('settings').notNull().default({}),
  onboardingSteps: jsonb('onboarding_steps').$type<string[]>().notNull().default([]),
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const users = pgTable('users', {
  id: id(),
  orgId: orgId(),
  email: text('email').notNull(),
  authProvider: text('auth_provider').notNull().default('magic_link'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  pushToken: text('push_token'),
  biometricEnabled: boolean('biometric_enabled').notNull().default(false),
  passwordHash: text('password_hash'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  notificationPreferences: jsonb('notification_preferences').notNull(),
  createdAt: createdAt(),
})

export const locations = pgTable('locations', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  address: text('address'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  geofenceRadiusM: integer('geofence_radius_m').notNull().default(150),
  createdAt: createdAt(),
})

export const departments = pgTable('departments', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  parentDepartmentId: uuid('parent_department_id'),
  createdAt: createdAt(),
})

export const workSchedules = pgTable('work_schedules', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  workingDays: integer('working_days').array().notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  gracePeriodMinutes: integer('grace_period_minutes').notNull().default(10),
  checkinWindowStart: text('checkin_window_start').notNull(),
  checkinWindowEnd: text('checkin_window_end').notNull(),
  createdAt: createdAt(),
})

export const employees = pgTable(
  'employees',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    employeeNumber: text('employee_number').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    managerId: uuid('manager_id'),
    jobTitle: text('job_title'),
    band: text('band'),
    roleId: text('role_id'),
    employmentType: text('employment_type').notNull().default('full_time'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    status: text('status').notNull().default('active'),
    workScheduleId: uuid('work_schedule_id').references(() => workSchedules.id, {
      onDelete: 'set null',
    }),
    roles: text('roles').array().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: uniqueIndex('employees_org_number_key').on(t.orgId, t.employeeNumber),
    managerIdx: index('employees_org_manager_idx').on(t.orgId, t.managerId),
  }),
)

export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const otpCodes = pgTable('otp_codes', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull().default('phone_verification'),
  codeHash: text('code_hash').notNull(),
  destination: text('destination').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
})

export const devices = pgTable('devices', {
  id: id(),
  orgId: orgId(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull(),
  platform: text('platform').notNull().default('web'),
  name: text('name'),
  pushToken: text('push_token'),
  approved: boolean('approved').notNull().default(true),
  approvalRequestedAt: timestamp('approval_requested_at', { withTimezone: true }),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
})

export const checkinCodes = pgTable('checkin_codes', {
  id: id(),
  orgId: orgId(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: id(),
    orgId: orgId(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true }),
    checkinMethod: text('checkin_method').notNull().default('geofence_code'),
    verificationSignals: jsonb('verification_signals').notNull().default({}),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    accuracyM: doublePrecision('accuracy_m'),
    status: text('status').notNull(),
    minutesLate: integer('minutes_late').notNull().default(0),
    rejectionReason: text('rejection_reason'),
    reason: text('reason'),
    recordedOffline: boolean('recorded_offline').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    historyIdx: index('attendance_history_idx').on(t.orgId, t.employeeId, t.date),
  }),
)

export const attendanceDisputes = pgTable('attendance_disputes', {
  id: id(),
  orgId: orgId(),
  recordId: uuid('record_id').notNull().references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('open'),
  createdAt: createdAt(),
})

export const leaveTypes = pgTable('leave_types', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  accrualMethod: text('accrual_method').notNull().default('annual_fixed'),
  accrualRate: numeric('accrual_rate', { precision: 6, scale: 2 }).notNull().default('0'),
  maxBalance: numeric('max_balance', { precision: 6, scale: 2 }),
  carryoverCap: numeric('carryover_cap', { precision: 6, scale: 2 }),
  carryoverExpiryMonths: integer('carryover_expiry_months'),
  requiresDocument: boolean('requires_document').notNull().default(false),
  minNoticeDays: integer('min_notice_days'),
  isPaid: boolean('is_paid').notNull().default(true),
  colour: text('colour').notNull().default('#4F46E5'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
})

export const leaveBalances = pgTable(
  'leave_balances',
  {
    id: id(),
    orgId: orgId(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid('leave_type_id').notNull().references(() => leaveTypes.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    accrued: numeric('accrued', { precision: 6, scale: 2 }).notNull().default('0'),
    taken: numeric('taken', { precision: 6, scale: 2 }).notNull().default('0'),
    pending: numeric('pending', { precision: 6, scale: 2 }).notNull().default('0'),
    carriedOver: numeric('carried_over', { precision: 6, scale: 2 }).notNull().default('0'),
    adjustment: numeric('adjustment', { precision: 6, scale: 2 }).notNull().default('0'),
    carryoverExpiresOn: date('carryover_expires_on'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUnique: uniqueIndex('leave_balances_period_key').on(
      t.orgId,
      t.employeeId,
      t.leaveTypeId,
      t.periodStart,
    ),
  }),
)

export const leaveBalanceAdjustments = pgTable('leave_balance_adjustments', {
  id: id(),
  orgId: orgId(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveTypeId: uuid('leave_type_id').notNull().references(() => leaveTypes.id, { onDelete: 'cascade' }),
  periodStart: date('period_start').notNull(),
  delta: numeric('delta', { precision: 6, scale: 2 }).notNull(),
  reason: text('reason').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: id(),
    orgId: orgId(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid('leave_type_id').notNull().references(() => leaveTypes.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    daysCount: numeric('days_count', { precision: 6, scale: 2 }).notNull(),
    halfDayStart: boolean('half_day_start').notNull().default(false),
    halfDayEnd: boolean('half_day_end').notNull().default(false),
    reason: text('reason'),
    status: text('status').notNull().default('pending'),
    warnings: jsonb('warnings').notNull().default([]),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionNote: text('decision_note'),
    overrideReason: text('override_reason'),
    documentUrl: text('document_url'),
    createdAt: createdAt(),
  },
  (t) => ({
    employeeIdx: index('leave_requests_employee_idx').on(t.orgId, t.employeeId, t.startDate),
    statusIdx: index('leave_requests_status_idx').on(t.orgId, t.status, t.submittedAt),
  }),
)

export const coverageRules = pgTable('coverage_rules', {
  id: id(),
  orgId: orgId(),
  departmentId: uuid('department_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
  maxConcurrentAbsent: integer('max_concurrent_absent'),
  maxConcurrentPercent: numeric('max_concurrent_percent', { precision: 5, scale: 2 }),
  blackoutPeriods: jsonb('blackout_periods').notNull().default([]),
  criticalRoleIds: text('critical_role_ids').array().notNull(),
  createdAt: createdAt(),
})

// --- Payroll ---------------------------------------------------------------
// `bigint({ mode: 'number' })` because every payroll amount is integer kobo and
// stays well inside Number.MAX_SAFE_INTEGER (₦90 trillion).

export const compensation = pgTable('compensation', {
  id: id(),
  orgId: orgId(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  basic: bigint('basic', { mode: 'number' }).notNull().default(0),
  housing: bigint('housing', { mode: 'number' }).notNull().default(0),
  transport: bigint('transport', { mode: 'number' }).notNull().default(0),
  allowances: jsonb('allowances').notNull().default([]),
  voluntaryPension: bigint('voluntary_pension', { mode: 'number' }).notNull().default(0),
  nhis: bigint('nhis', { mode: 'number' }).notNull().default(0),
  bankName: text('bank_name'),
  bankAccountNumber: text('bank_account_number'),
  bankAccountName: text('bank_account_name'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

export const employeeLoans = pgTable('employee_loans', {
  id: id(),
  orgId: orgId(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('loan_repayment'),
  name: text('name').notNull(),
  principal: bigint('principal', { mode: 'number' }).notNull(),
  paid: bigint('paid', { mode: 'number' }).notNull().default(0),
  perPeriod: bigint('per_period', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('active'),
  reason: text('reason'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

export const payrollRuns = pgTable('payroll_runs', {
  id: id(),
  orgId: orgId(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  payDate: date('pay_date').notNull(),
  status: text('status').notNull().default('draft'),
  scheduleId: text('schedule_id').notNull(),
  totals: jsonb('totals').notNull().default({}),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const payslips = pgTable('payslips', {
  id: id(),
  orgId: orgId(),
  runId: uuid('run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  gross: bigint('gross', { mode: 'number' }).notNull(),
  netPay: bigint('net_pay', { mode: 'number' }).notNull(),
  paye: bigint('paye', { mode: 'number' }).notNull(),
  pensionEmployee: bigint('pension_employee', { mode: 'number' }).notNull(),
  pensionEmployer: bigint('pension_employer', { mode: 'number' }).notNull(),
  nhf: bigint('nhf', { mode: 'number' }).notNull(),
  nhis: bigint('nhis', { mode: 'number' }).notNull(),
  nsitf: bigint('nsitf', { mode: 'number' }).notNull(),
  totalDeductions: bigint('total_deductions', { mode: 'number' }).notNull(),
  detail: jsonb('detail').notNull(),
  createdAt: createdAt(),
})

export const documents = pgTable('documents', {
  id: id(),
  orgId: orgId(),
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('other'),
  name: text('name').notNull(),
  s3Key: text('s3_key').notNull(),
  contentType: text('content_type'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  requiresAcknowledgement: boolean('requires_acknowledgement').notNull().default(false),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
})

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: id(),
  orgId: orgId(),
  key: text('key').notNull(),
  endpoint: text('endpoint').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: createdAt(),
})

export const notifications = pgTable('notifications', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  deepLink: text('deep_link'),
  data: jsonb('data').notNull().default({}),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: orgId(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  createdAt: createdAt(),
})

export const meetingTypes = pgTable('meeting_types', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  captureEnabled: boolean('capture_enabled').notNull().default(true),
  routeToHr: boolean('route_to_hr').notNull().default(false),
  attendanceTracked: boolean('attendance_tracked').notNull().default(true),
  retentionDays: integer('retention_days').notNull().default(90),
  createdAt: createdAt(),
})

export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    orgId: orgId(),
    calendarEventId: text('calendar_event_id'),
    googleConferenceRecordId: text('google_conference_record_id'),
    title: text('title').notNull(),
    meetingTypeId: uuid('meeting_type_id').references(() => meetingTypes.id, {
      onDelete: 'set null',
    }),
    hostEmployeeId: uuid('host_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),
    actualStart: timestamp('actual_start', { withTimezone: true }),
    actualEnd: timestamp('actual_end', { withTimezone: true }),
    source: text('source').notNull().default('google_meet'),
    status: text('status').notNull().default('scheduled'),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    venue: text('venue'),
    agenda: text('agenda'),
    checkinCode: text('checkin_code'),
    checkinCodeExpiresAt: timestamp('checkin_code_expires_at', { withTimezone: true }),
    recordingS3Key: text('recording_s3_key'),
    transcriptS3Key: text('transcript_s3_key'),
    routeToHr: boolean('route_to_hr').notNull().default(false),
    attendanceResolution: text('attendance_resolution'),
    recordingStartedAt: timestamp('recording_started_at', { withTimezone: true }),
    offRecordFlags: jsonb('off_record_flags').notNull().default([]),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    ingestCompletedAt: timestamp('ingest_completed_at', { withTimezone: true }),
    ingestError: text('ingest_error'),
    createdAt: createdAt(),
  },
  (t) => ({
    startIdx: index('meetings_org_start_idx').on(t.orgId, t.scheduledStart),
    hostIdx: index('meetings_host_idx').on(t.orgId, t.hostEmployeeId, t.status),
  }),
)

export const meetingParticipants = pgTable(
  'meeting_participants',
  {
    id: id(),
    orgId: orgId(),
    meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    inviteStatus: text('invite_status').notNull().default('needs_action'),
    isOptional: boolean('is_optional').notNull().default(false),
    expected: boolean('expected').notNull().default(true),
    firstJoinAt: timestamp('first_join_at', { withTimezone: true }),
    lastLeaveAt: timestamp('last_leave_at', { withTimezone: true }),
    totalDurationSeconds: integer('total_duration_seconds').notNull().default(0),
    attendanceStatus: text('attendance_status'),
    minutesLate: integer('minutes_late').notNull().default(0),
    source: text('source'),
    createdAt: createdAt(),
  },
  (t) => ({
    employeeIdx: index('meeting_participants_employee_idx').on(
      t.orgId,
      t.employeeId,
      t.attendanceStatus,
    ),
    oneEach: uniqueIndex('meeting_participants_meeting_employee_key').on(
      t.meetingId,
      t.employeeId,
    ),
  }),
)

export const meetingTranscripts = pgTable('meeting_transcripts', {
  id: id(),
  orgId: orgId(),
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  language: text('language').notNull().default('en'),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  segmentCount: integer('segment_count').notNull().default(0),
  s3Key: text('s3_key').notNull(),
  speakersResolved: boolean('speakers_resolved').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const meetingSummaries = pgTable('meeting_summaries', {
  id: id(),
  orgId: orgId(),
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  overview: text('overview').notNull(),
  decisions: jsonb('decisions').notNull().default([]),
  topics: jsonb('topics').notNull().default([]),
  openQuestions: jsonb('open_questions').notNull().default([]),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  chunkCount: integer('chunk_count').notNull().default(1),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const meetingActions = pgTable(
  'meeting_actions',
  {
    id: id(),
    orgId: orgId(),
    meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    ownerStated: text('owner_stated'),
    ownerConfidence: text('owner_confidence').notNull().default('unclear'),
    dueDate: date('due_date'),
    sourceQuote: text('source_quote').notNull(),
    timestampMs: integer('timestamp_ms').notNull().default(0),
    status: text('status').notNull().default('draft'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    taskId: uuid('task_id'),
    createdAt: createdAt(),
  },
  (t) => ({
    ownerIdx: index('meeting_actions_owner_idx').on(t.orgId, t.ownerEmployeeId, t.status),
    meetingIdx: index('meeting_actions_meeting_idx').on(t.orgId, t.meetingId),
  }),
)

export const meetingDisputes = pgTable(
  'meeting_disputes',
  {
    id: id(),
    orgId: orgId(),
    meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    outcome: text('outcome'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => ({
    meetingIdx: index('meeting_disputes_meeting_idx').on(t.orgId, t.meetingId, t.status),
  }),
)

export const policyDocuments = pgTable(
  'policy_documents',
  {
    id: id(),
    orgId: orgId(),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    storageKey: text('storage_key').notNull(),
    bodyText: text('body_text').notNull().default(''),
    charCount: integer('char_count').notNull().default(0),
    status: text('status').notNull().default('ready'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ orgIdx: index('policy_documents_org_idx').on(t.orgId, t.createdAt) }),
)

/** Pre-tenant; see the DDL note. No orgId column, no RLS. */
export const signups = pgTable('signups', {
  id: id(),
  email: text('email').notNull(),
  orgName: text('org_name').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  orgId: uuid('org_id'),
  createdAt: createdAt(),
})

export const trainingPlans = pgTable(
  'training_plans',
  {
    id: id(),
    orgId: orgId(),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    periodType: text('period_type').notNull().default('month'),
    periodStart: date('period_start').notNull(),
    status: text('status').notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    employeeIdx: index('training_plans_employee_idx').on(t.orgId, t.employeeId, t.periodStart),
    period: uniqueIndex('training_plans_period_key').on(t.orgId, t.employeeId, t.periodType, t.periodStart),
  }),
)

export const trainingItems = pgTable(
  'training_items',
  {
    id: id(),
    orgId: orgId(),
    planId: uuid('plan_id').notNull().references(() => trainingPlans.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    provider: text('provider'),
    mode: text('mode').notNull().default('virtual'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    need: text('need').notNull().default(''),
    costKobo: bigint('cost_kobo', { mode: 'number' }),
    status: text('status').notNull().default('planned'),
    proofDocumentId: uuid('proof_document_id').references(() => documents.id, { onDelete: 'set null' }),
    proofNote: text('proof_note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastReminder: text('last_reminder'),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    planIdx: index('training_items_plan_idx').on(t.orgId, t.planId),
    datesIdx: index('training_items_dates_idx').on(t.orgId, t.status, t.endDate),
  }),
)

export const speakerMappings = pgTable(
  'speaker_mappings',
  {
    id: id(),
    orgId: orgId(),
    meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
    diarisedSpeakerLabel: text('diarised_speaker_label').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    method: text('method').notNull().default('host_tagged'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('1'),
    createdAt: createdAt(),
  },
  (t) => ({
    oneEach: uniqueIndex('speaker_mappings_meeting_label_key').on(
      t.meetingId,
      t.diarisedSpeakerLabel,
    ),
  }),
)

export const schema = {
  organisations,
  users,
  locations,
  departments,
  workSchedules,
  employees,
  magicLinkTokens,
  refreshTokens,
  otpCodes,
  devices,
  checkinCodes,
  attendanceRecords,
  attendanceDisputes,
  leaveTypes,
  leaveBalances,
  leaveBalanceAdjustments,
  leaveRequests,
  coverageRules,
  compensation,
  employeeLoans,
  payrollRuns,
  payslips,
  documents,
  idempotencyKeys,
  notifications,
  auditLog,
  meetingTypes,
  meetings,
  meetingParticipants,
  meetingTranscripts,
  meetingSummaries,
  meetingActions,
  meetingDisputes,
  speakerMappings,
  policyDocuments,
}
