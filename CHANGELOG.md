# Changelog

All notable changes to this package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-09-02

First release intended to be installable from a tarball or registry on a machine
other than the one it was built on. `0.1.0` was an internal baseline that was
never published; it worked only when the DSH host's `HOME` happened to match the
value hardcoded into the browser shim.

### Added

- **Placeholder-root discovery.** New host endpoint `GET /sidebar/remote/root`
  returns the authoritative `remoteRoot(process.env)`. The client probes it once
  at mount, through the *original* `fetch`, and feeds the answer back via the
  `env` parameter `routeByCwd()` already accepts. Because `DSH_SSH_REMOTE_ROOT`
  has top precedence in `remoteRoot()`, the host's answer overrides the
  build-time shim entirely, so one bundle now serves any deployment.
- **`routeByPlaceholderTail()`** in `src/shared/router.ts` — root-independent
  recognition of the `<hostId>/<base64url(absolute path)>` placeholder shape.
  A `WebSocket` constructor is synchronous and cannot await the probe, so a
  terminal tab restored during boot would otherwise connect to the local
  terminal and render the empty placeholder directory. The check is a fallback
  only: once the authoritative root is known it is switched off, which keeps the
  local-zero-regression guarantee exact.
- **First-paint sequencing.** `patchedFetch` awaits discovery (bounded at
  1500 ms) for `/sidebar/*` requests that carry a `cwd`, so early requests route
  on the authoritative root instead of the build-time guess. Placed after the
  route exclusions so the probe can never wait on itself.
- **Graceful degradation.** A host that does not serve the endpoint (404) or a
  failed probe logs a warning, settles immediately, schedules one un-awaited
  retry, and routing continues off the shape check. The sidebar is never
  stalled by discovery.
- `LICENSE` file, matching the `MIT` declaration that `package.json` already
  carried. Its absence was a real compliance gap and npm warns about it.
- `.gitignore`, `CHANGELOG.md`.
- `keywords`, `author`, `repository`/`homepage`/`bugs`, and
  `sideEffects: ["./lib/client.js"]` (the client bundle calls
  `window.__ModuleLoader__.load()` at module scope, so it is genuinely
  side-effecting and must not be tree-shaken away).
- `publishConfig.access = "public"` was added while the package was still
  scoped, then **removed** as part of the rename: on an unscoped package it is a
  no-op, and leaving it in would imply the package is still scoped.
- 13 tests: cross-`HOME` placeholder detection, probe sequencing, the
  authoritative root suppressing the fallback, WebSocket routing while the probe
  is still in flight, and 404 degradation. Suite is now 79 tests / 11 suites.

### Changed

- **Renamed from `@remote/sidebar-remote` to `dsh-sidebar-remote`.** The `@remote`
  scope was a placeholder: publishing a scoped package requires owning that npm
  org, which would have made the first release fail with 404/402. Dropping the
  scope removes the blocker entirely. Neither name was ever published, so no
  installed deployment carries the old one.

  This is not a metadata-only change. The string is also the DSH plugin id
  (`export const name` in `src/host/index.ts`), so it determines the client
  bundle path `/plugins/<id>/client.js` and the boot-manifest `id`. Upgrading
  therefore requires both profile entries to be renamed in lockstep —
  `dependencies` **and** `dsh.profile.bundles` — plus a DSH web restart;
  otherwise the old bundle path 404s. `cordis.patch.yml`'s `id: remote-sidebar`
  is the patch layer's own alias, unrelated to the package name, and did not
  change. `scripts/build-client.mjs` and `scripts/verify-live.mjs` now derive
  the id from `package.json#name` instead of hardcoding it, so a future rename
  cannot silently leave a stale bundle path behind.
- **`scripts/shim-os.mjs` no longer hardcodes a home directory.** `homedir()`
  now returns `__DSH_BUILD_HOME__`, injected by `scripts/build-client.mjs` via
  esbuild `define` from `os.homedir()` at build time (override with
  `DSH_BUILD_HOME` when cross-building for a known target). Migrating to another
  machine no longer requires editing a source file. The build now logs the value
  it baked in.
- `src/types.d.ts`: the upstream `env` parameters are typed
  `Record<string, string | undefined>` rather than `Record<string, string>`, so
  `process.env` is assignable without a cast. Its index signature carries
  `undefined`, and the upstream implementation only truthiness-checks the keys.
- `files` now ships `src/`, `scripts/`, `test/`, `docs/` and `tsconfig.json`
  alongside `lib/`, so the package is auditable, rebuildable for a different
  `DSH_BUILD_HOME`, and self-verifying — `npm test` runs against the packed
  `lib/` with no devDependencies required.
- `prepack` invokes `tsc` and `node scripts/build-client.mjs` directly instead
  of `pnpm build`, so packing works under any package manager. Added `prepare`
  for the same reason, which also makes a git-URL install build itself.
- **Repository sanitised before going public.** Real infrastructure details in
  `docs/` and in the test fixtures were replaced with placeholders: two private
  IPs, an internal server label and its non-standard SSH port, the real host UUID
  from `~/.dsh/settings.yaml`, the remote account and home directory, the build
  machine's home, and filenames that disclosed the author's research workflow.
  No credentials were ever present — nothing here was a secret, but all of it was
  real. IPs now come from the RFC 5737 documentation range (`198.51.100.0/24`)
  and the UUID is an obviously synthetic value that still satisfies
  `isValidHostId`. One consequence worth knowing: the `scripts/verify-live.mjs`
  defaults are placeholders too, so a live run needs `DSH_HOST_ID` and
  `DSH_REMOTE_PATH` (optionally `DSH_ORIGIN` / `DSH_EXPECT_ENTRY`) pointed at a
  real host. Recorded in `docs/delivery.md` §7.

### Fixed

Seven defects that made a remote SSH session render local placeholder content.
All were invisible to the previous suites because each sat at a seam — between
the Node and browser halves, or between this package and the *other* copy of
`@dsh-ssh/dsh-ssh` that the DSH profile loads.

| Layer | Symptom | Root cause |
|-------|---------|------------|
| client bundle | `routeByCwd()` always returned `local` in the browser, so nothing was ever rewritten | The `buffer@6.0.3` polyfill has no `base64url` encoding; `decodeRemotePath()` threw, the throw was swallowed, and every placeholder decoded to `null`. Handled now by a dependency-free `base64url` implementation in `scripts/inject-buffer.mjs`. |
| client | Requests fired before the session was hydrated could not be routed | `cwdOfSessionId()` returned `null` with no fallback; now falls back to the `cwd` already on the wire (query string or JSON body). |
| shared/router | File tree permanently empty, SSH answered "No such file" | Upstream `resolveRemotePath()` guards with `rel !== ''`, which drops the exact-root case — `posix.relative(p, p)` is `''`. The sidebar asks for exactly that when rendering the tree root. |
| host | Every remote terminal died with `conn.shell is not a function` (WS close 1011) | ESM double-copy hazard: `sshPool` is created by the profile's copy of `@dsh-ssh/dsh-ssh`, a distinct module instance, so the prototype patch landed on ours and never reached the pooled connections. `ensureShellOnConn()` now installs `shell()` on the live connection at the single choke point every remote route funnels through. |
| host | Every directory in the tree rendered as a file | Type hints were read from SFTP `.filename` / `.longname`, but the `ExecFs` fallback (SFTP disabled) yields `{name, type}`. Both backends are now handled. |
| host | Terminal filled with JSON garbage and ignored every keypress | Wire protocol mismatch. `dsh-better-sidebar`'s view does `term.write(event.data)` on raw text and only uses JSON for `resize`/`close`/`park`; this package wrapped everything in a `{type:'data'}` envelope, and sent `tabId` where the protocol says `tab`. |
| host | `pty.close` returned 404 | The method was not dispatched. It now short-circuits without acquiring a connection. |

- `GET /sidebar/remote/address` accepts a `cwd` override, consistent with
  `/sidebar/remote/file` and the git endpoint. The session registry is populated
  lazily, so a probe fired before hydration 404'd even though the caller already
  knew the cwd.

## 0.1.0 - unreleased

Internal baseline. Aggregated `dsh-better-sidebar@0.17.1` and
`@dsh-ssh/dsh-ssh@0.1.3` behind a single installable package using controlled
inlining, because neither upstream exposes an `fsProvider` / `ptyProvider`
extension point (see `docs/architecture.md` §2.1). Not published: the browser
half hardcoded a home directory, so it silently misrouted on any host whose
`HOME` differed.
