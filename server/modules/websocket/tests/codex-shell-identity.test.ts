import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { inspectOwnedCodexShellThread, hasHeldCodexThreadLock, inspectCodexDesktopOwner } from '@/modules/websocket/services/codex-shell-identity.service.js';

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


async function desktopFixture(t: TestContext) {
  const f = await fixture(t);
  const applicationPath = path.join(path.dirname(path.dirname(f.lockDirectory)), 'ChatGPT.app');
  const executable = path.join(applicationPath, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const parentExecutable = path.join(applicationPath, 'Contents/MacOS/ChatGPT');
  const plist = path.join(applicationPath, 'Contents/Info.plist');
  for (const file of [executable, parentExecutable, plist]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'fixture', { mode: 0o755 });
  }
  const lock = path.join(f.lockDirectory, 'native-one.lock');
  await writeFile(lock, '');
  const parentPid = 43100;
  const processStart = 'Sat Nov 14 12:00:00 2026';
  const state = {
    flock: 'held\n', inventoryPid: pid, extraPid: 0, bundleId: 'com.openai.codex',
    version: 'codex-cli 0.169.0-alpha.11.1\n',
    childStart: processStart, command: `${executable} app-server --analytics-default-enabled`,
    childTextPath: executable, versionCalls: [] as string[],
  };
  const fileRecord = async (owner: number, fd: string, file: string) => {
    const info = await stat(file);
    return `p${owner}\nf${fd}\ntREG\nD0x${info.dev.toString(16)}\ni${info.ino}\nn${file}\n`;
  };
  const runFile = async (file: string, args: string[]) => {
    if (file === '/usr/bin/perl') return { stdout: state.flock };
    if (file === '/usr/bin/plutil') {
      assert.deepEqual(args, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
      return { stdout: state.bundleId };
    }
    if (file === executable) {
      assert.deepEqual(args, ['--version']);
      state.versionCalls.push(file);
      return { stdout: state.version };
    }
    if (file === '/bin/ps') {
      const inspectedPid = Number(args[3]);
      if (args[1] === 'ppid=,lstart=') return { stdout: inspectedPid === pid
        ? `${parentPid} ${state.childStart}\n` : `1 ${processStart}\n` };
      if (args[1] === 'comm=') return { stdout: inspectedPid === pid ? `${executable}\n` : `${parentExecutable}\n` };
      if (args[1] === 'args=') return { stdout: state.command };
    }
    if (file === '/usr/sbin/lsof') {
      if (args.includes('-d')) {
        const inspectedPid = Number(args[args.indexOf('-p') + 1]);
        return { stdout: await fileRecord(inspectedPid, 'txt', inspectedPid === pid ? state.childTextPath : parentExecutable), stderr: '' };
      }
      assert.equal(args.at(-1), lock);
      return { stdout: await fileRecord(state.inventoryPid, '51', lock)
        + (state.extraPid ? await fileRecord(state.extraPid, '52', lock) : ''), stderr: '' };
    }
    throw new Error(`Unexpected executable ${file} ${args.join(' ')}`);
  };
  return { ...f, applicationPath, executable, lock, state, runFile };
}

test('Desktop delegation identifies only a uniquely open, actually held native flock and verified embedded CLI', async (t) => {
  const f = await desktopFixture(t);
  const owner = await inspectCodexDesktopOwner('native-one', f.home, {
    platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
  });
  assert.equal(owner?.pid, pid);
  assert.equal(owner?.version, '0.169.0-alpha.11.1');
  assert.ok(owner?.identity.includes(String(pid)));
  assert.deepEqual(f.state.versionCalls, [f.executable]);
});

test('an unlocked descriptor or ambiguous open processes never identify a Desktop writer', async (t) => {
  for (const scenario of ['unlocked', 'ambiguous'] as const) {
    const f = await desktopFixture(t);
    if (scenario === 'unlocked') f.state.flock = 'clear\n';
    else f.state.extraPid = 43211;
    assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
      platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
    }), null);
    assert.deepEqual(f.state.versionCalls, []);
  }
});

test('unknown Desktop bundle, unsupported native version and a mismatched executable fail closed', async (t) => {
  for (const scenario of ['bundle', 'version', 'executable', 'mode'] as const) {
    const f = await desktopFixture(t);
    if (scenario === 'bundle') f.state.bundleId = 'org.example.impostor';
    if (scenario === 'version') f.state.version = 'codex-cli 0.169.0\n';
    if (scenario === 'executable') f.state.childTextPath = f.lock;
    if (scenario === 'mode') f.state.command = `${f.executable} exec resume native-one`;
    assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
      platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
    }), null);
    if (scenario !== 'version') assert.deepEqual(f.state.versionCalls, []);
  }
});

test('a captured executable argument is never executed as a Desktop version probe', async (t) => {
  const f = await desktopFixture(t);
  f.state.command = '/tmp/untrusted-codex app-server';
  assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
    platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
  }), null);
  assert.deepEqual(f.state.versionCalls, []);
});

test('Desktop ownership becomes unverified when process identity, flock state or open inventory changes', async (t) => {
  for (const scenario of ['pid-reused', 'released', 'new-opener'] as const) {
    const f = await desktopFixture(t);
    let versionRead = false;
    const runFile = async (file: string, args: string[]) => {
      const result = await f.runFile(file, args);
      if (file === f.executable) {
        versionRead = true;
        if (scenario === 'pid-reused') f.state.childStart = 'Sat Nov 14 12:01:00 2026';
        if (scenario === 'released') f.state.flock = 'clear\n';
        if (scenario === 'new-opener') f.state.extraPid = 43211;
      }
      return result;
    };
    assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
      platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile,
    }), null);
    assert.equal(versionRead, true, 'race occurs after the first verified process snapshot');
  }
});

test('a replaced lock inode and an incomplete lsof inventory cannot authorize Desktop delegation', async (t) => {
  for (const scenario of ['inode', 'warning'] as const) {
    const f = await desktopFixture(t);
    const oldLock = await open(f.lock, 'r');
    t.after(() => oldLock.close());
    const runFile = async (file: string, args: string[]) => {
      const result = await f.runFile(file, args);
      if (file === f.executable && scenario === 'inode') {
        await rm(f.lock);
        await writeFile(f.lock, '');
      }
      if (file === '/usr/sbin/lsof' && !args.includes('-d') && scenario === 'warning') {
        return { ...result, stderr: 'lsof: cannot inspect another process' };
      }
      return result;
    };
    assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
      platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile,
    }), null);
  }
});

test('unsupported platforms and unsafe thread IDs cannot trigger Desktop process probes', async (t) => {
  const f = await desktopFixture(t);
  const runFile = async () => { throw new Error('must not inspect'); };
  assert.equal(await inspectCodexDesktopOwner('native-one', f.home, { platform: 'linux', runFile }), null);
  assert.equal(await inspectCodexDesktopOwner('../native-one', f.home, { platform: 'darwin', runFile }), null);
});


test('inherited invalid locales cannot turn a held Desktop flock into an inspection warning', async (t) => {
  const f = await desktopFixture(t);
  const before = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.LANG = 'invalid_CLOUDCLI_test';
  process.env.LC_ALL = 'invalid_CLOUDCLI_test';
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const runFile = async (file: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => {
    environments.push(options.env);
    const result = await f.runFile(file, args);
    if (file === '/usr/bin/perl' && (options.env?.LC_ALL !== 'C' || options.env?.LANG !== 'C')) {
      return { ...result, stderr: 'perl: warning: Setting locale failed' };
    }
    return result;
  };
  const owner = await inspectCodexDesktopOwner('native-one', f.home, {
    platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile,
  });
  assert.equal(owner?.pid, pid);
  assert.ok(environments.length > 0);
  assert.ok(environments.every((environment) => environment?.LC_ALL === 'C' && environment?.LANG === 'C'));
  assert.ok(environments.every((environment) => environment !== process.env));
  assert.equal(process.env.LANG, 'invalid_CLOUDCLI_test');
  assert.equal(process.env.LC_ALL, 'invalid_CLOUDCLI_test');
});


test('verified Desktop startup accepts its exact known code-mode and app-tools boolean overrides', async (t) => {
  const f = await desktopFixture(t);
  f.state.command = `${f.executable} -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`;
  assert.equal((await inspectCodexDesktopOwner('native-one', f.home, {
    platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
  }))?.pid, pid);
});

test('Desktop startup cannot smuggle model, provider, transport or unknown overrides through config flags', async (t) => {
  for (const args of [
    '-c model=unverified app-server',
    'app-server -c model_provider=unverified',
    'app-server -c features.code_mode_host=false',
    'app-server -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false',
    'app-server -c features.code_mode_host=true -c features.code_mode_host=true',
    'app-server --listen ws://127.0.0.1:9999',
    'app-server daemon',
    'app-server --analytics-default-enabled --unknown',
  ]) {
    const f = await desktopFixture(t);
    f.state.command = `${f.executable} ${args}`;
    assert.equal(await inspectCodexDesktopOwner('native-one', f.home, {
      platform: 'darwin', desktopApplicationPath: f.applicationPath, runFile: f.runFile,
    }), null, args);
    assert.deepEqual(f.state.versionCalls, [], args);
  }
});
