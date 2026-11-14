import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionsDb, sessionDraftsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry, connectedClients, createWebSocketServer, isCodexChatSessionActive, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';
import { closeScheduledMessageDispatcher, dispatchDueScheduledMessages, dispatchQueuedMessages, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function withDatabase(run: (userId: number, directory: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-queued-handoff-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const user = userDb.createUser('queued-handoff', 'fixture-hash');
    sessionsDb.createAppSession('codex-queue', 'codex', directory);
    sessionsDb.assignProviderSessionId('codex-queue', 'codex-native-queue');
    await run(Number(user.id), directory);
  } finally {
    closeScheduledMessageDispatcher();
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const cleanupFails of [false, true]) {
  test(`queued Codex turn survives ${cleanupFails ? 'failed' : 'normal'} runtime cleanup and runs once after release`, async () => {
    await withDatabase(async (userId) => {
      let release = () => {};
      const cleanup = new Promise<void>((resolve) => { release = resolve; });
      let writer: ProviderRuntimeWriter | undefined;
      const calls: string[] = [];
      const runtime = {
        hasRuntime: () => true,
        hasBackgroundWork: () => false,
        run: async (_provider: string, command: string, _options: unknown, sink: ProviderRuntimeWriter) => {
          calls.push(command);
          if (command === 'initial') {
            writer = sink;
            await cleanup;
            if (cleanupFails) throw new Error('Expected cleanup failure fixture');
          } else {
            sink.send({ kind: 'complete', provider: 'codex', sessionId: 'codex-queue', exitCode: 0 });
          }
        },
      } as unknown as ProviderRuntimeGateway;
      const initial = runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'initial' }, { runtime });
      try {
        await settle();
        assert.ok(writer);
        sessionDraftsDb.saveDraft(userId, 'codex-queue', { text: '', queuedMessage: { content: 'preserved followup' } });
        initializeScheduledMessageDispatcher(runtime);
        writer.send({ kind: 'complete', provider: 'codex', sessionId: 'codex-queue', exitCode: 0 });
        await settle();
        assert.deepEqual(calls, ['initial']);
        assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 1, 'UI completion must not claim a turn while Codex still owns the runtime');
        const refused = await runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'premature' }, { runtime });
        assert.equal(refused.started, false);
        assert.equal((refused as { retryable?: boolean }).retryable, true, 'a temporary ownership refusal must be distinguishable from permanent failure');
        release();
        await initial;
        await settle();
        assert.deepEqual(calls, ['initial', 'preserved followup']);
        assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 0);
      } finally {
        closeScheduledMessageDispatcher();
        release();
        await initial;
      }
    });
  });
}

test('one Codex cleanup does not block queued turns for another Codex session or provider', async () => {
  await withDatabase(async (userId, directory) => {
    sessionsDb.createAppSession('other-codex-queue', 'codex', directory);
    sessionsDb.createAppSession('other-provider-queue', 'claude', directory);
    let release = () => {};
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let writer: ProviderRuntimeWriter | undefined;
    const calls: string[] = [];
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      run: async (provider: string, command: string, options: { sessionId: string }, sink: ProviderRuntimeWriter) => {
        calls.push(command);
        if (command === 'initial') { writer = sink; await cleanup; }
        else sink.send({ kind: 'complete', provider, sessionId: options.sessionId, exitCode: 0 });
      },
    } as unknown as ProviderRuntimeGateway;
    const initial = runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'initial' }, { runtime });
    try {
      await settle();
      for (const sessionId of ['codex-queue', 'other-codex-queue', 'other-provider-queue']) {
        sessionDraftsDb.saveDraft(userId, sessionId, { text: '', queuedMessage: { content: `queued:${sessionId}` } });
      }
      writer?.send({ kind: 'complete', provider: 'codex', sessionId: 'codex-queue', exitCode: 0 });
      assert.equal(await dispatchQueuedMessages(runtime), 2);
      assert.equal(calls[0], 'initial');
      assert.deepEqual(calls.slice(1).sort(), ['queued:other-codex-queue', 'queued:other-provider-queue']);
      assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 1);
    } finally { release(); await initial; }
  });
});

test('a Shell-owned queued turn stays pending and dispatches after that Shell exits', async () => {
  await withDatabase(async (userId, directory) => {
    const calls: string[] = [];
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      run: async (_provider: string, command: string) => { calls.push(command); },
    } as unknown as ProviderRuntimeGateway;
    let exit: ((event: { exitCode: number }) => void) | undefined;
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void };
    socket.readyState = 1; socket.send = () => {};
    const http = createServer();
    const gateway = createWebSocketServer(http, {
      verifyClient: { isPlatform: false, authenticateWebSocket: () => ({ id: userId }) },
      chat: { runtime },
      shell: {
        resolveProviderSessionId: () => 'codex-native-queue',
        spawnPty: () => ({ onData: () => ({ dispose() {} }), onExit: (listener: typeof exit) => { exit = listener; }, kill() {}, write() {}, resize() {} }) as never,
      },
      getPluginPort: () => null,
    });
    try {
      gateway.emit('connection', socket, { url: '/shell', user: { id: userId } });
      socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'codex-queue', provider: 'codex', hasSession: true, projectPath: directory, attachOnly: false }));
      await settle();
      assert.ok(exit, 'fixture Shell must be retained before dispatch');
      sessionDraftsDb.saveDraft(userId, 'codex-queue', { text: '', queuedMessage: { content: 'after Shell' } });
      assert.equal(await dispatchQueuedMessages(runtime), 0);
      assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 1);
      assert.deepEqual(calls, []);
      exit({ exitCode: 0 });
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(calls, ['after Shell']);
    } finally { exit?.({ exitCode: 0 }); socket.emit('close'); gateway.close(); }
  });
});

test('a fresh Chat keeps its later native identity reserved through cleanup and blocks an alias Shell', async () => {
  await withDatabase(async (userId, directory) => {
    sessionsDb.createAppSession('fresh-chat-app', 'codex', directory);
    let release = () => {};
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let writer: ProviderRuntimeWriter | undefined;
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      run: async (_provider: string, _command: string, _options: unknown, sink: ProviderRuntimeWriter) => {
        writer = sink;
        await cleanup;
      },
    } as unknown as ProviderRuntimeGateway;
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void };
    const frames: Array<Record<string, unknown>> = [];
    socket.readyState = 1; socket.send = (raw) => frames.push(JSON.parse(raw));
    let launches = 0;
    let exit: ((event: { exitCode: number }) => void) | undefined;
    const gateway = createWebSocketServer(createServer(), {
      verifyClient: { isPlatform: false, authenticateWebSocket: () => ({ id: userId }) },
      chat: { runtime },
      shell: {
        resolveProviderSessionId: () => 'fresh-chat-native',
        spawnPty: () => {
          launches += 1;
          return { onData: () => ({ dispose() {} }), onExit: (listener: typeof exit) => { exit = listener; }, kill() {}, write() {}, resize() {} } as never;
        },
      },
      getPluginPort: () => null,
    });
    const initial = runDetachedChatTurn({ sessionId: 'fresh-chat-app', userId, content: 'initial' }, { runtime });
    try {
      await settle();
      assert.ok(writer);
      sessionsDb.assignProviderSessionId('fresh-chat-app', 'fresh-chat-native');
      writer.send({ kind: 'complete', provider: 'codex', sessionId: 'fresh-chat-app', exitCode: 0 });
      await settle();
      assert.equal(isCodexChatSessionActive('fresh-chat-native'), true, 'late provider identity must resolve an active app reservation');
      gateway.emit('connection', socket, { url: '/shell', user: { id: userId } });
      const init = JSON.stringify({ type: 'init', sessionId: 'fresh-chat-native', provider: 'codex', hasSession: true, projectPath: directory, attachOnly: false });
      socket.emit('message', init);
      await settle();
      assert.equal(launches, 0);
      assert.equal(frames.at(-1)?.code, 'CHAT_SESSION_ACTIVE');
      release();
      await initial;
      assert.equal(isCodexChatSessionActive('fresh-chat-native'), false);
      socket.emit('message', init);
      await settle();
      assert.equal(launches, 1, 'the same alias may connect after the actual runtime releases');
    } finally { release(); await initial; exit?.({ exitCode: 0 }); socket.emit('close'); gateway.close(); }
  });
});

test('a held native writer preserves only its queued turn until its flock releases', {
  skip: !['darwin', 'linux'].includes(process.platform) ||
    spawnSync(process.platform === 'darwin' ? '/usr/bin/perl' : 'perl', ['-MFcntl=:flock', '-e', 'exit 0'], { timeout: 1000 }).status !== 0,
}, async () => {
  await withDatabase(async (userId, directory) => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = path.join(directory, 'codex-home');
    const lockDirectory = path.join(codexHome, 'thread-writer-locks');
    await mkdir(lockDirectory, { recursive: true });
    const child = spawn(process.platform === 'darwin' ? '/usr/bin/perl' : 'perl', ['-e', `
      use Fcntl qw(O_RDWR O_CREAT LOCK_EX LOCK_UN);
      sysopen(my $lock, $ARGV[0], O_RDWR | O_CREAT, 0600) or die "open: $!";
      flock($lock, LOCK_EX) or die "flock: $!";
      $| = 1; print "ready\n";
      scalar <STDIN>;
      flock($lock, LOCK_UN) or die "unlock: $!";
      print "released\n";
      scalar <STDIN>;
    `, path.join(lockDirectory, 'codex-native-queue.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    await once(child.stdout, 'data');
    process.env.CODEX_HOME = codexHome;
    sessionsDb.createAppSession('unrelated-native-writer', 'codex', directory);
    sessionsDb.assignProviderSessionId('unrelated-native-writer', 'unrelated-native');
    const calls: string[] = [];
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      run: async (_provider: string, command: string) => { calls.push(command); },
    } as unknown as ProviderRuntimeGateway;
    try {
      const refused = await runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'premature' }, { runtime });
      assert.equal(refused.started, false, 'a held native writer flock must defer this target');
      assert.equal(refused.retryable, true);
      for (const sessionId of ['codex-queue', 'unrelated-native-writer']) {
        sessionDraftsDb.saveDraft(userId, sessionId, { text: '', queuedMessage: { content: sessionId } });
      }
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(calls, ['unrelated-native-writer']);
      assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 1);
      const released = once(child.stdout, 'data');
      child.stdin.write('release\n');
      await released;
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(calls, ['unrelated-native-writer', 'codex-queue']);
      assert.equal(sessionDraftsDb.listQueuedMessages('codex-queue').length, 0);
    } finally {
      child.stdin.end();
      await exited;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});

test('a timed Codex interruption stays pending during cleanup and continues once without repeating abort', async () => {
  await withDatabase(async (userId) => {
    let release = () => {};
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    let aborts = 0;
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      abort: async () => { aborts += 1; return true; },
      run: async (_provider: string, command: string, _options: unknown, sink: ProviderRuntimeWriter) => {
        calls.push(command);
        if (command === 'initial') await cleanup;
        else sink.send({ kind: 'complete', provider: 'codex', sessionId: 'codex-queue', exitCode: 0 });
      },
    } as unknown as ProviderRuntimeGateway;
    const initial = runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'initial' }, { runtime });
    try {
      await settle();
      initializeScheduledMessageDispatcher(runtime);
      const row = scheduledMessagesDb.create({ userId, sessionId: 'codex-queue', content: 'timed continuation', options: {}, scheduledFor: new Date(0) });
      assert.equal(await dispatchDueScheduledMessages(runtime), 0, 'a deferred admission is not sent');
      await settle();
      assert.equal(scheduledMessagesDb.listForSession(userId, 'codex-queue').find((candidate) => candidate.id === row.id)?.status, 'pending');
      assert.equal(await dispatchDueScheduledMessages(runtime), 0);
      assert.deepEqual(calls, ['initial']);
      assert.equal(aborts, 1, 'retry during cleanup must not abort the same runtime again');
      release();
      await initial;
      await settle();
      assert.deepEqual(calls, ['initial', 'timed continuation']);
      assert.equal(aborts, 1);
      assert.equal(scheduledMessagesDb.listForSession(userId, 'codex-queue').find((candidate) => candidate.id === row.id)?.status, 'sent');
    } finally { closeScheduledMessageDispatcher(); release(); await initial; }
  });
});

test('cancelling a timed turn during Codex cleanup prevents its deferred retry', async () => {
  await withDatabase(async (userId) => {
    let release = () => {};
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const runtime = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      abort: async () => true,
      run: async (_provider: string, command: string) => {
        calls.push(command);
        if (command === 'initial') await cleanup;
      },
    } as unknown as ProviderRuntimeGateway;
    const initial = runDetachedChatTurn({ sessionId: 'codex-queue', userId, content: 'initial' }, { runtime });
    try {
      await settle();
      initializeScheduledMessageDispatcher(runtime);
      const row = scheduledMessagesDb.create({ userId, sessionId: 'codex-queue', content: 'cancelled continuation', options: {}, scheduledFor: new Date(0) });
      assert.equal(await dispatchDueScheduledMessages(runtime), 0);
      assert.equal(scheduledMessagesDb.cancel(userId, row.id), 'codex-queue');
      scheduledMessagesDb.restorePending(row.id); // A stale restoration may not resurrect a cancellation.
      release();
      await initial;
      await settle();
      assert.deepEqual(calls, ['initial']);
      assert.equal(scheduledMessagesDb.listForSession(userId, 'codex-queue').find((candidate) => candidate.id === row.id)?.status, 'cancelled');
    } finally { closeScheduledMessageDispatcher(); release(); await initial; }
  });
});
