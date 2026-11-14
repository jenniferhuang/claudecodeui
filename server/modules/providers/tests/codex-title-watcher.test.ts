import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Registry construction captures provider home directories and auth imports can
// open SQLite eagerly. Isolate both before importing any application modules.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'codex-title-watcher-'));
const previousEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_PATH: process.env.DATABASE_PATH,
  CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING,
};
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.DATABASE_PATH = path.join(fixtureHome, 'auth.db');
process.env.CHOKIDAR_USEPOLLING = 'false';

const { initializeDatabase, closeConnection, sessionsDb } = await import('@/modules/database/index.js');
const { initializeSessionsWatcher, closeSessionsWatcher } = await import('@/modules/providers/services/sessions-watcher.service.js');
const { sessionSynchronizerService } = await import('@/modules/providers/services/session-synchronizer.service.js');
const { connectedClients } = await import('@/modules/websocket/index.js');

after(async () => {
  await closeSessionsWatcher();
  closeConnection();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixtureHome, { recursive: true, force: true });
});

async function writeSession(sessionId: string): Promise<{ transcript: string; indexPath: string }> {
  await rm(path.join(fixtureHome, '.codex'), { recursive: true, force: true });
  const sessionsDir = path.join(fixtureHome, '.codex', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const transcript = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const indexPath = path.join(fixtureHome, '.codex', 'session_index.jsonl');
  await writeFile(transcript, `${JSON.stringify({
    type: 'session_meta', payload: { id: sessionId, cwd: path.join(fixtureHome, 'workspace') },
  })}\n`);
  await writeFile(indexPath, `${JSON.stringify({ id: sessionId, thread_name: 'Original title' })}\n`);
  return { transcript, indexPath };
}

async function appendRename(indexPath: string, sessionId: string, title: string): Promise<void> {
  await appendFile(indexPath, `${JSON.stringify({ id: sessionId, thread_name: title })}\n`);
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'watcher condition completed within five seconds');
    await delay(20);
  }
}

function hasRenameEvent(payloads: string[], sessionId: string, title: string): boolean {
  return payloads.some((payload) => {
    const event: { kind?: string; sessionId?: string; session?: { summary?: string } } = JSON.parse(payload);
    return event.kind === 'session_upserted' && event.sessionId === sessionId && event.session?.summary === title;
  });
}

test('an index-only Codex rename updates the DB and connected sidebar without a transcript write', async () => {
  const sessionId = 'codex-index-only-rename';
  const { transcript, indexPath } = await writeSession(sessionId);
  const payloads: string[] = [];
  const client = { readyState: 1, send: (payload: string) => payloads.push(payload) };
  await initializeDatabase();
  connectedClients.add(client);

  try {
    await initializeSessionsWatcher();
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Original title');
    const before = await stat(transcript);
    await appendRename(indexPath, sessionId, 'Cloudcli');
    await waitUntil(() => hasRenameEvent(payloads, sessionId, 'Cloudcli'));
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Cloudcli');
    assert.equal((await stat(transcript)).mtimeMs, before.mtimeMs);
  } finally {
    await closeSessionsWatcher();
    connectedClients.delete(client);
  }
});

test('a rename between initial synchronization and watcher readiness is reconciled', async () => {
  const sessionId = 'codex-startup-rename';
  const { indexPath } = await writeSession(sessionId);
  const originalSync = sessionSynchronizerService.synchronizeSessions;
  sessionSynchronizerService.synchronizeSessions = async () => {
    const result = await originalSync();
    await appendRename(indexPath, sessionId, 'Renamed during startup');
    return result;
  };

  try {
    await initializeSessionsWatcher();
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Renamed during startup');
  } finally {
    sessionSynchronizerService.synchronizeSessions = originalSync;
    await closeSessionsWatcher();
  }
});

test('watcher shutdown waits for an accepted name refresh before returning', async () => {
  const sessionId = 'codex-shutdown-rename';
  const { indexPath } = await writeSession(sessionId);
  await initializeSessionsWatcher();
  const originalRefresh = sessionSynchronizerService.synchronizeProviderNames;
  let releaseRefresh: () => void = () => {};
  const refreshMayFinish = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let refreshStarted = false;
  sessionSynchronizerService.synchronizeProviderNames = async (provider) => {
    refreshStarted = true;
    await refreshMayFinish;
    return originalRefresh(provider);
  };

  try {
    await appendRename(indexPath, sessionId, 'Renamed before shutdown');
    await waitUntil(() => refreshStarted);
    let shutdownFinished = false;
    const shutdown = closeSessionsWatcher().then(() => { shutdownFinished = true; });
    await delay(30);
    assert.equal(shutdownFinished, false);
    releaseRefresh();
    await shutdown;
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Renamed before shutdown');
  } finally {
    releaseRefresh();
    sessionSynchronizerService.synchronizeProviderNames = originalRefresh;
    await closeSessionsWatcher();
  }
});
