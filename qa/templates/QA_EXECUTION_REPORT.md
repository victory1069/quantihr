<!--
QA EXECUTION REPORT TEMPLATE, QuantiHR
Framework: qa/framework/SENIOR_QA_SOFTWARE_TESTING_FRAMEWORK.md

Save a copy as:  qa/reports/QA_REPORT_<date>_<sha>.md
  <date> = report date, YYYY-MM-DD
  <sha>  = 7-character short SHA of the HEAD commit under test
  Never overwrite an existing report; add _2, _3 ... for a same-date, same-SHA re-issue.

Rules (framework §14–§16):
  - Use only real evidence. Never substitute local results for CI results.
  - No bare "N/A". Use one of:
      NOT APPLICABLE — <reason>
      BLOCKED — <reason>
      DEFERRED — <reason>
      STRUCTURAL / RUNTIME NOT REQUIRED — <reason>
  - Delete these instruction comments in the saved report.
-->

# QA Execution Report: <phase / change name>

## 1. Report Information

| Field | Value |
|---|---|
| Report file | `qa/reports/QA_REPORT_<date>_<sha>.md` |
| Report date | <YYYY-MM-DD> |
| Repository | <owner/repo> |
| Branch under test | <branch> |
| HEAD commit under test | <full SHA> |
| Base branch / commit | <default branch> @ <SHA> |
| Pull request | <#number, URL> |
| Phase / tracker case IDs | <e.g. INF-01, INF-02> |
| Prepared by | <name / agent> |
| Framework version | `qa/framework/SENIOR_QA_SOFTWARE_TESTING_FRAMEWORK.md` @ <SHA> |
| Previous related report | <path, or NOT APPLICABLE — reason> |

## 2. Executive Summary

<3–6 sentences: what changed, what was tested, the headline result, the QA status,
and the most important remaining risk. No claim here that isn't supported below.>

## 3. QA Status

**Status:** <SHIP | SHIP WITH CONDITIONS | DO NOT SHIP | NOT ENOUGH EVIDENCE TO DECIDE>

**Reasoning:** <evidence-based reasoning, directly under the status>

**Conditions (if SHIP WITH CONDITIONS):**
1. <condition>

> This status is a QA assessment only. It does not authorize a merge or release.
> That decision belongs to the human reviewer/owner (section 27 below; framework §18).

## 4. Scope

| In scope | Case IDs | Notes |
|---|---|---|
| <area> | <IDs> | <notes> |

## 5. Out of Scope / Deferred Items

| Item | Marker | Reason |
|---|---|---|
| <item> | DEFERRED / NOT APPLICABLE / BLOCKED | <reason> |

## 6. Environment

| Aspect | Local | CI |
|---|---|---|
| OS | <> | <> |
| Node / npm | <> | <> |
| Install command | <> | <> |
| Test runner / versions | <> | <> |
| Other relevant config | <> | <> |

Known environment differences between local and CI: <list, or NOT APPLICABLE — reason>

## 7. Baseline

| Measure | Baseline value | Source (run / commit) |
|---|---|---|
| Tests per workspace | <> | <> |
| Typecheck per workspace | <> | <> |
| Coverage | <> | <> |
| Known pre-existing failures | <> | <> |

## 8. Changes Under Test

| Commit | Summary | Files | Category (infra / test / product / config / docs) |
|---|---|---|---|
| <SHA> | <> | <> | <> |

Diff stat vs base: <paste `git diff --stat <base>..<head>`>

## 9. Test Strategy

- Case priority: <P0/P1/P2; framework §5>
- **Depth:** <BASIC | STANDARD | DEEP | INTENSIVE> — why: <risk factors that drove it; framework §5.1>
- **Structural vs runtime decision:** <structural / runtime / hybrid, with reason; framework §4.1>
- Modes used: <structural/static, runtime, hybrid; framework §4>
- What evidence would prove success, and what would prove failure: <>

**Test-type applicability (framework §4.2):** REQUIRED / OPTIONAL /
`NOT APPLICABLE — <reason>` / `STRUCTURAL / RUNTIME NOT REQUIRED — <reason>`

| Test type | Decision | Reason / where covered |
|---|---|---|
| Static/structural | <> | <> |
| Runtime | <> | <> |
| Manual | <> | <> |
| Exploratory | <> | <> |
| Automated | <> | <> |
| API | <> | <> |
| UI | <> | <> |
| Database/data-integrity | <> | <> |
| Accessibility | <> | <> |
| Browser compatibility | <> | <> |
| Device/mobile compatibility | <> | <> |
| Performance | <> | <> |
| Security/authorization | <> | <> |
| Regression | <> | <> |
| CI/CD validation | <> | <> |

## 10. Intended-User / Normal-Path Testing

<Perspective 1, framework §6: web user, mobile user, API client, administrator,
integration, as applicable. Record NOT APPLICABLE — <reason> for any that don't apply.>

| # | Scenario | Mode | Evidence | Result |
|---|---|---|---|---|
| N1 | <> | <> | <> | <> |

## 11. Unexpected / Misuse / Failure-Path Testing

<Perspective 2, framework §7: invalid/missing/unexpected input, repeats, interrupted
workflows, stale state, unauthorized actions, tenant/account boundaries, ID
manipulation, API bypass of UI, concurrency, state-transition abuse, retries,
rate/volume, cross-user data exposure. REQUIRED for security-, authorization-,
financial-, data-, state- and workflow-sensitive features where applicable.>

| # | Scenario (misuse, loophole, injected failure) | Mode | Evidence | Result |
|---|---|---|---|---|
| U1 | <> | <> | <> | <> |

## 12. Structural / Static QA

| Check | Tool / method | Result |
|---|---|---|
| <e.g. workflow schema validation> | <> | <> |
| <e.g. diff review, lockfile review> | <> | <> |

## 13. Automated Test Results

| Workspace | Local result | CI result (run ID) | Notes |
|---|---|---|---|
| <> | <passed/total> | <passed/total> | <> |

## 14. Typecheck / Build Results

| Workspace | Local | CI | Notes |
|---|---|---|---|
| <> | <> | <> | <> |

## 15. Coverage Results

| Workspace | Statements | Branches | Functions | Lines | Source |
|---|---|---|---|---|---|
| <> | <> | <> | <> | <> | <local / CI run> |

Interpretation (framework §13): <scope of measurement, what is and isn't covered and why.
Don't recommend tests merely to raise a percentage.>

## 16. Test Quality Review

<Are the tests meaningful? Do they assert observable outcomes? Are any fragile,
clock-dependent, environment-dependent, or weakened? Was any test skipped or
removed? (It must not be, framework §10.) For every failing test: which cause did
the investigation establish, and on what evidence? A failing test must not
automatically be classified as a bad test (framework §8.1).>

## 17. Regression Testing

<Full suites re-run after each fix? Merge regressions checked? Results vs baseline (section 7).>

## 18. CI/CD Verification

| Run | Commit | Trigger | Result | Failing step / notes |
|---|---|---|---|---|
| <run ID / URL> | <SHA> | <> | <> | <> |

Artifacts: <name, size, retention, or NOT APPLICABLE — reason>

## 19. Defects / Findings

| ID | Title | Class (framework §9) | Severity (impact) | Priority (urgency) | Evidence | Status |
|---|---|---|---|---|---|---|
| <> | <> | Product defect / Test defect / Environment-configuration issue / Architectural risk / Missing-deferred functionality | <High/Medium/Low + rationale; framework §9.1> | <P0/P1/P2 finding urgency; framework §9.1> | <> | <Open / Fixed / Deferred / Tracked> |

Severity and priority are recorded separately and are not interchangeable (framework §9.1).

For each finding: discovery method → evidence (before the fix) → root cause
(failing tests: investigated per framework §8.1) → classification → fix (if
authorized) → retest → regression.

## 20. Change Attribution

<Attribute every difference from the baseline to a specific commit, to pre-existing
state, or to the environment. Confirm whether any unrelated product/application code
was changed.>

## 21. Security / Privacy Considerations

<Permissions, secrets, data exposure, supply chain (new dependencies), or
NOT APPLICABLE — reason>

## 22. Performance Considerations

<Runtime/CI duration impact, resource use, or NOT APPLICABLE — reason>

## 23. Remaining Risks

| Risk | Likelihood / impact | Owner / next step | Tracker ref |
|---|---|---|---|
| <> | <> | <> | <> |

## 24. Known Limitations / Unknowns

<What was not verified, and why. Label each: BLOCKED / DEFERRED / NOT APPLICABLE.>

## 25. Evidence Matrix

| Area | Evidence | Result | Status |
|---|---|---|---|
| <> | <run / log / commit / reproduction> | <> | Verified / Tracked / Deferred / Blocked / Not applicable |

## 26. Release / Merge Evidence

| Item | Value |
|---|---|
| PR | <#, URL, state> |
| Required CI checks | <names, result, run ID> |
| Mergeable against base | <> |
| Report exists before merge decision | Yes: this file |
| Merged by QA | **No.** QA never merges (framework §18) |

## 27. Human QA / Release Review

```text
Human QA/Release Review

Reviewer:
Date:
Decision:
Comments:
```

<!-- QA must not fill in this block. -->

## 28. Owner Handoff

- What the owner needs to decide: <>
- Follow-ups recorded in the tracker: <IDs>
- Tracker updated: <yes/no, `qa/QA_TRACKER.md` reference>

---

**AWAITING HUMAN QA/RELEASE REVIEW**
