import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_NATIVE_ID = /^[a-zA-Z0-9_.\-:]+$/;

// Darwin's setuid /bin/ps cannot execute inside Seatbelt. This fixed system-Perl
// probe reads BSD identity, the kernel executable path and exactly argc arguments through native kernel
// calls; environment bytes from KERN_PROCARGS2 are never decoded or returned.
const DARWIN_PROCESS_IDENTITY_PROBE = String.raw`
  use strict; use warnings; use JSON::PP;
  my ($pid) = ($ARGV[0] // '') =~ /\A([1-9][0-9]*)\z/;
  die "invalid pid\n" unless defined($pid) && $pid <= 2147483647;
  die "unsupported native word size\n" unless length(pack('J',0)) == 8 && length(pack('L',0)) == 4;
  my $bsd = "\0" x 136;
  my $n = syscall(336,2,0+$pid,3,0,$bsd,136);
  die "proc_info failed\n" unless $n == 136;
  my @b = unpack('L12a16a32L6Q2',$bsd);
  die "invalid identity\n" unless $b[3] == $pid && $b[4] > 0 && $b[4] != $pid && $b[20] > 0 && $b[21] < 1000000;
  my $pathbuf = "\0" x 4096;
  $n = syscall(336,2,0+$pid,11,0,$pathbuf,4096);
  my $pathend = index($pathbuf,"\0");
  die "kernel executable failed\n" unless $n == 0 && $pathend > 0 && $pathend < 4096;
  my $executable = substr($pathbuf,0,$pathend);
  die "invalid kernel executable\n" unless substr($executable,0,1) eq '/';
  my $mib = pack('i3',1,49,0+$pid);
  my $length = pack('J',0);
  $n = syscall(202,$mib,3,0,$length,0,0);
  my $capacity = unpack('J',$length);
  die "args size failed\n" unless $n == 0 && $capacity >= 6 && $capacity <= 2097152;
  my $buf = "\0" x $capacity;
  $n = syscall(202,$mib,3,$buf,$length,0,0);
  my $actual = unpack('J',$length);
  die "args read failed\n" unless $n == 0 && $actual >= 6 && $actual <= $capacity;
  $buf = substr($buf,0,$actual);
  my $argc = unpack('i',substr($buf,0,4));
  die "invalid argc\n" unless $argc >= 1 && $argc <= 256;
  my $end = index($buf,"\0",4);
  die "invalid executable\n" unless $end > 4 && $end < $actual;
  my $saved_executable = substr($buf,4,$end-4);
  die "executable identity changed\n" unless $saved_executable eq $executable;
  my $off = $end + 1;
  $off++ while $off < $actual && substr($buf,$off,1) eq "\0";
  my @argv;
  for (1..$argc) {
    my $tail = index($buf,"\0",$off);
    die "truncated argv\n" if $tail < $off || $tail >= $actual;
    push @argv, substr($buf,$off,$tail-$off);
    $off = $tail + 1;
  }
  die "empty argv0\n" unless length($argv[0]);
  print JSON::PP->new->ascii->encode({pid=>0+$pid,parentPid=>$b[4],startSeconds=>$b[20],startMicroseconds=>$b[21],executable=>$executable,argv=>\@argv}),"\n";
`;

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
  const inspectionEnvironment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  // Taint mode also ignores Perl injection variables; clear them explicitly so
  // these fixed native probes never load a caller-supplied startup module.
  for (const key of Object.keys(inspectionEnvironment)) {
    if (key.startsWith('PERL')) delete inspectionEnvironment[key];
  }
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
      const { stdout } = await runFile('/usr/bin/perl', ['-T', '-e', DARWIN_PROCESS_IDENTITY_PROBE, String(pid)], options);
      const parsed: unknown = JSON.parse(stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (Object.keys(record).sort().join(',') !== 'argv,executable,parentPid,pid,startMicroseconds,startSeconds'
        || record.pid !== pid || !Number.isSafeInteger(record.parentPid) || Number(record.parentPid) <= 0
        || Number(record.parentPid) > 2147483647 || record.parentPid === pid
        || !Number.isSafeInteger(record.startSeconds) || Number(record.startSeconds) <= 0
        || !Number.isSafeInteger(record.startMicroseconds) || Number(record.startMicroseconds) < 0
        || Number(record.startMicroseconds) >= 1000000 || record.executable !== expectedExecutable
        || !Array.isArray(record.argv) || record.argv.length < 1 || record.argv.length > 256
        || record.argv[0] !== expectedExecutable
        || record.argv.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 2097152)
        || !await mappedExecutable(pid, expectedExecutable, expectedFile)) return null;
      return {
        pid, parentPid: Number(record.parentPid), startSeconds: Number(record.startSeconds),
        startMicroseconds: Number(record.startMicroseconds), executable: expectedExecutable, argv: record.argv as string[],
      };
    };
    const snapshot = async () => {
      const child = await processIdentity(ownerPid, executable, executableBefore);
      if (!child) return null;
      const parent = await processIdentity(child.parentPid, parentExecutable, parentExecutableBefore);
      if (!parent) return null;
      // This verified Desktop build adds these exact boolean startup overrides.
      // Native argv boundaries are retained: never split a rendered command or
      // accept general -c model/provider/transport options for this known owner.
      const tokens = child.argv.slice(1);
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
      return { child, parent };
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
