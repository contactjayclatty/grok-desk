/**
 * Launch Electron with a sensible project cwd.
 * Sets GROK_DESK_CWD to the monorepo root (or --cwd / env override).
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

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

const forward = process.argv.slice(2);
const cwd = resolveCwd(forward);
process.env.GROK_DESK_CWD = cwd;

const electronCli = require("electron"); // path to electron binary
const child = spawn(electronCli, [desktopRoot, ...forward], {
  stdio: "inherit",
  env: process.env,
  cwd: desktopRoot,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
