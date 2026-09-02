// Client entry for the DSH client module loader (`dsh.client.inject`).
//
// esbuild bundles this to CJS and scripts/build-client.mjs wraps the result in
// `window.__ModuleLoader__.load({ id, factory })`, where the factory supplies
// `module`/`exports`. The loader picks `apply` and `inject` off the returned
// module.exports, so a plain re-export is all that is needed here.
export { apply, inject } from './client/index.js'
