import { defineConfig } from 'tsdown'

/** Host packages the Harness supplies; bundled copies would create a second service instance. */
const HOST_EXTERNAL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-storage-domain',
]

/**
 * Browser platform module table, reproduced from the shipped client build.
 * These must stay as `require(...)` calls so the Module Loader resolves the
 * single shared instance the page already holds.
 */
const CLIENT_PLATFORM = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    clean: true,
    deps: { neverBundle: HOST_EXTERNAL },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: { neverBundle: CLIENT_PLATFORM },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-mate", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
