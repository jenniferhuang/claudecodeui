# Codex Desktop Owner Routing Implementation Plan

> **For agentic workers:** Implement independent tasks in this shared isolated worktree, keep file ownership separate, use failing tests before code, and obtain a whole-change review before release.

**Goal:** Allow CloudCLI to submit to a compatible Desktop-owned native thread without waiting indefinitely for its writer to exit.

**Architecture:** Preserve native ownership. A verified owner route uses a pinned experimental queue transport, a durable delivery ledger, and history-based turn correlation. Gateway admission and UI report the actual execution authority and enforce the server-controlled delegation boundary.

**Tech Stack:** TypeScript, native Codex 0.169.0 RPC, SQLite, React, Node test runner and Vitest.

**Spec:** ../specs/2026-11-15-codex-desktop-owner-routing-design.md

## Global Constraints

- No production restart, diagnostic message, lock removal, history fork/deletion, or configuration enablement during implementation.
- No blind resend after an ambiguous enqueue acknowledgement.
- Desktop does not inherit CloudCLI writableRoots, approvals, or SDK AbortController.
- Experimental owner/transport support requires verified compatibility; uncertain owners fail closed.

## Review Focus

- Identity/PID/inode changes between inspection and submission.
- Reconnect/restart after enqueue with no acknowledgement.
- A different native turn completing while this submission remains pending.
- Missing queue rows or delete receipts incorrectly treated as completion/cancellation.
- External execution state leaking to another provider/session or exposing functional Stop/settings controls.

## Tasks

- [x] Owner identity and server policy: add failing tests, implement strict attestation/opt-in, verify focused tests.
- [x] Queue transport and ledger: test durable intent, ambiguity and native correlation before implementation; verify isolated database/RPC cases.
- [x] Gateway integration: test refusal-to-route change, policy/capability guards, session isolation and reconnect metadata; integrate through provider/config barrels.
- [x] Frontend: test per-session Desktop metadata, banner, disabled controls and uncertain-state handling; implement without a per-message route chooser.
- [x] Verify all suites, typecheck, lint and production build; review resulting diff and fix material findings. Do not claim production resolution before deployment and approved end-to-end verification.

## Local verification

Node 22.23.2, source copied and hash-checked into a worktree outside the OS temporary
directory so existing filesystem-policy tests exercise their intended boundary.

- Full backend suite with the CI concurrency limit: 1,189 passed, 4 skipped, 0 failed.
- Full frontend suite: 1,199 passed across 162 files.
- Release safeguards: 9 passed.
- Typecheck, lint (existing warnings), frontend/backend production build and diff checks passed.
- Review regressions covered Stop before ledger creation, scheduled interruption,
  completed-request replay after ownership release, conflicting replay before
  scheduled interruption, and fresh-tab pending-state recovery. Final independent
  integrated audit found no remaining actionable material concerns.

An unrestricted concurrent run exceeded an existing updater timing assertion.
The first bounded run encountered a Node test-runner serialization failure in an
unchanged agent-route test; that file passed in isolation. The complete bounded
rerun passed without changing or weakening either test.

## Release and acceptance

After the Desktop permission/Stop boundary was explained, the user explicitly
requested: "do publish on the remote, . and test it." This authorizes production
deployment, enabling the server policy opt-in, and a bounded no-tools acceptance
message. Preserve Desktop and unrelated native sessions; recheck no active
CloudCLI runs or retained Shells immediately before service cutover.

- [x] PR Linux/macOS quality checks, merge, and immutable jh.4 fork tarball release.
- [x] Verify release provenance, install jh.4 into a new remote prefix, back up policy,
  LaunchAgent and database, enable the opt-in, and restart CloudCLI when idle.
- [ ] Test the originally Desktop-owned thread through the deployed gateway;
  verify correlated completion, replay deduplication and preserved native ownership.

## Sandboxed deployment follow-up

The jh.4 release passed both platform quality/install checks and deployed with
Desktop PID 18520 and the original held lock preserved. Live admission refused
the diagnostic before enqueue: request c7750092-6b57-4893-815c-5a9ed7626137
has no durable ledger entry and the native transcript hash stayed unchanged.

The exact installed owner inspector succeeds in ordinary SSH but fails under
the deployed filesystem policy at `/bin/ps` with spawn EPERM. macOS ships that
executable setuid; the existing Seatbelt boundary refuses it. Do not weaken the
profile or remove writer checks. Replace Desktop process snapshots with bounded
read-only native inspection through the existing system Perl runtime, retaining
PID/start/parent/executable/argv validation and repeated inode/flock checks.

- [x] Prove the native snapshot under the unchanged remote sandbox before release.
- [x] Add the sandbox regression and fail-closed identity/parser coverage.
- [ ] Run focused/full required checks, review, merge and release jh.5.
- [ ] Verify installed package provenance, deploy idle CloudCLI only, and repeat
  one correlated live acceptance plus same-request deduplication check.

The final full owner inspector passed twice under the exact unchanged remote
profile with Desktop still holding the target flock. A separate read-only native
`thread/queue/list` call also passed inside that profile, with no queued input.
The fixed Perl helper crosschecks the kernel executable path against saved
process-argument metadata; it returns precise start time and only argc arguments.

Local jh.5 verification: 26 focused tests passed, full backend 1,194 passed and
4 skipped, 9 release safeguards passed, typecheck/lint/production build passed,
and final independent code review found no material issue. The first full run's
unchanged filesystem-policy fixture inherited the App's custom CODEX_HOME and
failed its default-home assertion. With that selector unset to match CI, the
isolated 30-test policy suite and unchanged complete backend rerun passed.
