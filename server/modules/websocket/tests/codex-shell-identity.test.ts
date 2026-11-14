import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { inspectOwnedCodexShellThread, hasHeldCodexThreadLock } from '@/modules/websocket/services/codex-shell-identity.service.js';

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


const perl = process.platform === 'darwin' ? '/usr/bin/perl' : 'perl';
const nativeFlockAvailable = (process.platform === 'darwin' || process.platform === 'linux')
  && spawnSync(perl, ['-MFcntl=:flock', '-e', 'exit 0'], { timeout: 1000 }).status === 0;
const nativeFlockTest = { skip: nativeFlockAvailable ? false : 'Requires POSIX flock and Perl' };

test('an open but unlocked native lock descriptor does not block a thread', nativeFlockTest, async (t) => {
  const f = await fixture(t);
  const lock = await open(path.join(f.lockDirectory, 'native-one.lock'), 'w+');
  t.after(() => lock.close());
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home), false);
});

test('a held native flock blocks only its thread and clears before its descriptor closes', nativeFlockTest, async (t) => {
  const f = await fixture(t);
  const lockPath = path.join(f.lockDirectory, 'native-one.lock');
  await writeFile(lockPath, '');
  await writeFile(path.join(f.lockDirectory, 'unrelated-native.lock'), '');
  const child = spawn(perl, ['-e', `
    use strict;
    use warnings;
    use Fcntl qw(O_RDONLY LOCK_EX LOCK_UN);
    sysopen(my $lock, $ARGV[0], O_RDONLY) or die "open: $!";
    flock($lock, LOCK_EX) or die "flock: $!";
    $| = 1;
    print "ready\n";
    scalar <STDIN>;
    flock($lock, LOCK_UN) or die "unlock: $!";
    print "released\n";
    scalar <STDIN>;
  `, lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  await once(child.stdout, 'data');
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home), true);
  assert.equal(await hasHeldCodexThreadLock('unrelated-native', f.home), false);
  const released = once(child.stdout, 'data');
  child.stdin.write('release\n');
  await released;
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home), false);
});

test('a missing requested lock is released; unsupported and failed probes stay unknown', async (t) => {
  const f = await fixture(t);
  assert.equal(await hasHeldCodexThreadLock('missing-native', f.home, { platform: 'darwin' }), false);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(f.lockDirectory, 'native-one.lock'), '');
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home, { platform: 'win32' }), undefined);
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home, { platform: 'darwin',
    runFile: async () => { throw new Error('lsof unavailable'); } }), undefined);
});


test('a missing flock helper and malformed output leave native Codex authoritative', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.lockDirectory, 'native-one.lock'), '');
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home, { platform: 'darwin',
    runFile: async () => { throw Object.assign(new Error('missing helper'), { code: 'ENOENT', syscall: 'spawn /usr/bin/perl' }); } }), undefined);
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home, { platform: 'linux',
    runFile: async () => ({ stdout: 'unrecognized result' }) }), undefined);
});

test('a replaced native lock inode cannot report ownership of the old file', async (t) => {
  const f = await fixture(t);
  const lockPath = path.join(f.lockDirectory, 'native-one.lock');
  await writeFile(lockPath, '');
  const original = await open(lockPath, 'r');
  t.after(() => original.close());
  assert.equal(await hasHeldCodexThreadLock('native-one', f.home, { platform: 'darwin',
    runFile: async () => {
      await rm(lockPath);
      await writeFile(lockPath, '');
      return { stdout: 'held\n' };
    } }), undefined);
});
