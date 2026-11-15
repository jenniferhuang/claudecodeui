# Codex Desktop owner routing

The user approved proceeding with the automatically selected routing described in this conversation. Preserve one native thread/history and all other sessions. Do not quit Desktop, remove locks, fork history, or send production diagnostics as part of implementation.

## Approaches

- Waiting for Desktop ownership release preserves the current boundary but does not solve the reported indefinite refusal.
- A shared App Server can provide live control, but the installed Desktop's connection is not validated and migration needs a planned restart. This is separate future work.
- Route to the verified existing Desktop queue when allowed by server policy. This is the selected bounded fix for sending from CloudCLI while Desktop remains running. Queue execution is asynchronous and does not grant web approvals or Stop.

## Behavior and boundaries

CloudCLI keeps its existing run reservation and per-session sequencing. When the native writer is held, identify a single, stable, compatible Desktop owner. Only an explicitly enabled server policy permits delegation outside CloudCLI's inherited filesystem sandbox. Unsupported/ambiguous owners and policy-disabled delegation produce actionable refusals rather than invented ownership or repeated retries. No browser option can authorize the route.

When Desktop owns the thread, persist a unique submission intent before one native queue add. The queue helper never resumes the target. Reconcile uncertain acknowledgement through queue and native history; never automatically resend. Client message identity links a persisted user item to the resulting native turn. Only that turn's terminal event establishes completion. Queue disappearance and successful deletion cannot establish completion/cancellation.

Expose executor, queue/execution state, Desktop permission authority, and unavailable web controls. Preserve this state across reconnect and session switching. Unknown delivery blocks new submissions until reconciliation, rather than suggesting safe retry. Other providers/sessions continue through their existing paths.

The first release keeps managed Desktop delegation disabled by default. Production enablement is a separate concrete deployment/configuration decision because existing writableRoots do not restrict Desktop. Text-only normal sends are supported by this route; attachments and history-rewriting edits are refused without altering history.

## Verification

Cover native owner identity/races and strict policy parsing; durable request deduplication and ambiguous delivery; legacy/paginated history correlation and unrelated-turn exclusion; gateway route selection/policy enforcement; reconnect/status/control behavior and session isolation. Use fake native transports and isolated databases; no real model calls. Run backend/frontend suites, typecheck, lint and production builds, then review the whole change before publishing or deployment.
