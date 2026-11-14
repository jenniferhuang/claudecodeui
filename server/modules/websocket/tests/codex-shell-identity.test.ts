import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { inspectOwnedCodexShellThread, hasOpenCodexThreadLock } from '@/modules/websocket/services/codex-shell-identity.service.js';

const pid = 43210;
const firstIdentity = `${process.pid} ${pid} Sat Nov 14 12:00:00 2026`;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-shell-identity-'));
  await mkdir(path.join(directory, 'home', 'thread-writer-locks'), { recursive: true });
  await symlink(path.join(directory, 'home'), path.join(directory, 'home-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { home: path.join(directory, 'home-alias'), lockDirectory: await realpath(path.join(directory, 'home', 'thread-writer-locks')) };
}
function response(lockDirectory: string, names = ['native-one']) {
  return `p${pid}\ng${pid}\n` + names.map((name, index) => `f${index + 3}\ntREG\nn${lockDirectory}/${name}.lock\n`).join('');
}

test('unique group lock FD uses the canonical Codex home and exact native ID', async (t) => {
  const f = await fixture(t);
  const result = await inspectOwnedCodexShellThread(pid, f.home, {
    platform: 'darwin',
    runFile: async (file, args) => {
      if (file === '/bin/ps') return { stdout: firstIdentity };
      assert.deepEqual(args, ['-nP', '-a', '-g', '43210', '-F', 'pgftn']);
      return { stdout: response(f.lockDirectory) };
    },
  });
  assert.equal(result, 'native-one');
});

test('another directory with the same lock filename is not native ownership evidence', async (t) => {
  const f = await fixture(t);
  const result = await inspectOwnedCodexShellThread(pid, f.home, {
    platform: 'darwin', runFile: async (file) => ({ stdout: file === '/bin/ps' ? firstIdentity : response(path.dirname(f.lockDirectory)) }),
  });
  assert.equal(result, null);
});

test('multiple native lock IDs remain ambiguous instead of adopting the wrong history', async (t) => {
  const f = await fixture(t);
  const result = await inspectOwnedCodexShellThread(pid, f.home, {
    platform: 'darwin', runFile: async (file) => ({ stdout: file === '/bin/ps' ? firstIdentity : response(f.lockDirectory, ['native-one', 'native-two']) }),
  });
  assert.equal(result, undefined);
});

test('a reused PID or changed root process identity cannot associate a fresh Shell', async (t) => {
  const f = await fixture(t);
  for (const changed of [`1 ${pid} Sat Nov 14 12:00:00 2026`, `${process.pid} ${pid} Sat Nov 14 12:01:00 2026`]) {
    let reads = 0;
    const result = await inspectOwnedCodexShellThread(pid, f.home, {
      platform: 'darwin', runFile: async (file) => ({ stdout: file === '/bin/ps'
        ? (++reads === 1 ? firstIdentity : changed) : response(f.lockDirectory) }),
    });
    assert.equal(result, undefined);
  }
});

test('a lock attributed to a different process group cannot adopt a native ID', async (t) => {
  const f = await fixture(t);
  const result = await inspectOwnedCodexShellThread(pid, f.home, {
    platform: 'darwin', runFile: async (file) => ({ stdout: file === '/bin/ps'
      ? firstIdentity : response(f.lockDirectory).replace(`g${pid}`, 'g99999') }),
  });
  assert.equal(result, undefined);
});

test('unsupported platforms and failed bounded inspection remain unassociated', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runFile = async (_file: string, _args: string[], options: { timeout: number }) => {
    calls += 1;
    assert.ok(options.timeout > 0 && options.timeout <= 1000);
    throw new Error('inspection unavailable');
  };
  assert.equal(await inspectOwnedCodexShellThread(pid, f.home, { platform: 'win32', runFile }), undefined);
  assert.equal(calls, 0, 'unsupported platforms must not spawn platform probes');
  assert.equal(await inspectOwnedCodexShellThread(pid, f.home, { platform: 'darwin', runFile }), undefined);
  assert.equal(calls, 1);
});


test('the exact requested native writer FD stays busy until its descriptor closes', async (t) => {
  const f = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(f.lockDirectory, 'native-one.lock'), '');
  let open = true;
  const dependencies = { platform: 'darwin' as const,
    runFile: async (_file: string, args: string[], options: { timeout: number }) => {
      assert.equal(args.at(-1), path.join(f.lockDirectory, 'native-one.lock'));
      assert.ok(options.timeout > 0 && options.timeout <= 1000);
      return { stdout: open ? response(f.lockDirectory) : '' };
    },
  };
  assert.equal(await hasOpenCodexThreadLock('native-one', f.home, dependencies), true);
  open = false;
  assert.equal(await hasOpenCodexThreadLock('native-one', f.home, dependencies), false);
});

test('a missing requested lock is released; unsupported and failed probes stay unknown', async (t) => {
  const f = await fixture(t);
  assert.equal(await hasOpenCodexThreadLock('missing-native', f.home, { platform: 'darwin' }), false);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(f.lockDirectory, 'native-one.lock'), '');
  assert.equal(await hasOpenCodexThreadLock('native-one', f.home, { platform: 'win32' }), undefined);
  assert.equal(await hasOpenCodexThreadLock('native-one', f.home, { platform: 'darwin',
    runFile: async () => { throw new Error('lsof unavailable'); } }), undefined);
});
