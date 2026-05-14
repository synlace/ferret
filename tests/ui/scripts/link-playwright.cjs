/**
 * link-playwright.cjs — postinstall script
 *
 * Resolves the @playwright/test package from the system `playwright` binary
 * and creates symlinks in node_modules so ESM imports resolve to the same
 * instance as the runner.
 *
 * Why this is needed:
 *   - The project uses "type": "module" so spec files use ESM `import`.
 *   - ESM resolution ignores NODE_PATH; it only walks node_modules directories.
 *   - On NixOS, `playwright` is installed system-wide (not in node_modules).
 *   - Installing @playwright/test locally creates a second instance, causing
 *     "Playwright Test did not expect test() to be called here" errors and
 *     browser binary path mismatches.
 *   - Symlinking the system packages into node_modules ensures a single instance.
 *
 * Environments:
 *   - NixOS (native): resolves from the `playwright` binary on PATH.
 *   - Docker (mcr.microsoft.com/playwright): resolves from /ms-playwright-agent
 *     or falls back to installing @playwright/test normally via npm.
 *   - CI / other: falls back to npm install of @playwright/test.
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const nodeModules = path.resolve(__dirname, '../node_modules');

// Packages to symlink from the system playwright installation
const PACKAGES = [
  { scope: '@playwright', name: 'test', dir: '@playwright/test' },
  { scope: null,          name: 'playwright',      dir: 'playwright' },
  { scope: null,          name: 'playwright-core',  dir: 'playwright-core' },
];

/**
 * Try to find the system playwright node_modules root.
 * Returns the path if found, null otherwise.
 */
function findSystemPlaywrightRoot() {
  // Strategy 1: resolve from the `playwright` binary on PATH
  try {
    const bin = execSync('which playwright 2>/dev/null', { encoding: 'utf8' }).trim();
    if (bin) {
      const root = path.resolve(bin, '../../lib/node_modules');
      if (fs.existsSync(path.join(root, '@playwright', 'test'))) {
        return root;
      }
    }
  } catch (_) { /* not on PATH */ }

  // Strategy 2: Docker Playwright image — packages live at /ms-playwright-agent
  const dockerPaths = [
    '/ms-playwright-agent/node_modules',
    '/usr/local/lib/node_modules',
  ];
  for (const p of dockerPaths) {
    if (fs.existsSync(path.join(p, '@playwright', 'test'))) {
      return p;
    }
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const systemRoot = findSystemPlaywrightRoot();

if (systemRoot) {
  console.log(`[link-playwright] Symlinking Playwright packages from: ${systemRoot}`);

  for (const pkg of PACKAGES) {
    const src = path.join(systemRoot, pkg.dir);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ Source not found, skipping: ${src}`);
      continue;
    }

    let linkPath;
    if (pkg.scope) {
      const scopeDir = path.join(nodeModules, pkg.scope);
      fs.mkdirSync(scopeDir, { recursive: true });
      linkPath = path.join(scopeDir, pkg.name);
    } else {
      linkPath = path.join(nodeModules, pkg.name);
    }

    try {
      // lstatSync throws if path doesn't exist — that's fine
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch (_) { /* doesn't exist yet */ }

    fs.symlinkSync(src, linkPath);
    console.log(`  ✓ node_modules/${pkg.dir} → ${src}`);
  }

  console.log('[link-playwright] Done.');
} else {
  // Fallback: install @playwright/test from npm.
  // This happens in environments where playwright is not pre-installed
  // (e.g. bare CI runners). The version must match the runner binary.
  console.log('[link-playwright] System playwright not found — installing @playwright/test from npm...');
  const result = spawnSync(
    'npm', ['install', '--no-save', '@playwright/test@1.56.1'],
    { stdio: 'inherit', cwd: path.resolve(__dirname, '..') },
  );
  if (result.status !== 0) {
    console.error('[link-playwright] npm install failed.');
    process.exit(result.status ?? 1);
  }
}
