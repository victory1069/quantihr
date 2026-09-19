-- Quanti HR — authoritative schema.
--
-- Hand-written rather than generated, because the row-level security policies
-- ARE the tenant isolation mechanism (spec §2) and a migration tool that only
-- diffs columns will silently drop them.
--
-- Two rules hold everywhere below:
--   1. Every tenant-scoped table carries `org_id` and a policy keyed to the
--      `app.org_id` session claim.
--   2. The application connects as `quanti_app`, which is NOT a superuser and
--      NOT the table owner. Both matter: superusers bypass RLS entirely, and
--      table owners bypass it unless FORCE is set. FORCE is deliberately not
--      set — the owner is the identity of the pre-tenant lookups, and forcing
--      the policy onto it blinds them. See the note at the RLS block.

-- `gen_random_uuid()` is core since Postgres 13, so no pgcrypto extension is
-- required. That also keeps this schema loadable under PGlite, which does not
-- bundle pgcrypto.

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quanti_app') then
    create role quanti_app nologin;
  end if;

  -- The connecting user must be able to `set role` into quanti_app.
  --
  -- Locally the connection is a superuser and can assume any role, so this was
  -- never exercised. On managed Postgres the connecting user is an ordinary
  -- owner with CREATEROLE, and on PG16+ creating a role auto-inserts a
  -- membership row for the creator with ADMIN but *without* SET — so a naive
  -- "does membership exist?" guard finds that row and skips the grant, and
  -- `set local role quanti_app` still fails with 42501. That guard is what
  -- broke the first fix. Grant unconditionally, with SET stated explicitly.
  --
  -- The PG16 `WITH SET TRUE` form is tried first; on an older server that is
  -- a syntax error and the plain grant — where membership alone confers SET —
  -- is used instead. `current_user` is whoever runs this script, which is the
  -- same user the app connects as.
  begin
    execute format('grant quanti_app to %I with set true, inherit true', current_user);
  exception when syntax_error or feature_not_supported then
    execute format('grant quanti_app to %I', current_user);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Tenancy root
-- ---------------------------------------------------------------------------

create table if not exists organisations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  country      text not null default 'NG',
  timezone     text not null default 'Africa/Lagos',
  settings     jsonb not null default '{}'::jsonb,
  -- Setup progress. Steps completed are recorded as they happen so the wizard
  -- can resume where the HR lead left off; completed_at is what gates the
  -- console out of the wizard and into the product.
  onboarding_steps         jsonb not null default '[]'::jsonb,
  onboarding_completed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id) on delete cascade,
  email             text not null,
  auth_provider     text not null default 'magic_link',
  last_login_at     timestamptz,
  push_token        text,
  biometric_enabled boolean not null default false,
  -- Password is a second sign-in method beside the magic link, added so HR
  -- can hand a new joiner credentials on paper. Null means link-only. A
  -- temporary password sets must_change_password, and the app refuses to go
  -- anywhere else until it is replaced.
  password_hash        text,
  must_change_password boolean not null default false,
  password_changed_at  timestamptz,
  notification_preferences jsonb not null default
    '{"leaveDecisions":true,"checkinReminders":true,"balanceExpiry":true,"documents":true}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (email)
);

create table if not exists locations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id) on delete cascade,
  name              text not null,
  address           text,
  latitude          double precision not null,
  longitude         double precision not null,
  geofence_radius_m integer not null default 150,
  created_at        timestamptz not null default now()
);

create table if not exists departments (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organisations(id) on delete cascade,
  name                 text not null,
  parent_department_id uuid references departments(id) on delete set null,
  created_at           timestamptz not null default now()
);

create table if not exists work_schedules (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organisations(id) on delete cascade,
  name                  text not null,
  working_days          integer[] not null default '{1,2,3,4,5}',
  start_time            text not null default '09:00',
  end_time              text not null default '17:00',
  grace_period_minutes  integer not null default 10,
  checkin_window_start  text not null default '06:00',
  checkin_window_end    text not null default '11:00',
  created_at            timestamptz not null default now()
);

create table if not exists employees (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id) on delete cascade,
  user_id          uuid references users(id) on delete set null,
  employee_number  text not null,
  first_name       text not null,
  last_name        text not null,
  email            text not null,
  phone            text,
  department_id    uuid references departments(id) on delete set null,
  location_id      uuid references locations(id) on delete set null,
  manager_id       uuid references employees(id) on delete set null,
  job_title        text,
  band             text,
  -- Free-text role key used by coverage rules' critical_role_ids.
  role_id          text,
  employment_type  text not null default 'full_time',
  start_date       date not null,
  end_date         date,
  status           text not null default 'active',
  work_schedule_id uuid references work_schedules(id) on delete set null,
  roles            text[] not null default '{employee}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, employee_number),
  unique (org_id, email)
);

create index if not exists employees_org_manager_idx on employees (org_id, manager_id);
create index if not exists employees_org_department_idx on employees (org_id, department_id);

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------

create table if not exists magic_link_tokens (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists refresh_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

-- One-time codes for phone verification during sign-up.
--
-- Separate from magic_link_tokens because the threat model differs: a 6-digit
-- code is brute-forceable, so this table carries an attempt counter and a
-- lockout, neither of which a 256-bit link token needs.
create table if not exists otp_codes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null default 'phone_verification',
  code_hash   text not null,
  destination text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  consumed_at timestamptz,
  -- Set when the attempt limit is hit; verification refuses until it passes.
  locked_until timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists otp_codes_lookup_idx
  on otp_codes (org_id, user_id, purpose, created_at desc);

-- Device binding. A proxy check-in should require physically handing over a
-- phone (spec §7), so re-registration is gated on HR approval rather than
-- happening silently on next login.
create table if not exists devices (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organisations(id) on delete cascade,
  employee_id           uuid not null references employees(id) on delete cascade,
  device_id             text not null,
  platform              text not null default 'web',
  name                  text,
  push_token            text,
  approved              boolean not null default true,
  approval_requested_at timestamptz,
  registered_at         timestamptz not null default now(),
  last_seen_at          timestamptz,
  unique (org_id, employee_id, device_id)
);

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

create table if not exists checkin_codes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  code        text not null,
  valid_from  timestamptz not null,
  valid_until timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists checkin_codes_lookup_idx
  on checkin_codes (org_id, location_id, valid_until desc);

create table if not exists attendance_records (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organisations(id) on delete cascade,
  employee_id           uuid not null references employees(id) on delete cascade,
  date                  date not null,
  checked_in_at         timestamptz,
  client_timestamp      timestamptz,
  checkin_method        text not null default 'geofence_code',
  verification_signals  jsonb not null default '{}'::jsonb,
  latitude              double precision,
  longitude             double precision,
  accuracy_m            double precision,
  status                text not null,
  minutes_late          integer not null default 0,
  rejection_reason      text,
  reason                text,
  recorded_offline      boolean not null default false,
  created_at            timestamptz not null default now()
);

-- One accepted record per employee per day. Rejected attempts are still stored
-- (a rejected attempt is a record, not a void — spec §7) but must not collide,
-- so the constraint is partial.
create unique index if not exists attendance_one_accepted_per_day
  on attendance_records (org_id, employee_id, date)
  where status in ('present', 'late');

create index if not exists attendance_history_idx
  on attendance_records (org_id, employee_id, date desc);

create table if not exists attendance_disputes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  record_id   uuid not null references attendance_records(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  reason      text not null,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------

create table if not exists leave_types (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organisations(id) on delete cascade,
  name                    text not null,
  accrual_method          text not null default 'annual_fixed',
  accrual_rate            numeric(6,2) not null default 0,
  max_balance             numeric(6,2),
  carryover_cap           numeric(6,2),
  carryover_expiry_months integer,
  requires_document       boolean not null default false,
  min_notice_days         integer,
  is_paid                 boolean not null default true,
  colour                  text not null default '#4F46E5',
  active                  boolean not null default true,
  created_at              timestamptz not null default now()
);

create table if not exists leave_balances (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations(id) on delete cascade,
  employee_id   uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  accrued       numeric(6,2) not null default 0,
  taken         numeric(6,2) not null default 0,
  pending       numeric(6,2) not null default 0,
  carried_over  numeric(6,2) not null default 0,
  adjustment    numeric(6,2) not null default 0,
  carryover_expires_on date,
  computed_at   timestamptz not null default now(),
  unique (org_id, employee_id, leave_type_id, period_start)
);

create table if not exists leave_balance_adjustments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations(id) on delete cascade,
  employee_id   uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete cascade,
  period_start  date not null,
  delta         numeric(6,2) not null,
  reason        text not null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists leave_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  leave_type_id   uuid not null references leave_types(id) on delete cascade,
  start_date      date not null,
  end_date        date not null,
  days_count      numeric(6,2) not null,
  half_day_start  boolean not null default false,
  half_day_end    boolean not null default false,
  reason          text,
  status          text not null default 'pending',
  warnings        jsonb not null default '[]'::jsonb,
  submitted_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references users(id) on delete set null,
  decision_note   text,
  override_reason text,
  document_url    text,
  created_at      timestamptz not null default now()
);

create index if not exists leave_requests_employee_idx
  on leave_requests (org_id, employee_id, start_date desc);
create index if not exists leave_requests_status_idx
  on leave_requests (org_id, status, submitted_at);

create table if not exists coverage_rules (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations(id) on delete cascade,
  department_id          uuid not null references departments(id) on delete cascade,
  max_concurrent_absent  integer,
  max_concurrent_percent numeric(5,2),
  blackout_periods       jsonb not null default '[]'::jsonb,
  critical_role_ids      text[] not null default '{}',
  created_at             timestamptz not null default now(),
  unique (org_id, department_id)
);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

create table if not exists documents (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organisations(id) on delete cascade,
  -- NULL means org-wide (a policy every employee can read).
  employee_id              uuid references employees(id) on delete cascade,
  type                     text not null default 'other',
  name                     text not null,
  s3_key                   text not null,
  content_type             text,
  size_bytes               bigint,
  uploaded_by              uuid references users(id) on delete set null,
  uploaded_at              timestamptz not null default now(),
  requires_acknowledgement boolean not null default false,
  acknowledged_at          timestamptz
);

create index if not exists documents_employee_idx on documents (org_id, employee_id);

-- ---------------------------------------------------------------------------
-- Payroll (spec §10)
-- ---------------------------------------------------------------------------
--
-- All money is stored as bigint MINOR UNITS (kobo). Never numeric, never float.
-- A payroll figure that has been through a float is a figure nobody can
-- reconcile against a bank file.

-- Compensation is versioned rather than mutated: a payslip issued in March must
-- still be reproducible after an April raise, and a back-dated correction has to
-- be visible as a correction.
create table if not exists compensation (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  effective_from  date not null,
  effective_to    date,
  basic           bigint not null default 0,
  housing         bigint not null default 0,
  transport       bigint not null default 0,
  allowances      jsonb not null default '[]'::jsonb,
  voluntary_pension bigint not null default 0,
  nhis            bigint not null default 0,
  bank_name       text,
  bank_account_number text,
  bank_account_name   text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (org_id, employee_id, effective_from)
);

create index if not exists compensation_lookup_idx
  on compensation (org_id, employee_id, effective_from desc);

create table if not exists employee_loans (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  kind        text not null default 'loan_repayment',
  name        text not null,
  principal   bigint not null,
  paid        bigint not null default 0,
  per_period  bigint not null,
  status      text not null default 'active',
  reason      text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists employee_loans_active_idx
  on employee_loans (org_id, employee_id, status);

-- A run moves draft → pending_approval → approved → paid. Nothing is payable
-- until a named human approves it (spec §10, §3 "no automated decisions").
create table if not exists payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  pay_date      date not null,
  status        text not null default 'draft',
  -- Which statutory schedule produced these figures. Recorded so a later rate
  -- correction can identify exactly which runs are affected.
  schedule_id   text not null,
  totals        jsonb not null default '{}'::jsonb,
  notes         text,
  created_by    uuid references users(id) on delete set null,
  approved_by   uuid references users(id) on delete set null,
  approved_at   timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (org_id, period_start, period_end, pay_date)
);

create table if not exists payslips (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id) on delete cascade,
  run_id            uuid not null references payroll_runs(id) on delete cascade,
  employee_id       uuid not null references employees(id) on delete cascade,
  gross             bigint not null,
  net_pay           bigint not null,
  paye              bigint not null,
  pension_employee  bigint not null,
  pension_employer  bigint not null,
  nhf               bigint not null,
  nhis              bigint not null,
  nsitf             bigint not null,
  total_deductions  bigint not null,
  -- The full engine output, so a payslip can be re-rendered and explained
  -- without recomputing against rates that may since have changed.
  detail            jsonb not null,
  created_at        timestamptz not null default now(),
  unique (org_id, run_id, employee_id)
);

create index if not exists payslips_employee_idx
  on payslips (org_id, employee_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Infrastructure
-- ---------------------------------------------------------------------------

-- The offline outbox retries; without this a flaky connection produces
-- duplicate leave requests (spec §4).
create table if not exists idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id) on delete cascade,
  key             text not null,
  endpoint        text not null,
  request_hash    text not null,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  unique (org_id, key, endpoint)
);

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  event       text not null,
  title       text not null,
  body        text not null,
  deep_link   text,
  data        jsonb not null default '{}'::jsonb,
  sent_at     timestamptz,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications (org_id, user_id, created_at desc);

create table if not exists audit_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  ip            text,
  created_at    timestamptz not null default now()
);

create index if not exists audit_log_entity_idx on audit_log (org_id, entity_type, entity_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Meeting assistant
-- ---------------------------------------------------------------------------
--
-- Capture policy is per meeting type, never a global default (meeting spec
-- §8.3). A team working candidly through a problem behaves differently when HR
-- reads the transcript, so `route_to_hr` is configured per type and shown to
-- attendees on the meeting record before it starts.

create table if not exists meeting_types (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organisations(id) on delete cascade,
  name               text not null,
  capture_enabled    boolean not null default true,
  route_to_hr        boolean not null default false,
  attendance_tracked boolean not null default true,
  retention_days     integer not null default 90,
  created_at         timestamptz not null default now()
);

create table if not exists meetings (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references organisations(id) on delete cascade,
  calendar_event_id            text,
  google_conference_record_id  text,
  title                        text not null,
  meeting_type_id              uuid references meeting_types(id) on delete set null,
  host_employee_id             uuid references employees(id) on delete set null,
  scheduled_start              timestamptz not null,
  scheduled_end                timestamptz not null,
  actual_start                 timestamptz,
  actual_end                   timestamptz,
  source                       text not null default 'google_meet',
  status                       text not null default 'scheduled',
  location_id                  uuid references locations(id) on delete set null,
  -- Free text, because a physical meeting is as often "Boardroom, 3rd floor"
  -- or a customer's office as it is one of the configured locations.
  venue                        text,
  agenda                       text,
  -- A meeting code is fixed for the sitting rather than rotating like the
  -- door code: a rotation partway through would lock out the person who
  -- arrived late, which is exactly who still needs to check in.
  checkin_code                 text,
  checkin_code_expires_at      timestamptz,
  recording_s3_key             text,
  transcript_s3_key            text,
  route_to_hr                  boolean not null default false,
  -- How the attendance set resolved: recorded, did_not_occur or too_short.
  -- Stored rather than recomputed, so the record an employee disputed does not
  -- change underneath the dispute.
  attendance_resolution        text,
  recording_started_at         timestamptz,
  -- Millisecond offsets at which an attendee flagged the preceding two minutes
  -- as off the record (§8.2). Held here because the flags are raised during the
  -- meeting, before any transcript exists; they are applied at normalisation
  -- and the flagged segments are never persisted.
  off_record_flags             jsonb not null default '[]'::jsonb,
  reviewed_at                  timestamptz,
  reviewed_by                  uuid references users(id) on delete set null,
  -- Drives the 30-day expiry alert (§2.4). Transcript entries served by the
  -- Meet API are deleted 30 days after the conference ends, and those entries
  -- are the speaker-attributed artifact we actually want.
  ingest_completed_at          timestamptz,
  ingest_error                 text,
  created_at                   timestamptz not null default now()
);

create index if not exists meetings_org_start_idx on meetings (org_id, scheduled_start desc);
create index if not exists meetings_host_idx on meetings (org_id, host_employee_id, status);
create unique index if not exists meetings_conference_idx
  on meetings (org_id, google_conference_record_id)
  where google_conference_record_id is not null;

create table if not exists meeting_participants (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations(id) on delete cascade,
  meeting_id             uuid not null references meetings(id) on delete cascade,
  employee_id            uuid not null references employees(id) on delete cascade,
  invite_status          text not null default 'needs_action',
  is_optional            boolean not null default false,
  -- False for someone who attended without being invited, and for optional or
  -- declined invitees. Never counted against an absence figure (§7.1).
  expected               boolean not null default true,
  first_join_at          timestamptz,
  last_leave_at          timestamptz,
  total_duration_seconds integer not null default 0,
  attendance_status      text,
  minutes_late           integer not null default 0,
  source                 text,
  created_at             timestamptz not null default now(),
  unique (meeting_id, employee_id)
);

create index if not exists meeting_participants_employee_idx
  on meeting_participants (org_id, employee_id, attendance_status);

create table if not exists meeting_transcripts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id) on delete cascade,
  meeting_id        uuid not null references meetings(id) on delete cascade,
  language          text not null default 'en',
  duration_seconds  integer not null default 0,
  segment_count     integer not null default 0,
  s3_key            text not null,
  speakers_resolved boolean not null default false,
  -- Retention runs against this rather than the meeting date, so a transcript
  -- ingested late still gets its full configured life (§8.4).
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (meeting_id)
);

create table if not exists meeting_summaries (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations(id) on delete cascade,
  meeting_id     uuid not null references meetings(id) on delete cascade,
  overview       text not null,
  decisions      jsonb not null default '[]'::jsonb,
  topics         jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  model          text not null,
  -- Cost telemetry from day one (§11). Meeting volume varies enormously
  -- between customers and LLM tokens are the variable cost driver, so this is
  -- recorded per meeting rather than estimated later.
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  tokens_used    integer not null default 0,
  cost_usd       numeric(10, 6) not null default 0,
  chunk_count    integer not null default 1,
  generated_at   timestamptz not null default now(),
  unique (meeting_id)
);

create table if not exists meeting_actions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations(id) on delete cascade,
  meeting_id        uuid not null references meetings(id) on delete cascade,
  description       text not null,
  owner_employee_id uuid references employees(id) on delete set null,
  owner_stated      text,
  owner_confidence  text not null default 'unclear',
  due_date          date,
  -- Never null and never empty. An action without the verbatim line it came
  -- from cannot be checked by the host, which makes a hallucinated one
  -- indistinguishable from a real one (§5.3).
  source_quote      text not null,
  timestamp_ms      integer not null default 0,
  status            text not null default 'draft',
  confirmed_by      uuid references users(id) on delete set null,
  confirmed_at      timestamptz,
  -- Response time is measured confirmed_at -> completed_at. Without this the
  -- status flips to 'done' and the elapsed time is gone, so a metric that
  -- feeds performance review would have to be inferred. It is not.
  completed_at      timestamptz,
  task_id           uuid,
  created_at        timestamptz not null default now()
);

create index if not exists meeting_actions_owner_idx
  on meeting_actions (org_id, owner_employee_id, status);
create index if not exists meeting_actions_meeting_idx
  on meeting_actions (org_id, meeting_id);

create table if not exists meeting_disputes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations(id) on delete cascade,
  meeting_id  uuid not null references meetings(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  reason      text not null,
  status      text not null default 'open',
  -- Disputes route to the meeting host, not HR: the host was there and can
  -- settle it in one tap. HR sees the outcome, not the argument (§7.4).
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  outcome     text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists meeting_disputes_meeting_idx
  on meeting_disputes (org_id, meeting_id, status);

create table if not exists speaker_mappings (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations(id) on delete cascade,
  meeting_id             uuid not null references meetings(id) on delete cascade,
  diarised_speaker_label text not null,
  employee_id            uuid references employees(id) on delete set null,
  -- `host_tagged` today. Voice enrolment is noted as a future improvement in
  -- §6 and deliberately not built: it adds a biometric data category with its
  -- own consent bar and degrades badly on poor room audio.
  method                 text not null default 'host_tagged',
  confidence             numeric(4, 3) not null default 1,
  created_at             timestamptz not null default now(),
  unique (meeting_id, diarised_speaker_label)
);

-- ---------------------------------------------------------------------------
-- Policy corpus — what the self-service assistant answers from
-- ---------------------------------------------------------------------------

-- The handbook and every policy an org uploads, with the text extracted at
-- upload time. The assistant is given an org's corpus whole, in a cached
-- prompt, rather than chunks from a shared index: a handbook is tens of
-- thousands of tokens, which fits, and it makes per-tenant isolation a matter
-- of which rows are loaded rather than which vectors are filtered. One
-- organisation's handbook surfacing in another's assistant is the
-- highest-severity failure this product can have, and a per-row org_id under
-- RLS is a far stronger guarantee than a metadata filter on an index.
create table if not exists policy_documents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations(id) on delete cascade,
  title          text not null,
  filename       text not null,
  mime_type      text not null,
  storage_key    text not null,
  -- Extracted at upload. Empty when extraction failed, which the assistant
  -- treats as "this document says nothing" rather than guessing.
  body_text      text not null default '',
  char_count     integer not null default 0,
  status         text not null default 'ready',
  uploaded_by    uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists policy_documents_org_idx on policy_documents(org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Learning & development
--
-- A plan is one employee's intended training for a month or a quarter,
-- submitted for their manager's approval. Items are the individual courses;
-- each carries its own completion and its proof. The plan and its items are
-- separate rows because approval is of the plan as a whole, while proof and
-- reminders are per course.
-- ---------------------------------------------------------------------------

create table if not exists training_plans (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations(id) on delete cascade,
  employee_id    uuid not null references employees(id) on delete cascade,
  -- 'month' or 'quarter'; period_start is the first day of that period.
  period_type    text not null default 'month',
  period_start   date not null,
  -- draft → submitted → approved | declined | changes_requested (→ submitted)
  status         text not null default 'draft',
  submitted_at   timestamptz,
  decided_at     timestamptz,
  decided_by     uuid references users(id) on delete set null,
  decision_note  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, employee_id, period_type, period_start)
);

create index if not exists training_plans_employee_idx on training_plans(org_id, employee_id, period_start desc);

create table if not exists training_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organisations(id) on delete cascade,
  plan_id            uuid not null references training_plans(id) on delete cascade,
  employee_id        uuid not null references employees(id) on delete cascade,
  title              text not null,
  provider           text,
  -- 'physical' or 'virtual'
  mode               text not null default 'virtual',
  start_date         date not null,
  end_date           date not null,
  -- Why this course, this period: the "based on need" the manager judges.
  need               text not null default '',
  cost_kobo          bigint,
  -- planned → completed | missed. Set by the employee with proof, or by the
  -- reminder sweep once the end date is long past.
  status             text not null default 'planned',
  proof_document_id  uuid references documents(id) on delete set null,
  proof_note         text,
  completed_at       timestamptz,
  -- The last reminder kind sent, so each is sent once: 'starts', 'proof_due', 'nudge_1' …
  last_reminder      text,
  last_reminder_at   timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists training_items_plan_idx on training_items(org_id, plan_id);
create index if not exists training_items_dates_idx on training_items(org_id, status, end_date);

-- ---------------------------------------------------------------------------
-- Additive migrations
-- ---------------------------------------------------------------------------

-- `create table if not exists` is skipped entirely when the table already
-- exists, so a column added to a CREATE above never reaches a database that was
-- built before it. Locally that is invisible — PGlite is in-memory and every
-- boot is a fresh database — and it surfaced on Render as
-- `column "onboarding_steps" of relation "organisations" does not exist`.
--
-- The rule from here on: a column added to an existing table goes in the CREATE
-- above (so a fresh database is right) AND here as an idempotent ALTER (so an
-- existing one catches up). Both, every time. `add column if not exists` is a
-- no-op when the column is already there, so this section is safe on every
-- boot and never needs pruning.

alter table organisations add column if not exists onboarding_steps        jsonb not null default '[]'::jsonb;
alter table organisations add column if not exists onboarding_completed_at timestamptz;

alter table meetings add column if not exists venue                   text;
alter table meetings add column if not exists agenda                  text;
alter table meetings add column if not exists checkin_code            text;
alter table meetings add column if not exists checkin_code_expires_at timestamptz;

alter table meeting_actions add column if not exists completed_at timestamptz;

alter table users add column if not exists password_hash        text;
alter table users add column if not exists must_change_password boolean not null default false;
alter table users add column if not exists password_changed_at  timestamptz;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- `nullif(..., '')` makes an unset or blank claim compare as NULL, which makes
-- the predicate NULL, which hides the row. Unset context fails closed.
--
-- **Why RLS is enabled but not FORCED.** FORCE makes the policy apply to the
-- table owner as well. That sounds like a second line of defence, and the
-- header of this file once described it that way — but it broke sign-in on
-- the first real deployment, and the reasoning was wrong:
--
--   - The application never runs as the owner. Every request transaction does
--     `set local role quanti_app`, a non-owner, and RLS applies to it in full
--     whether or not FORCE is set. FORCE adds nothing to the app's isolation.
--
--   - The owner IS the identity of the SECURITY DEFINER lookups below —
--     auth_lookup_user, auth_lookup_magic_link, auth_lookup_invite,
--     list_org_ids. They run before any tenant claim exists; that is their
--     whole purpose. Under FORCE, with no claim set, the policy hides every
--     row from them: no user is ever found, no magic link ever verifies, and
--     seedIfEmpty sees zero orgs on every boot.
--
--   - Locally this was invisible because PGlite's owner is a superuser, and
--     superusers bypass RLS regardless of FORCE. On managed Postgres (Render,
--     RDS, Supabase) the owner is an ordinary role and FORCE bites.
--
-- The narrow lookups are still narrow — each returns a handful of columns
-- and is the only privileged path — and the app role is still fully
-- constrained. What FORCE was defending against was the owner reading
-- tenant data, and the owner is exactly the role that has to.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'users', 'locations', 'departments', 'work_schedules', 'employees',
    'magic_link_tokens', 'refresh_tokens', 'devices', 'otp_codes',
    'checkin_codes', 'attendance_records', 'attendance_disputes',
    'leave_types', 'leave_balances', 'leave_balance_adjustments',
    'leave_requests', 'coverage_rules',
    'compensation', 'employee_loans', 'payroll_runs', 'payslips',
    'documents', 'idempotency_keys', 'notifications', 'audit_log',
    'meeting_types', 'meetings', 'meeting_participants',
    'meeting_transcripts', 'meeting_summaries', 'meeting_actions',
    'meeting_disputes', 'speaker_mappings',
    'policy_documents', 'training_plans', 'training_items'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    -- Deliberately NOT forced. See the note above the block.
    execute format('alter table %I no force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I using (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
       with check (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  end loop;
end $$;

-- organisations is the tenancy root: an org row is visible only to itself.
alter table organisations enable row level security;
alter table organisations no force row level security;
drop policy if exists org_self on organisations;
create policy org_self on organisations
  using (id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to quanti_app;
grant select, insert, update, delete on all tables in schema public to quanti_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to quanti_app;

-- audit_log is append-only, enforced at the database role level rather than in
-- application code (spec §3) — application code is exactly what an attacker who
-- has reached this point already controls.
revoke update, delete on audit_log from quanti_app;

-- ---------------------------------------------------------------------------
-- Pre-tenant lookups
-- ---------------------------------------------------------------------------
--
-- Auth has a bootstrapping problem: to set `app.org_id` you must first know
-- which org the caller belongs to, and finding that out means reading `users`
-- before any tenant claim exists.
--
-- The tempting fix is to run auth as a superuser. It works in development and
-- fails in production, where the app connects as `quanti_app` and cannot bypass
-- RLS at all. These SECURITY DEFINER functions behave identically in both: each
-- is read-only, takes an exact-match argument, returns the minimum needed to
-- establish tenancy, and is the ONLY route around a policy in the system.
--
-- Nothing here should ever return a list of users, accept a pattern, or be
-- granted to a role other than quanti_app.

-- Dropped first, not just replaced: `create or replace` refuses to change a
-- function's return type, and this one grew two columns when passwords
-- arrived. A deployment whose database predates that would fail to boot.
-- The grant below is re-issued every run, so dropping loses nothing.
drop function if exists auth_lookup_user(text);
create function auth_lookup_user(p_email text)
returns table (user_id uuid, org_id uuid, password_hash text, must_change_password boolean)
language sql stable security definer set search_path = public as $$
  select id, org_id, password_hash, must_change_password from users where email = lower(trim(p_email)) limit 1
$$;

create or replace function auth_lookup_magic_link(p_token_hash text)
returns table (token_id uuid, user_id uuid, org_id uuid,
               expires_at timestamptz, used_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, user_id, org_id, expires_at, used_at
  from magic_link_tokens where token_hash = p_token_hash limit 1
$$;

create or replace function auth_lookup_refresh_token(p_token_hash text)
returns table (token_id uuid, user_id uuid, org_id uuid,
               expires_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, user_id, org_id, expires_at, revoked_at
  from refresh_tokens where token_hash = p_token_hash limit 1
$$;

-- Invite lookup for the sign-up flow.
--
-- NOTE ON ENUMERATION. This deliberately confirms whether an address belongs to
-- an employee, which `auth_lookup_user` never exposes to a caller. That is a
-- product decision, not an oversight: the sign-up screen has to be able to say
-- "we can't find an invite for that email", because the alternative is a new
-- joiner staring at a screen that silently does nothing.
--
-- The cost is a staff-directory oracle for anyone who can guess addresses. It is
-- mitigated by rate limiting at the route, and by returning only the org name
-- and a masked phone tail — never a name, a role, or the full number.
create or replace function auth_lookup_invite(p_email text)
returns table (org_id uuid, org_name text, email text, phone text, employee_status text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, e.email, e.phone, e.status
  from employees e
  join organisations o on o.id = e.org_id
  where e.email = lower(trim(p_email))
  limit 1
$$;

-- Nightly jobs iterate orgs, then do their real work inside a tenant context so
-- the policies are still exercised on every row they touch.
create or replace function list_org_ids()
returns table (org_id uuid, timezone text, settings jsonb)
language sql stable security definer set search_path = public as $$
  select id, timezone, settings from organisations order by created_at
$$;

revoke all on function auth_lookup_user(text) from public;
revoke all on function auth_lookup_magic_link(text) from public;
revoke all on function auth_lookup_refresh_token(text) from public;
revoke all on function auth_lookup_invite(text) from public;
revoke all on function list_org_ids() from public;

grant execute on function auth_lookup_user(text) to quanti_app;
grant execute on function auth_lookup_magic_link(text) to quanti_app;
grant execute on function auth_lookup_refresh_token(text) to quanti_app;
grant execute on function auth_lookup_invite(text) to quanti_app;
grant execute on function list_org_ids() to quanti_app;
