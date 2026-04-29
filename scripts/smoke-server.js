// Boot score-server.js with a stub LLM, exercise the auth flow, exit 0/1.
// CI smoke test — runs in extras.yml and locally via `npm run smoke`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = '7780';
const TOKEN = 'smoketok';

// `fs.mkdtempSync` atomically creates a unique directory in /tmp owned only
// by us, so writing the stub inside it is not vulnerable to a TOCTOU /
// symlink-swap attack on a predictable temp path.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkshit-smoke-'));
const stubPath = path.join(stubDir, 'stub-claude.sh');
fs.writeFileSync(
  stubPath,
  '#!/bin/bash\necho \'[{"id":1,"score":5,"reason":"stub"}]\'\n',
  { mode: 0o755 },
);

// Use `process.execPath` (the absolute path of the node binary running this
// script) instead of relying on $PATH lookup for "node". Avoids the security
// rule about world-writable PATH directories shadowing a known command.
const proc = spawn(
  process.execPath,
  ['score-server.js'],
  {
    env: { ...process.env, LINKSHIT_TOKEN: TOKEN, PORT, CLAUDE_BIN: stubPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(__dirname, '..'),
  },
);

let serverOut = '';
let serverErr = '';
proc.stdout.on('data', d => { serverOut += d; });
proc.stderr.on('data', d => { serverErr += d; });

const cleanup = () => {
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* already gone */ }
};

// Sonar S5145 (log injection) on the two server-output lines is a false
// positive here: this is a CI smoke script printing a child process's own
// stdout/stderr to the runner's stderr for diagnostic purposes — there is
// no log-analyzer downstream that could be fooled by CRLF injection.
const fail = msg => {
  console.error('SMOKE FAIL:', msg); // NOSONAR
  if (serverOut) console.error('--- server stdout ---\n' + serverOut); // NOSONAR
  if (serverErr) console.error('--- server stderr ---\n' + serverErr); // NOSONAR
  cleanup();
  process.exit(1);
};

const waitListen = async () => {
  for (let i = 0; i < 50; i++) {
    if (serverOut.includes('Linkshit score server')) return;
    await new Promise(r => setTimeout(r, 100));
  }
  fail('server did not start within 5s');
};

const post = (token) => fetch(`http://127.0.0.1:${PORT}/score`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { 'x-linkshit-token': token } : {}),
  },
  body: JSON.stringify({
    criteria: 'smoke',
    posts: [{ author: 'A', text: 'hello hello hello hello hello hello', reactions: 0 }],
  }),
});

const checks = async () => {
  await waitListen();

  const r1 = await post(null);
  if (r1.status !== 401) fail(`no-token: expected 401, got ${r1.status}`);

  const r2 = await post('wrong');
  if (r2.status !== 401) fail(`wrong-token: expected 401, got ${r2.status}`);

  const r3 = await post(TOKEN);
  if (r3.status !== 200) {
    const body = await r3.text();
    fail(`valid-token: expected 200, got ${r3.status}: ${body}`);
  }
  const body = await r3.json();
  if (!Array.isArray(body) || body.length !== 1 || body[0].id !== 1) {
    fail(`valid-token: unexpected body: ${JSON.stringify(body)}`);
  }

  const r4 = await fetch(`http://127.0.0.1:${PORT}/score`, { method: 'OPTIONS' });
  if (r4.status !== 200) fail(`OPTIONS: expected 200, got ${r4.status}`);
  const allow = r4.headers.get('access-control-allow-headers') || '';
  if (!allow.toLowerCase().includes('x-linkshit-token')) {
    fail(`OPTIONS: missing x-linkshit-token in Allow-Headers: ${allow}`);
  }

  console.log('SMOKE OK: 4/4 assertions passed');
  cleanup();
  process.exit(0);
};

checks().catch(e => fail(e.message ?? String(e)));
