import { readFileSync } from "node:fs";

/**
 * Minimal reader for grok's `config.toml` — enough for desktop/extension hosts
 * to mirror CLI defaults (always-approve, default model, reasoning effort).
 * No TOML dependency: section-aware line scans.
 *
 * grok writes `permission_mode = "always-approve"` when the user picks
 * "Always Approve" via Shift+Tab or runs `/always-approve` in the TUI, which
 * silently makes *every* grok session (CLI + this extension) auto-approve tool
 * actions server-side. The extension can't see that over ACP (the CLI still
 * reports the ordinary `default`/agent mode), so it reads the file directly to
 * keep the mode button honest.
 */

/** True when a `permission_mode` value means "auto-approve everything". grok
 *  writes the hyphenated spelling; the underscore variant is accepted too. */
export function isAlwaysApprovePermission(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().replace(/_/g, "-") === "always-approve";
}

/** Unquote a TOML scalar and strip trailing comments. */
function unquoteTomlValue(raw: string): string {
  return raw.trim().replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * Read a single key from a named top-level table (e.g. `ui`, `models`).
 * Only simple `key = value` assignments; arrays/tables-as-values ignored.
 */
export function readTomlTableKey(
  toml: string,
  tableName: string,
  key: string,
): string | undefined {
  let inTable = false;
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`);
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (table) {
      inTable = table[1].trim() === tableName;
      continue;
    }
    if (!inTable) continue;
    const kv = line.match(keyRe);
    if (kv) return unquoteTomlValue(kv[1]);
  }
  return undefined;
}

/**
 * Read `permission_mode` from the `[ui]` table of a config.toml string, or
 * `undefined` when the table/key is absent. Comments (`#…`) and surrounding
 * quotes are stripped, and only the `[ui]` table is consulted so a
 * `permission_mode` under another table can't be misread.
 */
export function readUiPermissionMode(toml: string): string | undefined {
  return readTomlTableKey(toml, "ui", "permission_mode");
}

/** `[models].default` — preferred coding model id (e.g. grok-4.5). */
export function readModelsDefault(toml: string): string | undefined {
  return readTomlTableKey(toml, "models", "default");
}

/** `[models].default_reasoning_effort` — none|minimal|low|medium|high|xhigh. */
export function readModelsDefaultEffort(toml: string): string | undefined {
  return readTomlTableKey(toml, "models", "default_reasoning_effort");
}

/** `[ui].yolo` — boolean-ish; when true, same spirit as always-approve. */
export function readUiYolo(toml: string): boolean {
  const v = readTomlTableKey(toml, "ui", "yolo");
  if (!v) return false;
  return /^(true|1|yes|on)$/i.test(v);
}

/**
 * The effective always-approve verdict from a project + global config pair.
 * Project `.grok/config.toml` overrides global `~/.grok/config.toml` (grok
 * merges project over global); a key absent from project falls back to global.
 * Either string may be `undefined` (file missing / unreadable).
 */
export function configForcesAlwaysApprove(input: {
  project?: string;
  global?: string;
}): boolean {
  const projectMode = input.project != null ? readUiPermissionMode(input.project) : undefined;
  const effective =
    projectMode ?? (input.global != null ? readUiPermissionMode(input.global) : undefined);
  return isAlwaysApprovePermission(effective);
}

/** Effective default model: project overrides global. */
export function configDefaultModel(input: {
  project?: string;
  global?: string;
}): string | undefined {
  const fromProject = input.project != null ? readModelsDefault(input.project) : undefined;
  if (fromProject) return fromProject;
  return input.global != null ? readModelsDefault(input.global) : undefined;
}

/** Effective default reasoning effort: project overrides global. */
export function configDefaultEffort(input: {
  project?: string;
  global?: string;
}): string | undefined {
  const fromProject = input.project != null ? readModelsDefaultEffort(input.project) : undefined;
  if (fromProject) return fromProject;
  return input.global != null ? readModelsDefaultEffort(input.global) : undefined;
}

/** True when project or global config enables yolo / always-approve. */
export function configForcesYolo(input: {
  project?: string;
  global?: string;
}): boolean {
  if (configForcesAlwaysApprove(input)) return true;
  const projectYolo = input.project != null ? readUiYolo(input.project) : false;
  if (input.project != null && readTomlTableKey(input.project, "ui", "yolo") != null) {
    return projectYolo;
  }
  return input.global != null ? readUiYolo(input.global) : false;
}

/** Load raw toml text from a path, or undefined if missing/unreadable. */
export function readTomlFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
