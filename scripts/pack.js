// Build the Chrome extension zip via an explicit allowlist.
//
// web-ext's --ignore-files is a deny-list, so any new file added to the repo
// root (NOTICE.md, .editorconfig, …) would silently leak into the bundle
// until someone updated the list. We instead stage exactly the files that
// belong in the extension into ./dist and point web-ext at that directory.
// Any new file added to the repo root has to be explicitly added to
// EXTENSION_FILES below to ship.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXTENSION_FILES = ['manifest.json', 'content.js'];
const STAGE_DIR = path.resolve(__dirname, '..', 'dist');
const ARTIFACTS_DIR = path.resolve(__dirname, '..', 'web-ext-artifacts');
const REPO_ROOT = path.resolve(__dirname, '..');

fs.rmSync(STAGE_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGE_DIR, { recursive: true });

for (const f of EXTENSION_FILES) {
  const src = path.join(REPO_ROOT, f);
  const dst = path.join(STAGE_DIR, f);
  fs.copyFileSync(src, dst);
  console.log(`staged ${f}`);
}

const result = spawnSync(
  'npx',
  [
    '--yes',
    'web-ext',
    'build',
    '--source-dir', STAGE_DIR,
    '--artifacts-dir', ARTIFACTS_DIR,
    '--overwrite-dest',
  ],
  { stdio: 'inherit', cwd: REPO_ROOT },
);

process.exit(result.status ?? 1);
