# Fork Tarball Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test fork changes and publish an installable npm tarball to this fork's GitHub Releases from an explicitly selected main commit.

**Architecture:** A reusable read-only quality workflow tests, builds, validates and smoke-installs the package. A manual release workflow verifies the exact current main commit, calls that quality workflow, then grants write access only to a publication job that checks provenance and collisions again before staging and publishing assets.

**Tech Stack:** GitHub Actions, Node.js 22 built-in test/crypto/fetch APIs, npm pack, GitHub REST API.

**Spec:** Human-approved fork publication requirements recorded in this task; install `.tgz` via npm URL, preserve `@cloudcli-ai/cloudcli`, no npm registry publication or PAT.

## Global Constraints

- Work in `/Users/jennifer.huang/.cloudcli/worktrees/fork-release-workflow-20261114`; do not modify the live checkout or service.
- Only `jenniferhuang/claudecodeui`, `refs/heads/main`, `workflow_dispatch`, and the operator's exact 40-character expected SHA may publish.
- Backend tests, frontend tests, lint, typecheck, build, package validation and installation smoke tests must pass before release.
- Only publish job receives `contents: write`; no npm credential or PAT; retain immutable action SHAs already present upstream.
- Version `1.37.8-jh.1` is committed in both manifests; no automatic version mutation or asset overwrite.

## Review Focus

- A branch dispatch or main moving during checks must fail closed before publication.
- Existing release/tag and API authorization/server errors must never count as absence.
- Altered artifacts, missing compiled entrypoints/assets and mismatching SDK provenance must fail validation.
- An upload failure must leave a draft for inspection and prevent a partial public release.
- Inherited desktop, Discord, Docker and npm publishers must remain upstream-only.

---

### Task 1: Tested release validation and publication

**Files:** Create `scripts/release/fork-release.mjs` and `scripts/release/fork-release.test.mjs`.

**Interfaces:** Export `validateContext`, `validatePackage`, `validatePackedFiles`, `validateAssets`, `assertAbsent`, `publishRelease`; CLI commands `preflight`, `pack`, `smoke`, `publish`.

- [x] Write behavior tests for provenance, package completeness, checksums, API failures and staged publication.
- [x] Run `node --test scripts/release/fork-release.test.mjs`; verify failure before implementation.
- [x] Implement built-in-only validation, packing, isolated install smoke and publication; rerun tests.

### Task 2: Fork workflows and operating instructions

**Files:** Create `.github/workflows/fork-quality.yml`, `.github/workflows/fork-release.yml`, `docs/fork-releases.md`; modify inherited publisher job guards and root package versions.

- [x] Add PR/main/reusable quality gate and main-only manual release workflow; guard inherited upstream publisher jobs.
- [x] Document exact SHA dispatch, checksum verification, npm URL install and failure recovery.
- [ ] Run release tests, package smoke, full backend/frontend tests, lint, typecheck, build and workflow structural validation.
- [ ] Obtain independent review, address findings and commit the branch without pushing, merging or publishing.

## Local verification

Release guard tests9/9, backend1054passed/4existing skips, frontend1169passed,
typecheck, lint(147warnings/0errors), build, actual tar inspection and actionlint
passed. Cold isolated production installation was stopped at the10-minute cap
while npm was still resolving registry peer metadata; it did not reach CLI/SDK
smoke. Final script reuses npm cache, enforces hard subprocess timeouts, and
keeps the full production install gate mandatory. Fresh Linux/macOS CI and the
integrated SDK169 package smoke remain required before publication.
