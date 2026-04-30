# Linkshit

[![CI](https://github.com/Replikanti/linkshit/actions/workflows/ci.yml/badge.svg)](https://github.com/Replikanti/linkshit/actions/workflows/ci.yml)

> Your LinkedIn feed is shit. Linkshit reads it for you.

Auto-scrolls your LinkedIn feed, extracts every post that loads, scores each
one against criteria you define, and surfaces only the posts worth your time
in a side panel. Built for users with thousands of connections whose feed
takes hours to skim manually.

The default backend is **Claude Code CLI**, so scoring runs against your
Claude Pro/Max subscription (no API tokens, no per-call cost). Replace one
function in `host.js` and you can point it at the Anthropic API, Ollama, or
anything else.

> **Heads-up.** A non-technical one-click installer is in the oven (issue
> [#10](https://github.com/Replikanti/linkshit/issues/10), shipping with
> v0.2.0). Until then the setup below is developer-grade — you write the
> Chrome native messaging manifest once by hand.

## How it works

```mermaid
flowchart TD
    subgraph Browser["Browser (your logged-in Chrome)"]
        Ext["Chrome MV3 extension<br/>auto-scroll · capture · dedupe<br/>pre-filter · render hits"]
        BG["background service worker<br/>chrome.runtime.connectNative"]
    end
    subgraph Local["Localhost (no port, no server)"]
        Host["host.js<br/>spawned by Chrome on demand<br/>runLLM() swap point"]
        CC["Claude Code CLI<br/>claude -p"]
    end
    Anthropic[("Anthropic<br/>Pro/Max account")]

    Ext -->|"chrome.runtime.sendMessage"| BG
    BG -->|"native messaging<br/>(stdin/stdout JSON)"| Host
    Host -->|"spawns"| CC
    CC -->|"OAuth"| Anthropic
```

Three pieces:

1. **Chrome MV3 extension** (`manifest.json`, `content.js`, `background.js`)
   — loaded unpacked. The content script runs the panel on
   `linkedin.com/feed/*`; the background service worker bridges to the
   native messaging host.
2. **Native messaging host** (`host.js`) — a Node script that Chrome
   spawns on demand when the extension opens a `connectNative` port and
   tears down when the connection closes. Speaks length-prefixed JSON
   over stdin/stdout. Holds the `runLLM()` swap point.
3. **Native messaging manifest** — a small JSON file at an OS-specific
   path that tells Chrome where `host.js` is and which extension is
   allowed to call it.

There is no localhost HTTP server, no auth token, no port to manage. Chrome
authenticates the connection by extension ID (stabilized via the `key` field
in `manifest.json`).

## Prerequisites

- **Node.js 22+** (the host runs on Node, ships with no runtime deps).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** installed
  and signed in with a Pro or Max account (`claude` once interactively to
  complete the OAuth login).
- **Google Chrome** (or Chromium-based browser with MV3 support).

## Setup (manual, until v0.2.0 ships an installer)

### 1. Clone the repo and install dev tooling

```bash
git clone git@github.com:Replikanti/linkshit.git
cd linkshit
npm install
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this repository's directory

The extension's ID is pinned via `manifest.json`'s `key` field, so it is
stable across reloads: **`pgcnimcldmdfkemofhjfnemieckciche`**. The native
messaging manifest references this exact ID.

### 3. Register the native messaging host

Pick the path for your OS:

- **Linux:** `~/.config/google-chrome/NativeMessagingHosts/com.replikanti.linkshit.json`
- **macOS:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.replikanti.linkshit.json`
- **Windows:** registered via a registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.replikanti.linkshit` (see [Chrome docs](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging))

Write this JSON (replacing `/full/path/to/host.js` with the absolute path
to `host.js` in your clone):

```json
{
  "name": "com.replikanti.linkshit",
  "description": "Linkshit native messaging host",
  "path": "/full/path/to/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://pgcnimcldmdfkemofhjfnemieckciche/"
  ]
}
```

Make sure `host.js` is executable (`chmod +x host.js` after clone — git
should preserve the bit).

### 4. Configure and run

Visit `linkedin.com/feed`. A panel appears in the upper right. Click **⚙**:

| Setting | What it does |
|---|---|
| **Criteria** | Free-text description of what's relevant. Sent to the LLM. The more specific, the better the scores. |
| **Pre-filter keywords** | Comma-separated. Only posts containing at least one keyword get scored. Empty = score everything (expensive in subscription quota). |
| **Author allowlist** | Comma-separated substrings. Matching authors always pass pre-filter regardless of keywords. |
| **Min reactions** | Skip posts with fewer reactions than this. |
| **Score threshold** | 0–10. Posts at or above this score show up in the panel. |
| **Scroll delay min/max ms** | Random jitter between scroll ticks. 3000–6000ms is conservative. |
| **Batch size** | Posts per LLM call. Higher = fewer messages = saves quota, but longer per-batch latency. |
| **Max posts per session** | Safety stop. |

Click **Save**, then **Start**. Counters update live; hits stream into the
panel sorted by score.

## Cost / quota

| Backend | Marginal cost per session (~1500 posts, ~38 batches) |
|---|---|
| Claude Pro/Max via Claude Code (default) | $0, but ~38 messages of quota |
| Anthropic API key (swap-in) | ~$0.30–0.80 with Haiku |
| Local Ollama (swap-in) | $0 |

Pro plan's ~45 messages / 5h window is borderline for one daily session. On
Max, you're fine. If you're on Pro and you hit limits, increase batch size
to 15–20 or tighten the pre-filter.

## Swap the backend

`host.js` exposes a single function called `runLLM(prompt)`. Replace its
body to use any backend.

**Anthropic API** (per-token billing, no Claude Code dependency):

```javascript
async function runLLM(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.content[0].text;
}
```

**Ollama** (local, free, private):

```javascript
async function runLLM(prompt) {
  const r = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.1:8b', prompt, stream: false }),
  });
  const j = await r.json();
  return j.response;
}
```

The browser-side code never changes.

## Risks

- **LinkedIn ToS.** Automated interaction with LinkedIn is against their
  ToS. Conservative pacing (3–6 s delays, ≤1500 posts per run, daytime use,
  in a real logged-in browser) is in the range that typically doesn't trip
  detection — but no guarantees. An account with thousands of connections
  is irreplaceable. Don't run this 24/7 or in headless Chrome.
- **Selector drift.** LinkedIn redesigns its feed periodically. If the
  `captured` counter stays at 0, open DevTools, find the new CSS class
  names, and update `extractPost()` in `content.js`. The current targets
  are documented in a comment there.
- **No secret in the browser.** Native messaging is authenticated by
  extension ID, not by a shared secret. The `key` field in `manifest.json`
  pins the extension ID; the native host's `allowed_origins` whitelists
  exactly that ID. No token to leak, nothing in `localStorage` worth
  stealing.
- **Prompt injection from post text.** Each batch wraps its posts in
  `<post-NONCE id="N">…</post-NONCE>` tags using a per-call random hex
  nonce, so a poster cannot synthesize a valid closing tag to break out
  and inject a fake post into the prompt. The LLM is also told to treat
  in-post text as untrusted data and ignore in-post instructions. Both
  the structural fence and the behavioral mitigation would have to fail
  for scoring to be biased. Residual risk is "the LLM follows in-post
  instructions despite being told not to" — worst case the panel shows
  off-topic posts at high scores, which a human reader catches in
  seconds. UX issue, not a security one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Panel never appears | Extension not loaded, or you're on a non-`www` LinkedIn subdomain. Check `chrome://extensions`. Reload the LinkedIn tab. |
| `captured` stuck at 0 | Selector drift. See Risks. |
| `Error: native host disconnected before responding (is it installed?)` | Chrome can't find `host.js`. The native messaging manifest is missing, or its `path` is wrong. Re-check step 3 of Setup. |
| `Error: failed to connect to native host: …` | Same family — manifest exists but Chrome rejected it. Often the `allowed_origins` doesn't list the right extension ID. Confirm the extension ID at `chrome://extensions` matches `pgcnimcldmdfkemofhjfnemieckciche`. |
| `Error: claude exit …` | `claude` not in PATH or not logged in. Run `claude` manually first. |
| Quota exhausted mid-session | See Cost / quota. |
| `Error: claude exit 1` with no stderr | Try `CLAUDE_MODEL=sonnet` — `haiku` may not be available on your plan. Set the env var in the wrapper that invokes the host (see installer in PR-B). |

## Files

- `manifest.json` — Chrome MV3 extension manifest, with `key` field pinning the extension ID
- `content.js` — extension content script (UI + scroll + extract + dedupe)
- `background.js` — service worker bridging content script to native messaging host
- `host.js` — Node native messaging host; `runLLM()` is the swap point
- `package.json` — Node metadata (runtime has no deps; dev tooling only)
- `eslint.config.mjs` — ESLint flat config
- `.github/workflows/ci.yml` — CI pipeline (validate / check / lint / pack)
- `.github/workflows/extras.yml` — extras (audit / web-ext lint / link check / smoke)
- `.github/workflows/codeql.yml` — CodeQL static analysis

## Development

```bash
npm install        # installs dev tooling (eslint, web-ext)
npm run check      # node --check on the JS files
npm run validate   # JSON files parse
npm run lint       # eslint
npm run pack       # builds web-ext-artifacts/linkshit-<version>.zip
```

CI runs check / validate / lint / pack on every push and PR.

## License

MIT — see [LICENSE](./LICENSE).
