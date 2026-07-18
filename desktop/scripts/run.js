/**
 * Launch Electron with a sensible project cwd.
 * Resolves the electron binary robustly (trims path.txt CRLF junk).
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { ensureElectron } = require("./ensure-electron");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");

function resolveCwd(argv) {
  if (process.env.GROK_DESK_CWD) return path.resolve(process.env.GROK_DESK_CWD);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--cwd=")) return path.resolve(a.slice("--cwd=".length));
    if (a.startsWith("--grok-desk-cwd=")) return path.resolve(a.slice("--grok-desk-cwd=".length));
    if ((a === "--cwd" || a === "--grok-desk-cwd") && argv[i + 1]) return path.resolve(argv[i + 1]);
  }
  if (fs.existsSync(path.join(repoRoot, "media", "chat.js"))) return repoRoot;
  return process.cwd();
}

function resolveElectronBinary() {
  const electronRoot = path.join(desktopRoot, "node_modules", "electron");
  const dist = path.join(electronRoot, "dist");
  const exeName = process.platform === "win32" ? "electron.exe" : "electron";
  const direct = path.join(dist, exeName);
  if (fs.existsSync(direct)) return direct;

  const pathFile = path.join(electronRoot, "path.txt");
  if (fs.existsSync(pathFile)) {
    const name = fs.readFileSync(pathFile, "utf8").replace(/^\uFEFF/, "").trim();
    const candidate = path.join(dist, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const fromPkg = String(require("electron") || "").replace(/^\uFEFF/, "").trim();
    if (fromPkg && fs.existsSync(fromPkg)) return fromPkg;
  } catch {
    /* not installed */
  }

  return null;
}

const forward = process.argv.slice(2);
const cwd = resolveCwd(forward);
process.env.GROK_DESK_CWD = cwd;

const ensured = ensureElectron();
if (!ensured.ok) {
  console.error("[run] could not ensure Electron binary:", ensured.error || "unknown");
  process.exit(1);
}

let electronBin = resolveElectronBinary() || ensured.path;
if (!electronBin) {
  console.error(
    "[run] Electron binary not found.\n" +
      "  Try:  cd desktop && npm run ensure-electron\n" +
      "  Or:   cd desktop && npm install electron --force",
  );
  process.exit(1);
}

electronBin = electronBin.replace(/[\r\n]+/g, "").trim();

console.log("[run] electron =", electronBin);
console.log("[run] cwd      =", cwd);

const child = spawn(electronBin, [desktopRoot, ...forward], {
  stdio: "inherit",
  env: process.env,
  cwd: desktopRoot,
  windowsHide: false,
});

child.on("error", (err) => {
  console.error("[run] failed to start electron:", err.message);
  console.error("[run] path was:", JSON.stringify(electronBin));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
