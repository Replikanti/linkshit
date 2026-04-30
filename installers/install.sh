#!/usr/bin/env bash
# Linkshit installer for Linux and macOS.
#
# What it does:
#   1. Verifies Node.js 22+ is installed.
#   2. Installs the @anthropic-ai/claude-code CLI globally (needed for the
#      Pro/Max subscription path).
#   3. Drops host.js into ~/.linkshit/ and makes it executable.
#   4. Writes the Chrome native messaging manifest into the OS-specific
#      directory so Chrome knows how to spawn the host.
#
# After this script finishes, the only manual step left is loading the
# extension zip in chrome://extensions (developer mode → Load unpacked).
# See README "Quick Start" for that bit.
#
# When this script is published as a release asset by .github/workflows/release.yml,
# the LINKSHIT_HOST_JS_BASE64 line below is rewritten to embed the actual
# host.js inline. Running the unmodified template here in the repo falls
# back to downloading host.js from the latest GitHub release.

set -euo pipefail

# ---------- Constants ----------
readonly EXT_ID="pgcnimcldmdfkemofhjfnemieckciche"
readonly HOST_NAME="com.replikanti.linkshit"
readonly INSTALL_DIR="${HOME}/.linkshit"
readonly HOST_PATH="${INSTALL_DIR}/host.js"
readonly LINKSHIT_VERSION="${LINKSHIT_VERSION:-latest}"

# Substituted at release time. Until then, this stays as the literal
# placeholder string so we know to fall back to a network download.
readonly LINKSHIT_HOST_JS_BASE64="__HOST_JS_BASE64__"

# ---------- OS / browser detection ----------
case "$(uname -s)" in
  Linux*)
    NM_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"
    ;;
  Darwin*)
    NM_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  *)
    echo "ERROR: unsupported OS: $(uname -s)" >&2
    echo "       This installer supports Linux and macOS." >&2
    echo "       Windows is not supported." >&2
    exit 1
    ;;
esac

# ---------- Banner ----------
cat <<'EOF'
==============================================================
  Linkshit — non-technical installer
==============================================================
EOF

# ---------- Step 1: Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  cat <<EOF >&2
ERROR: Node.js is not installed.

Install Node.js 22 or later from https://nodejs.org and re-run this
script. On macOS you can also install with Homebrew (\`brew install node\`),
on Linux with your distro package manager (\`apt install nodejs\` etc.) or
via nvm (https://github.com/nvm-sh/nvm).
EOF
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "${NODE_MAJOR}" -lt 22 ]; then
  cat <<EOF >&2
ERROR: Node.js ${NODE_MAJOR} is too old. Linkshit requires Node 22+.
Found: $(node -v).
EOF
  exit 1
fi
echo "✓ Node.js $(node -v)"

# ---------- Step 2: Claude Code CLI ----------
if ! command -v claude >/dev/null 2>&1; then
  echo
  echo "Claude Code CLI is not installed. Installing globally via npm..."
  npm install -g @anthropic-ai/claude-code
  echo
fi
echo "✓ Claude Code: $(claude --version 2>/dev/null || echo installed)"

# ---------- Step 3: Confirm OAuth login ----------
cat <<EOF

Linkshit needs your Claude Code account to be already logged in
(Pro or Max subscription — there are no API tokens involved).

If you have not logged in yet:
  1. Open a new terminal window
  2. Run:    claude
  3. Complete the sign-in flow that opens in your browser
  4. Type    /exit    to leave the chat
  5. Come back here

EOF
# Tolerate EOF (Ctrl-D, or `bash install.sh </dev/null`) so `set -e` doesn't
# kill the script with no message; treat silent stdin as "no".
read -r -p "Are you already logged in to Claude Code? [y/N] " logged_in || logged_in=""
case "${logged_in}" in
  [Yy]*) ;;
  *)
    echo "OK — log in first, then re-run this installer."
    exit 0
    ;;
esac

# ---------- Step 4: Install host.js ----------
echo
echo "Installing host.js into ${INSTALL_DIR}/ ..."
mkdir -p "${INSTALL_DIR}"

# Template-vs-released detection by length, not by string equality with the
# placeholder. The release workflow's `sed` replaces every occurrence of
# __HOST_JS_BASE64__ — if we used a string-equality test, the comparison
# literal here would be substituted too and the test would always be true,
# defeating the whole point of embedding. A real base64 of host.js is a
# few thousand chars; the unsubstituted placeholder is 21. 200 is a safe
# middle threshold.
if [ "${#LINKSHIT_HOST_JS_BASE64}" -lt 200 ]; then
  # Template form (running from a clone of the repo, before release): pull
  # host.js over the network from the latest release.
  if [ "${LINKSHIT_VERSION}" = "latest" ]; then
    URL="https://github.com/Replikanti/linkshit/releases/latest/download/host.js"
  else
    URL="https://github.com/Replikanti/linkshit/releases/download/${LINKSHIT_VERSION}/host.js"
  fi
  echo "  fetching ${URL}"
  if ! curl -fSL -o "${HOST_PATH}" "${URL}"; then
    cat <<EOF >&2

ERROR: failed to download host.js from ${URL}.

If no release exists yet, this is expected — please use the released
install.sh from the Releases page instead, which embeds host.js inline
and needs no network. https://github.com/Replikanti/linkshit/releases
EOF
    exit 1
  fi
else
  # Released form: host.js is embedded as base64 in this script.
  printf '%s' "${LINKSHIT_HOST_JS_BASE64}" | base64 -d > "${HOST_PATH}"
fi
chmod +x "${HOST_PATH}"
echo "✓ host.js installed"

# ---------- Step 5: Native messaging manifest ----------
echo
echo "Registering native messaging host with Chrome..."
mkdir -p "${NM_DIR}"
cat > "${NM_DIR}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Linkshit native messaging host",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF
echo "✓ Manifest written: ${NM_DIR}/${HOST_NAME}.json"

# ---------- Done ----------
cat <<EOF

==============================================================
  Done!
==============================================================

One more step — load the extension in Chrome:

  1. Download the latest extension zip:
     https://github.com/Replikanti/linkshit/releases/latest

     Look for: linkshit-extension-vX.Y.Z.zip

  2. Unzip it to a folder somewhere stable (it has to stay there —
     Chrome reads from this location every time you open the browser).

  3. Open  chrome://extensions

  4. In the top right, turn on  Developer mode

  5. Click  Load unpacked  and pick the folder you unzipped to.

  6. Visit  https://www.linkedin.com/feed
     A panel appears in the upper right. Click ⚙, set your criteria,
     click Save, then Start.

If anything fails, check README "Troubleshooting".
EOF
