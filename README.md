# Grok Desk

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Unofficial](https://img.shields.io/badge/Unofficial-fork%20%C2%B7%20MIT-FF6B35)](#)

> **GUI for the Grok Build CLI** — not affiliated with or endorsed by xAI. *Grok*, *Grok Build*, and *xAI* are trademarks of xAI.

**Grok Desk** is a rebranded fork of [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode) (MIT), by Paweł Huryn. It still runs as a VS Code / Cursor extension today; the long-term goal is a **standalone desktop GUI** over `grok agent stdio` (ACP), not only an editor sidebar.

## What it does

Thin client over **Grok Build CLI** (`grok agent stdio`):

- Multi-session chat with history and status dots  
- Permission cards / plan mode / auto-accept  
- File chips, `@` context, image/video, voice, Mermaid, LaTeX  

Requires the [Grok Build CLI](https://x.ai) plus SuperGrok, X Premium+, or an xAI API key.

## Install (dev)

```powershell
git clone https://github.com/contactjayclatty/grok-desk.git
cd grok-desk
npm install
npm run package
# or: pwsh scripts\install.ps1
code --install-extension grok-desk-0.1.0.vsix --force
```

Uninstall:

```powershell
code --uninstall-extension contactjayclatty.grok-desk
# or: pwsh scripts\uninstall.ps1
```

Reload the window, then open the **Grok** view.

## Develop

```bash
npm install
npm run compile
npm test
```

Press F5 in VS Code for the Extension Development Host.

## Attribution

Based on [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode) by Paweł Huryn, MIT License. See [docs/attribution.md](docs/attribution.md) and [LICENSE](LICENSE).

## Desktop app (Electron MVP)

Standalone window that reuses the same chat UI + ACP core (no VS Code required):

```powershell
npm install
npm run compile
npm run desktop:install
npm run desktop
# optional project root:
npm start --prefix desktop -- --cwd=C:\path\to\project
```

Details: [desktop/README.md](desktop/README.md).

## Roadmap (this fork)

1. Keep VS Code extension working under the **Grok Desk** brand  
2. ~~Ship a standalone desktop shell (Electron MVP)~~ — see `desktop/`  
3. Extract shared core; add session history, chips, voice, native diff  
4. Package as installable Windows / macOS app  

## License

MIT — see [LICENSE](LICENSE).
