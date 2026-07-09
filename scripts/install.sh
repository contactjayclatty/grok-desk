#!/usr/bin/env bash
# Install the Grok VS Code extension on macOS / Linux / WSL.
# Usage:  ./scripts/install.sh [path/to/file.vsix] [cli]
#   [cli] — a code-compatible CLI name or path to install into (e.g. code-insiders,
#           antigravity-ide, /path/to/code); also settable via CODE_CLI=…
#           Default: auto-detect code → code-insiders → antigravity-ide → antigravity.
# Picks the first .vsix in the repo root, or builds one if none exists.
# Args are classified by shape, so order doesn't matter: *.vsix → package, else → cli.

set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

known_clis="code code-insiders antigravity-ide antigravity"

vsix=""
cli_override="${CODE_CLI:-}"
for arg in "$@"; do
    case "$arg" in
        *.vsix) vsix="$arg" ;;
        *) cli_override="$arg" ;;
    esac
done

find_code_cli() {
    if [ -n "$cli_override" ]; then
        if command -v "$cli_override" >/dev/null 2>&1; then
            echo "$cli_override"; return 0
        fi
        echo "Requested CLI not found: $cli_override" >&2
        return 1
    fi
    for name in $known_clis; do
        if command -v "$name" >/dev/null 2>&1; then
            echo "$name"; return 0
        fi
    done
    # macOS install paths
    for path in \
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
        "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
    ; do
        [ -x "$path" ] && { echo "$path"; return 0; }
    done
    echo "Could not find a code-compatible CLI. Install VS Code, or pass one: ./scripts/install.sh <cli-name-or-path>" >&2
    return 1
}

hint_other_clis() {
    others=""
    for name in $known_clis; do
        [ "$name" = "$1" ] && continue
        command -v "$name" >/dev/null 2>&1 && others="$others $name"
    done
    if [ -n "$others" ]; then
        echo "Also detected:$others — to install there instead: ./scripts/install.sh <cli>"
    fi
}

if [ -z "$vsix" ]; then
    # Always rebuild so the installed extension is never stale
    cd "$repo_root"
    [ -d node_modules ] || npm install
    npm run package
    vsix=$(ls -t "$repo_root"/*.vsix | head -n1)
fi
[ -f "$vsix" ] || { echo "vsix not found: $vsix" >&2; exit 1; }

code=$(find_code_cli)
echo "Installing $vsix via $code"
# --force so a same-version reinstall actually overwrites the installed files
"$code" --install-extension "$vsix" --force
echo
echo "Done. Reload the IDE window (Ctrl+Shift+P -> 'Developer: Reload Window') and click the Grok icon."
[ -z "$cli_override" ] && hint_other_clis "$code" || true
