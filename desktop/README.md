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

## What works (MVP)

- Chat send / stop / new session  
- Streaming messages, thoughts, tool cards  
- Shell tools via ACP `terminal/*`  
- File read/write via ACP `fs/*`  
- Permission cards + Plan / Agent / Auto-accept modes  
- Ask-user questions  

## Not yet

- Session history / resume / fork  
- Voice, image paste, file chips  
- Native diff editor  
- Multi-session pool  
- CLI install / login onboarding actions  

## Layout

| Path | Role |
|------|------|
| `src/main.ts` | Electron window + IPC |
| `src/preload.ts` | `acquireVsCodeApi` polyfill |
| `src/host.ts` | ACP bridge (thin host) |
| `src/html.ts` | Chat HTML loading `media/*` |
| `theme.css` | VS Code CSS variable theme |
