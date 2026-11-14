# Server-owned local filesystem permissions

CloudCLI can apply a persistent macOS filesystem policy to its server process and
all child processes. This covers agent commands, the terminal, Git operations,
plugins, and server filesystem operations. It is an optional restriction on the
host process, independent of the agent permission dropdown.

The dropdown still controls agent tool approvals. It cannot grant filesystem
access beyond the server's policy, including when a session selects bypass mode.
Normal macOS file permissions and privacy controls still apply to reads.

## Configure once on this Mac

With no policy file, CloudCLI keeps its existing behavior. To enable the policy,
create `~/.config/cloudcli/filesystem-policy.json` outside your editable projects.
The following example allows edits in `.hermes` and `Projects/Integrates` and
allows reviewing other local folders. Both writable directories must already
exist.

Run this from your normal terminal, outside CloudCLI's restricted terminal:

```sh
node --input-type=module <<'NODE'
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const configDirectory = path.join(homedir(), '.config', 'cloudcli');
await mkdir(configDirectory, { recursive: true, mode: 0o700 });
const configPath = path.join(configDirectory, 'filesystem-policy.json');
await writeFile(configPath, JSON.stringify({
  version: 1,
  writableRoots: [
    path.join(homedir(), '.hermes'),
    path.join(homedir(), 'Projects', 'Integrates'),
  ],
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(configPath);
NODE
```

The example refuses to overwrite an existing policy. Edit that file using your
normal local editor if it already exists. To use another policy location, set
`CLOUDCLI_FILESYSTEM_POLICY` to its absolute path in the server's launch
environment. An explicitly configured missing or malformed policy fails startup;
CloudCLI does not silently drop the restriction. Configured policies on
unsupported platforms also fail startup rather than run unconfined.

Start or restart CloudCLI normally after changing the policy. The server resolves
symlinks before comparing roots, and writes through a symlink cannot escape the
allowed locations. Existing folders outside the roots can be opened as review
projects; saving, creating, renaming, deleting, and uploading files there is
rejected. Folder creation and cloning still require a writable location.

## Runtime state and agent compatibility

CloudCLI and its providers must continue writing their own databases, session
records, logs, authentication refresh records, and caches. The generated macOS
profile includes the operational locations used by CloudCLI, Codex, Claude,
Cursor, and OpenCode. These are exceptions for application state, separate from
the editable project roots. Temporary and cache files use a private runtime
directory. The policy configuration and generated profile must remain outside
editable project roots.

The filesystem restriction is inherited by children and remains in force when
an agent uses its own bypass mode. macOS does not permit applying a second
Seatbelt sandbox inside an existing one. CloudCLI therefore makes its Codex and
Claude launch options compatible with the inherited policy instead of nesting
their filesystem sandboxes. Codex side questions retain their instructions and
external-tool exclusions, and share the server's outer filesystem boundary.

This policy controls local filesystem writes by CloudCLI processes. It does not
change permissions for your desktop Codex app or normal terminal, and does not
change the authorization of remote services or connected applications.
Managed mode blocks delegation through launchd jobs, LaunchServices app launches,
and AppleEvents. Normal child commands still run inside the inherited policy.
If provider authentication needs to open an external desktop browser, complete
that sign-in from your normal terminal or browser instead.

## Reinstalls and fork releases

The policy lives outside the installed npm package. A release containing this
implementation reads the same policy on startup, so replacing or upgrading the
package on the same Mac does not require re-entering folder grants or reapplying
local source patches. An existing LaunchAgent may still point to an older pinned
installation; update its executable path when switching installations.

If this Mac uses an earlier custom `cloudcli-restricted-env` wrapper, migrate its
folder grants into the JSON policy once and launch the new CLI directly from the
service. Do not stack the older sandbox wrapper around the new automatic
bootstrap. An inherited sandbox that does not match the saved policy is rejected
instead of silently accepting a different boundary. Keep the old installation
and its configuration available until the replacement has passed its checks.

Keep this source change in your fork and its release builds. Installing an older
release or an unpatched upstream package does not add this feature. Another Mac
needs its own policy with paths that exist there. Back up the policy with your
other host configuration, and rerun read/write checks after changing roots or
upgrading the runtime.
