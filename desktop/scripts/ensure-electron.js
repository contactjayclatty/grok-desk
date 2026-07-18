/**
 * Ensure electron binary is extracted into node_modules/electron/dist
 * and path.txt has a clean filename (no trailing \r\n — breaks spawn on Windows).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const electronRoot = path.join(__dirname, "..", "node_modules", "electron");
const dist = path.join(electronRoot, "dist");
const pathFile = path.join(electronRoot, "path.txt");
const exeName = process.platform === "win32" ? "electron.exe" : "electron";
const exe = path.join(dist, exeName);

function writePathTxt() {
  // LF-only, no trailing junk — electron/index.js concatenates this raw into a path.
  fs.writeFileSync(pathFile, exeName, "utf8");
}

function binaryOk() {
  return fs.existsSync(exe) && fs.statSync(exe).size > 1_000_000;
}

function pathTxtOk() {
  if (!fs.existsSync(pathFile)) return false;
  const raw = fs.readFileSync(pathFile, "utf8");
  return raw === exeName;
}

if (binaryOk() && pathTxtOk()) {
  process.exit(0);
}

if (binaryOk() && !pathTxtOk()) {
  console.log("[ensure-electron] fixing corrupted path.txt");
  writePathTxt();
  process.exit(0);
}

console.log("[ensure-electron] binary missing — installing…");

try {
  if (fs.existsSync(dist)) {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  const installJs = path.join(electronRoot, "install.js");
  if (fs.existsSync(installJs)) {
    // install.js is async via promises in some versions; require runs it
    require(installJs);
  }
} catch (e) {
  console.error("[ensure-electron] install.js failed:", e.message || e);
}

// Normalize path.txt even if install wrote CRLF
if (binaryOk()) {
  writePathTxt();
  console.log("[ensure-electron] ok");
  process.exit(0);
}

// Fallback: download + extract via @electron/get
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"));
  const version = pkg.version;
  let getPath;
  try {
    getPath = require.resolve("@electron/get", { paths: [electronRoot, path.join(electronRoot, "node_modules")] });
  } catch {
    getPath = path.join(electronRoot, "node_modules", "@electron", "get");
  }
  let extractPath;
  try {
    extractPath = require.resolve("extract-zip", { paths: [electronRoot, path.join(__dirname, "..")] });
  } catch {
    extractPath = require.resolve("extract-zip");
  }

  const script = `
    const { downloadArtifact } = require(${JSON.stringify(getPath)});
    const extract = require(${JSON.stringify(extractPath)});
    const fs = require("fs");
    (async () => {
      const zip = await downloadArtifact({ version: ${JSON.stringify(version)}, artifactName: "electron" });
      const dest = ${JSON.stringify(dist)};
      fs.mkdirSync(dest, { recursive: true });
      await extract(zip, { dir: dest });
      console.log("[ensure-electron] extracted to", dest);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  execFileSync(process.execPath, ["-e", script], { stdio: "inherit" });
} catch (e) {
  console.error("[ensure-electron] fallback failed:", e.message || e);
  process.exit(1);
}

if (!binaryOk()) {
  console.error("[ensure-electron] still missing", exe);
  process.exit(1);
}
writePathTxt();
console.log("[ensure-electron] ok (fallback)");
