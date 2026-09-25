# QuantiHR — QA Tracker

Durable, version-controlled tracker under `qa/framework/SENIOR_QA_SOFTWARE_TESTING_FRAMEWORK.md` §19.

- **Source:** transcribed on 2026-09-25 from the published tracker page
  (https://claude.ai/artifact/SRohASB1Ee5LufwCxNJZb5, version 13). From this commit on,
  this file is the version-controlled record. Keep the published page in step with it or
  retire it (owner's choice).
- **Repo:** `victory1069/quantihr` · default branch `master`
- **Source plan:** "QuantiHR Test Plan", reviewed 14 Sep 2026. **Not committed to this
  repository.** Case wording below comes from the tracker, not from the plan itself.
- **Rules:** execution log is append-only; case and finding IDs are permanent; only verified
  information is recorded.

## Current state (2026-09-25)

| Item | State |
|---|---|
| Phase 1 (PR #1) | Merged to `master` 2026-09-23 by the repo owner (`1bb0841`); post-merge verification EXEC-009 |
| Phase 2 (PR #2, branch `ci/phase-2-inf-02-inf-01`) | **Open, not merged.** CI green on `e0d21f6` (run 36141102729). QA report issued: `qa/reports/QA_REPORT_2026-09-25_e0d21f6.md`, recommendation **SHIP WITH CONDITIONS**. **Awaiting human QA/release review.** The recommendation is a QA assessment, not merge approval |
| INF-01 coverage baseline | Completed; verified in live CI (on the PR #2 branch, not yet on `master`) |
| INF-02 CI workflow | Completed; verified in live CI (on the PR #2 branch, not yet on `master`) |
| First CI failure (EXEC-012) | Investigated and resolved: environment/configuration issue (shallow checkout), fixed in `e0d21f6` |
| CI re-run (EXEC-013) | Passed |
| Coverage artifact | Verified: uploaded by run 36141102729, 521,442 bytes |
| EBADENGINE install warnings | Tracked environment/dependency warning (FND-ENV-002) |
| Mobile CI / typecheck | DEFERRED: Expo typed-routes environment issue (FND-ENV-001) |
| Open product-level risk | DEF-006, deferred by decision |
| Totals | 56 cases: 35 passing (incl. INF-01/02 on the PR #2 branch), 21 not started, 0 blocked, 0 failing |

## QA reports

| Report | HEAD | Scope | Status |
|---|---|---|---|
| `qa/reports/QA_REPORT_2026-09-25_e0d21f6.md` | `e0d21f6` (PR #2) | Phase 2: INF-02 CI workflow, INF-01 coverage baseline, FND-CI-001 fix | QA recommendation **SHIP WITH CONDITIONS** (4 conditions, report §3). **AWAITING HUMAN QA/RELEASE REVIEW.** Not merge approval. Report file uncommitted as of 2026-09-25 |

Report naming: `qa/reports/QA_REPORT_<date>_<sha>.md` (framework §17).

Phase 1 was reported through the PR #1 description and the published tracker. No file
report exists for it.

---

## 01 — Test case register

Status key: **pass** = automated/in place and passing · **not started** = no test yet ·
**blocked** = waiting on a finding · **fail** = implemented, currently red.

### Session lifecycle
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| SES-01 | Refresh rotates the token and invalidates the one it replaced | P0 | Integration | pass | POST /v1/auth/refresh |
| SES-02 | A replayed (already-rotated) refresh token is rejected | P0 | Integration | pass | POST /v1/auth/refresh |
| SES-03 | A second device is flagged for review, not refused (reworded 18 Sep, see note) | P0 | Integration | pass | POST /v1/auth/verify |
| SES-04 | Refresh token past the 90-day sliding window is rejected | P0 | Integration | pass | POST /v1/auth/refresh |
| SES-05 | Magic link sent only to a known employee address | P0 | Integration | pass | POST /v1/auth/magic-link |
| SES-06 | Token signed with the wrong secret is rejected | P0 | Integration | pass | auth middleware |
| SES-07 | Every non-public route requires authentication | P0 | Integration | pass | all routes |

> **SES-03 note (18 Sep):** the plan said an unapproved device's tokens are refused. The
> product flags a second device (`deviceReviewRequired: true`) and still issues a working
> session; `requireAuth` never checks approval status. The test asserts the specified
> behaviour ("flag for review rather than reject, per spec §7").

### Invite, OTP & rate limiting
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| INV-01 | Rate-limit behaviour documented/tested across >1 API instance | P1 | Integration | not started | routes/invite.ts |
| INV-02 | `resetRateLimits()` confirmed unreachable outside test env | P1 | Integration | not started | routes/invite.ts |
| INV-03 | Five wrong OTP codes locks out and names the email fallback | P1 | Integration | pass | POST /v1/invite/otp/verify |
| INV-04 | Invite lookup never leaks a name or full phone number | P1 | Integration | pass | POST /v1/invite |
| INV-05 | A superseded OTP code stops working | P1 | Integration | pass | POST /v1/invite/otp/request |

### Attendance, geofencing & check-in codes
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| ATT-01 | Employee raises a dispute on their own record; manager can see and act on it (built alongside, DEF-007) | P1 | Integration | pass | POST /v1/attendance/dispute · GET+POST /v1/team/attendance-disputes |
| ATT-02 | A dispute on a record that is not the caller's own is refused (reworded, see note) | P1 | Integration | pass | POST /v1/attendance/dispute |
| ATT-03 | A rotated check-in code invalidates the previous one | P1 | Integration | not started | GET /v1/admin/checkin-code/:locationId |
| ATT-04 | Check-in inside/outside the geofence, by measured distance | P1 | Integration | pass | POST /v1/attendance/checkin |
| ATT-05 | Mocked or imprecise location rejected outright | P1 | Integration | pass | POST /v1/attendance/checkin |
| ATT-06 | Second same-day check-in refused; idempotency-key retry doesn't double-record | P1 | Integration | pass | POST /v1/attendance/checkin |

> **ATT-01/02 note (18 Sep):** "manager can act on it" had no endpoint; one was built (DEF-007).
> The route's authorization only checks record ownership, so ATT-02 was reworded from "not
> scheduled at that location" to "not the caller's own".

### Leave, accrual & coverage rules
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| LEA-01 | A request larger than the balance fails with an actionable error code | P2 | Integration | pass | POST /v1/leave |
| LEA-02 | Approving against a coverage rule requires an override reason | P2 | Integration | pass | POST /v1/team/approvals |
| LEA-03 | An employee cannot approve their own request | P2 | Integration | pass | POST /v1/team/approvals |
| LEA-04 | Balance adjustment audit trail | P2 | Integration | not started | POST /v1/admin/balances/adjust |

### Payroll, compensation & loans
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| PAY-01 | A loan balance that would go negative on an over-large instalment | P2 | Unit | not started | payroll.ts |
| PAY-02 | Two concurrent approval attempts on the same run (race) | P2 | Integration | not started | /v1/payroll/* |
| PAY-03 | Bank file refused before approval; CSV emitted only after | P2 | Integration | pass | /v1/payroll/* |
| PAY-04 | Approval by the run's own creator refused | P2 | Integration | pass | /v1/payroll/* |
| PAY-05 | Statutory-rate and missing-compensation warnings surface, not fail silently | P2 | Integration | pass | /v1/payroll/* |

### Meetings — AI transcription & summarisation
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| MTG-01 | The 25-of-30-day backfill alert fires for an un-ingested transcript | P2 | Integration | not started | jobs/reminders.ts |
| MTG-02 | A real, sandboxed Claude call against `MEETING_MODEL` — response schema | P2 | Contract | not started | MEETING_MODEL |
| MTG-03 | Summarisation skipped, not fabricated, with no API key configured | P2 | Integration | pass | meetings ingestion |
| MTG-04 | A host cannot rewrite a summary already sent to HR | P2 | Integration | pass | meetings |
| MTG-05 | Someone absent from the meeting can't file a dispute on it | P2 | Integration | pass | meetings disputes |
| MTG-06 | A dispute routes to the host, who can correct the record | P2 | Integration | pass | meetings disputes |

### Documents & admin surface
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| DOC-01 | Document list, acknowledge, and download URL for a real owned document | P0 | Integration | pass | /v1/documents/* |
| DOC-02 | Scaled down (DEF-006 deferred): whichever storage driver is selected fails loudly, not silently | P1 | Unit | pass | lib/storage.ts |
| DOC-03 | Admin CRUD on locations/schedules/coverage-rules; an employee sees the effect | P0 | Integration | pass | /v1/admin/* |
| DOC-04 | `/v1/admin/devices/approve` actually unblocks the pending device's tokens | P0 | Integration | pass | /v1/admin/devices/approve |
| DOC-05 | Cross-tenant document fetch by id refused | P0 | Integration | pass | /v1/documents/:id |
| DOC-06 | Employee import: blank rows skipped, headings normalised, non-spreadsheet refused | P0 | Integration | pass | /v1/admin/employees/import |

### Notification delivery
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| NOT-01 | A push notification reaches Expo's API in the shape it expects | P1 | Integration | not started | PUSH_DRIVER=expo |
| NOT-02 | Contract test: SES / Termii DND / Twilio send against a sandbox account | P1 | Contract | not started | lib/notify.ts |
| NOT-03 | SMS never sends to a caller-supplied destination, only the HR record | P1 | Integration | pass | lib/notify.ts |
| NOT-04 | A failed SMS provider tells the user to fall back to email | P1 | Integration | pass | lib/notify.ts |

### Mobile app — offline sync & device security
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| MOB-01 | Outbox queues an offline check-in, replays once connectivity returns | P0 | Unit | not started | src/api/outbox.ts |
| MOB-02 | Sync-loop backs off on repeated failure | P0 | Unit | not started | src/api/sync-loop.ts |
| MOB-03 | An idempotency key survives an app restart mid-retry | P0 | Unit | not started | src/api/sync.ts |
| MOB-04 | Biometric gate blocks the app after backgrounding | P0 | E2E | not started | ui/BiometricGate.tsx |
| MOB-05 | The auth deep-link callback completes sign-in from a magic-link tap | P0 | E2E | not started | app/auth/callback.tsx |
| MOB-06 | A denied location permission degrades check-in gracefully | P0 | E2E | not started | check-in flow |

### Non-functional
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| NFR-01 | Boot refuses a dev-only JWT secret / console email driver in `NODE_ENV=production` | P1 | Unit | not started | env.ts |
| NFR-02 | Dependency-vulnerability scanning wired in (npm audit / Dependabot) | P1 | Infra | not started | CI config |
| NFR-03 | Idempotency-key pattern checked once, parametrised across every route that accepts one | P1 | Integration | not started | cross-cutting |
| NFR-04 | Push and storage driver failure paths each have a named fallback, tested | P1 | Integration | not started | lib/notify.ts, storage driver |
| NFR-05 | Scripted load smoke test: everyone checking in within one 15-minute window | P2 | Performance | not started | PGlite scale test |

### CI & coverage infrastructure
| ID | Scenario | Pri | Type | Status | Surface |
|---|---|---|---|---|---|
| INF-01 | Coverage measured via `vitest.config.ts`: `@vitest/coverage-v8` (V8 native coverage, c8's engine); baseline in §05; no thresholds yet | P1 | Infra | pass (live CI, PR #2 branch) | vitest.config.ts ×2 |
| INF-02 | CI runs typecheck + tests for `shared` and `api` on every PR and push to `master` (scope narrowed, see note) | P0 | Infra | pass (live CI, PR #2 branch) | .github/workflows/ci.yml |

> **INF-01/02 note (25 Sep):** INF-02 originally read "npm test --workspaces + typecheck". It
> covers `shared` and `api` only. `apps/mobile` has no suite and its typecheck fails on
> FND-ENV-001. The workflow installs as `render.yaml` does, on Node 22.11.0. INF-01 names
> c8; vitest's V8 provider (the same engine) was used because the case specifies
> `vitest.config.ts`.

---

## 02 — Traceability matrix

| Risk item (plan §03) | Priority | Case IDs | Pass | Open | Blocked / fail |
|---|---|---|---|---|---|
| Session lifecycle | P0 | SES-01…07 | 7 | 0 | — |
| Documents — list, download, acknowledge | P0 | DOC-01…06 | 6 | 0 | — |
| Mobile client — outbox, sync, biometric gate | P0 | MOB-01…06 | 0 | 6 | — |
| CI gate | P0 | INF-02 | 1 | 0 | — |
| Attendance dispute | P1 | ATT-01, ATT-02 | 2 | 0 | — |
| Device approval & check-in code rotation | P1 | ATT-03, DOC-04 | 1 | 1 | — |
| Admin CRUD — org, locations, schedules, coverage | P1 | DOC-03 | 0 | 1 | — |
| Reminder & accrual jobs | P1 | MTG-01 | 0 | 1 | — |
| Driver contracts (SES, Termii/Twilio, Deepgram, Meet) | P1 | NOT-01, NOT-02, MTG-02 | 0 | 3 | — |
| Coverage measurement | P1 | INF-01 | 1 | 0 | — |
| Payroll runs, payslips, bank file, loans | P2 — maintain | PAY-01…05 | 3 | 2 | — |
| Meetings — ingestion, summarisation, disputes | P2 — maintain | MTG-01…06 | 4 | 2 | — |
| Tenant isolation & RLS | P2 — extend as written | tenant-isolation.test.ts | 35 | — | — |

> Rows are carried over from the published tracker unchanged, including the "Admin CRUD" row
> showing DOC-03 as open while the register shows DOC-03 as pass. That inconsistency exists in
> the source and is **not resolved here**. Flagged for the next tracker review.
> The CI gate and Coverage measurement rows were added for INF-02/INF-01. They aren't
> plan §03 items.

---

## 03 — Defects & findings log

Classes per framework §9.

| ID | Title | Class | Severity | Found | Status |
|---|---|---|---|---|---|
| DEF-001 | `apps/mobile` typecheck failed: nine `@quanti/shared` types never re-exported at the package root | Product defect (build/type) | — | 16 Sep | Fixed 17 Sep |
| DEF-002 | Meeting-dispute test failed on a hardcoded fixture date vs real clock | Test defect | — | 16 Sep | Fixed 17 Sep; superseded by master's dynamic-date fix (EXEC-008) |
| DEF-003 | `Palette.surfaceAlt` didn't exist (3 call sites) | Product defect (type) | Low | 17 Sep | Fixed 18 Sep; master's `surfaceRaised` kept at merge (EXEC-008) |
| DEF-004 | `Screen.refreshControl` typed as bare `ReactElement`: type-only, no runtime mismatch | Product defect (type-only) | Low | 17 Sep | Fixed 18 Sep |
| DEF-005 | `/v1/admin/devices/pending` listed retired devices; missing `approvalRequestedAt` filter | Product defect | — | 18 Sep | Fixed 18 Sep |
| DEF-006 | Document storage not production-durable: S3 driver is a stub; Render uses `STORAGE_DRIVER=local` with no persistent disk | Architectural risk | High | 18 Sep | **Open, deferred by decision.** DOC-02 guards against silent loss only |
| DEF-007 | Attendance disputes could be raised but never reviewed; no endpoint | Missing functionality | — | 18 Sep | Built 18 Sep (`/v1/team/attendance-disputes`, `previousStatus`) |
| FND-ENV-001 | Mobile typecheck: 6 × TS2493 in `app/_layout.tsx`; expo-router typed routes (`.expo/types`, gitignored) never generated | Environment / configuration issue | Low for PR #2 | 21 Sep | **DEFERRED.** Pre-existing in `master`'s code; excluded from CI |
| FND-ENV-002 | `EBADENGINE` install warnings: react-native 0.86.3 / `@react-native/*` / metro 0.84.5 (29 packages) request Node `^20.19.4 \|\| ^22.13.0 \|\| ^24.3.0 \|\| >=25`; CI runs 22.11.0, and `render.yaml` also pins 22.11.0 | Environment / dependency compatibility warning | Low as observed | 25 Sep | **Tracked.** No failure observed in shared/api CI. EBADENGINE warnings were observed in the CI/development dependency installation. Whether the same warnings occur during the current Render build was not directly verified. A Node upgrade is a coordinated owner decision |
| FND-CI-001 | First live CI run failed: shallow checkout lacked commit `ad3ba4e` needed by `schema-drift.test.ts` | Environment / configuration issue | High | 25 Sep | **Resolved** in `e0d21f6` (`fetch-depth: 0`); test unchanged |
| FND-QA-001 | Local CI simulation (`git worktree`) couldn't reproduce CI's shallow checkout | Test defect (QA method) | Low | 25 Sep | **Resolved as a process lesson**: simulate with `git clone --depth 1` |
| FND-CFG-001 | `render.yaml` comment says the workspace flags keep react-native/Expo out of the install; observed installs include them at the root | Environment / configuration issue (inaccurate config comment) | Low | 25 Sep | **DEFERRED.** Deployment config outside Phase 2 scope |

> The FND- IDs are new. FND-ENV-001, FND-ENV-002 and FND-CI-001 were assigned while moving the
> tracker into the repo, for findings the published tracker recorded as notes or execution
> entries (not DEF- items). FND-QA-001 and FND-CFG-001 were assigned in the Phase 2 QA report.
> Severities for FND- items are QA proposals (framework §9.1).

### Phase 2 findings: detail

Source: `qa/reports/QA_REPORT_2026-09-25_e0d21f6.md` §19. Severity = impact; priority = finding
urgency (framework §9.1); both are QA proposals for owner confirmation.

| ID | Classification | Severity | Priority | Status | Discovery method | Evidence | Fix | Retest | Regression |
|---|---|---|---|---|---|---|---|---|---|
| FND-CI-001 | Environment / configuration issue | High (CI gate unusable; no product impact) | P0 (blocks INF-02) | Resolved | First live CI run on PR #2 (run 36139284575), failed-step log | `git show ad3ba4e:apps/api/src/db/ddl.sql` → status 128, `fatal: invalid object name 'ad3ba4e'`; api 348/349; reproduced locally: depth-1 clone exit 128, full clone exit 0 | `e0d21f6`: `actions/checkout@v4` `fetch-depth: 0`; test unchanged | Run 36141102729: `schema-drift.test.ts` passes; api 349/349 | Same run: full shared 181/181 + api 349/349; coverage identical to baseline |
| FND-QA-001 | Test defect (QA method) | Low | P2 | Resolved as a process lesson | Root-cause analysis of FND-CI-001 | Local simulation used `git worktree` (full history) vs CI's depth-1 checkout | Method change: simulate CI with `git clone --depth 1` | NOT APPLICABLE — QA-method finding, no code artifact | NOT APPLICABLE — QA-method finding |
| FND-ENV-002 | Environment / dependency compatibility warning | Low as observed; impact on mobile tooling NOT ENOUGH EVIDENCE TO DECIDE | P2 | Tracked | Review of run 36141102729 Install log | 29 `npm warn EBADENGINE` entries (react-native 0.86.3, 13 × `@react-native/*`, 14 × `metro*` 0.84.5, `ob1`), required `^20.19.4 \|\| ^22.13.0 \|\| ^24.3.0 \|\| >=25`, current v22.11.0. Render build not inspected | DEFERRED — owner decision (keep 22.11.0 or bump Render + CI together) | NOT APPLICABLE — no fix applied | Shared/api CI unaffected in the same run (530/530) |
| FND-CFG-001 | Environment / configuration issue (inaccurate config comment) | Low | P2 | Deferred | Local clean-worktree install (EXEC-010) | After the flagged `npm ci`, `react-native` and `expo` present in root `node_modules`; CI EBADENGINE list shows react-native/metro installed with the same flags | DEFERRED — deployment config out of Phase 2 scope | NOT APPLICABLE — no fix applied | NOT APPLICABLE — no fix applied |
| FND-ENV-001 | Environment / configuration issue | Low for PR #2 (pre-existing, not in gate) | P1 for mobile CI | Deferred | EXEC-008 note (21 Sep); re-observed EXEC-009 (25 Sep) | 6 × TS2493, `app/_layout.tsx` lines 132–135 | DEFERRED — mobile tooling outside Phase 2 scope | NOT APPLICABLE — no fix applied | Last observed unchanged: 6 errors (EXEC-009) |

---

## 04 — Execution log (append-only)

| Run | Date | Trigger | Scope | Result | Summary |
|---|---|---|---|---|---|
| EXEC-001 | 16 Sep 2026 | Baseline verification, fresh checkout | test + typecheck, all workspaces | fail | shared 181/181; api 257/258 (DEF-002); mobile typecheck 24 errors (DEF-001) |
| EXEC-002 | 17 Sep 2026 | Verify DEF-001/002 fixes | test + typecheck | pass* | shared 181/181; api 258/258; mobile 24 → 4 errors (DEF-003/004) |
| EXEC-003 | 18 Sep 2026 | Verify DEF-003/004 fixes | typecheck + test | pass | 0 typecheck errors in all workspaces; 439/439 |
| EXEC-004 | 18 Sep 2026 | Phase 1: session + document/admin tests | vitest (api) | 1 fail | 268/269; the failure was DEF-005 caught by DOC-04 |
| EXEC-005 | 18 Sep 2026 | Verify DEF-005 fix | typecheck + test | pass | shared 181/181; api 269/269 |
| EXEC-006 | 18 Sep 2026 | DOC-02 scoped down; storage test | vitest (api) + typecheck | pass | caught and fixed a clock-dependent DOC-03 test; api 271/271 |
| EXEC-007 | 18 Sep 2026 | ATT-01/02 build + test | typecheck + vitest (api) | pass | 2 wrong test expectations corrected (404 via RLS; 422 convention); api 278/278; total 459 |
| EXEC-008 | 21 Sep 2026 | Merge `master` into Phase 1 branch | merge + install + typecheck + test | pass | 3 conflicts resolved; duplicate barrel exports fixed; incompatible DEF-002 fixes reconciled; api 349/349; shared 181/181 |
| EXEC-009 | 25 Sep 2026 | Post-merge verification of PR #1 (`1bb0841`) | diff + test + typecheck | pass* | merge tree identical to PR head; shared 181/181; api 349/349; mobile 6 known errors (FND-ENV-001) |
| EXEC-010 | 25 Sep 2026 | INF-02 local simulation (clean worktree) | schema validation + install + typecheck + test | pass | injected failures produced non-zero exits; validator rejects malformed input; commit `e585adc` |
| EXEC-011 | 25 Sep 2026 | INF-01 coverage baseline | test:coverage + clean-worktree CI steps | pass | coverage-v8 2.1.9; lockfile +249/−0; api +11s; commit `cd783f9` |
| EXEC-012 | 25 Sep 2026 | First live CI run (PR #2) | GitHub Actions run 36139284575 | 1 fail | api 348/349: `schema-drift.test.ts` `git show ad3ba4e:…` exit 128 on shallow clone (FND-CI-001); reproduced locally with a depth-1 clone |
| EXEC-013 | 25 Sep 2026 | Fix FND-CI-001 | GitHub Actions run 36141102729 | pass | `fetch-depth: 0` (`e0d21f6`); Node 22.11.0; shared 181/181; api 349/349; coverage identical to baseline; artifact 521,442 bytes; FND-ENV-002 observed |

Full per-run narrative for EXEC-001…013 is in the published tracker, version 13.

---

## 05 — Coverage baseline (recorded 2026-09-25)

Scope: each workspace's own `src/**/*.ts`. Measured locally (EXEC-011) and matched in CI
(EXEC-013). No thresholds enforced.

| Workspace | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| apps/api | 73.22% (7847/10717) | 75.44% (1112/1474) | 65.62% (210/320) | 73.22% (7847/10717) |
| packages/shared | 44.06% (1061/2408) | 91.21% (374/410) | 81.44% (79/97) | 44.06% (1061/2408) |
| apps/mobile | DEFERRED — no test suite | — | — | — |

- **shared:** all 10 covered files are in `domain/` (95–100% lines). The 16 files at 0% are
  the 12 zod schema files, `errors.ts`, and 3 barrel `index.ts` files, which shared's own
  suite never imports. The low aggregate is self-coverage: it doesn't by itself mean the
  application is inadequately tested. **The coverage analysis does not establish that the api
  suite exercises every shared schema file.** api's coverage counts only `apps/api/src`, so
  any indirect execution of shared code is unmeasured.
- **api:** largest uncovered areas (lines): `routes/meetings.ts` 374, `routes/admin.ts` 324,
  `db/seed.ts` 300 (dev tooling, 0%), `routes/payroll.ts` 216, `routes/team.ts` 173,
  `lib/anthropic.ts` 141, `lib/transcription.ts` 123, `lib/meet.ts` 122,
  `jobs/meeting-pipeline.ts` 101, `jobs/reminders.ts` 97 (0%, which is MTG-01).
