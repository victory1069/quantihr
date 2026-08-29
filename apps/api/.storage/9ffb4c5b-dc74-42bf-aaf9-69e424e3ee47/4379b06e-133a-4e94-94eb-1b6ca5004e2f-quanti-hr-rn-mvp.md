# Quanti HR — React Native MVP Build Spec

**Version 0.1**
**Scope:** Phase 1 only (attendance, leave, employee records, manager approvals)
**Target:** shippable to one design partner, 20–100 employees

---

## 1. MVP boundary

The MVP is a leave and attendance system with a document vault. Payroll, meeting assistant, policy assistant, goals, and promotion dossiers are all out.

The test for inclusion: does this need to work before a design partner can stop using spreadsheets? If no, it waits.

**In**

- Org onboarding and configuration (web console, minimal)
- Employee records and bulk import
- Office check-in with geofence and rotating code
- Leave request, approval, and accrual engine
- Manager approval queue and team calendar
- Document vault (read-only, HR uploads)
- Push notifications
- Employee home screen

**Out**

- Payroll and payslips
- Meeting attendance and the meeting assistant
- Policy assistant
- Queries and disciplinary workflow
- Goals, KPIs, reviews
- NFC and BLE verification (geofence + code only for now)
- E-signature
- Analytics beyond a basic attendance summary

Two things in the "out" list will be tempting to pull forward. Resist both. The **query engine** should not ship until the attendance data has run clean for a full month with a real customer, because a disciplinary letter built on bad data is worse than no letter. **Payslips** are the strongest employee retention feature in the product, but they depend on the payroll engine, and half-shipping them (HR uploads PDFs manually) creates a migration problem later.

---

## 2. Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Client | Expo (SDK 54+) with dev client | Geofencing, biometrics, background tasks, and push all have first-party or plugin support. Bare RN buys nothing here and costs upgrade pain. |
| Language | TypeScript, strict | |
| Navigation | Expo Router | File-based, handles deep links from notifications cleanly |
| Server state | TanStack Query | Cache, retry, and offline persistence in one place |
| Local persistence | MMKV for cache, expo-sqlite for the write outbox | MMKV is fast enough for query cache hydration; SQLite for anything needing a transaction |
| Client state | Zustand | Small. Session, config, and UI state only |
| Forms | React Hook Form + Zod | Zod schemas shared with the backend |
| Styling | Nativewind | |
| Backend | Node + TypeScript, Fastify | |
| Database | Postgres with row-level security | RLS is the tenant isolation mechanism, not application-layer filtering |
| ORM | Drizzle | Typed, and the migration story is predictable |
| Files | S3 with presigned URLs | |
| Push | Expo Push Service → APNs/FCM | |
| Hosting | AWS (ECS Fargate or App Runner) | |
| Jobs | pg-boss or SQS | Accrual runs, notification batches, reminder sweeps |

**On Expo:** the one thing that would force a bare workflow is a native module without a config plugin. Nothing in the MVP needs that. NFC and BLE in Phase 2 both have maintained plugins.

---

## 3. Data model

Core tables. Every tenant-scoped table carries `org_id` and has an RLS policy keyed to the JWT claim.

```
organisations
  id, name, country, timezone, created_at, settings jsonb

locations
  id, org_id, name, address, latitude, longitude, geofence_radius_m

departments
  id, org_id, name, parent_department_id

employees
  id, org_id, employee_number, first_name, last_name, email, phone,
  department_id, location_id, manager_id, job_title, band,
  employment_type, start_date, end_date, status,
  work_schedule_id, user_id

users
  id, email, auth_provider, last_login_at, push_token, biometric_enabled

work_schedules
  id, org_id, name, working_days int[], start_time, end_time,
  grace_period_minutes, checkin_window_start, checkin_window_end

-- Attendance

checkin_codes
  id, org_id, location_id, code, valid_from, valid_until

attendance_records
  id, org_id, employee_id, date, checked_in_at, checkin_method,
  verification_signals jsonb, latitude, longitude, accuracy_m,
  status, minutes_late, reason, recorded_offline bool, created_at

-- Leave

leave_types
  id, org_id, name, accrual_method, accrual_rate, max_balance,
  carryover_cap, carryover_expiry_months, requires_document,
  min_notice_days, is_paid, colour

leave_balances
  id, org_id, employee_id, leave_type_id, period_start, period_end,
  accrued, taken, pending, carried_over, adjustment

leave_requests
  id, org_id, employee_id, leave_type_id, start_date, end_date,
  days_count, half_day_start bool, half_day_end bool, reason,
  status, submitted_at, decided_at, decided_by, decision_note,
  override_reason, document_url

coverage_rules
  id, org_id, department_id, max_concurrent_absent,
  max_concurrent_percent, blackout_periods jsonb, critical_role_ids

-- Documents

documents
  id, org_id, employee_id, type, name, s3_key, uploaded_by,
  uploaded_at, requires_acknowledgement, acknowledged_at

-- Audit

audit_log
  id, org_id, actor_user_id, action, entity_type, entity_id,
  before jsonb, after jsonb, ip, created_at
```

**Notes**

`attendance_records.verification_signals` holds what we actually checked: code match, distance from geofence centre, GPS accuracy, whether WiFi BSSID matched, whether the device reported mock location. Storing the signals rather than a boolean means we can revisit thresholds later without losing history, and it gives HR something concrete to show an employee disputing a record.

`leave_balances` is materialised per period rather than computed on read. Accrual rules get messy enough that a nightly job writing balances is easier to debug than a query that recomputes from first principles every time someone opens the home screen.

`audit_log` is append-only. Revoke UPDATE and DELETE at the database role level, not in application code.

---

## 4. API surface

REST, versioned. Every endpoint requires a JWT carrying `user_id`, `org_id`, `employee_id`, and `roles`.

```
POST   /v1/auth/magic-link          request link
POST   /v1/auth/verify              exchange token for session
POST   /v1/auth/refresh
POST   /v1/auth/device              register push token

GET    /v1/me                       employee profile + org config
PATCH  /v1/me                       update editable fields

GET    /v1/attendance/status        today's record + whether window is open
POST   /v1/attendance/checkin       { code, lat, lng, accuracy, signals, client_timestamp }
GET    /v1/attendance/history       ?from&to
POST   /v1/attendance/dispute       { record_id, reason }

GET    /v1/leave/balances
GET    /v1/leave/types
POST   /v1/leave/requests           { type_id, start, end, half_days, reason }
GET    /v1/leave/requests           ?status
DELETE /v1/leave/requests/:id       cancel while pending
POST   /v1/leave/check-conflicts    { type_id, start, end } → warnings before submit

GET    /v1/team/calendar            ?from&to        manager or team member
GET    /v1/team/approvals           manager only
POST   /v1/team/approvals/:id       { decision, note, override_reason }
GET    /v1/team/attendance          manager only

GET    /v1/documents
GET    /v1/documents/:id/url        presigned, short TTL

GET    /v1/config                   org settings the client needs
```

**Idempotency.** `POST /attendance/checkin` and `POST /leave/requests` accept an `Idempotency-Key` header. The offline outbox retries, and without this a flaky connection produces duplicate leave requests.

**Server time is authoritative.** The client sends `client_timestamp` for offline records but the server decides lateness against its own clock and the record's sync context. Never trust a device clock for anything disciplinary.

---

## 5. Screens

### Employee

**Home** (`/`)
Leave balance, next check-in or check-in status, one primary action button, list of pending items. Hydrates from cache instantly, revalidates in background. Never shows a full-screen spinner.

**Check-in** (`/checkin`)
Code entry, location status indicator, submit. Shows clearly whether the window is open, and if it isn't, when it opens. Failed attempts show why (out of range, wrong code, stale code) rather than a generic error.

**Leave** (`/leave`)
Balance by type, request history, new request button.

**Leave request** (`/leave/new`)
Type picker, date range, half-day toggles, live balance projection, conflict warnings shown inline before submit, reason field.

**Documents** (`/documents`)
List, biometric gate on open, view or download.

**Profile** (`/profile`)
Editable personal fields, read-only employment fields, notification settings, sign out.

### Manager mode

**Approvals** (`/manage/approvals`)
Queue, swipe or tap to approve, conflict context surfaced on each request, override reason required when approving against a coverage rule.

**Team calendar** (`/manage/calendar`)
Month view, who is off, coverage gaps highlighted.

**Team attendance** (`/manage/attendance`)
Weekly summary, drill-down per employee, employees approaching a lateness threshold flagged. The flag is informational in the MVP since queries aren't built yet, but the data model should support it from day one.

Manager mode is a toggle in the tab bar for users with the role, not a separate app or a separate login.

---

## 6. Offline strategy

Two separate mechanisms, and conflating them causes bugs.

**Read cache.** TanStack Query with an MMKV persister. Hydrate on launch, revalidate in background. Balances, attendance history, documents metadata, and team calendar all serve stale-while-revalidate. The home screen must render meaningful content with no network.

**Write outbox.** A SQLite table:

```
outbox
  id, idempotency_key, endpoint, method, payload jsonb,
  created_at, attempts, last_error, status
```

Mutations write to the outbox and optimistically update the cache. A background task drains it with exponential backoff. UI shows a pending state on any record with an unsynced write.

**Conflicts.** For the MVP the rules are simple enough to resolve server-side:

- Check-in: server accepts the earliest client_timestamp for a given employee-date and rejects duplicates on idempotency key
- Leave request: if the balance changed and the request no longer fits, server rejects with a specific error code and the client surfaces it as an actionable message rather than a silent failure

Do not build general conflict resolution. Two rules cover the MVP.

---

## 7. Attendance verification

Geofence plus rotating code for the MVP. Be clear-eyed about what this proves.

**Client checks, sent as signals:**

```ts
{
  code: string,
  latitude: number,
  longitude: number,
  accuracy_m: number,
  is_mocked: boolean,        // Location.hasServicesEnabledAsync + platform mock flag
  wifi_bssid?: string,       // Android only without extra entitlements
  device_id: string,
}
```

**Server validates:**

1. Code is current for that location (and not more than one rotation stale, to allow for entry latency)
2. Coordinates inside `geofence_radius_m` of the location
3. `accuracy_m` below a threshold (reject wildly imprecise fixes rather than accepting them)
4. `is_mocked` false
5. `device_id` matches the employee's registered device, or flag for review if it doesn't
6. Within the check-in window

All signals persist regardless of outcome. A rejected attempt is a record, not a void.

**Known holes, to state plainly to customers:**

- Screenshot sharing defeats the code. A colleague can send it in eleven seconds.
- Rooted or jailbroken devices can spoof GPS.
- Device binding is the strongest single control here, since it means a proxy check-in requires physically handing over your phone.

Positioning matters: this is a deterrent and a record, not proof of presence. Customers who need proof need NFC or BLE, which is Phase 2.

**iOS background location:** don't. The MVP uses foreground-only location captured at the moment of check-in. Background geofencing triggers App Store review scrutiny, drains battery, and is not needed when the employee is actively opening the app to check in.

---

## 8. Leave accrual engine

The part most likely to be underestimated. Build it properly now.

**Nightly job** per org, in the org's timezone:

1. For each employee, for each active leave type, compute accrual for the period
2. Apply pro-rating for employees who started or ended mid-period
3. Apply carryover at period boundaries, respecting caps and expiry
4. Write to `leave_balances`
5. Emit notifications for balances expiring within a configurable window

**Accrual methods to support in v1:**

- Annual grant on a fixed date
- Annual grant on employment anniversary
- Monthly accrual
- Accrual per hours worked (stub the interface, don't implement until a customer needs it)

**Pro-rating:** days × (months employed in period / 12), rounded per the org's configured rule (up, down, or nearest half day). Make the rounding rule configurable. Every org has an opinion and they are all different.

**Balance arithmetic:** `available = accrued + carried_over + adjustment − taken − pending`. Pending must be deducted, or an employee submits three overlapping requests and the third one shouldn't have been allowed.

**Test coverage here should be disproportionate.** Mid-year joiner, mid-year leaver, leap year, carryover expiring mid-request, half day at a period boundary, negative adjustment taking a balance below zero. These are the bugs that lose a customer's trust permanently, because they show up in the one number the employee actually checks.

---

## 9. Auth and session

- Magic link by email for first login. No passwords in the MVP.
- On success, issue a refresh token stored in `expo-secure-store` and a short-lived access token in memory.
- Biometric unlock (`expo-local-authentication`) gates app open after first login, and always gates the documents screen.
- Refresh token TTL of 90 days, sliding. An employee who last opened the app four months ago should not hit a login wall.
- If the refresh fails, fall back to magic link, not to a password screen.

**Device registration** happens at first login and binds `device_id` to the employee for attendance verification. Re-registration requires HR approval, which prevents the obvious workaround.

---

## 10. Notifications

Expo Push, with deep links routed by Expo Router.

| Event | Recipient | Deep link |
|---|---|---|
| Leave approved or declined | Requester | `/leave/[id]` |
| Leave request submitted | Manager | `/manage/approvals` |
| Approval pending 48h | Manager | `/manage/approvals` |
| Check-in window opening | Employee | `/checkin` |
| Balance expiring soon | Employee | `/leave` |
| Document uploaded | Employee | `/documents` |

**Manager approval from the notification.** iOS notification actions and Android quick actions let a manager approve without opening the app. This is worth building in the MVP — it's the single biggest driver of approval latency, which is the metric employees judge the product on.

**Content rules:** nothing in a preview that shouldn't be visible on a lock screen. No salary figures (not yet relevant), no disciplinary content, no leave reasons.

---

## 11. Build sequence

Rough two-week increments. Assumes a small team.

**1–2. Foundation**
Repo, CI, Expo dev build on both platforms, Postgres with RLS, auth end to end, employee record CRUD, bulk import with validation preview.

**3–4. Leave core**
Leave types and configuration, accrual engine with the test suite, balances, request and approval flow, coverage rules.

**5–6. Attendance**
Code generation and rotation, check-in flow, geofence validation, signal capture, history, manager attendance view.

**7. Offline and notifications**
Outbox, cache persistence, optimistic updates, push registration, notification actions.

**8. Manager mode and documents**
Approval queue, team calendar, document vault, biometric gating.

**9. Web console**
Minimal: org config, employee management, leave type setup, location and geofence setup, document upload. Not pretty, functional.

**10. Hardening**
Audit log coverage, error tracking, load test on the accrual job, spoofing test in a real office, accessibility pass.

Design partner onboards at the end of increment 6 in read-only shadow mode, running parallel to their spreadsheet. They cut over after increment 8.

---

## 12. Testing

- **Unit:** accrual engine, coverage rule evaluation, lateness computation. These three have the highest bug-to-damage ratio.
- **Integration:** API against a real Postgres with RLS enabled. Every test asserts tenant isolation, not just correctness.
- **E2E:** Maestro for the check-in and leave request flows on both platforms.
- **Offline:** scripted airplane-mode runs. Queue a check-in and two leave requests offline, reconnect, assert no duplicates and correct ordering.
- **Tenant isolation:** a dedicated suite that authenticates as org A and attempts to read every org B resource. Run it in CI on every commit.

---

## 13. Open technical decisions

1. **Web console framework.** Next.js sharing the Zod schemas and API client is the obvious choice, but it's a second surface to maintain from month one. An alternative is making the MVP console a Retool or Refine build and replacing it later.
2. **Whether HR gets a mobile surface in the MVP.** Currently no. If the design partner's HR lead works primarily from a phone, this changes the scope materially.
3. **Timezone handling for multi-location orgs.** MVP assumes one timezone per org. Multi-timezone needs the schedule and accrual jobs reworked, so decide before the accrual engine is built rather than after.
4. **Photo capture on check-in.** A selfie at check-in is a strong verification signal and a significant privacy intrusion. Not in the MVP. Worth asking the design partner whether they'd want it configurable.
5. **Employee data export.** Required under NDPR. Straightforward to build, easy to forget, and awkward to explain if a customer asks before it exists.
