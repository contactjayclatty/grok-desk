import { app, BrowserWindow, ipcMain, session } from "electron";
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
  const arg = process.argv.find((a) => a.startsWith("--cwd="));
  if (arg) return path.resolve(arg.slice("--cwd=".length));
  const idx = process.argv.indexOf("--cwd");
  if (idx >= 0 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return process.cwd();
}

let mainWindow: BrowserWindow | null = null;
let host: DesktopHost | null = null;

function createWindow(): void {
  const cwd = parseCwd();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    title: "Grok Desk",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  host = new DesktopHost({
    cwd,
    packageVersion: PKG.version ?? "0.1.0",
    post: (msg) => {
      mainWindow?.webContents.send("host-msg", msg);
    },
    log: (line) => {
      console.log(line);
    },
  });

  ipcMain.removeAllListeners("webview-msg");
  ipcMain.on("webview-msg", (_event, msg) => {
    if (!host || !msg || typeof msg !== "object") return;
    void host.handle(msg as { type: string });
  });

  // Allow loading local media assets (file://) and data: images from the chat UI.
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

  mainWindow.on("closed", () => {
    host?.dispose();
    host = null;
    mainWindow = null;
  });

  if (process.env.GROK_DESK_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  host?.dispose();
  if (process.platform !== "darwin") app.quit();
});
