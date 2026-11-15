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

- [ ] PR Linux/macOS quality checks, merge, and immutable fork tarball release.
- [ ] Verify release provenance, install into a new remote prefix, back up policy,
  LaunchAgent and database, enable the opt-in, and restart CloudCLI when idle.
- [ ] Test the originally Desktop-owned thread through the deployed gateway;
  verify correlated completion, replay deduplication and preserved native ownership.
