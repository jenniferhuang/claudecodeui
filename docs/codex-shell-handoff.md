# Switching a Codex session between Chat and Shell

Chat and Shell resume the same native Codex thread, so they share history.
Codex allows only one runtime to write that thread at a time.

- Opening the Shell tab automatically **reattaches** an existing terminal; it
  does not start Codex. Click **Connect** to start one explicitly.
- A network disconnect or tab switch preserves the terminal for reconnection.
  It does not end a running task or release its writer.
- To return to Chat, finish the Shell task and use `/exit`, or click **End Codex
  Shell**. The latter stops that terminal, including any work still running in
  it. Chat is available after the process actually exits.
- To return to Shell, let Chat's turn and background work finish, then click
  **Connect**. Connect never restarts a retained terminal.

CloudCLI checks ownership in both directions before starting another runtime.
The check covers the app session ID and its native thread ID, including a
detached or terminating Shell and a Chat process finishing cleanup. Other
sessions, project paths, and providers keep running. Switching tabs alone never
stops an agent.

New Codex terminals use `codex --no-daemon` (supported by the bundled 0.166.0
CLI), so their lifetime does not extend into the shared background daemon.
A failed `resume` reports its error instead of silently starting a new thread.

## Deployment considerations

Reload browser pages after updating. Older pages without explicit launch intent
may reattach existing terminals but cannot cold-start a Codex writer.

The fix coordinates runtimes managed by this CloudCLI server. An independent
Codex app/CLI on the host can still own the same thread; CloudCLI does not stop
those external processes. Existing daemon-backed terminals also need to finish
and release their thread before Chat resumes. Updating code alone does not
release a writer already held by an old process.

Deploy during an appropriate service restart window: retained PTYs belong to
the server process, and this change does not provide a service hot reload.

## Verification

`npm run test:codex-handoff` is an opt-in macOS/Linux integration check using
the installed Codex CLI, a real PTY, and the Codex SDK. It creates a throwaway
`CODEX_HOME` and a Responses API fixture listening only on localhost. It checks
that Shell owns the thread while open, that stopping it releases the writer,
and that the SDK resumes the original history and adds another turn. The
fixture supplies both responses; no real model service or credentials are used.
