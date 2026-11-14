import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withFixture(run: (fixture: {
  home: string;
  transcript: string;
  indexPath: string;
  database: typeof import('@/modules/database/index.js');
  synchronizer: import('@/modules/providers/list/codex/codex-session-synchronizer.provider.js').CodexSessionSynchronizer;
}) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-name-sync-'));
  const previous = { HOME: process.env.HOME, DATABASE_PATH: process.env.DATABASE_PATH };
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  const database = await import('@/modules/database/index.js');
  const { CodexSessionSynchronizer } = await import('@/modules/providers/list/codex/codex-session-synchronizer.provider.js');
  database.closeConnection();
  await database.initializeDatabase();
  const sessionsDir = path.join(home, '.codex', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const transcript = path.join(sessionsDir, 'rollout-thread-1.jsonl');
  await writeFile(transcript, `${JSON.stringify({
    type: 'session_meta', payload: { id: 'thread-1', cwd: path.join(home, 'workspace') },
  })}\n`);
  const indexPath = path.join(home, '.codex', 'session_index.jsonl');

  try {
    await run({ home, transcript, indexPath, database, synchronizer: new CodexSessionSynchronizer() });
  } finally {
    database.closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function indexRows(...titles: string[]): string {
  return titles.map((thread_name) => JSON.stringify({ id: 'thread-1', thread_name })).join('\n') + '\n';
}

test('imports use the latest valid title and ignore partial or empty trailing index rows', async () => {
  await withFixture(async ({ indexPath, database, synchronizer, transcript }) => {
    await writeFile(indexPath, indexRows('Fork session to project', 'Cloudcli', ' ') + '{"id":');
    await synchronizer.synchronizeFile(transcript);
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name, 'Cloudcli');
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name_source, 'provider');
  });
});

test('an incremental empty scan repairs a cached historical title without changing activity', async () => {
  await withFixture(async ({ home, indexPath, database, synchronizer }) => {
    const { sessionsDb, getConnection } = database;
    sessionsDb.createSession('thread-1', 'codex', home, 'Fork session to project', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    sessionsDb.updateSessionIsArchived('thread-1', true);
    getConnection().prepare('UPDATE sessions SET custom_name_source = NULL WHERE session_id = ?').run('thread-1');
    await writeFile(indexPath, indexRows('Fork session to project', 'Cloudcli'));
    assert.equal(await synchronizer.synchronize(new Date('2100-01-01')), 0);
    const row = sessionsDb.getSessionById('thread-1')!;
    assert.equal(row.custom_name, 'Cloudcli');
    assert.equal(row.custom_name_source, 'provider');
    assert.equal(row.isArchived, 1);
    assert.equal(row.updated_at, '2026-01-02T00:00:00.000Z');
  });
});

test('manual imported titles survive an external rename even when they match a historical title', async () => {
  await withFixture(async ({ indexPath, database, synchronizer, transcript }) => {
    await writeFile(indexPath, indexRows('Original', 'Cloudcli'));
    await synchronizer.synchronize();
    database.sessionsDb.renameSessionCustomName('thread-1', 'Original');
    await writeFile(indexPath, indexRows('Original', 'Cloudcli', 'External rename'));
    assert.deepEqual(await synchronizer.synchronizeNames(), []);
    await synchronizer.synchronizeFile(transcript);
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name, 'Original');
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name_source, 'user');
  });
});

test('legacy titles absent from index history are retained as possible manual overrides', async () => {
  await withFixture(async ({ home, indexPath, database, synchronizer }) => {
    database.sessionsDb.createSession('thread-1', 'codex', home, 'My sidebar name');
    database.getConnection().prepare('UPDATE sessions SET custom_name_source = NULL WHERE session_id = ?').run('thread-1');
    await writeFile(indexPath, indexRows('Original', 'Cloudcli'));
    assert.deepEqual(await synchronizer.synchronizeNames(), []);
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name, 'My sidebar name');
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name_source, 'user');
  });
});

test('CloudCLI-created mapped sessions keep their own titles', async () => {
  await withFixture(async ({ home, indexPath, database, synchronizer, transcript }) => {
    database.sessionsDb.createAppSession('app-1', 'codex', home, 'CloudCLI app name');
    database.sessionsDb.assignProviderSessionId('app-1', 'thread-1');
    await writeFile(indexPath, indexRows('Original', 'Cloudcli'));
    await synchronizer.synchronizeFile(transcript);
    await synchronizer.synchronize();
    assert.equal(database.sessionsDb.getSessionById('app-1')?.custom_name, 'CloudCLI app name');
    assert.equal(database.sessionsDb.getSessionById('thread-1'), null);
  });
});

test('missing index metadata leaves an existing cached title intact', async () => {
  await withFixture(async ({ home, database, synchronizer, transcript }) => {
    database.sessionsDb.createSession('thread-1', 'codex', home, 'Cached name');
    await synchronizer.synchronizeFile(transcript);
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name, 'Cached name');
  });
});

test('a transcript scan does not consume rename notifications before the index watcher', async () => {
  await withFixture(async ({ indexPath, database, synchronizer, transcript }) => {
    await writeFile(indexPath, indexRows('Original'));
    await synchronizer.synchronizeFile(transcript);
    await writeFile(indexPath, indexRows('Original', 'Cloudcli'));
    await synchronizer.synchronizeFile(transcript);
    assert.equal(database.sessionsDb.getSessionById('thread-1')?.custom_name, 'Cloudcli');
    assert.deepEqual(await synchronizer.synchronizeNames(), ['thread-1']);
    assert.deepEqual(await synchronizer.synchronizeNames(), []);
  });
});

test('a rename during a transcript scan wins over that scan’s older index snapshot', async () => {
  await withFixture(async ({ home, indexPath, database, synchronizer }) => {
    const { sessionsDb } = database;
    sessionsDb.createSession('thread-1', 'codex', home, 'Original');
    await writeFile(indexPath, indexRows('Original'));
    const originalCreate = sessionsDb.createSession;
    sessionsDb.createSession = (...args) => {
      // Model a metadata watcher applying a newer title before a scan commits
      // its old snapshot. Final reconciliation must restore the newest title.
      appendFileSync(indexPath, indexRows('Renamed during scan'));
      sessionsDb.applyNativeProviderSessionNames('codex', [
        { sessionId: 'thread-1', customName: 'Renamed during scan', source: 'provider' },
      ]);
      return originalCreate(...args);
    };
    try {
      await synchronizer.synchronize();
      assert.equal(sessionsDb.getSessionById('thread-1')?.custom_name, 'Renamed during scan');
    } finally {
      sessionsDb.createSession = originalCreate;
    }
  });
});
