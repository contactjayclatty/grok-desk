# Grok Desk — Desktop shell

Standalone Electron window for Grok Desk. Reuses `media/chat.*` UI and the compiled ACP core from the parent package (`out/acp.js`, etc.).

## Prerequisites

1. **Grok Build CLI** installed and signed in (`grok login` or `XAI_API_KEY`)
2. Parent package compiled: `npm run compile` at repo root

## Run

```powershell
cd C:\Users\Admin\source\repos\grok-desk
npm run compile
cd desktop
npm install
npm start
```

Or from repo root (after first `desktop/npm install`):

```powershell
npm run desktop
```

Open a project directory:

```powershell
npm start -- --cwd=C:\path\to\project
```

DevTools:

```powershell
$env:GROK_DESK_DEVTOOLS="1"; npm start
```

## What works

- Chat send / stop / queue / steer / new session  
- Streaming messages, thoughts, tool cards, subagents, media  
- Shell tools via ACP `terminal/*` + file read/write  
- Permission cards + Plan / Agent / Auto-accept  
- Ask-user questions  
- Session history: list, search, resume, rename, delete, clear, fork  
- File chips: pick, drop path, paste image  
- Diff: opens in VS Code/Cursor `--diff` when available, else temp files  
- CLI install / login onboarding (opens system terminal)  
- Global + project config openers  

## Not yet

- Voice dictation  
- Multi-session live pool (parallel background agents)  
- Packaged `.exe` installer (`electron-builder`) 

## Layout

| Path | Role |
|------|------|
| `src/main.ts` | Electron window + IPC |
| `src/preload.ts` | `acquireVsCodeApi` polyfill |
| `src/host.ts` | ACP bridge (thin host) |
| `src/html.ts` | Chat HTML loading `media/*` |
| `theme.css` | VS Code CSS variable theme |
