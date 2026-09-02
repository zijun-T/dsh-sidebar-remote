#!/usr/bin/env node
// Build client bundle: bundle src/client.ts → lib/client.js wrapped in __ModuleLoader__.load()
import { build } from 'esbuild';
import { writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// scripts/shim-os.mjs needs a home directory to derive the placeholder root
// from, and a browser has none. It used to hardcode one, which silently broke
// every deployment whose HOME differed from the build author's. Inject it here
// instead so the fallback tracks the building machine and no source edit is
// needed per deployment. It is only a fallback: at runtime the client asks the
// host for the authoritative root (/sidebar/remote/root) and that answer wins.
// Override with DSH_BUILD_HOME when cross-building for a known target.
const buildHome = process.env.DSH_BUILD_HOME || homedir();

// Step 1: Bundle client code with esbuild (CJS format)
const result = await build({
  entryPoints: [resolve(root, 'src/client.ts')],
  bundle: true,
  format: 'cjs',  // CommonJS format
  platform: 'browser',
  target: 'es2022',
  write: false,
  alias: {
    'node:path': resolve(root, 'scripts/shim-path.mjs'),
    'node:os': resolve(root, 'scripts/shim-os.mjs'),
  },
  inject: [resolve(root, 'scripts/inject-buffer.mjs')],
  define: {
    'process.env': '{}',
    '__DSH_BUILD_HOME__': JSON.stringify(buildHome),
  },
  logLevel: 'info',
});

const bundledCode = result.outputFiles[0].text;

// Step 2: Wrap CJS bundle with __ModuleLoader__.load()
// The id DSH registers the client module under is the package name (mirrored by
// `export const name` in src/host/index.ts). Read it instead of hardcoding so a
// rename cannot leave the bundle registered under a stale id.
const pluginId = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name;

// For CJS format, esbuild outputs:
// "use strict";
// ... helpers ...
// ... code ...
// module.exports = { apply, inject };
// or exports.apply = apply; exports.inject = inject;

// We need to wrap this in a factory function that provides module/exports
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pluginId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${bundledCode.split('\n').map(l => '\t' + l).join('\n')}
\t\treturn module.exports;
\t}
});
`;

// Step 3: Write to lib/client.js
const outPath = resolve(root, 'lib/client.js');
writeFileSync(outPath, wrapped, 'utf-8');
console.log(`✓ Client bundle written to lib/client.js (${wrapped.length} bytes)`);
console.log(`  fallback home baked in: ${buildHome}${process.env.DSH_BUILD_HOME ? ' (from DSH_BUILD_HOME)' : ' (from os.homedir())'}`);
console.log('  runtime root comes from GET /sidebar/remote/root — the baked-in value is only a fallback');
