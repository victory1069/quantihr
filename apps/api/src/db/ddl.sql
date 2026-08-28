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
--      table owners bypass it unless FORCE is set. We set FORCE anyway as a
--      second line of defence.

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
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- `nullif(..., '')` makes an unset or blank claim compare as NULL, which makes
-- the predicate NULL, which hides the row. Unset context fails closed.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'users', 'locations', 'departments', 'work_schedules', 'employees',
    'magic_link_tokens', 'refresh_tokens', 'devices',
    'checkin_codes', 'attendance_records', 'attendance_disputes',
    'leave_types', 'leave_balances', 'leave_balance_adjustments',
    'leave_requests', 'coverage_rules',
    'documents', 'idempotency_keys', 'notifications', 'audit_log'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I using (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
       with check (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  end loop;
end $$;

-- organisations is the tenancy root: an org row is visible only to itself.
alter table organisations enable row level security;
alter table organisations force row level security;
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

create or replace function auth_lookup_user(p_email text)
returns table (user_id uuid, org_id uuid)
language sql stable security definer set search_path = public as $$
  select id, org_id from users where email = lower(trim(p_email)) limit 1
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
revoke all on function list_org_ids() from public;

grant execute on function auth_lookup_user(text) to quanti_app;
grant execute on function auth_lookup_magic_link(text) to quanti_app;
grant execute on function auth_lookup_refresh_token(text) to quanti_app;
grant execute on function list_org_ids() to quanti_app;
