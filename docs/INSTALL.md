# Advanced install

The quickest path is in the [README](../README.md#install-dev): build from source and install the `.vsix`. This file covers CLI setup and multi-IDE paths.

## Install the CLI yourself (optional)

The extension's onboarding installs the CLI and signs you in for you — but if you'd rather use the terminal:

macOS / Linux / WSL:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Windows (PowerShell):

```powershell
irm https://x.ai/cli/install.ps1 | iex
grok login
```

`grok login` opens a browser and completes OAuth in one step. Prefer an API key? Get one at [console.x.ai](https://console.x.ai) and set `XAI_API_KEY` in your shell or a workspace `.env` (the extension auto-loads it).

## Install Grok Desk from a built .vsix

```bash
code --install-extension grok-desk-0.1.0.vsix --force
```

## Build from source

```bash
git clone https://github.com/contactjayclatty/grok-desk.git
cd grok-desk
npm install
./scripts/install.sh        # Windows: pwsh scripts\install.ps1
```

The install script auto-detects your IDE's CLI (`code` → `code-insiders` → `cursor` → Antigravity's `antigravity-ide`/`antigravity`). To target a specific code-compatible IDE, pass its CLI name or path — `./scripts/install.sh cursor` (Windows: `pwsh scripts\install.ps1 -Cli cursor`) — or set `CODE_CLI=…`. To install into **every** detected IDE in one run, pass `--all` (Windows: `-All`).

## Uninstall

Remove it from the Extensions view, or:

```bash
./scripts/uninstall.sh [cli]          # Windows: pwsh scripts\uninstall.ps1 [-Cli name]
code --uninstall-extension contactjayclatty.grok-desk
```

The uninstall scripts take the same optional CLI argument as install.
