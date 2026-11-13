import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

function createSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data) => socket.frames.push(JSON.parse(data));
  return socket;
}

async function withSessions(runTest: (context: {
  chat: ReturnType<typeof createSocket>;
  shell: ReturnType<typeof createSocket>;
  launches: string[];
  runs: string[];
  terminal: { killed: boolean; emitExit: () => void };
  directory: string;
  setChatBusy: (busy: boolean) => void;
}) => Promise<void>) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-shell-handoff-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const chat = createSocket();
  const shell = createSocket();
  const launches: string[] = [];
  const runs: string[] = [];
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  let chatBusy = false;
  const terminal = {
    killed: false,
    onData: () => ({ dispose() {} }),
    onExit: (listener: (event: { exitCode: number }) => void) => { onExit = listener; return { dispose() {} }; },
    emitExit: () => onExit?.({ exitCode: 0 }),
    kill() { this.killed = true; },
    write() {},
    resize() {},
  };
  try {
    for (const [id, provider] of [['handoff', 'codex'], ['unrelated', 'codex'], ['other-llm', 'claude']]) {
      sessionsDb.createAppSession(id, provider, directory);
      sessionsDb.assignProviderSessionId(id, `native-${id}`);
    }
    handleChatConnection(chat as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, _command: string, options: { sessionId: string }) => { runs.push(options.sessionId); },
      } as never,
    });
    handleShellConnection(shell as never, {
      resolveProviderSessionId: (id) => sessionsDb.getSessionById(id)?.provider_session_id ?? id,
      isChatSessionRunning: () => chatBusy,
      spawnPty: (_shell, args) => { launches.push(String(args.at(-1))); return terminal as never; },
    });
    await runTest({ chat, shell, launches, runs, terminal, directory, setChatBusy: (busy) => { chatBusy = busy; } });
  } finally {
    terminal.emitExit();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('Chat waits for its Codex Shell to actually exit; other sessions keep working', async () => {
  await withSessions(async ({ chat, shell, runs, terminal, directory }) => {
    shell.emit('message', JSON.stringify({ type: 'init', provider: 'codex', sessionId: 'handoff',
      hasSession: true, projectPath: directory, attachOnly: false }));
    shell.emit('close'); // A network disconnect is not a runtime exit.
    for (const sessionId of ['handoff', 'unrelated', 'other-llm']) {
      chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId, content: 'hello' }));
      await settle();
    }
    assert.deepEqual(runs, ['unrelated', 'other-llm']);
    assert.ok(chat.frames.some((frame) => frame.code === 'SHELL_SESSION_ACTIVE' && frame.sessionId === 'handoff'));
    assert.equal(terminal.killed, false, 'Chat must not kill a possibly running Shell task');
    terminal.emitExit();
    chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'handoff', content: 'continue' }));
    await settle();
    assert.deepEqual(runs, ['unrelated', 'other-llm', 'handoff']);
  });
});

test('Chat also recognizes a Shell opened using the native thread id', async () => {
  await withSessions(async ({ chat, shell, runs, directory }) => {
    shell.emit('message', JSON.stringify({ type: 'init', provider: 'codex', sessionId: 'native-handoff',
      hasSession: true, projectPath: directory, attachOnly: false }));
    chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'handoff', content: 'hello' }));
    await settle();
    assert.deepEqual(runs, []);
    assert.equal(chat.frames.at(-1)?.code, 'SHELL_SESSION_ACTIVE');
  });
});

test('Codex Shell waits for Chat and can start once Chat releases the session', async () => {
  await withSessions(async ({ shell, launches, directory, setChatBusy }) => {
    const init = JSON.stringify({ type: 'init', provider: 'codex', sessionId: 'handoff',
      hasSession: true, projectPath: directory, attachOnly: false });
    setChatBusy(true);
    shell.emit('message', init);
    assert.deepEqual(launches, []);
    assert.equal(shell.frames.at(-1)?.code, 'CHAT_SESSION_ACTIVE');
    setChatBusy(false);
    shell.emit('message', init);
    assert.equal(launches.length, 1);
  });
});

test('legacy automatic Codex clients cannot create a writer', async () => {
  await withSessions(async ({ shell, launches, directory }) => {
    shell.emit('message', JSON.stringify({ type: 'init', provider: 'codex', sessionId: 'handoff',
      hasSession: true, projectPath: directory }));
    assert.deepEqual(launches, []);
    assert.ok(shell.frames.some((frame) => frame.type === 'session_unavailable'));
  });
});

test('an explicit End keeps Chat blocked until the PTY exit event', async () => {
  await withSessions(async ({ chat, shell, runs, terminal, directory }) => {
    shell.emit('message', JSON.stringify({ type: 'init', provider: 'codex', sessionId: 'handoff',
      hasSession: true, projectPath: directory, attachOnly: false }));
    shell.emit('message', JSON.stringify({ type: 'terminate' }));
    assert.equal(terminal.killed, true);
    chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'handoff', content: 'continue' }));
    await settle();
    assert.deepEqual(runs, []);
    assert.equal(chat.frames.at(-1)?.code, 'SHELL_SESSION_ACTIVE');
    terminal.emitExit();
    chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'handoff', content: 'continue' }));
    await settle();
    assert.deepEqual(runs, ['handoff']);
  });
});
