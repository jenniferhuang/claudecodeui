import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-name-source-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('title source migration leaves legacy provenance unknown and is idempotent', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-title', 'codex', '/workspace/project', 'Existing title');
    const db = getConnection();
    db.exec('ALTER TABLE sessions DROP COLUMN custom_name_source');

    runMigrations(db);
    assert.equal(sessionsDb.getSessionById('legacy-title')?.custom_name_source, null);
    assert.equal(sessionsDb.getSessionById('legacy-title')?.custom_name, 'Existing title');

    sessionsDb.renameSessionCustomName('legacy-title', 'Manual title');
    runMigrations(db);
    assert.equal(sessionsDb.getSessionById('legacy-title')?.custom_name_source, 'user');
    assert.equal(sessionsDb.getSessionById('legacy-title')?.custom_name, 'Manual title');
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    assert.equal(columns.filter((column) => column.name === 'custom_name_source').length, 1);
  });
});

test('provider imports and automatic setters preserve explicit user names on both upsert paths', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('imported-title', 'codex', '/workspace/project', 'Provider title');
    assert.equal(sessionsDb.getSessionById('imported-title')?.custom_name_source, 'provider');
    sessionsDb.renameSessionCustomName('imported-title', 'Manual title');
    sessionsDb.createSession('imported-title', 'codex', '/workspace/project', 'Later provider title');
    sessionsDb.updateSessionCustomName('imported-title', 'Automatic fallback title');
    assert.equal(sessionsDb.getSessionById('imported-title')?.custom_name, 'Manual title');
    assert.equal(sessionsDb.getSessionById('imported-title')?.custom_name_source, 'user');

    // A legacy row without a native mapping takes INSERT ... ON CONFLICT.
    sessionsDb.createAppSession('legacy-unmapped-title', 'codex', '/workspace/project', 'Initial app title');
    sessionsDb.renameSessionCustomName('legacy-unmapped-title', 'Manual unmapped title');
    sessionsDb.createSession('legacy-unmapped-title', 'codex', '/workspace/project', 'Indexed title');
    assert.equal(sessionsDb.getSessionById('legacy-unmapped-title')?.custom_name, 'Manual unmapped title');
    assert.equal(sessionsDb.getSessionById('legacy-unmapped-title')?.custom_name_source, 'user');
  });
});

test('automatic writes keep legacy provenance NULL until the synchronizer classifies it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-unknown-title', 'codex', '/workspace/project', 'Old title');
    getConnection().prepare('UPDATE sessions SET custom_name_source = NULL WHERE session_id = ?')
      .run('legacy-unknown-title');

    sessionsDb.createSession('legacy-unknown-title', 'codex', '/workspace/project', 'Imported title');
    assert.equal(sessionsDb.getSessionById('legacy-unknown-title')?.custom_name_source, null);
    sessionsDb.updateSessionCustomName('legacy-unknown-title', 'Automatic title');
    assert.equal(sessionsDb.getSessionById('legacy-unknown-title')?.custom_name_source, null);
  });
});

test('native title batches protect mappings, providers and overrides without changing activity', async () => {
  await withIsolatedDatabase(() => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const updatedAt = '2026-01-02T00:00:00.000Z';
    sessionsDb.createSession('native-title', 'codex', '/workspace/project', 'Old title', createdAt, updatedAt);
    sessionsDb.updateSessionIsArchived('native-title', true);
    sessionsDb.createSession('manual-title', 'codex', '/workspace/project', 'Provider original');
    sessionsDb.renameSessionCustomName('manual-title', 'User title');
    sessionsDb.createSession('other-provider', 'claude', '/workspace/project', 'Claude title');
    sessionsDb.createAppSession('mapped-app', 'codex', '/workspace/project', 'App title');
    sessionsDb.assignProviderSessionId('mapped-app', 'mapped-provider');

    assert.deepEqual(
      sessionsDb.getNativeSessionsByProvider('codex').map((row) => row.session_id).sort(),
      ['manual-title', 'native-title'],
    );
    const changed = sessionsDb.applyNativeProviderSessionNames('codex', [
      { sessionId: 'native-title', customName: 'Latest title', source: 'provider' },
      { sessionId: 'manual-title', customName: 'Provider overwrite', source: 'provider' },
      { sessionId: 'other-provider', customName: 'Wrong provider overwrite', source: 'provider' },
      { sessionId: 'mapped-app', customName: 'Mapped overwrite', source: 'provider' },
      { sessionId: 'mapped-provider', customName: 'Native mapped overwrite', source: 'provider' },
      { sessionId: 'missing-session', customName: 'Unknown title', source: 'provider' },
    ]);

    assert.deepEqual(changed, ['native-title']);
    const native = sessionsDb.getSessionById('native-title')!;
    assert.equal(native.custom_name, 'Latest title');
    assert.equal(native.custom_name_source, 'provider');
    assert.equal(native.created_at, createdAt);
    assert.equal(native.updated_at, updatedAt);
    assert.equal(native.isArchived, 1);
    assert.equal(sessionsDb.getSessionById('manual-title')?.custom_name, 'User title');
    assert.equal(sessionsDb.getSessionById('other-provider')?.custom_name, 'Claude title');
    assert.equal(sessionsDb.getSessionById('mapped-app')?.custom_name, 'App title');
  });
});

test('legacy manual title classification cannot relabel a newer or provider-owned name', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-manual', 'codex', '/workspace/project', 'Legacy custom title');
    sessionsDb.createSession('already-provider', 'codex', '/workspace/project', 'Provider title');
    getConnection().prepare('UPDATE sessions SET custom_name_source = NULL WHERE session_id = ?')
      .run('legacy-manual');

    assert.deepEqual(sessionsDb.applyNativeProviderSessionNames('codex', [
      { sessionId: 'legacy-manual', customName: 'An outdated name', source: 'user' },
      { sessionId: 'already-provider', customName: 'Provider title', source: 'user' },
    ]), []);
    assert.equal(sessionsDb.getSessionById('legacy-manual')?.custom_name_source, null);
    assert.equal(sessionsDb.getSessionById('already-provider')?.custom_name_source, 'provider');

    assert.deepEqual(sessionsDb.applyNativeProviderSessionNames('codex', [
      { sessionId: 'legacy-manual', customName: 'Legacy custom title', source: 'user' },
    ]), []);
    assert.equal(sessionsDb.getSessionById('legacy-manual')?.custom_name_source, 'user');
    sessionsDb.applyNativeProviderSessionNames('codex', [
      { sessionId: 'legacy-manual', customName: 'Later external title', source: 'provider' },
    ]);
    assert.equal(sessionsDb.getSessionById('legacy-manual')?.custom_name, 'Legacy custom title');
  });
});

test('a failing title batch rolls back earlier title and provenance changes', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('batch-first', 'codex', '/workspace/project', 'First title');
    sessionsDb.createSession('batch-second', 'codex', '/workspace/project', 'Second title');
    const invalidSource = 'invalid' as 'provider';
    assert.throws(() => sessionsDb.applyNativeProviderSessionNames('codex', [
      { sessionId: 'batch-first', customName: 'Changed first title', source: 'provider' },
      { sessionId: 'batch-second', customName: 'Changed second title', source: invalidSource },
    ]), /CHECK constraint failed/);
    assert.equal(sessionsDb.getSessionById('batch-first')?.custom_name, 'First title');
    assert.equal(sessionsDb.getSessionById('batch-second')?.custom_name, 'Second title');
  });
});
