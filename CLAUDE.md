# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that auto-scrolls LinkedIn's feed, scores posts against
user-defined criteria via an LLM, and surfaces the hits in a side panel. Default
LLM backend is the Claude Code CLI (`claude -p`) over the user's Pro/Max
subscription — there are no API keys in the box.

The runtime ships with **zero npm dependencies**; everything in `package.json`'s
`devDependencies` is tooling. Don't add runtime deps without a strong reason —
the install story (drop `host.js` into `~/.linkshit/`) only works because there
is no `node_modules/` to ship.

## Architecture

Three pieces, three trust boundaries:

1. **Content script** (`content.js`, ~420 lines, IIFE): runs on
   `linkedin.com/feed/*`. Owns the panel UI, scroll loop, post extraction, the
   pre-filter (keywords / author allowlist / min reactions), the dedupe via
   IndexedDB (`linkshit` DB, `posts` store, keyed by `urn`), and config
   persistence in `localStorage` under the `linkshit.` prefix. Cannot call
   `chrome.runtime.connectNative` — content scripts don't get native messaging.
2. **Background service worker** (`background.js`): the bridge. Receives
   `{type: 'score', criteria, posts}` over `chrome.runtime.sendMessage`, opens a
   short-lived `connectNative('com.replikanti.linkshit')` port for each batch,
   relays the response back. That's the only thing it does.
3. **Native messaging host** (`host.js`): a Node script Chrome spawns on
   demand. Speaks length-prefixed JSON over stdin/stdout (4-byte LE uint32
   length, then UTF-8 JSON). Builds the prompt, runs `runLLM()`, parses the
   result, replies. **`runLLM()` is the only swap point** for switching backends
   — the prompt builder and JSON-array parser stay put.

There is no localhost server, no port, no auth token. Chrome authenticates the
native host by **extension ID**, which is pinned via `manifest.json`'s `key`
field (always `pgcnimcldmdfkemofhjfnemieckciche`). The native messaging
manifest's `allowed_origins` whitelists exactly that ID. If you regenerate the
key, the manifest must be re-registered.

### Prompt-injection fence

`buildPrompt()` wraps each post in `<post-${nonce} id="N">…</post-${nonce}>`
with a per-call random hex nonce. A poster cannot synthesize a closing tag they
don't know the nonce for, so they cannot break out of their own post. The LLM is
also told to treat in-post text as untrusted data. Both layers (structural
fence + behavioral instruction) must hold for scoring to be honest. **Don't
remove the nonce when refactoring the prompt.**

### Stdin framing in `host.js`

`readMessage()` keeps a module-level `inboundBuf` so a single stdin chunk that
spans frames (or stops mid-frame) reassembles correctly. The parallel
implementation in `scripts/smoke-host.js` mirrors this layout — keep them in
sync if you change the framing.

## Common commands

```bash
npm install        # devDependencies only — runtime ships with none
npm run check      # node --check on host.js / content.js / background.js
npm run validate   # JSON parse on manifest.json + package.json
npm run lint       # eslint flat config (per-file env: browser/sw/node)
npm run pack       # build dist/ then web-ext build → web-ext-artifacts/*.zip
npm run smoke      # drive host.js through the native messaging protocol with a stubbed `claude`
npm run audit      # npm audit --audit-level=high
```

CI (`ci.yml`) runs check / validate / lint / pack on every push and PR. Extras
(`extras.yml`) runs audit, web-ext lint, link check, shellcheck, and the
native-host smoke test. CodeQL runs separately.

There is no test runner / framework. The smoke test in `scripts/smoke-host.js`
**is** the host's test suite — four assertions over the native messaging
plumbing. Add cases there when you change `host.js`.

## Build / pack

`scripts/pack.js` is an **allowlist**, not a deny-list. The `EXTENSION_FILES`
constant declares exactly the files that get staged into `dist/` and zipped.
This is deliberate — `web-ext --ignore-files` is a deny-list, and any new file
in the repo root would silently leak into the bundle until someone updated the
ignore list. **If you add a new file that belongs in the extension (e.g.
`popup.html`, an icon), add it to `EXTENSION_FILES` in `scripts/pack.js`.**

## Release

Triggered by pushing a `v*` tag. `.github/workflows/release.yml`:

1. `npm run pack` → `web-ext-artifacts/linkshit-extension-vX.Y.Z.zip`.
2. Base64-encodes `host.js` and substitutes it into `installers/install.sh` in
   place of the literal placeholder `__HOST_JS_BASE64__`.
3. Attaches the zip, raw `host.js`, and the patched `install.sh` to a GitHub
   Release.

The substitution detection in `install.sh` uses **length** of
`LINKSHIT_HOST_JS_BASE64` (threshold 200), not string equality with the
placeholder, because the release `sed` would otherwise rewrite the literal in
the comparison itself and the test would always be true. Don't "simplify" that
to an `==` check.

## Backend swap

Replace the body of `runLLM(prompt)` in `host.js`. Examples for Anthropic API
and Ollama are in `README.md` — keep that section current if you alter the
function signature. The browser side never changes.

Two env vars affect the default Claude Code backend:
- `CLAUDE_BIN` — path to the `claude` binary (default: `claude` from PATH).
- `CLAUDE_MODEL` — model passed to `claude --model` (default: `haiku`).

## Selector drift

LinkedIn redesigns its feed periodically. The post extractor lives in
`extractPost()` inside `content.js`; the current CSS selectors are documented
in a comment there. If the extension's `captured` counter sits at 0 in the
panel, that is the symptom and that is the place to look.

## Platform support

Linux and macOS only. Windows is intentionally not supported and the installer
exits early on non-Linux/Darwin `uname`. Keep that explicit if you touch
`installers/install.sh`.

## Working in this repo

### Language

Chat with the maintainer is in Czech. **Everything written into the repo —
code, comments, commit messages, PR titles/bodies, issue text — is in
English.** No mixing.

### This is a public repo

The repository is open-source under MIT and lives at
`github.com/Replikanti/linkshit`. Anything you put into a PR body, an issue
comment, a release note, or a CI log can be read by anyone. Do not leak:

- Absolute home-directory paths from local clones.
- Names or paths of unrelated private projects on the same machine.
- Any internal tooling references that aren't relevant to linkshit itself.

When pasting test output or stack traces into PRs/issues, scrub local paths
first.

### Branching and worktrees

For any non-trivial fix or feature, create a worktree rather than working
in-place on a possibly dirty `main`:

```bash
git worktree add worktrees/<branch-name>
```

Trivial typo / one-liner fixes can go straight on a branch. The line is "would
I be sad if `main` was dirty when I started this?"

### Plan-first for issue-tracked work

Anything that has an open GitHub issue gets a short plan posted as an issue
comment **before** any code is written, even when the scope feels small. The
plan doesn't have to be long — bullet points with the intended files,
behaviour change, and test surface is enough. Skip this only for releases /
version bumps and trivial untracked fixes.

Before spawning a planner or starting work on an issue, **verify it's still
fresh**: `state == OPEN`, no `closedByPullRequestsReferences`, and quickly grep
recent main commits for the keyword. This codebase ships fast — scope can get
shipped in parallel and an "open" issue can already be done.

### PR workflow

After an implementation PR is opened:

1. Wait for CI to go green.
2. Run a substantive QA pass on the PR (manual exercise of the changed code +
   regression check on the golden path). For QA findings tables in PR
   comments, use ✅ / ⚠️ / ❌ emoji in the Result column and on the verdict —
   plain "pass"/"fail" text doesn't render distinctively in the GitHub UI.
3. **Do not merge.** Post the QA report as a PR comment and stop. The
   maintainer merges manually, even on green CI + ship-it.
4. When fixing a QA finding, **edit the original QA comment** to flip the
   relevant row (via `gh api -X PATCH .../comments/<id>`); don't post a
   follow-up "fixed it" comment.

Version-bump PRs (touching only `package.json` / `manifest.json` / CLAUDE.md
/ similar metadata, no code change) skip the QA pass — green CI is enough.

#### Issue references in PR bodies

GitHub's auto-close parser does not understand negation. Writing `does not
fix #N` will close issue N when the PR merges. Use `does NOT address #N` or
`out of scope for #N` instead — anything that doesn't begin with a closing
keyword.

### Releases

When a version-bump PR merges, **tag immediately**:

```bash
git tag vX.Y.Z <merge-sha> -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Pushing the tag is what triggers `release.yml` to build and publish the GitHub
Release with the extension zip, raw `host.js`, and the patched `install.sh`. A
release without a pushed tag is not a release.

### Long-running local processes

If you ever need to spawn a long-running process from a Claude Code shell
(local dev server, watcher), prefix it with `setsid` rather than relying on
`nohup` + `disown`. Backgrounded processes without `setsid` get killed when
the shell tool times out.

