import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { DesktopHost } from "./host";
import { buildChatHtml } from "./html";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PRELOAD = path.join(__dirname, "preload.js");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  version?: string;
};

function parseCwd(): string {
  // Prefer explicit env (most reliable across Electron argv quirks).
  if (process.env.GROK_DESK_CWD) return path.resolve(process.env.GROK_DESK_CWD);

  // Accept both --cwd=PATH and --grok-desk-cwd=PATH (Chromium sometimes eats --cwd).
  for (const a of process.argv) {
    for (const prefix of ["--grok-desk-cwd=", "--cwd="]) {
      if (a.startsWith(prefix) && a.length > prefix.length) {
        return path.resolve(a.slice(prefix.length));
      }
    }
  }
  for (const flag of ["--grok-desk-cwd", "--cwd"]) {
    const idx = process.argv.indexOf(flag);
    if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
      return path.resolve(process.argv[idx + 1]);
    }
  }

  // Default: repo root when launched from desktop/, else process.cwd().
  // Never fall back to drive root alone if the repo is discoverable next to this app.
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."), // desktop/out -> repo root
    path.resolve(__dirname, ".."), // desktop/
  ];
  for (const c of candidates) {
    if (path.basename(c) === "desktop" && fs.existsSync(path.join(c, "..", "package.json"))) {
      return path.resolve(c, "..");
    }
    if (fs.existsSync(path.join(c, "package.json")) && fs.existsSync(path.join(c, "media", "chat.js"))) {
      return c;
    }
  }
  return process.cwd();
}

let mainWindow: BrowserWindow | null = null;
let host: DesktopHost | null = null;

function createWindow(): void {
  const cwd = parseCwd();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "Grok Desk",
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  host = new DesktopHost({
    cwd,
    packageVersion: PKG.version ?? "0.1.0",
    post: (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("host-msg", msg);
      }
    },
    log: (line) => console.log(line),
    pickFiles: async () => {
      if (!mainWindow) return [];
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Add context to Grok Desk",
        properties: ["openFile", "multiSelections"],
      });
      return result.canceled ? [] : result.filePaths;
    },
  });

  ipcMain.removeAllListeners("webview-msg");
  ipcMain.on("webview-msg", (_event, msg) => {
    if (!host || !msg || typeof msg !== "object") return;
    void host.handle(msg as { type: string }).catch((e) => {
      console.error("[ipc]", e);
    });
  });

  // Allow local media + data URIs used by the chat UI.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' file: data: blob:; " +
            "script-src 'self' 'unsafe-inline' file:; " +
            "style-src 'self' 'unsafe-inline' file:; " +
            "img-src 'self' data: blob: file:; " +
            "media-src 'self' data: blob: file:; " +
            "font-src 'self' data: file:; " +
            "connect-src 'self' https: http:;",
        ],
      },
    });
  });

  const html = buildChatHtml(REPO_ROOT);
  const tmpHtml = path.join(app.getPath("temp"), "grok-desk-index.html");
  fs.writeFileSync(tmpHtml, html, "utf8");
  void mainWindow.loadFile(tmpHtml);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("did-fail-load", code, desc);
  });

  mainWindow.on("closed", () => {
    host?.dispose();
    host = null;
    mainWindow = null;
  });

  if (process.env.GROK_DESK_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// Single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  host?.dispose();
  if (process.platform !== "darwin") app.quit();
});
