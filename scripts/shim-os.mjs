// Browser shim for node:os — only homedir() is used, by
// @dsh-ssh/dsh-ssh/src/router.js when it derives the placeholder root:
//   remoteRoot(env) = DSH_SSH_REMOTE_ROOT > $DSH_HOME/remote > homedir()/.dsh/remote
//
// This value is injected at build time by scripts/build-client.mjs (esbuild
// `define`), so it tracks the machine that ran the build instead of being
// hand-edited per deployment. It is a FALLBACK only. At runtime the client asks
// the host for the authoritative root (GET /sidebar/remote/root) and feeds it
// back through the `env` parameter routeByCwd() already accepts; because
// DSH_SSH_REMOTE_ROOT has top precedence, that answer overrides this shim
// entirely. A bundle served by a machine other than the one that built it
// therefore still routes correctly.
//
// The typeof guard is deliberate: if the bundle is ever produced without the
// define, a bare identifier reference would throw at module scope and take the
// whole plugin down. Degrading to '/' merely makes routeByCwd() answer 'local',
// which the root-independent tail check in shared/router.ts then corrects.
export function homedir() {
  return typeof __DSH_BUILD_HOME__ !== 'undefined' ? __DSH_BUILD_HOME__ : '/';
}
export default { homedir };
