import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, codexDesktopSubmissionsDb, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createCodexDesktopQueueService } from '@/modules/providers/services/codex-desktop-queue.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const row = (payload: Record<string, unknown>) => `${JSON.stringify({ type: 'event_msg', payload })}\n`;
async function fixture(run: (context: { transcriptPath: string }) => Promise<void>) {
  const prior = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-queue-'));
  process.env.DATABASE_PATH = path.join(directory, 'state.db');
  closeConnection();
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const transcriptPath = path.join(directory, 'rollout.jsonl');
  await writeFile(transcriptPath, row({ type: 'agent_message', message: 'OLD HISTORY MUST NOT LEAK' }));
  try { await run({ transcriptPath }); } finally {
    closeConnection();
    if (prior === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prior;
    await rm(directory, { force: true, recursive: true });
  }
}

// Removing the client-id check would leak another Desktop turn and incorrectly complete this request.
test('follows only the client-correlated legacy turn and records intent before enqueue', async () => fixture(async ({ transcriptPath }) => {
  const messages: NormalizedMessage[] = [];
  let enqueues = 0;
  const service = createCodexDesktopQueueService({
    pollIntervalMs: 1, observationTimeoutMs: 40,
    queue: {
      async add(input) {
        enqueues++;
        assert.equal(codexDesktopSubmissionsDb.getByRequestId('request-legacy')?.clientMessageId, input.clientMessageId);
        await appendFile(transcriptPath,
          row({ type: 'task_started', turn_id: 'unrelated' }) +
          row({ type: 'user_message', client_id: 'someone-else', message: 'other' }) +
          row({ type: 'agent_message', message: 'OTHER TURN MUST NOT LEAK' }) +
          row({ type: 'task_complete', turn_id: 'unrelated' }) +
          row({ type: 'task_started', turn_id: 'ours' }) +
          row({ type: 'user_message', client_id: input.clientMessageId, message: input.text }) +
          row({ type: 'agent_message', message: 'our answer' }) +
          row({ type: 'task_complete', turn_id: 'ours' }));
        return { id: 'queue-legacy', clientMessageId: input.clientMessageId };
      },
      async list() { return []; },
    },
  });
  const input = { appSessionId: 'app-legacy', nativeThreadId: 'native-legacy', requestId: 'request-legacy', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } };
  await service.run(input);
  assert.equal(enqueues, 1);
  assert.deepEqual(messages.filter(m => m.kind === 'text').map(m => m.content), ['our answer']);
  assert.equal(messages.at(-1)?.kind, 'complete');
  assert.equal(messages.at(-1)?.success, true);
  assert.equal(codexDesktopSubmissionsDb.getByRequestId(input.requestId)?.turnId, 'ours');
  const statuses = messages.filter(m => m.kind === 'status');
  assert.ok(statuses.every(m => m.canInterrupt === false));
  assert.ok(statuses.every(m => m.text?.includes('Executor: native session owner (last verified: Desktop)')));
  assert.ok(statuses.some(m => m.desktopExecution?.state === 'running'));
  await service.run(input);
  assert.equal(enqueues, 1);
  await assert.rejects(service.run({ ...input, text: 'different' }), /request.*different|conflict/i);
}));

// Treating a missing queue row as completion would make this test incorrectly succeed.
test('lost acknowledgement and absent queue remains uncertain across a service restart without resend', async () => fixture(async ({ transcriptPath }) => {
  let enqueues = 0;
  const queue = {
    async add() { enqueues++; throw new Error('connection dropped after write'); },
    async list() { return []; },
  };
  const messages: NormalizedMessage[] = [];
  const input = { appSessionId: 'app-uncertain', nativeThreadId: 'native-uncertain', requestId: 'request-uncertain', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } };
  const service = createCodexDesktopQueueService({ queue, pollIntervalMs: 1, observationTimeoutMs: 8 });
  await service.run(input);
  assert.equal(service.getActiveStatus(input.appSessionId)?.state, 'uncertain');
  assert.equal(messages.at(-1)?.success, false);
  const restarted = createCodexDesktopQueueService({ queue, pollIntervalMs: 1, observationTimeoutMs: 8 });
  await restarted.run(input);
  assert.equal(enqueues, 1);
  assert.equal(restarted.getActiveStatus(input.appSessionId)?.state, 'uncertain');
  assert.ok(messages.filter(m => m.kind === 'status').some(m => /Desktop/.test(m.text ?? '')));
}));

// A queue ack is not completion; only the correlated terminal event settles the run.
test('reconciles paginated native item events after ambiguous ack and ignores unrelated terminal events', async () => fixture(async ({ transcriptPath }) => {
  let clientId = '';
  const messages: NormalizedMessage[] = [];
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 8, queue: {
    async add(input) { clientId = input.clientMessageId; throw new Error('lost ACK'); },
    async list() { return [{ id: 'queue-page', clientMessageId: clientId }]; },
  } });
  const input = { appSessionId: 'app-page', nativeThreadId: 'native-page', requestId: 'request-page', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } };
  await service.run(input);
  assert.equal(service.getActiveStatus(input.appSessionId)?.state, 'uncertain');
  await appendFile(transcriptPath,
    row({ type: 'item_completed', turn_id: 'turn-page', item: { type: 'UserMessage', client_id: clientId, content: [] } }) +
    row({ type: 'task_complete', turn_id: 'someone-else' }) +
    row({ type: 'item_completed', turn_id: 'turn-page', item: { type: 'AgentMessage', id: 'assistant-1', content: [{ type: 'Text', text: 'page answer' }] } }) +
    row({ type: 'task_complete', turn_id: 'turn-page' }));
  await service.run(input);
  assert.deepEqual(messages.filter(m => m.kind === 'text').map(m => m.content), ['page answer']);
  assert.equal(codexDesktopSubmissionsDb.getByRequestId(input.requestId)?.state, 'completed');
  assert.equal(messages.at(-1)?.success, true);
}));

test('incremental follower waits for a complete JSONL line and does not turn timeout into native failure', async () => fixture(async ({ transcriptPath }) => {
  const messages: NormalizedMessage[] = [];
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 8, queue: {
    async add(input) {
      await appendFile(transcriptPath, row({ type: 'task_started', turn_id: 'partial' }) + row({ type: 'user_message', client_id: input.clientMessageId }) +
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'partial' } }));
      return { id: 'queue-partial', clientMessageId: input.clientMessageId };
    }, async list() { return []; },
  } });
  const input = { appSessionId: 'app-partial', nativeThreadId: 'native-partial', requestId: 'request-partial', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } };
  await service.run(input);
  assert.equal(service.getActiveStatus(input.appSessionId)?.state, 'uncertain');
  assert.equal(codexDesktopSubmissionsDb.getByRequestId(input.requestId)?.turnId, 'partial');
  await appendFile(transcriptPath, '\n');
  await service.run(input);
  assert.equal(messages.at(-1)?.success, true);
}));

test('concurrent conflicting reuse is rejected before the first durable intent finishes', async () => fixture(async ({ transcriptPath }) => {
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 8, queue: {
    async add(input) { return { id: 'queue-one', clientMessageId: input.clientMessageId }; }, async list() { return []; },
  } });
  const input = { appSessionId: 'app-concurrent', nativeThreadId: 'native-concurrent', requestId: 'request-concurrent', text: 'first', transcriptPath,
    writer: { isWebSocketWriter: true, send() {} } };
  const first = service.run(input);
  await assert.rejects(service.run({ ...input, text: 'second' }), /different|conflict/i);
  await first;
}));

test('follower can cross a JSONL record larger than its read chunk without leaking it', async () => fixture(async ({ transcriptPath }) => {
  const messages: NormalizedMessage[] = [];
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 100, queue: {
    async add(input) {
      await appendFile(transcriptPath, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(600_000) } }) + '\n' +
        row({ type: 'task_started', turn_id: 'large-line' }) + row({ type: 'user_message', client_id: input.clientMessageId }) +
        row({ type: 'agent_message', message: 'after large line' }) + row({ type: 'task_complete', turn_id: 'large-line' }));
      return { id: 'queue-large', clientMessageId: input.clientMessageId };
    }, async list() { return []; },
  } });
  await service.run({ appSessionId: 'app-large', nativeThreadId: 'native-large', requestId: 'request-large', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } });
  assert.equal(messages.at(-1)?.success, true);
  assert.deepEqual(messages.filter(m => m.kind === 'text').map(m => m.content), ['after large line']);
}));

test('only a correlated native failure emits an error and failed execution status', async () => fixture(async ({ transcriptPath }) => {
  const messages: NormalizedMessage[] = [];
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 20, queue: {
    async add(input) {
      await appendFile(transcriptPath, row({ type: 'task_started', turn_id: 'failed-turn' }) +
        row({ type: 'user_message', client_id: input.clientMessageId }) + row({ type: 'turn_aborted', turn_id: 'failed-turn' }));
      return { id: 'queue-failed', clientMessageId: input.clientMessageId };
    }, async list() { return []; },
  } });
  await service.run({ appSessionId: 'app-failed', nativeThreadId: 'native-failed', requestId: 'request-failed', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } });
  assert.equal(messages.filter(m => m.kind === 'error').length, 1);
  assert.equal(messages.at(-1)?.success, false);
  assert.equal(codexDesktopSubmissionsDb.getByRequestId('request-failed')?.state, 'failed');
}));

test('recovered cursor retains turn boundaries before unrelated legacy output', async () => fixture(async ({ transcriptPath }) => {
  const messages: NormalizedMessage[] = [];
  const queue = {
    async add(input: { clientMessageId: string }) {
      await appendFile(transcriptPath, row({ type: 'task_started', turn_id: 'ours-before-restart' }) +
        row({ type: 'user_message', client_id: input.clientMessageId }) + row({ type: 'task_started', turn_id: 'another-turn' }));
      return { id: 'queue-recover', clientMessageId: input.clientMessageId };
    }, async list() { return []; },
  };
  const input = { appSessionId: 'app-boundary', nativeThreadId: 'native-boundary', requestId: 'request-boundary', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send(value: unknown) { messages.push(value as NormalizedMessage); } } };
  await createCodexDesktopQueueService({ queue, pollIntervalMs: 1, observationTimeoutMs: 8 }).run(input);
  await appendFile(transcriptPath, row({ type: 'agent_message', message: 'not ours after restart' }) + row({ type: 'task_complete', turn_id: 'another-turn' }));
  const recovered = createCodexDesktopQueueService({ queue, pollIntervalMs: 1, observationTimeoutMs: 8 });
  await recovered.run(input);
  assert.deepEqual(messages.filter(m => m.kind === 'text'), []);
  assert.equal(recovered.getActiveStatus(input.appSessionId)?.state, 'uncertain');
}));


test('real chat writer retains the provider-native mapping when app and native session ids differ', async () => fixture(async ({ transcriptPath }) => {
  const { chatRunRegistry } = await import('@/modules/websocket/index.js');
  const appSessionId = 'app-writer-mapping';
  const nativeThreadId = 'native-writer-mapping';
  sessionsDb.createAppSession(appSessionId, 'codex', '/workspace/writer-mapping');
  sessionsDb.assignProviderSessionId(appSessionId, nativeThreadId);
  const run = chatRunRegistry.startRun({ appSessionId, provider: 'codex', providerSessionId: nativeThreadId, connection: null, userId: null });
  assert.ok(run);
  const service = createCodexDesktopQueueService({ pollIntervalMs: 1, observationTimeoutMs: 8, queue: {
    async add(input) { return { id: 'queue-writer', clientMessageId: input.clientMessageId }; }, async list() { return []; },
  } });
  try {
    await service.run({ appSessionId, nativeThreadId, requestId: 'request-writer-mapping', text: 'hello', transcriptPath, writer: run.writer });
    assert.equal(run.providerSessionId, nativeThreadId);
    assert.equal(sessionsDb.getSessionById(appSessionId)?.provider_session_id, nativeThreadId);
    assert.equal(run.writer.getSessionId(), nativeThreadId);
  } finally { chatRunRegistry.clearAll(); }
}));

test('status reconciliation after restart retains a partial large line across calls', async () => fixture(async ({ transcriptPath }) => {
  const queue = {
    async add(input: { clientMessageId: string }) { return { id: 'queue-status-large', clientMessageId: input.clientMessageId }; },
    async list() { return []; },
  };
  const input = { appSessionId: 'app-status-large', nativeThreadId: 'native-status-large', requestId: 'request-status-large', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send() {} } };
  await createCodexDesktopQueueService({ queue, observationTimeoutMs: 8, pollIntervalMs: 1 }).run(input);
  const clientId = codexDesktopSubmissionsDb.getByRequestId(input.requestId)!.clientMessageId;
  await appendFile(transcriptPath, JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(600_000) } }) + '\n' +
    row({ type: 'item_completed', turn_id: 'status-recovered', item: { type: 'UserMessage', client_id: clientId } }) +
    row({ type: 'task_complete', turn_id: 'status-recovered' }));
  const restarted = createCodexDesktopQueueService({ queue });
  await restarted.reconcile(input.appSessionId);
  const status = await restarted.reconcile(input.appSessionId);
  assert.equal(status?.state, 'completed');
  assert.equal(status?.turnId, 'status-recovered');
}));

test('reattaching a run waits for its in-flight status reconciliation before sharing a cursor', async () => fixture(async ({ transcriptPath }) => {
  const initialQueue = {
    async add(input: { clientMessageId: string }) { return { id: 'queue-serialize', clientMessageId: input.clientMessageId }; },
    async list() { return []; },
  };
  const input = { appSessionId: 'app-serialize', nativeThreadId: 'native-serialize', requestId: 'request-serialize', text: 'hello', transcriptPath,
    writer: { isWebSocketWriter: true, send() {} } };
  await createCodexDesktopQueueService({ queue: initialQueue, observationTimeoutMs: 8, pollIntervalMs: 1 }).run(input);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  const resumed = createCodexDesktopQueueService({ observationTimeoutMs: 8, pollIntervalMs: 1, queue: {
    ...initialQueue,
    async list() { reads++; started(); await gate; return []; },
  } });
  const reconciliation = resumed.reconcile(input.appSessionId);
  await firstRead;
  const reattached = resumed.run(input);
  try {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(reads, 1, 'a resumed observer must wait for the existing reconciliation');
  } finally {
    release();
    await Promise.all([reconciliation, reattached]);
  }
}));
