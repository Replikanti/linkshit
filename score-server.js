// Tiny localhost bridge between the Chrome extension and an LLM.
//
// Why exists: LinkedIn's CSP blocks `connect-src` from the page context, so
// the extension cannot call the LLM directly. The extension POSTs batches of
// posts to this server, which forwards them to the LLM and returns scores.
//
// Default backend: Claude Code CLI (`claude -p`). When you are signed into
// Claude Code with a Pro/Max OAuth account, calls draw from your subscription
// quota rather than from API tokens. To use a different backend, replace the
// body of runLLM() — that is the only swap point.

const http = require('http');
const { spawn } = require('child_process');

const PORT = 7777;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'haiku';

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST' || req.url !== '/score') {
    res.writeHead(404);
    return res.end();
  }

  let body = '';
  req.on('data', c => (body += c));
  req.on('end', async () => {
    try {
      const { criteria, posts } = JSON.parse(body);
      if (!Array.isArray(posts) || posts.length === 0) {
        throw new Error('posts must be a non-empty array');
      }
      const prompt = buildPrompt(criteria, posts);
      const out = await runLLM(prompt);
      const arr = parseJsonArray(out);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(arr));
    } catch (e) {
      console.error('[Linkshit]', e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(PORT, '127.0.0.1', () =>
  console.log(`Linkshit score server on http://127.0.0.1:${PORT} (model=${MODEL})`)
);

function buildPrompt(criteria, posts) {
  const list = posts
    .map((p, i) =>
      `[${i + 1}] Author: ${p.author}${p.subtitle ? ' (' + p.subtitle + ')' : ''}\n` +
      `Reactions: ${p.reactions}\n` +
      `Text: ${(p.text || '').slice(0, 1500)}`
    )
    .join('\n\n---\n\n');

  return `You are scoring LinkedIn posts.

RELEVANCE CRITERIA:
${criteria}

For each numbered post below, output one JSON object:
{ "id": <number>, "score": <0-10>, "reason": "<short English sentence>" }

Respond with ONLY a JSON array, one object per post, in input order. No prose, no markdown fences.

POSTS:

${list}`;
}

// Swap point. Replace the body to use any other LLM backend.
//
// Examples:
//   - Anthropic API (per-token billing):
//       POST https://api.anthropic.com/v1/messages with x-api-key header.
//   - Ollama (local, free, private):
//       POST http://localhost:11434/api/generate
//   - OpenAI:
//       POST https://api.openai.com/v1/chat/completions
//
// Contract: takes a single string prompt, returns a string containing a
// JSON array somewhere in the response. parseJsonArray() will extract it.
function runLLM(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'text'];
    if (MODEL) args.push('--model', MODEL);
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', c => (out += c));
    proc.stderr.on('data', c => (err += c));
    proc.on('error', reject);
    proc.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `claude exit ${code}`))
    );
  });
}

function parseJsonArray(txt) {
  const m = txt.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in LLM output: ' + txt.slice(0, 200));
  return JSON.parse(m[0]);
}
