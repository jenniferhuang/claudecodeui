import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_NATIVE_ID = /^[a-zA-Z0-9_.\-:]+$/;

type IdentityDependencies = {
  platform?: NodeJS.Platform;
  runFile?: (executable: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr?: string }>;
  /** Isolates the fixed Desktop bundle in filesystem fixtures; never request-controlled. */
  desktopApplicationPath?: string;
};

/**
 * Used by Shell ownership admission to associate a fresh retained PTY with its
 * native Codex thread. A unique regular lock FD in that exact child process
 * group is evidence; cwd, timestamps, terminal text and global thread lists are
 * not. Null means no thread FD yet; undefined means inspection was unsupported,
 * ambiguous or changed identity. Neither result invents an association.
 */
export async function inspectOwnedCodexShellThread(
  terminalPid: number,
  codexHome: string,
  dependencies: IdentityDependencies = {},
): Promise<string | null | undefined> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return undefined;
  if (!Number.isSafeInteger(terminalPid) || terminalPid <= 0 || terminalPid === process.pid) return undefined;
  const runFile = dependencies.runFile ?? execFileAsync;
  const options = { timeout: 1000, maxBuffer: 1024 * 1024 };
  const ps = platform === 'darwin' ? '/bin/ps' : 'ps';
  const lsof = platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  try {
    const identity = async () => {
      const { stdout } = await runFile(ps, ['-o', 'ppid=,pgid=,lstart=', '-p', String(terminalPid)], options);
      const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match || Number(match[1]) !== process.pid || Number(match[2]) !== terminalPid) return null;
      return match[0];
    };
    const before = await identity();
    if (!before) return undefined;
    let lockDirectory: string;
    try { lockDirectory = await fs.realpath(path.join(codexHome, 'thread-writer-locks')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      return await identity() === before ? null : undefined;
    }
    const { stdout } = await runFile(lsof, ['-nP', '-a', '-g', String(terminalPid), '-F', 'pgftn'], options);
    const nativeIds = new Set<string>();
    let group = '';
    let type = '';
    let hasProcess = false;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) { hasProcess = /^p[0-9]+$/.test(line); group = ''; type = ''; }
      else if (line.startsWith('g')) group = line.slice(1);
      else if (line.startsWith('f')) type = '';
      else if (line.startsWith('t')) type = line.slice(1);
      else if (line.startsWith('n') && type === 'REG') {
        const file = line.slice(1);
        if (path.dirname(file) !== lockDirectory || !file.endsWith('.lock')) continue;
        if (!hasProcess || group !== String(terminalPid)) return undefined;
        const nativeId = path.basename(file, '.lock');
        if (!SAFE_NATIVE_ID.test(nativeId) || nativeId === '.' || nativeId === '..') return undefined;
        nativeIds.add(nativeId);
      }
    }
    if (!hasProcess || await identity() !== before || nativeIds.size > 1) return undefined;
    return nativeIds.size === 1 ? [...nativeIds][0] : null;
  } catch {
    // Native Codex still owns the final OS writer check on unsupported systems.
    return undefined;
  }
}

/**
 * Used by Shell admission and the refresh wrapper consumed by Chat/schedules.
 * Probe the native writer flock, not whether a process merely has the file open.
 * The read-only helper releases a successfully acquired lock immediately; it
 * never deletes the file or changes another process's ownership. Missing Perl
 * or unsupported inspection leaves Codex's own writer check authoritative.
 */
export async function hasHeldCodexThreadLock(
  nativeId: string,
  codexHome: string,
  dependencies: IdentityDependencies = {},
): Promise<boolean | undefined> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return undefined;
  if (!SAFE_NATIVE_ID.test(nativeId) || nativeId === '.' || nativeId === '..') return undefined;
  const runFile = dependencies.runFile ?? execFileAsync;
  let lockPath: string;
  try {
    lockPath = await fs.realpath(path.join(codexHome, 'thread-writer-locks', `${nativeId}.lock`));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
  try {
    const before = await fs.stat(lockPath);
    if (!before.isFile()) return undefined;
    const { stdout } = await runFile(platform === 'darwin' ? '/usr/bin/perl' : 'perl', ['-e', `
      use strict;
      use warnings;
      use Fcntl qw(O_RDONLY LOCK_EX LOCK_NB LOCK_UN);
      use Errno qw(EAGAIN EWOULDBLOCK);
      sysopen(my $lock, $ARGV[0], O_RDONLY) or die "open: $!";
      if (flock($lock, LOCK_EX | LOCK_NB)) {
        flock($lock, LOCK_UN) or die "unlock: $!";
        print "clear\n";
      } elsif ($! == EAGAIN || $! == EWOULDBLOCK) {
        print "held\n";
      } else {
        die "flock: $!";
      }
    `, lockPath], { timeout: 1000, maxBuffer: 1024 * 1024 });
    const after = await fs.stat(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return undefined;
    if (stdout.trim() === 'held') return true;
    return stdout.trim() === 'clear' ? false : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Used by Chat admission before server-authorized native queue delegation.
 * Darwin does not expose flock owners through lsof: a held kernel flock plus
 * exactly one open process for the same inode is the conservative attribution.
 * Two unchanged inventories, process/parent identities, executable mappings and
 * file identities are required. Extra open processes or incomplete inspection
 * fail closed. The caller must re-inspect before acting on a retained result.
 */
export async function inspectCodexDesktopOwner(
  nativeId: string,
  codexHome: string,
  dependencies: IdentityDependencies = {},
): Promise<{ pid: number; identity: string; version: string } | null> {
  if ((dependencies.platform ?? process.platform) !== 'darwin'
    || !SAFE_NATIVE_ID.test(nativeId) || nativeId === '.' || nativeId === '..') return null;
  const options = { timeout: 1000, maxBuffer: 1024 * 1024 };
  const execute = dependencies.runFile ?? execFileAsync;
  // Locale warnings would make a complete OS inventory look incomplete. Pin
  // only these bounded probes; leave the server/provider environment unchanged.
  const inspectionEnvironment = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const runFile: NonNullable<IdentityDependencies['runFile']> = async (executable, args, settings) => {
    const result = await execute(executable, args, { ...settings, env: inspectionEnvironment });
    // lsof may return a partial inventory with a successful status. Never
    // infer a unique lock owner from a command that reported an error/warning.
    if (result.stderr?.trim()) throw new Error('Incomplete Desktop owner inspection');
    return result;
  };
  const applicationPath = dependencies.desktopApplicationPath ?? '/Applications/ChatGPT.app';
  const executable = path.join(applicationPath, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const parentExecutable = path.join(applicationPath, 'Contents/MacOS/ChatGPT');
  const plist = path.join(applicationPath, 'Contents/Info.plist');
  try {
    const directory = await fs.realpath(path.join(codexHome, 'thread-writer-locks'));
    const requestedLock = path.join(directory, `${nativeId}.lock`);
    const lockPath = await fs.realpath(requestedLock);
    if (lockPath !== requestedLock) return null;
    const fileIdentity = async (file: string) => {
      if (await fs.realpath(file) !== file) throw new Error('Unexpected Desktop path alias');
      const info = await fs.stat(file);
      if (!info.isFile()) throw new Error('Expected a regular Desktop identity file');
      return { dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs };
    };
    const lockBefore = await fileIdentity(lockPath);
    const held = () => hasHeldCodexThreadLock(nativeId, codexHome, { ...dependencies, runFile });
    if (await held() !== true) return null;
    const records = (stdout: string) => {
      const result: Array<{ pid: number; fd: string; type: string; dev: string; ino: string; name: string }> = [];
      let currentPid = 0;
      let entry: (typeof result)[number] | undefined;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          if (entry) result.push(entry);
          entry = undefined;
          currentPid = /^p[0-9]+$/.test(line) ? Number(line.slice(1)) : 0;
        } else if (line.startsWith('f')) {
          if (entry) result.push(entry);
          entry = { pid: currentPid, fd: line.slice(1), type: '', dev: '', ino: '', name: '' };
        } else if (entry) {
          if (line.startsWith('t')) entry.type = line.slice(1);
          if (line.startsWith('D')) entry.dev = line.slice(1);
          if (line.startsWith('i')) entry.ino = line.slice(1);
          if (line.startsWith('n')) entry.name = line.slice(1);
        }
      }
      if (entry) result.push(entry);
      return result;
    };
    const matchesFile = (entry: ReturnType<typeof records>[number], file: string, identity: { dev: number; ino: number }) => {
      if (entry.type !== 'REG' || entry.name !== file || !/^0x[0-9a-f]+$/i.test(entry.dev)
        || !/^[0-9]+$/.test(entry.ino)) return false;
      return BigInt(entry.dev) === BigInt(identity.dev) && BigInt(entry.ino) === BigInt(identity.ino);
    };
    const inventory = async () => {
      const { stdout } = await runFile('/usr/sbin/lsof', ['-nP', '-F', 'pftDin', lockPath], options);
      const entries = records(stdout);
      if (!entries.length || entries.some((entry) => !Number.isSafeInteger(entry.pid) || entry.pid <= 0
        || !/^[0-9]+$/.test(entry.fd) || !matchesFile(entry, lockPath, lockBefore))) return null;
      const pids = new Set(entries.map((entry) => entry.pid));
      if (pids.size !== 1 || pids.has(process.pid)) return null;
      return { pid: entries[0].pid, key: JSON.stringify(entries.sort((a, b) => a.fd.localeCompare(b.fd))) };
    };
    const firstInventory = await inventory();
    if (!firstInventory) return null;
    const ownerPid = firstInventory.pid;
    const executableBefore = await fileIdentity(executable);
    const parentExecutableBefore = await fileIdentity(parentExecutable);
    const plistBefore = await fileIdentity(plist);
    const mappedExecutable = async (pid: number, expectedPath: string, expectedIdentity: { dev: number; ino: number }) => {
      const { stdout } = await runFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-F', 'pftDin'], options);
      const entries = records(stdout);
      return entries.length > 0 && entries.every((entry) => entry.pid === pid)
        && entries.some((entry) => entry.fd === 'txt' && matchesFile(entry, expectedPath, expectedIdentity));
    };
    const processIdentity = async (pid: number, expectedExecutable: string, expectedFile: { dev: number; ino: number }) => {
      const identity = await runFile('/bin/ps', ['-o', 'ppid=,lstart=', '-p', String(pid)], options);
      const parsed = identity.stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!parsed || Number(parsed[1]) <= 0 || Number(parsed[1]) === pid) return null;
      const command = await runFile('/bin/ps', ['-o', 'comm=', '-p', String(pid)], options);
      if (command.stdout.trim() !== expectedExecutable || !await mappedExecutable(pid, expectedExecutable, expectedFile)) return null;
      return { parentPid: Number(parsed[1]), identity: identity.stdout.trim() };
    };
    const snapshot = async () => {
      const child = await processIdentity(ownerPid, executable, executableBefore);
      if (!child) return null;
      const parent = await processIdentity(child.parentPid, parentExecutable, parentExecutableBefore);
      if (!parent) return null;
      const { stdout } = await runFile('/bin/ps', ['-o', 'args=', '-p', String(ownerPid)], options);
      const command = stdout.trim();
      // This verified Desktop build adds these exact boolean startup overrides.
      // Do not accept general -c options: model/provider or transport overrides
      // would invalidate the capability check for this stdio app-server owner.
      if (!command.startsWith(`${executable} `)) return null;
      const tokens = command.slice(executable.length + 1).split(/\s+/);
      const permittedOverrides = new Set([
        'features.code_mode_host=true',
        'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
      ]);
      const seenOverrides = new Set<string>();
      let appServer = false;
      let analytics = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '-c') {
          const override = tokens[++index];
          if (!permittedOverrides.has(override) || seenOverrides.has(override)) return null;
          seenOverrides.add(override);
        } else if (token === 'app-server' && !appServer) {
          appServer = true;
        } else if (token === '--analytics-default-enabled' && appServer && !analytics) {
          analytics = true;
        } else return null;
      }
      if (!appServer) return null;
      return { child, parent, command };
    };
    const before = await snapshot();
    if (!before) return null;
    const bundle = await runFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], options);
    if (bundle.stdout.trim() !== 'com.openai.codex') return null;
    // The probe target comes from our fixed allowlist, never captured argv or
    // an lsof-reported arbitrary executable. Its mapped inode is checked above.
    const reported = await runFile(executable, ['--version'], options);
    const version = reported.stdout.trim().match(/^codex-cli (0\.169\.0-alpha\.11\.1)$/)?.[1];
    if (!version) return null;
    const after = await snapshot();
    const finalInventory = await inventory();
    if (!after || JSON.stringify(after) !== JSON.stringify(before)
      || !finalInventory || finalInventory.key !== firstInventory.key
      || JSON.stringify(await fileIdentity(lockPath)) !== JSON.stringify(lockBefore)
      || JSON.stringify(await fileIdentity(executable)) !== JSON.stringify(executableBefore)
      || JSON.stringify(await fileIdentity(parentExecutable)) !== JSON.stringify(parentExecutableBefore)
      || JSON.stringify(await fileIdentity(plist)) !== JSON.stringify(plistBefore)
      || await held() !== true) return null;
    return { pid: ownerPid, version, identity: JSON.stringify({ pid: ownerPid, ...before, lock: lockBefore, executable: executableBefore, parentExecutable: parentExecutableBefore, plist: plistBefore }) };
  } catch {
    return null;
  }
}
