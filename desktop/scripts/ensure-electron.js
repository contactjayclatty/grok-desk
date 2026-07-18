/**
 * Ensure electron binary is extracted into node_modules/electron/dist.
 * npm postinstall sometimes leaves only locales/ on Windows.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const electronRoot = path.join(__dirname, "..", "node_modules", "electron");
const dist = path.join(electronRoot, "dist");
const exe = path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");

if (fs.existsSync(exe)) {
  process.exit(0);
}

console.log("[ensure-electron] binary missing — reinstalling…");
try {
  // Clear partial dist and re-run official install script
  if (fs.existsSync(dist)) {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  const installJs = path.join(electronRoot, "install.js");
  if (fs.existsSync(installJs)) {
    require(installJs);
  }
} catch (e) {
  console.error("[ensure-electron] install.js failed:", e.message || e);
}

if (fs.existsSync(exe)) {
  console.log("[ensure-electron] ok");
  process.exit(0);
}

// Last resort: download + unzip via @electron/get
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"));
  const version = pkg.version;
  const { downloadArtifact } = require(path.join(electronRoot, "node_modules", "@electron", "get"));
  // sync-ish via child? downloadArtifact is async — use a tiny inline runner
  const script = `
    const {downloadArtifact}=require(${JSON.stringify(path.join(electronRoot, "node_modules", "@electron", "get"))});
    const extract=require(${JSON.stringify(require.resolve("extract-zip"))});
    const path=require("path");
    const fs=require("fs");
    (async()=>{
      const zip=await downloadArtifact({version:${JSON.stringify(version)},artifactName:"electron"});
      const dest=${JSON.stringify(dist)};
      fs.mkdirSync(dest,{recursive:true});
      await extract(zip,{dir:dest});
      console.log("extracted to",dest);
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  execFileSync(process.execPath, ["-e", script], { stdio: "inherit" });
} catch (e) {
  console.error("[ensure-electron] fallback failed:", e.message || e);
  process.exit(1);
}

if (!fs.existsSync(exe)) {
  console.error("[ensure-electron] still missing", exe);
  process.exit(1);
}
console.log("[ensure-electron] ok (fallback)");
