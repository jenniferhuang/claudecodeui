# Fork tarball releases

This fork publishes `@cloudcli-ai/cloudcli` as an installable `.tgz` attached to
[jenniferhuang/claudecodeui releases](https://github.com/jenniferhuang/claudecodeui/releases).
It does not publish to the npm registry. Use **Fork Tarball Release**, not the
upstream **Release** workflow. The inherited npm, desktop, Docker and Discord
publisher jobs run only in `siteboon/claudecodeui`.

`Fork Quality` runs backend tests, frontend tests, typecheck, lint, build, release
safeguard tests, package inspection and isolated production installation on
Ubuntu 22.04 and macOS 15 (Apple Silicon) with Node.js 22. The installed CLI must report the fork
version and print help; the installed Codex SDK must import and resolve a
Codex executable whose `--version` matches the lockfile. Both Codex packages must match the versions recorded in the source lockfile. The Linux
package plus a provenance manifest and SHA-256 checksums are retained for 14 days.
No service is started by the installation smoke test. Backend test concurrency is
bounded to four and frontend workers to two; both commands run the full suites.

## Publish

1. Merge and test the desired PRs. Commit a unique fork version in both
   `package.json` and `package-lock.json`, including `packages[""].version`.
   The initial fork version is `1.37.8-jh.1`; future releases increment the
   `-jh.N` suffix. Preserve the package name.
2. Wait for **Fork Quality** on `main` to pass. Copy the exact 40-character main
   commit SHA from GitHub. In Actions, select **Fork Tarball Release**, **Run
   workflow**, branch **main**, and paste that SHA as `expected_sha`.
   CLI equivalent:

   ```sh
   gh workflow run fork-release.yml --repo jenniferhuang/claudecodeui \
     --ref main -f expected_sha=REPLACE_WITH_REVIEWED_40_CHARACTER_MAIN_SHA
   ```

3. The release workflow checks that main still equals that SHA and that the
   version's tag/release are unused, repeats the full Ubuntu/macOS quality gate,
   and downloads only the Linux artifact produced by this run. Only the final
   publication job has `contents: write`, through its normal `GITHUB_TOKEN`.
   No PAT, npm token, OIDC permission or repository secret is needed.
4. Publication verifies package/version/SDK/commit provenance and checksums,
   checks main and collisions again, atomically creates a tag at the tested SHA,
   stages the three assets in a draft, then verifies main/tag once more before
   publishing a prerelease. It never overwrites tags, releases or assets. The
   manifest records exact commit, declared and locked Codex versions, toolchain,
   archive digest and workflow run.

The operator needs permission to dispatch workflows; repository Actions must be
enabled and allow `GITHUB_TOKEN` contents writes for the publication job. The
workflow's default token permissions remain read-only. If desired, configure a
repository ruleset to prevent humans from moving/deleting `v*-jh.*` tags and
enable GitHub immutable releases; the workflow itself never updates them.

## Verify and install

Download all three release assets into the same directory, then verify:

```sh
sha256sum -c SHA256SUMS  # macOS: shasum -a 256 -c SHA256SUMS
npm install -g ./cloudcli-ai-cloudcli-1.37.8-jh.1.tgz
cloudcli --version
```

For direct installation or updates from an explicit release URL:

```sh
npm install -g https://github.com/jenniferhuang/claudecodeui/releases/download/v1.37.8-jh.1/cloudcli-ai-cloudcli-1.37.8-jh.1.tgz
```

For an isolated installation that can coexist with the current global package:

```sh
npm install --prefix "$HOME/.local/cloudcli-fork" https://github.com/jenniferhuang/claudecodeui/releases/download/v1.37.8-jh.1/cloudcli-ai-cloudcli-1.37.8-jh.1.tgz
"$HOME/.local/cloudcli-fork/node_modules/.bin/cloudcli" --version
```

Use the explicit future fork release URL for updates too. Do not use
`cloudcli update` or the UI's official npm Update button for this fork. The inherited CLI's `update`
command checks the upstream npm package and does not select these fork releases.
The tarball preserves the original CLI name and package name, so installing it
globally replaces another global installation of that same package.

## Failed or interrupted publication

A failed upload or main/tag changing during publication leaves the release as a
draft and may leave its newly created tag. Inspect the run, draft and tag before
recovery. The workflow deliberately refuses to resume or overwrite a partial
release. Prefer committing a fresh `-jh.N` version and dispatching its reviewed
main SHA; remove abandoned drafts/tags only after an operator audits them.
Transient API failures, authorization failures and rate limits fail closed.
Do not rerun a successful release or expect a tag/release collision to be reused.

Publishing a GitHub Release does not deploy, install or restart the current service.
