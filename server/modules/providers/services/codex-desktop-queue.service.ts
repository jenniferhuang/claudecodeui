import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { codexDesktopSubmissionsDb } from '@/modules/database/index.js';
import { AppError, createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type {
  CodexDesktopExecutionStatus, CodexDesktopSubmission, NormalizedMessage, ProviderRuntimeWriter,
} from '@/shared/types.js';

import { codexAppServer } from '../list/codex/codex-app-server.client.js';

type QueueItem = { id: string; clientMessageId: string };
type Dependencies = {
  queue?: {
    add(input: { threadId: string; clientMessageId: string; text: string }): Promise<QueueItem>;
    list(threadId: string): Promise<QueueItem[]>;
  };
  pollIntervalMs?: number;
  observationTimeoutMs?: number;
};
type RunInput = {
  appSessionId: string;
  nativeThreadId: string;
  requestId: string;
  text: string;
  transcriptPath: string;
  writer: ProviderRuntimeWriter;
};
type Scan = { offset: number; currentTurnId: string | null; pending: Buffer };
type JsonObject = Record<string, unknown>;

const isTerminal = (record: CodexDesktopSubmission) => record.state === 'completed' || record.state === 'failed';
const statusOf = (record: CodexDesktopSubmission): CodexDesktopExecutionStatus => ({
  state: record.state, requestId: record.requestId, queueItemId: record.queueItemId, turnId: record.turnId,
});
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function send(writer: ProviderRuntimeWriter | undefined, message: NormalizedMessage) {
  if (!writer) return;
  try { writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message)); } catch { /* Reconnect recovers durable status. */ }
}
function emitStatus(record: CodexDesktopSubmission, writer?: ProviderRuntimeWriter) {
  const progress = {
    queued: 'Message queued for the native session owner; execution has not been confirmed.',
    running: 'The native session owner started the correlated turn.',
    uncertain: 'Native delivery or completion is unconfirmed. Check Desktop or the current session owner; this request will not be sent again automatically.',
    completed: 'The native session owner completed the correlated turn.',
    failed: 'The correlated native turn ended without successful completion.',
  }[record.state];
  send(writer, createNormalizedMessage({
    provider: 'codex', sessionId: record.appSessionId, kind: 'status',
    text: `${progress} Executor: native session owner (last verified: Desktop). The current owner's permissions apply; Desktop permissions were last verified. Web Stop is unavailable.`,
    canInterrupt: false, desktopExecution: statusOf(record),
  }));
}

/** WebSocket execution and subscriptions use a native-owner observer with injectable transport for isolated tests. */
export function createCodexDesktopQueueService(dependencies: Dependencies = {}) {
  const queue = dependencies.queue ?? { add: codexAppServer.queueAdd, list: codexAppServer.queueList };
  const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
  const observationTimeoutMs = dependencies.observationTimeoutMs ?? 5 * 60_000;
  const runs = new Map<string, { input: RunInput; promise: Promise<void> }>();
  const scans = new Map<string, Promise<CodexDesktopSubmission>>();
  const cursors = new Map<string, Scan>();

  function cursorFor(record: CodexDesktopSubmission): Scan {
    let scan = cursors.get(record.requestId);
    if (!scan || scan.offset < record.transcriptOffset) {
      scan = { offset: record.transcriptOffset, currentTurnId: record.turnId, pending: Buffer.alloc(0) };
      cursors.set(record.requestId, scan);
    }
    return scan;
  }

  function update(record: CodexDesktopSubmission, patch: Parameters<typeof codexDesktopSubmissionsDb.update>[1]) {
    codexDesktopSubmissionsDb.update(record.requestId, { ...patch, updatedAt: Date.now() });
    return codexDesktopSubmissionsDb.getByRequestId(record.requestId)!;
  }

  async function reconcileQueue(record: CodexDesktopSubmission): Promise<CodexDesktopSubmission> {
    if (isTerminal(record) || record.turnId) return record;
    try {
      const matches = (await queue.list(record.nativeThreadId)).filter(item => item.clientMessageId === record.clientMessageId);
      if (matches.length === 1) {
        return update(record, { queueItemId: matches[0].id, state: 'queued', error: null });
      }
      if (matches.length > 1) {
        return update(record, { state: 'uncertain', error: 'Multiple native queue entries have this client identifier. Do not resend.' });
      }
    } catch {
      // A failed/missing queue snapshot cannot establish failure, cancellation, or safe retry.
    }
    return record;
  }

  async function readTranscript(
    record: CodexDesktopSubmission, scan: Scan, writer?: ProviderRuntimeWriter,
  ): Promise<CodexDesktopSubmission> {
    let file;
    try { file = await open(record.transcriptPath, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return record;
      throw error;
    }
    try {
      const metadata = await file.stat();
      const readPosition = scan.offset + scan.pending.length;
      if (metadata.size < readPosition) {
        return update(record, { state: 'uncertain', error: 'Native transcript was truncated. Confirm execution in Desktop.' });
      }
      const available = Math.min(metadata.size - readPosition, 512 * 1024);
      if (available <= 0) return record;
      const nextChunk = Buffer.alloc(available);
      const { bytesRead } = await file.read(nextChunk, 0, available, readPosition);
      const buffer = Buffer.concat([scan.pending, nextChunk.subarray(0, bytesRead)]);
      if (buffer.length > 16 * 1024 * 1024) throw new Error('Native transcript line exceeds the observation limit. Check Desktop.');
      const completeEnd = buffer.lastIndexOf(10);
      scan.pending = buffer.subarray(completeEnd + 1);
      if (completeEnd < 0) return record; // Never parse or commit an incomplete UTF-8/JSON line.
      let lineStart = 0;
      while (lineStart <= completeEnd) {
        const lineEnd = buffer.indexOf(10, lineStart);
        const lineBytes = lineEnd - lineStart + 1;
        const raw = buffer.subarray(lineStart, lineEnd).toString('utf8');
        scan.offset += lineBytes;
        lineStart = lineEnd + 1;
        let entry: JsonObject;
        try { entry = object(JSON.parse(raw)); } catch { continue; }
        if (entry.type === 'turn_context') {
          scan.currentTurnId = string(object(entry.payload).turn_id) ?? scan.currentTurnId;
          continue;
        }
        if (entry.type !== 'event_msg') continue;
        const payload = object(entry.payload);
        const type = string(payload.type);
        const eventTurnId = string(payload.turn_id) ?? string(object(payload.turn).id);
        if (type === 'task_started' || type === 'turn_started') {
          scan.currentTurnId = eventTurnId;
        }
        const item = object(payload.item);
        const itemType = string(item.type)?.replaceAll('_', '').toLowerCase();
        const isUser = type === 'user_message' || (type === 'item_completed' && itemType === 'usermessage');
        const clientId = type === 'user_message' ? string(payload.client_id) : string(item.client_id);
        if (isUser && clientId === record.clientMessageId) {
          const turnId = eventTurnId ?? scan.currentTurnId;
          if (turnId && (!record.turnId || record.turnId === turnId)) {
            record = update(record, { state: 'running', turnId, error: null });
            scan.currentTurnId = turnId;
            emitStatus(record, writer);
          }
        }
        const scopedTurnId = eventTurnId ?? scan.currentTurnId;
        if (!record.turnId || scopedTurnId !== record.turnId) continue;
        if (type === 'agent_message' || (type === 'item_completed' && itemType === 'agentmessage')) {
          const text = type === 'agent_message' ? string(payload.message) : string(item.text) ??
            (Array.isArray(item.content) ? item.content.map(part => string(object(part).text) ?? '').join('') : '');
          if (text) send(writer, createNormalizedMessage({
            provider: 'codex', sessionId: record.appSessionId, kind: 'text', role: 'assistant', content: text,
            id: `desktop-${record.requestId}-${string(item.id) ?? scan.offset}`,
          }));
        }
        if (type === 'task_complete' || type === 'turn_complete' || type === 'turn_completed') {
          const reportedStatus = string(payload.status) ?? string(object(payload.turn).status);
          const failed = reportedStatus === 'failed' || reportedStatus === 'interrupted' || Boolean(payload.error);
          record = update(record, { state: failed ? 'failed' : 'completed', error: failed ? 'Desktop turn ended unsuccessfully.' : null });
        } else if (type === 'turn_aborted' || type === 'task_aborted' || type === 'turn_failed') {
          record = update(record, { state: 'failed', error: 'The Desktop turn was interrupted or failed.' });
        }
        // Before correlation keep the original durable offset: a restart must re-read the
        // task_started preceding a legacy user message. Afterwards each complete line is durable.
        if (scan.currentTurnId === record.turnId) record = update(record, { transcriptOffset: scan.offset });
        if (isTerminal(record)) return record;
      }
      if (record.turnId && scan.currentTurnId === record.turnId) record = update(record, { transcriptOffset: scan.offset });
      return record;
    } finally { await file.close(); }
  }

  async function observe(record: CodexDesktopSubmission, writer?: ProviderRuntimeWriter) {
    const scan = cursorFor(record);
    const deadline = Date.now() + observationTimeoutMs;
    record = await reconcileQueue(record);
    emitStatus(record, writer);
    do {
      record = await readTranscript(record, scan, writer);
      if (isTerminal(record)) {
        cursors.delete(record.requestId);
        emitStatus(record, writer);
        if (record.state === 'failed') send(writer, createNormalizedMessage({ provider: 'codex', sessionId: record.appSessionId, kind: 'error', content: record.error ?? 'Desktop turn failed.' }));
        send(writer, createCompleteMessage({ provider: 'codex', sessionId: record.appSessionId, exitCode: record.state === 'completed' ? 0 : 1 }));
        return;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
    } while (Date.now() < deadline);
    record = update(record, {
      state: 'uncertain',
      error: 'Observation timed out; Desktop execution may still be queued or running. No automatic resend.',
    });
    emitStatus(record, writer);
    // This closes the web transport run, not the native execution. Durable status remains uncertain.
    send(writer, createCompleteMessage({ provider: 'codex', sessionId: record.appSessionId, exitCode: 1 }));
  }

  async function execute(input: RunInput): Promise<void> {
    // A status request may already be reading this cursor. Registering the run prevents
    // later reconciliations; first let the one already in flight finish its snapshot.
    const reconciliation = scans.get(input.requestId);
    if (reconciliation) await reconciliation;
    let record = codexDesktopSubmissionsDb.getByRequestId(input.requestId);
    if (record && (record.appSessionId !== input.appSessionId || record.nativeThreadId !== input.nativeThreadId ||
        record.text !== input.text || record.transcriptPath !== input.transcriptPath)) {
      throw new AppError('This request id belongs to a different Desktop submission.', { code: 'CODEX_QUEUE_REQUEST_CONFLICT', statusCode: 409 });
    }
    if (!record) {
      let offset = 0;
      try { offset = (await stat(input.transcriptPath)).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const now = Date.now();
      const intent: CodexDesktopSubmission = {
        appSessionId: input.appSessionId, nativeThreadId: input.nativeThreadId, requestId: input.requestId,
        text: input.text, transcriptPath: input.transcriptPath, clientMessageId: randomUUID(),
        state: 'uncertain', queueItemId: null, turnId: null, transcriptOffset: offset,
        createdAt: now, updatedAt: now, error: null,
      };
      // The durable claim is made before sending anything to the non-idempotent native queue.
      const created = codexDesktopSubmissionsDb.createIntent(intent);
      record = codexDesktopSubmissionsDb.getByRequestId(input.requestId)!;
      if (record.appSessionId !== input.appSessionId || record.nativeThreadId !== input.nativeThreadId ||
          record.text !== input.text || record.transcriptPath !== input.transcriptPath) {
        throw new AppError('This request id belongs to a different Desktop submission.', { code: 'CODEX_QUEUE_REQUEST_CONFLICT', statusCode: 409 });
      }
      if (created) {
        emitStatus(record, input.writer);
        try {
          const acknowledgement = await queue.add({ threadId: record.nativeThreadId, clientMessageId: record.clientMessageId, text: record.text });
          if (acknowledgement.clientMessageId !== record.clientMessageId) throw new Error('Queue acknowledgement does not match client id.');
          record = update(record, { state: 'queued', queueItemId: acknowledgement.id, error: null });
        } catch (error) {
          // ACK loss can happen after delivery. Never retry the add, even after process restart.
          record = update(record, { state: 'uncertain', error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    input.writer.setSessionId?.(input.nativeThreadId);
    if (isTerminal(record)) {
      emitStatus(record, input.writer);
      send(input.writer, createCompleteMessage({ provider: 'codex', sessionId: input.appSessionId, exitCode: record.state === 'completed' ? 0 : 1 }));
      return;
    }
    try { await observe(record, input.writer); } catch (error) {
      record = update(record, { state: 'uncertain', error: error instanceof Error ? error.message : String(error) });
      emitStatus(record, input.writer);
      send(input.writer, createCompleteMessage({ provider: 'codex', sessionId: input.appSessionId, exitCode: 1 }));
    }
  }

  return {
    run(input: RunInput): Promise<void> {
      if (!input.requestId || !input.text.trim()) return Promise.reject(new AppError('A request id and message text are required.', { statusCode: 400 }));
      const existing = codexDesktopSubmissionsDb.getByRequestId(input.requestId);
      if (existing && (existing.appSessionId !== input.appSessionId || existing.nativeThreadId !== input.nativeThreadId ||
          existing.text !== input.text || existing.transcriptPath !== input.transcriptPath)) {
        return Promise.reject(new AppError('This request id belongs to a different Desktop submission.', { code: 'CODEX_QUEUE_REQUEST_CONFLICT', statusCode: 409 }));
      }
      const running = runs.get(input.requestId);
      if (running) {
        if (running.input.appSessionId !== input.appSessionId || running.input.nativeThreadId !== input.nativeThreadId ||
            running.input.text !== input.text || running.input.transcriptPath !== input.transcriptPath) {
          return Promise.reject(new AppError('This request id belongs to a different Desktop submission.', { code: 'CODEX_QUEUE_REQUEST_CONFLICT', statusCode: 409 }));
        }
        return running.promise;
      }
      const promise = execute(input).finally(() => { runs.delete(input.requestId); });
      runs.set(input.requestId, { input, promise });
      return promise;
    },
    getActiveStatus(appSessionId: string): CodexDesktopExecutionStatus | null {
      const record = codexDesktopSubmissionsDb.getActiveForSession(appSessionId);
      return record ? statusOf(record) : null;
    },
    listActive(): Array<{ appSessionId: string; startedAt: number; status: CodexDesktopExecutionStatus }> {
      return codexDesktopSubmissionsDb.listActive().map(record => ({
        appSessionId: record.appSessionId, startedAt: record.createdAt, status: statusOf(record),
      }));
    },
    async reconcile(appSessionId: string): Promise<CodexDesktopExecutionStatus | null> {
      const record = codexDesktopSubmissionsDb.getActiveForSession(appSessionId);
      if (!record) return null;
      // An attached observer owns its cursor. Reconnect reads its durable status without
      // racing a second follower that could advance the cursor before text is forwarded.
      if (runs.has(record.requestId)) return statusOf(record);
      let pending = scans.get(record.requestId);
      if (!pending) {
        pending = reconcileQueue(record).then(current => readTranscript(current, cursorFor(current)))
          .then(current => {
            if (isTerminal(current)) cursors.delete(current.requestId);
            return current;
          }).finally(() => { scans.delete(record.requestId); });
        scans.set(record.requestId, pending);
      }
      return statusOf(await pending);
    },
  };
}

/** WebSocket uses Desktop-owned execution while preserving a single native writer and truthful control status. */
export const codexDesktopQueueService = createCodexDesktopQueueService();
