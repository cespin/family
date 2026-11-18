---
name: vite-patterns
description: Vite 8 patterns for the family dashboard frontend, covering vite.config.js, @vitejs/plugin-react, VITE_ environment variables, the Vitest config block, build output, chunking and dev server problems. Use when changing the build, adding a plugin or env var, or debugging HMR, dev server or production bundle issues in frontend/web.
metadata:
  origin: ECC
---

# Vite Patterns

Build tool and dev server patterns for this app. Paths are relative to `frontend/web/`.

## When to Use

- Changing `vite.config.js`
- Adding or reading an environment variable or `.env` file
- Optimizing build output (chunks, minification, assets)
- Troubleshooting dependency pre-bundling or CJS/ESM interop
- Debugging HMR, dev server, or build errors
- Choosing a Vite plugin

## This project

- **Versions:** Vite 8 with `@vitejs/plugin-react` 6, on the Node version in `../../.nvmrc`. With an older Node, `npm run test` can fail at startup with `ERR_REQUIRE_ESM`, so run `nvm use` first.
- **`vite.config.js` is small on purpose:** the React plugin, `build.sourcemap: false`, and a `test` block that configures Vitest.
- **No path aliases.** Imports are relative.
- **No dev proxy and no local backend.** `npm run dev` simulates the session through `VITE_MOCK_SESSION=1` in `.env.development`.
- **Plain JavaScript.** `vite build` has no type-checking step to think about, and `npm run lint` runs oxlint.

## How It Works

- **Dev mode** serves source files as native ESM with no bundling. Transforms happen on demand per module request, which is why cold starts are fast and HMR is precise.
- **Build mode** uses Rolldown to bundle the app for production with tree-shaking, code-splitting, and Oxc-based minification.
- **Dependency pre-bundling** converts CJS/UMD deps to ESM once and caches the result under `node_modules/.vite`, so subsequent starts skip the work.
- **Plugins** share a unified interface across dev and build.
- **Environment variables** are statically inlined at build time. `VITE_`-prefixed vars become public constants in the bundle, and everything unprefixed is invisible to client code.

## Examples

### Config Structure

#### The current config

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The deploy script refuses to publish source maps.
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    include: ['src/**/*.test.{js,jsx}'],
  },
});
```

#### Key Config Options

| Key | Default | Description |
|-----|---------|-------------|
| `root` | `'.'` | Project root (where `index.html` lives) |
| `base` | `'/'` | Public base path for deployed assets |
| `envPrefix` | `'VITE_'` | Prefix for client-exposed env vars. Keep the default |
| `build.outDir` | `'dist'` | Output directory. The deploy script publishes `dist` |
| `build.minify` | `'oxc'` | Minifier for the client build |
| `build.sourcemap` | `false` | Must stay `false` here |

### Plugins

`@vitejs/plugin-react` provides Fast Refresh and the automatic JSX runtime. Version 6 does not depend on Babel. Babel-based transforms need the optional `@rolldown/plugin-babel` peer, so don't assume a `babel` option works without checking the plugin's README in `node_modules/@vitejs/plugin-react/`.

Add a plugin only for a real need. Useful ones if that need arrives:

| Plugin | Purpose | When to use |
|--------|---------|-------------|
| `rollup-plugin-visualizer` | Bundle treemap report | Periodic bundle size audits |
| `vite-plugin-pwa` | PWA + Workbox | If the dashboard must work offline |

A plugin that injects inline scripts or loads third-party resources will conflict with the Content Security Policy in `../../backend/templates/hosting/stack.yaml`.

#### Authoring Custom Plugins

Authoring is rare. When you do need one, start inline in `vite.config.js` and only extract if reused.

```javascript
// vite.config.js: minimal inline plugin
function myPlugin() {
  return {
    name: 'my-plugin',                        // required, must be unique
    enforce: 'pre',                           // 'pre' | 'post' (optional)
    apply: 'build',                           // 'build' | 'serve' (optional)
    transform(code, id) {
      if (!id.endsWith('.custom')) return;
      return { code: transformCustom(code), map: null };
    },
  };
}
```

**Key hooks:** `transform` (modify source), `resolveId` + `load` (virtual modules), `transformIndexHtml` (inject into HTML), `configureServer` (add dev middleware), `hotUpdate` (custom HMR).

For the full plugin API, see [vite.dev/guide/api-plugin](https://vite.dev/guide/api-plugin).

### HMR API

`@vitejs/plugin-react` handles HMR for components. Reach for `import.meta.hot` directly only in a non-component module that must keep state across updates.

```javascript
if (import.meta.hot) {
  // Persist state across updates (must MUTATE, never reassign .data)
  import.meta.hot.data.count = import.meta.hot.data.count ?? 0;

  // Cleanup side effects before module is replaced
  import.meta.hot.dispose((data) => clearInterval(data.intervalId));

  // Accept this module's own updates
  import.meta.hot.accept();
}
```

Fast Refresh only preserves state when a file exports components alone, and oxlint warns about a violation through `react/only-export-components`. `src/hooks/SessionProvider.jsx` exports only the provider, while the context and hook live in `src/hooks/useSession.js`.

### Environment Variables

Vite loads `.env`, `.env.local`, `.env.[mode]`, and `.env.[mode].local` in that order (later overrides earlier).

| Variable | Set by | Purpose |
|---|---|---|
| `VITE_COGNITO_DOMAIN` | The deploy script, from stack exports | Cognito OAuth host |
| `VITE_COGNITO_CLIENT_ID` | The deploy script, from stack exports | Public OAuth client ID |
| `VITE_MOCK_SESSION` | `.env.development` | Simulated session, honored only when `import.meta.env.DEV` is true |

`.env.example` documents the local overrides.

The root `../../.gitignore` covers `.env` and `.env.local` but not `.env.[mode].local`. Use `.env.local` for personal overrides so a mode-specific file is never committed by accident.

#### Client-Side Access

Only `VITE_`-prefixed vars are exposed to client code:

```javascript
import.meta.env.VITE_COGNITO_DOMAIN  // string
import.meta.env.MODE                 // 'development' | 'production' | custom
import.meta.env.BASE_URL             // base config value
import.meta.env.DEV                  // boolean
import.meta.env.PROD                 // boolean
```

#### Using Env in Config

```javascript
// vite.config.js
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());  // VITE_ prefixed only (safe)
  return { /* ... */ };
});
```

### Security

#### `VITE_` Prefix is NOT a Security Boundary

Any variable prefixed with `VITE_` is **statically inlined into the client bundle at build time**. Minification, base64 encoding, and disabling source maps do NOT hide it.

**Rule:** Only public values go in `VITE_` vars. Secrets live server-side, behind the API.

Staged builds are unlisted rather than access-controlled, so family data must never be baked into a build.

#### The `loadEnv('')` Trap

```javascript
// BAD: passing '' as the third arg loads ALL env vars, including server secrets,
// and makes them available to inline into client code via `define`.
const env = loadEnv(mode, process.cwd(), '');

// GOOD: the default prefix, or an explicit list
const env = loadEnv(mode, process.cwd(), ['VITE_']);
```

#### Source Maps in Production

Production source maps publish your original source code. `build.sourcemap` stays `false`, and `.claude/skills/frontend-deploy/scripts/deploy.sh` stops the deploy if `dist` contains a `.map` file.

### Build Optimization

#### Manual Chunks

The build config defines no manual chunks. Measure before adding any.

```javascript
// vite.config.js: build.rolldownOptions
build: {
  rolldownOptions: {
    output: {
      manualChunks(id) {
        if (id.includes('node_modules/react')) return 'react-vendor';
      },
    },
  },
}
```

#### Files in `public/`

Files in `public/` are copied to the site root. The CloudFront function in `../../backend/templates/hosting/stack.yaml` only serves root files listed in `STATIC_ROOT_FILES`, so a new file in `public/` must be added there too, or it serves `index.html`.

### Performance

#### Keep Barrel Files Small

A barrel file forces Vite to load every re-exported file even when you import a single symbol. `src/components/ui/index.js` is the app's one barrel. Each component there imports its own stylesheet, so everything exported from it loads together. Keep it to shared primitives, and don't add barrels for screens or modules.

#### Be Explicit with Import Extensions

Each implicit extension costs extra filesystem checks. The app writes extensions on file imports (`'../hooks/useSession.js'`). The directory import of `'../components/ui'` is the only exception.

#### Profiling Slow Dev Servers

When `vite dev` feels slow, start the dev server with its built-in Node.js inspector (see `vite --help`), interact with the app, then press `p+enter` to save a `.cpuprofile`. Load it in [Speedscope](https://www.speedscope.app) to find which plugins are taking the time.

### Dependency Pre-Bundling

```javascript
// vite.config.js: optimizeDeps
optimizeDeps: {
  include: ['cjs-package'],                   // CJS deps that cause interop issues
  exclude: ['local-esm-package'],             // must be valid ESM if excluded
  force: true,                                // ignore cache, re-optimize (temporary debugging)
}
```

### Common Pitfalls

#### Dev Does Not Match Build

CJS libraries can behave differently between the dev server and the production bundle. Verify with `npm run build && npm run preview` before deploying.

The mock session also hides real sign-in in dev. Anything touching auth needs a staged build to be tested for real.

#### Stale Chunks After Deployment

New builds produce new chunk hashes. The deploy script prunes old files when it publishes, and a missing file under `/assets/` deliberately fails instead of returning `index.html`. The app has no `lazy()` imports today, so this cannot bite yet. If you add one, catch the dynamic import failure and offer a reload.

### Anti-Patterns

```javascript
// BAD: Setting envPrefix to '' exposes ALL env vars (including secrets) to the client
envPrefix: ''

// BAD: Assuming require() works in application source code. Vite is ESM-first
const lib = require('some-lib')                // use import instead

// BAD: Splitting every node_module into its own chunk creates hundreds of tiny files
manualChunks(id) {
  if (id.includes('node_modules')) {
    return id.split('node_modules/')[1].split('/')[0]   // one chunk per package
  }
}

// BAD: Mutating import.meta.hot.data by reassignment
import.meta.hot.data = { count: 0 }           // WRONG: must mutate properties, not reassign
import.meta.hot.data.count = 0                // CORRECT

// BAD: Turning on production source maps
build: { sourcemap: true }                    // the deploy script refuses this build
```

**Process anti-patterns:**

- **`vite preview` is NOT a production server.** It is a smoke test for the built bundle.
- **Leaving stale `node_modules/.vite` after dep changes.** The pre-bundle cache causes phantom errors. Clear it when switching branches or after patching deps.

## Quick Reference

| Pattern | When to Use |
|---------|-------------|
| `defineConfig` | Always |
| `loadEnv(mode, root, ['VITE_'])` | Access env vars in config (explicit prefix) |
| `optimizeDeps.include` | CJS deps causing interop issues |
| `manualChunks` | Vendor bundle splitting, after measuring |
| The dev server's inspector option (`vite --help`) | Debug slow dev server |
| `npm run build && npm run preview` | Smoke-test the production bundle locally |

## Related

- The `react-patterns` skill for component patterns
- The `frontend-deploy` skill for staging and promoting a build
