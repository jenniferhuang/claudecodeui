import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_NATIVE_ID = /^[a-zA-Z0-9_.\-:]+$/;

type IdentityDependencies = {
  platform?: NodeJS.Platform;
  runFile?: (executable: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
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
 * Only an open regular descriptor for this exact canonical native lock is busy;
 * an absent file is clear, and unsupported/failed inspection remains unknown.
 * This never acquires the lock or infers ownership from an unrelated thread.
 */
export async function hasOpenCodexThreadLock(
  nativeId: string,
  codexHome: string,
  dependencies: IdentityDependencies = {},
): Promise<boolean | undefined> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return undefined;
  if (!SAFE_NATIVE_ID.test(nativeId) || nativeId === '.' || nativeId === '..') return undefined;
  const runFile = dependencies.runFile ?? execFileAsync;
  try {
    const lockPath = await fs.realpath(path.join(codexHome, 'thread-writer-locks', `${nativeId}.lock`));
    const before = await fs.stat(lockPath);
    if (!before.isFile()) return undefined;
    let stdout: string;
    try {
      ({ stdout } = await runFile(platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
        ['-nP', '-F', 'pftn', lockPath], { timeout: 1000, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      if (failure.code === 1 && !failure.stdout && !failure.stderr) return false;
      return undefined;
    }
    const after = await fs.stat(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return undefined;
    let processFound = false;
    let type = '';
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) { processFound = /^p[0-9]+$/.test(line); type = ''; }
      else if (line.startsWith('f')) type = '';
      else if (line.startsWith('t')) type = line.slice(1);
      else if (processFound && type === 'REG' && line === `n${lockPath}`) return true;
    }
    return stdout.trim() && !processFound ? undefined : false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
}
