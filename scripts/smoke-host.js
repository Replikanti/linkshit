// Native messaging smoke test for host.js.
//
// Drives host.js the way Chrome would: spawn it as a subprocess, write
// length-prefixed JSON messages to its stdin, read length-prefixed JSON
// from its stdout. Stubs `claude` so the test doesn't depend on the user
// being logged in to Claude Code or having network access.
//
// Asserts the four behaviors of the native messaging plumbing that we
// most want to keep working:
//   1. happy-path scoring round-trip
//   2. unknown message type is reported via {ok:false,error}
//   3. missing posts is reported via {ok:false,error}
//   4. malformed JSON inside a frame is reported via {ok:false,error}
//      (not silently dropped — the bug fixed during PR-A's QA round)
//
// Runs in the `score-server smoke test` job in extras.yml on every PR
// and push to main, and locally via `npm run smoke`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST_PATH = path.resolve(__dirname, '..', 'host.js');

// Atomically create a temp dir owned only by us, then drop a stub `claude`
// inside. Avoids the TOCTOU pitfall flagged by CodeQL on the previous
// smoke script (which used a predictable os.tmpdir() + pid path).
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkshit-host-smoke-'));
const stubPath = path.join(stubDir, 'claude');
fs.writeFileSync(
  stubPath,
  '#!/bin/bash\necho \'[{"id":1,"score":7,"reason":"stub-ok"}]\'\n',
  { mode: 0o755 },
);

const proc = spawn(process.execPath, [HOST_PATH], {
  env: { ...process.env, CLAUDE_BIN: stubPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
proc.stderr.on('data', c => { stderr += c; });

const cleanup = () => {
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* already gone */ }
};

const fail = msg => {
  console.error('SMOKE FAIL:', msg);                // NOSONAR — diagnostic stderr from a CI test, no log-injection downstream
  if (stderr) console.error('--- host stderr ---\n' + stderr);   // NOSONAR
  cleanup();
  process.exit(1);
};

// Read length-prefixed frames from host stdout.
let inboundBuf = Buffer.alloc(0);
let pendingResolve = null;

proc.stdout.on('data', chunk => {
  inboundBuf = Buffer.concat([inboundBuf, chunk]);
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    r();
  }
});

async function readFrame() {
  while (true) {
    if (inboundBuf.length >= 4) {
      const expected = inboundBuf.readUInt32LE(0);
      if (inboundBuf.length >= 4 + expected) {
        const json = inboundBuf.subarray(4, 4 + expected).toString('utf8');
        inboundBuf = inboundBuf.subarray(4 + expected);
        return JSON.parse(json);
      }
    }
    await new Promise(resolve => { pendingResolve = resolve; });
  }
}

function sendFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  proc.stdin.write(Buffer.concat([len, data]));
}

function sendRawFrame(bodyBytes) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bodyBytes.length, 0);
  proc.stdin.write(Buffer.concat([len, bodyBytes]));
}

async function checks() {
  // 1. happy-path
  sendFrame({
    type: 'score',
    criteria: 'smoke',
    posts: [{ author: 'A', text: 'hello hello hello hello hello hello', reactions: 0 }],
  });
  const r1 = await readFrame();
  if (!r1.ok) fail(`happy-path: expected ok=true, got ${JSON.stringify(r1)}`);
  if (!Array.isArray(r1.result) || r1.result[0]?.id !== 1) {
    fail(`happy-path: bad result shape: ${JSON.stringify(r1)}`);
  }

  // 2. unknown message type
  sendFrame({ type: 'bogus' });
  const r2 = await readFrame();
  if (r2.ok || !r2.error?.includes('unknown message type')) {
    fail(`unknown-type: expected error envelope, got ${JSON.stringify(r2)}`);
  }

  // 3. missing posts
  sendFrame({ type: 'score', criteria: 'x' });
  const r3 = await readFrame();
  if (r3.ok || !r3.error?.includes('non-empty array')) {
    fail(`missing-posts: expected error envelope, got ${JSON.stringify(r3)}`);
  }

  // 4. malformed JSON inside a frame
  sendRawFrame(Buffer.from('{not valid json', 'utf8'));
  const r4 = await readFrame();
  if (r4.ok || !r4.error?.includes('malformed JSON')) {
    fail(`malformed-json: expected error envelope, got ${JSON.stringify(r4)}`);
  }

  console.log('SMOKE OK: 4/4 assertions passed');
  cleanup();
  process.exit(0);
}

const watchdog = setTimeout(() => fail('test timeout (10 s)'), 10000);

checks()
  .catch(e => fail(e.message ?? String(e)))
  .finally(() => clearTimeout(watchdog));
