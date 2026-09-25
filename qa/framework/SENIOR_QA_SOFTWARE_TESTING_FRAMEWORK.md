# Senior QA Software Testing Framework — QuantiHR

> **Provenance.** This file brings the QA process already agreed and practised on
> QuantiHR (Phase 1, PR #1; Phase 2, PR #2) into version control. Its rules come
> from three sources only: the project owner's written QA instructions in the working
> session, the working rules used during Phase 1 and Phase 2, and the QA tracker
> (`qa/QA_TRACKER.md`, mirrored from the published tracker page). It is not a redesign.
>
> **Known gap:** the consolidated framework's original **command system** and
> **section numbering** were not available when this file was created. The
> sections below are numbered for this file only. §20 records the gap rather than
> inventing commands. When the original is supplied, reconcile the numbering and
> fill in §20. Do not treat this numbering as the canonical one until then.
>
> **Revision 2026-09-25 (documentation correction pass after the Phase 2 report review):**
> added §4.1 structural-vs-runtime decision rule, §4.2 test-type applicability,
> §5.1 testing depth levels, the two testing perspectives (§6, §7), §8.1 failing-test
> investigation rule, and §9.1 severity vs priority; corrected an unmeasured coverage
> claim in §13. Top-level section numbers are unchanged, so existing report
> references remain valid.

---

## 1. Core principles

1. **Evidence before claims.** Every result in a report must trace to evidence:
   command output, a CI run, a commit, a diff, or a reproduction. No evidence means
   no claim.
2. **No overclaiming.** Report exactly what was run, where, and on what. A local run
   is not a CI run. A passing suite is not complete coverage. A warning that hasn't
   caused a failure is not "harmless". It is a warning with no observed functional
   impact yet.
3. **Humans decide releases.** QA produces evidence and a status. Only a human
   reviewer/owner decides to merge or release (§18).
4. **History is preserved.** Reports are never overwritten and execution logs are
   appended to, never rewritten (§17, §19).
5. **Stay in scope.** Do only the QA scope that was authorized. Starting new phases,
   new test areas, or product changes needs explicit human direction (§10).

## 2. Understand the project before testing

Before writing or running tests:

- Read the code paths under test. Don't rely only on the test plan's wording.
  Where the plan and the product disagree, verify the product's actual, specified
  behaviour and correct the *case wording*, with a recorded note. For example,
  SES-03 was reworded from "refused" to "flagged for review", and ATT-02 was
  reworded to "not the caller's own", after reading the routes.
- Inspect existing repo conventions (scripts, configs, runtime versions, deploy
  config, error-code conventions) and match them.
- Identify the environment that production actually uses (e.g. `render.yaml`'s
  Node version and install command) and test against that.

## 3. Baseline before change

- Record the state **before** any change: test counts, typecheck results, coverage
  where measurable, and known failures. (Examples: EXEC-001 baseline; EXEC-009
  post-merge verification before Phase 2.)
- After a change, compare against the baseline so every difference can be
  attributed (§12, report §20).
- A baseline that includes failures is still a baseline. Record the failures;
  don't hide them.

## 4. Testing modes

| Mode | Use when | Examples |
|---|---|---|
| **Structural / static** | Correctness can be established by inspection, schema, or type analysis | typecheck, workflow schema validation, diff review, lockfile review |
| **Runtime** | Behaviour must be observed executing | vitest suites, CI runs, reproductions |
| **Hybrid** | Structure is checked statically and then exercised | a workflow validated by schema, simulated locally, then run live in CI |

If structural evidence is sufficient and runtime testing is genuinely unnecessary,
record: `STRUCTURAL / RUNTIME NOT REQUIRED — <reason>`.

A local simulation doesn't replace the real environment. Record where the two
differ (e.g. a `git worktree` shares full history, but CI's checkout is shallow;
see EXEC-012).

### 4.1 Structural vs runtime decision rule

**Before running tests**, decide whether the change can be adequately verified
by structural/static inspection.

Primarily structural changes include:

- workflow syntax
- CI configuration
- package scripts
- dependency configuration
- static configuration
- documentation
- naming/structure conventions

Decision:

1. **Structural is sufficient.** Verify by inspection, schema, diff, or type
   analysis, and record `STRUCTURAL / RUNTIME NOT REQUIRED — <reason>`.
2. **Runtime is required.** The behaviour can only be established by execution:
   application logic, data paths, integrations, timing, or environment-dependent
   behaviour.
3. **Hybrid.** The change is structural but its effect is behavioural (e.g. a CI
   workflow: valid syntax *and* it must actually pass good code and fail bad code).
   Perform both where required.

**Never skip runtime testing merely for convenience.** The reason for any
`STRUCTURAL / RUNTIME NOT REQUIRED` must be that static evidence is genuinely
sufficient, not that runtime testing is slow or awkward.

### 4.2 Test-type applicability

Not every test type applies to every change. For each type below, the tester
decides and records one of:

- **REQUIRED**: risk or scope makes it applicable, so it must be performed.
- **OPTIONAL**: useful but not necessary for this change.
- `NOT APPLICABLE — <reason>`: doesn't apply, with a documented reason.
- `STRUCTURAL / RUNTIME NOT REQUIRED — <reason>`: static evidence is sufficient
  (§4.1).

| Test type | Typical trigger for REQUIRED |
|---|---|
| Static/structural testing | Any change to configuration, schemas, types, workflows, scripts, dependencies |
| Runtime testing | Any change whose behaviour can only be observed executing |
| Manual testing | Behaviour that isn't automated, or needs human judgement (visual, UX, device) |
| Exploratory testing | New or high-risk features; unclear requirements; after defects cluster in an area |
| Automated testing | Behaviour that must be re-verified on every change (regression-prone, P0/P1) |
| API testing | Changes to routes, request/response contracts, auth middleware |
| UI testing | Changes to screens, components, navigation, client-side state |
| Database/data-integrity testing | Schema, migration, DDL, RLS/tenant isolation, or data-writing changes |
| Accessibility testing | User-facing UI changes |
| Browser compatibility testing | Changes to web-rendered UI |
| Device/mobile compatibility testing | Changes to the mobile app, native modules, permissions, offline behaviour |
| Performance testing | Hot paths, bulk/volume operations, scale-sensitive flows, CI duration changes |
| Security/authorization testing | Auth, permissions, tenant boundaries, data exposure, secrets |
| Regression testing | Every change (§11); scope scales with depth (§5.1) |
| CI/CD validation | Changes to workflows, build/test scripts, runtime versions, dependencies |

The report records the decision for each type in its Test Strategy section.
**Don't require every test type for every change.** Choose by risk and scope, and
document the choice.

## 5. Risk-based test depth

- Every case carries a priority: **P0** (highest risk: auth/session, data
  access, documents, mobile offline/device security, CI gate), **P1**, or **P2**
  ("maintain" / "extend as written"), as assigned in the tracker's register.
- Test depth scales with priority. P0 needs normal-path, failure-path and misuse
  coverage. Lower priorities may be covered proportionately.
- The traceability matrix maps each risk item to case IDs so gaps are visible.

> Case priority (P0/P1/P2) ranks **test cases and risk areas**. It is distinct from
> defect severity and defect priority (§9.1).

### 5.1 Testing depth

For every change, the tester **must choose and document** one depth level:

| Depth | Use when |
|---|---|
| **BASIC** | Low risk, small, isolated change; confirm it works and nothing obvious regresses |
| **STANDARD** | Typical feature or fix; normal-path and main failure-path testing plus relevant regression |
| **DEEP** | Sensitive or complex change; both perspectives (§6, §7) in full, boundary and state testing, wider regression |
| **INTENSIVE** | Highest risk; exhaustive misuse/loophole testing, concurrency and recovery, cross-area regression, independent verification where possible |

Decide from risk factors such as:

- user impact
- data sensitivity
- authentication/authorization
- financial impact
- destructive actions
- workflow/state complexity
- integration complexity
- change size
- regression risk
- production exposure
- history of defects in the area

The report must state the chosen depth **and why it is appropriate**, naming the
risk factors that drove it. Depth may rise during testing if findings reveal more
risk. Record the change and the reason.

## 6. Intended-user / normal-path testing

**Perspective 1: intended behaviour.** Testers must consider how the intended
user or system is expected to use the feature, where applicable:

- normal web user flow
- normal mobile flow
- expected API request
- expected administrator workflow
- expected integration behaviour

Exercise the feature as its intended user would, end to end, and verify the
observable outcome, not just a status code. For example, DOC-01 checks
list → download URL → served bytes → acknowledge. DOC-03 checks that an admin
change provably alters what an employee can do.

Both perspectives (§6 and §7) must be considered for every change. Where one
doesn't apply, record `NOT APPLICABLE — <reason>`.

## 7. Unexpected / misuse / loophole testing

**Perspective 2: unexpected / misuse behaviour.** Test how the system behaves
when users or systems:

- provide invalid input
- omit required fields
- send unexpected values
- repeat requests
- interrupt workflows
- use stale state
- attempt unauthorized actions
- cross tenant/account boundaries
- manipulate IDs or references
- bypass UI restrictions through API calls
- submit concurrent requests
- exploit state transitions
- retry failed operations
- abuse rate/volume boundaries where relevant
- attempt to expose data belonging to another user/tenant

**This perspective is REQUIRED for security-, authorization-, financial-, data-,
state-, and workflow-sensitive features where applicable.** For other changes,
apply it in proportion to the depth chosen (§5.1).

QuantiHR examples of this perspective already practised:

- wrong actor (another tenant, not the owner, self-approval);
- replay/reuse (rotated tokens, superseded codes, idempotency retries);
- boundary/expiry (sliding windows, dispute windows, lockouts);
- bad input (non-spreadsheet uploads, failed schema parse);
- injected failure: prove that gates actually fail. For example, a planted
  failing test and type error made CI steps exit non-zero, and the schema
  validator was shown to reject a malformed workflow, so the check isn't a no-op.

## 8. Document findings before fixing

A finding is recorded (ID, symptom, evidence, root cause) **before** it is fixed,
so the record shows what was wrong, not only what changed. Fixes are then linked
to the finding and verified by retest (§11).

### 8.1 Failing-test investigation (mandatory)

> **A failing test must not automatically be classified as a bad test.**

Before classifying any test failure, determine whether the discrepancy is caused by:

- product/application behaviour
- incorrect test expectation
- test implementation defect
- test data/fixture problem
- environment/configuration issue
- dependency/version issue
- timing/concurrency issue
- database/state issue
- external service issue

Record the evidence that established the cause (§14).

- **Only change or remove a test when evidence establishes that the test is
  incorrect or no longer represents the intended requirement.** Record that
  evidence with the change.
- **Never weaken a test merely to make the suite green** (§10).

QuantiHR examples:

- FND-CI-001: environment. The test was valid; the checkout was shallow.
- DEF-002: test data/fixture. A hardcoded date was compared against the real clock.
- EXEC-007: incorrect test expectation. The expected 403/400 didn't match the
  documented 404 (RLS) and 422 convention.
- DEF-005: product behaviour. The test correctly caught a real bug.

## 9. Finding classification

Every finding gets exactly one primary class:

| Class | Meaning | QuantiHR examples |
|---|---|---|
| **Product defect** | The application behaves incorrectly | DEF-005 (retired devices in pending queue) |
| **Test defect** | The test is wrong, fragile, or clock-dependent while the product is correct | DEF-002 (fixture date rot); EXEC-007 wrong status expectations |
| **Environment / configuration issue** | Failure caused by tooling, CI, install, or runtime setup | EXEC-012 shallow checkout; mobile typed-routes (`.expo/types`); EBADENGINE warnings |
| **Architectural risk** | A design or infrastructure gap with material risk, not a line-level bug | DEF-006 (document storage not durable) |
| **Missing / deferred functionality** | Behaviour the plan assumes but that was never built, or was consciously postponed | DEF-007 (no dispute review endpoint) |

Type-only mismatches with no runtime effect must be labelled as such (DEF-004).
Don't call a finding a product defect without evidence of wrong product behaviour.
Equally, don't call it a test defect without evidence that the test is wrong (§8.1).

### 9.1 Severity vs priority

Every finding records **both**, separately:

- **Severity** describes the **impact** of a defect on the system, users, data,
  security, reliability, or business-critical behaviour.
- **Priority** describes **how urgently** the defect should be addressed relative
  to other work.

They are related but **not interchangeable**. A high-severity defect can have low
priority (e.g. severe but in an unreleased, gated area, or deferred by a recorded
owner decision), and a low-severity defect can have high priority (e.g. it blocks
a P0 gate or a release). QuantiHR example: DEF-006 is High severity but deferred
by decision. Severity doesn't set the priority.

**Levels:** this framework doesn't yet define a formal severity or priority
scale; no S1–S4 / P1–P4 vocabulary exists in the QA documents. Until the owner
adopts one:

- record severity with the descriptive terms already in use (**High / Medium /
  Low**) and a one-line rationale;
- record finding priority with the labels already used in reports (**P0 / P1 /
  P2**), stating that it is *finding* urgency. These labels coincide with case
  priority (§5) but mean urgency of the fix, not risk ranking of a test case;
- mark both as QA proposals. The owner confirms or changes them.

## 10. Authorized-fix boundaries

- Fix only what the current authorized scope covers. Unrelated product code isn't
  modified.
- Never weaken, skip, or delete a test to make it pass. If the root cause is the
  environment, fix the environment (e.g. `fetch-depth: 0`, not editing
  `schema-drift.test.ts`). A test is changed only under §8.1.
- Never weaken validation, typechecking, or CI gates to make CI green.
- Where a fix would change product behaviour, infrastructure, or deployment
  (e.g. DEF-006, a Node version bump), record it and defer it for a human
  decision rather than doing it silently.
- Keep changes minimal and in focused commits, one concern per commit.
- Starting the next phase, a new case group, or a new scope requires explicit
  human instruction.

## 11. Retest and regression

- Every fix is retested against the case that exposed it.
- The **full** affected suites are re-run after each fix, not only the failing
  test, to catch regressions. (EXEC-006 caught an unrelated clock-dependent test
  this way.)
- Merges are regression events. Re-verify after merging (EXEC-008, EXEC-009),
  including silent line-merge breaks that produce no conflict markers.

## 12. CI/CD QA gates

- Every PR to the default branch runs CI: typecheck and tests for the workspaces
  in scope, with coverage measured in the same run.
- CI uses the production runtime (Node version and install command from
  `render.yaml`).
- Exclusions from CI must be explicit and justified in the workflow and the
  tracker (e.g. `apps/mobile` typecheck: DEFERRED).
- A CI configuration is only verified when it has run **live** on GitHub. Until
  then it is "done locally, awaiting CI".
- CI failures are investigated to root cause and classified (§9) before any fix.

## 13. Coverage interpretation

- Coverage is a measurement, not a verdict. A passing CI run doesn't mean
  coverage is complete.
- Report each figure with its scope (e.g. each workspace measures only its own
  `src/**/*.ts`).
- Explain low figures by locating what is uncovered. Example: shared's 44.06%
  lines is self-coverage. All 10 covered files are in `domain/`, and the files at
  0% are zod schema files, `errors.ts` and barrel `index.ts` files that shared's
  own suite never imports.
- **Don't claim indirect coverage that wasn't measured.** For example, it is not
  established that the api suite exercises every shared schema file: api's
  coverage counts only `apps/api/src`.
- **Don't recommend tests merely to raise a percentage.** Recommend tests for
  uncovered *risk* (e.g. `jobs/reminders.ts` at 0% maps to MTG-01).
- Thresholds are set only after a baseline has held steady. They are not guessed.

## 14. Evidence requirements

- Record exact values (counts, percentages, versions, run IDs, commit SHAs,
  artifact sizes) and where each came from.
- **Never substitute local results for CI results**, or the reverse. Label each.
- Reproduce root causes independently where feasible (e.g. a depth-1 clone
  reproducing exit 128).
- Evidence is summarised in the report's evidence matrix with a status per row:
  **Verified**, **Tracked**, **Deferred**, **Blocked**, or **Not applicable**.

## 15. Applicability markers

Never write a bare "N/A". Use one of:

- `NOT APPLICABLE — <reason>`
- `BLOCKED — <reason>` (could not be tested)
- `DEFERRED — <reason>` (intentionally postponed)
- `STRUCTURAL / RUNTIME NOT REQUIRED — <reason>`

When planning test types (§4.2), **REQUIRED** and **OPTIONAL** are also used.
They describe the plan. The four markers above describe why something wasn't
done or wasn't needed.

## 16. Release status vocabulary

A QA report ends with exactly one status:

| Status | Meaning |
|---|---|
| **SHIP** | Evidence supports release with no open conditions in scope |
| **SHIP WITH CONDITIONS** | Evidence supports release, provided listed conditions/risks are accepted or tracked |
| **DO NOT SHIP** | Evidence shows a defect or risk that blocks release |
| **NOT ENOUGH EVIDENCE TO DECIDE** | Evidence is insufficient to support any of the above |

The status is chosen strictly from the documented evidence and risk, and the
reasoning is written directly beneath it. **A status never authorizes a merge.**

## 17. QA reports

- Template: `qa/templates/QA_EXECUTION_REPORT.md`.
- Location and name: `qa/reports/QA_REPORT_<date>_<sha>.md`
  - `<date>`: the report date, `YYYY-MM-DD`.
  - `<sha>`: the 7-character short SHA of the HEAD commit under test.
  - Example: `qa/reports/QA_REPORT_2026-09-25_e0d21f6.md`
- A report must exist **before** the human merge/release decision.
- Reports are historical records. **Never overwrite or edit an existing report's
  findings.** A new run or a new HEAD gets a new report. The only exception: a
  **factual correction explicitly authorized by the owner before human review**
  (e.g. removing an unsupported claim). It must not change evidence, results, or
  the recommendation unless the evidence itself changed, and every correction is
  listed in a dated revision note at the top of the report. If one exists for the
  same date and SHA, append a suffix (`_2`, `_3`, …) rather than overwrite.
- Reports use only real evidence. Don't invent tests, results, coverage,
  screenshots, defects, or approvals.

## 18. Human QA / release review; merge control

- Every report ends with `AWAITING HUMAN QA/RELEASE REVIEW` and an empty review
  block (Reviewer / Date / Decision / Comments). QA never fills it in.
- **No automatic or direct merge to the default branch.** In this repo the default
  branch is `master` (the rule's "main" means the default branch). Changes reach it
  only through a PR merged by the human owner.
- QA doesn't merge PRs, mark reports approved, or start the next phase until the
  human reviewer says so.

## 19. QA tracker

- `qa/QA_TRACKER.md` is the durable, version-controlled tracker: case register,
  traceability matrix, defect/finding log, execution log, coverage baseline, report
  index.
- The execution log is **append-only** (EXEC-### IDs, never renumbered or rewritten).
- Case IDs (e.g. SES-01, INF-02) and finding IDs (DEF-###) are permanent.
- The tracker references every QA report by path.
- Only verified information enters the tracker. Unverified states are labelled
  as such.

## 20. Command system

`NOT RECONSTRUCTED — the consolidated framework's command system was not present
in the repository or in the session where this file was created. It must be
supplied by the owner and added here verbatim. Commands must not be improvised in
its absence.`

## 21. Standard QA workflow (as practised)

1. Understand the project and the scope (§2).
2. Record the baseline (§3).
3. Plan cases by risk (§5); assign case IDs in the tracker; choose and justify
   the depth (§5.1); decide structural vs runtime (§4.1) and test-type
   applicability (§4.2).
4. Test normal paths (§6) and misuse/failure paths (§7); choose the mode (§4).
5. Record findings before fixing them (§8); investigate every failing test
   before classifying it (§8.1); classify, and set severity and priority
   separately (§9, §9.1).
6. Fix only within authorized boundaries (§10); commit in focused commits.
7. Retest and regression (§11); verify in CI (§12).
8. Interpret coverage (§13) and assemble evidence (§14).
9. Write the QA report from the template (§17) with a status (§16).
10. Update the tracker (§19).
11. Stop at `AWAITING HUMAN QA/RELEASE REVIEW` (§18).
