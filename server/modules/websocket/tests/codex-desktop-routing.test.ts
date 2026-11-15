import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, codexDesktopSubmissionsDb, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { CodexDesktopExecutionStatus, ProviderRuntimeWriter } from '@/shared/types.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const nativeId = '22222222-2222-4222-8222-222222222222';

async function fixture(run: (context: {
  calls: string[];
  abortCalls: string[];
  submissions: Array<Record<string, unknown>>;
  controls: { held: boolean; allowed: boolean; known: boolean; pending: CodexDesktopExecutionStatus | null };
  dependencies: any;
  transcript: string;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desktop-routing-'));
  const oldDatabase = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const transcript = path.join(directory, 'native.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n');
  const now = new Date().toISOString();
  sessionsDb.createSession('desktop-app', 'codex', directory, 'Desktop thread', now, now, transcript);
  sessionsDb.assignProviderSessionId('desktop-app', nativeId);
  sessionsDb.createAppSession('unrelated', 'claude', directory);
  const calls: string[] = [];
  const abortCalls: string[] = [];
  const submissions: Array<Record<string, unknown>> = [];
  const controls = { held: true, allowed: true, known: true, pending: null as CodexDesktopExecutionStatus | null };
  const dependencies = {
    runtime: {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
      abort: async (_provider: string, sessionId: string) => { abortCalls.push(sessionId); return false; },
      run: async (_provider: string, text: string, _options: unknown, writer: ProviderRuntimeWriter) => {
        calls.push(text);
        writer.send({ kind: 'complete', provider: 'codex', sessionId: 'desktop-app', exitCode: 0 });
      },
    },
    codexOwner: {
      refreshOwnership: async () => controls.held ? 'writer-held' : 'ready',
      inspectDesktopOwner: async () => controls.known ? { pid: 123, identity: 'verified', version: '0.169.0-alpha.11.1' } : null,
      isDesktopDelegationAllowed: () => controls.allowed,
      queue: {
        run: async (input: Record<string, unknown> & { writer: ProviderRuntimeWriter }) => {
          submissions.push(input);
          input.writer.send({ kind: 'status', provider: 'codex', sessionId: 'desktop-app', text: 'Queued for Desktop', canInterrupt: false });
          input.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'desktop-app', exitCode: 0 });
        },
        getActiveStatus: (id: string) => id === 'desktop-app' ? controls.pending : null,
        reconcile: async (id: string) => id === 'desktop-app' ? controls.pending : null,
      },
    },
  };
  try { await run({ calls, abortCalls, submissions, controls, dependencies, transcript }); }
  finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase;
    await rm(directory, { recursive: true, force: true });
  }
}

test('a permitted verified Desktop owner receives the original native thread without starting a second writer', async () => {
  await fixture(async ({ calls, submissions, dependencies, transcript }) => {
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'continue here', options: { requestId, model: 'ignored-web-selection' } }, dependencies);
    assert.equal(result.started, true);
    assert.deepEqual(calls, []);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].nativeThreadId, nativeId);
    assert.equal(submissions[0].appSessionId, 'desktop-app');
    assert.equal(submissions[0].requestId, requestId);
    assert.equal(submissions[0].transcriptPath, transcript);
    assert.notEqual(sessionsDb.getSessionById('desktop-app')?.model, 'ignored-web-selection');
    assert.equal(sessionsDb.getSessionById('desktop-app')?.provider_session_id, nativeId);
  });
});

// Real gateway/registry behavior is exercised while only native ownership and execution are isolated.
function connect(dependencies: any) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as any[],
    send(text: string) { this.frames.push(JSON.parse(text)); },
  });
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  return {
    socket,
    receive: (frame: Record<string, unknown>) => Promise.all(socket.listeners('message')
      .map(listener => listener.call(socket, JSON.stringify(frame)))),
  };
}

test('web Stop during the final Desktop owner check cannot report cancellation before enqueue', async () => {
  await fixture(async ({ abortCalls, submissions, dependencies }) => {
    let inspectCount = 0;
    let releaseInspection!: () => void;
    let enteredInspection!: () => void;
    const inspectionGate = new Promise<void>(resolve => { releaseInspection = resolve; });
    const inspectionEntered = new Promise<void>(resolve => { enteredInspection = resolve; });
    dependencies.codexOwner.inspectDesktopOwner = async () => {
      if (++inspectCount === 2) { enteredInspection(); await inspectionGate; }
      return { pid: 123, identity: 'verified', version: '0.169.0-alpha.11.1' };
    };
    const { socket, receive } = connect(dependencies);
    const sending = receive({ type: 'chat.send', sessionId: 'desktop-app', requestId, content: 'continue safely' });
    await inspectionEntered;
    try {
      await receive({ type: 'chat.abort', sessionId: 'desktop-app' });
      assert.deepEqual(abortCalls, []);
      assert.equal(socket.frames.some(frame => frame.code === 'DESKTOP_STOP_UNAVAILABLE'), true);
      assert.equal(socket.frames.some(frame => frame.kind === 'complete' || frame.aborted), false);
      assert.equal(chatRunRegistry.isProcessing('desktop-app'), true);
    } finally {
      releaseInspection();
      await sending;
    }
    assert.equal(submissions.length, 1);
  });
});

for (const stage of ['owner check', 'native observation'] as const) {
  test(`scheduled interruption preserves the Desktop run during ${stage}`, async () => {
    await fixture(async ({ abortCalls, submissions, controls, dependencies }) => {
      let releaseExecution!: () => void;
      let enteredExecution!: () => void;
      const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
      const executionEntered = new Promise<void>(resolve => { enteredExecution = resolve; });
      if (stage === 'owner check') {
        let inspectCount = 0;
        dependencies.codexOwner.inspectDesktopOwner = async () => {
          if (++inspectCount === 2) { enteredExecution(); await executionGate; }
          return { pid: 123, identity: 'verified', version: '0.169.0-alpha.11.1' };
        };
      } else {
        dependencies.codexOwner.queue.run = async (input: Record<string, unknown> & { writer: ProviderRuntimeWriter }) => {
          submissions.push(input);
          controls.pending = { state: 'running', requestId, queueItemId: 'queue', turnId: 'native-turn' };
          enteredExecution();
          await executionGate;
          controls.pending = null;
          input.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'desktop-app', exitCode: 0 });
        };
      }
      const initial = runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'first', options: { requestId } }, dependencies);
      await executionEntered;
      try {
        const interrupted = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'scheduled', interruptActiveRun: true }, dependencies);
        assert.equal(interrupted.started, false);
        assert.equal(interrupted.retryable, true);
        assert.deepEqual(abortCalls, []);
        assert.equal(chatRunRegistry.isProcessing('desktop-app'), true);
      } finally {
        releaseExecution();
        await initial;
      }
      assert.equal(submissions.length, 1);
    });
  });
}

test('a completed Desktop request replays after owner release without executing the prompt again', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies, transcript }) => {
    controls.held = false;
    controls.allowed = false;
    codexDesktopSubmissionsDb.createIntent({
      appSessionId: 'desktop-app', nativeThreadId: nativeId, requestId, text: 'already delivered', transcriptPath: transcript,
      clientMessageId: requestId, state: 'completed', queueItemId: 'queue', turnId: 'native-turn',
      createdAt: 1, updatedAt: 2, transcriptOffset: 0, error: null,
    });
    let replayed = false;
    dependencies.codexOwner.queue.run = async (input: Record<string, unknown> & { writer: ProviderRuntimeWriter }) => {
      replayed = true;
      assert.equal(input.requestId, requestId);
      assert.equal(codexDesktopSubmissionsDb.getByRequestId(requestId)?.state, 'completed');
      input.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'desktop-app', exitCode: 0 });
    };
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'already delivered', options: { requestId } }, dependencies);
    assert.deepEqual(calls, []);
    assert.deepEqual(submissions, []);
    assert.equal(replayed, true);
    assert.equal(result.started, true);
  });
});

test('a completed Desktop request id cannot be reused for different content after owner release', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies, transcript }) => {
    controls.held = false;
    codexDesktopSubmissionsDb.createIntent({
      appSessionId: 'desktop-app', nativeThreadId: nativeId, requestId, text: 'original', transcriptPath: transcript,
      clientMessageId: requestId, state: 'completed', queueItemId: 'queue', turnId: 'native-turn',
      createdAt: 1, updatedAt: 2, transcriptOffset: 0, error: null,
    });
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'different', options: { requestId } }, dependencies);
    assert.equal(result.started, false);
    assert.match(result.error ?? '', /request.*different|conflict/i);
    assert.deepEqual(calls, []);
    assert.deepEqual(submissions, []);
  });
});

for (const content of ['original', 'different']) {
  test(`a scheduled Desktop request ${content === 'original' ? 'replay' : 'conflict'} cannot abort a later ordinary run`, async () => {
    await fixture(async ({ abortCalls, controls, dependencies, transcript }) => {
      controls.held = false;
      codexDesktopSubmissionsDb.createIntent({
        appSessionId: 'desktop-app', nativeThreadId: nativeId, requestId, text: 'original', transcriptPath: transcript,
        clientMessageId: requestId, state: 'completed', queueItemId: 'queue', turnId: 'native-turn',
        createdAt: 1, updatedAt: 2, transcriptOffset: 0, error: null,
      });
      const active = chatRunRegistry.startRun({
        appSessionId: 'desktop-app', provider: 'codex', providerSessionId: nativeId, connection: null, userId: 1,
      });
      const result = await runDetachedChatTurn({
        sessionId: 'desktop-app', userId: 1, content, options: { requestId }, interruptActiveRun: true,
      }, dependencies);
      assert.deepEqual(abortCalls, []);
      assert.equal(chatRunRegistry.getRun('desktop-app'), active);
      assert.equal(chatRunRegistry.isProcessing('desktop-app'), true);
      assert.equal(result.started, false);
      if (content === 'original') assert.equal(result.retryable, true);
      else assert.match(result.error ?? '', /request.*different|conflict/i);
    });
  });
}

for (const registered of [false, true]) {
  test(`a pending Desktop refusal restores status ${registered ? 'with' : 'without'} an active registry run`, async () => {
    await fixture(async ({ controls, dependencies }) => {
      controls.pending = { state: 'uncertain', requestId, queueItemId: 'queue', turnId: null };
      if (registered) chatRunRegistry.startRun({ appSessionId: 'desktop-app', provider: 'codex', providerSessionId: nativeId, connection: null, userId: 1 });
      const { socket, receive } = connect(dependencies);
      await receive({ type: 'chat.send', sessionId: 'desktop-app', content: 'do not duplicate' });
      const refusal = socket.frames.find(frame => frame.kind === 'protocol_error');
      assert.equal(refusal?.code, 'DESKTOP_DELIVERY_UNCONFIRMED');
      assert.equal(refusal?.sessionId, 'desktop-app');
      assert.deepEqual(refusal?.desktopExecution, controls.pending);
      assert.equal(refusal?.canInterrupt, false);
    });
  });
}

test('a disabled delegation policy refuses Desktop without submitting or launching another runtime', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies }) => {
    controls.allowed = false;
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'no bypass' }, dependencies);
    assert.equal(result.started, false);
    assert.match(result.error ?? '', /policy|administrator/i);
    assert.deepEqual(calls, []); assert.deepEqual(submissions, []);
  });
});

test('an unverified writer never receives a speculative queue message', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies }) => {
    controls.known = false;
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'do not guess' }, dependencies);
    assert.equal(result.started, false);
    assert.deepEqual(calls, []); assert.deepEqual(submissions, []);
  });
});

test('Desktop routing refuses attachments rather than losing their contents', async () => {
  await fixture(async ({ calls, submissions, dependencies }) => {
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'see image', options: { images: [{ path: '/untrusted/image.png' }] } }, dependencies);
    assert.equal(result.started, false);
    assert.match(result.error ?? '', /attachment|text.only/i);
    assert.deepEqual(calls, []); assert.deepEqual(submissions, []);
  });
});

test('an uncertain prior delivery blocks a new send even after the writer disappears', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies }) => {
    controls.held = false;
    controls.pending = { state: 'uncertain', requestId, queueItemId: null, turnId: null };
    const result = await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'must not duplicate' }, dependencies);
    assert.equal(result.started, false);
    assert.match(result.error ?? '', /unconfirmed|uncertain/i);
    assert.deepEqual(calls, []); assert.deepEqual(submissions, []);
  });
});

test('another provider and an unowned Codex thread keep their normal runtime route', async () => {
  await fixture(async ({ calls, submissions, controls, dependencies }) => {
    await runDetachedChatTurn({ sessionId: 'unrelated', userId: 1, content: 'other provider' }, dependencies);
    controls.held = false; controls.allowed = false;
    await runDetachedChatTurn({ sessionId: 'desktop-app', userId: 1, content: 'normal Codex', options: { desktopExecution: { enabled: true } } }, dependencies);
    assert.deepEqual(calls, ['other provider', 'normal Codex']);
    assert.deepEqual(submissions, []);
  });
});

test('reconnect restores durable Desktop uncertainty only for its matching session', async () => {
  await fixture(async ({ controls, dependencies }) => {
    controls.pending = { state: 'uncertain', requestId, queueItemId: null, turnId: null };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as any[], send(text: string) { this.frames.push(JSON.parse(text)); } });
    handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
    const message = { type: 'chat.subscribe', sessions: [{ sessionId: 'desktop-app' }, { sessionId: 'unrelated' }] };
    await Promise.all(socket.listeners('message').map(listener => listener.call(socket, JSON.stringify(message))));
    const desktop = socket.frames.find(frame => frame.kind === 'chat_subscribed' && frame.sessionId === 'desktop-app');
    const other = socket.frames.find(frame => frame.kind === 'chat_subscribed' && frame.sessionId === 'unrelated');
    assert.deepEqual(desktop?.desktopExecution, controls.pending);
    assert.equal(desktop?.canInterrupt, false);
    assert.equal(desktop?.isProcessing, true);
    assert.equal(other?.desktopExecution, undefined);
  });
});

test('running-session polling restores a durable Desktop request after the web observer exited', async () => {
  await fixture(async ({ transcript }) => {
    codexDesktopSubmissionsDb.createIntent({
      appSessionId: 'desktop-app', nativeThreadId: nativeId, requestId, text: 'retained', transcriptPath: transcript,
      clientMessageId: requestId, state: 'uncertain', queueItemId: null, turnId: null,
      createdAt: 1000, updatedAt: 1000, transcriptOffset: 0, error: null,
    });
    const rows = await sessionsService.listRunningSessions();
    const own = rows.find(row => row.sessionId === 'desktop-app');
    assert.equal(own?.desktopExecution?.state, 'uncertain');
    assert.equal(own?.canInterrupt, false);
    assert.equal(rows.some(row => row.sessionId === 'unrelated'), false);
  });
});

test('a stale web Stop cannot claim that a Desktop-owned turn was aborted', async () => {
  await fixture(async ({ controls, dependencies }) => {
    controls.pending = { state: 'running', requestId, queueItemId: 'queue', turnId: 'native-turn' };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, frames: [] as any[], send(text: string) { this.frames.push(JSON.parse(text)); } });
    handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
    await Promise.all(socket.listeners('message').map(listener => listener.call(socket, JSON.stringify({ type: 'chat.abort', sessionId: 'desktop-app' }))));
    assert.equal(socket.frames.some(frame => frame.code === 'DESKTOP_STOP_UNAVAILABLE'), true);
    assert.equal(socket.frames.some(frame => frame.kind === 'complete' || frame.aborted), false);
  });
});
