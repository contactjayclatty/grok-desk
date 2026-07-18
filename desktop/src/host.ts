/**
 * Full desktop ACP host for Grok Desk.
 * Speaks the same HostMsg/WebviewMsg contract as the VS Code sidebar so media/chat.js works.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { shell } from "electron";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { AcpClient } = require("../../out/acp") as { AcpClient: any };
const { locateGrokCli } = require("../../out/cli-locator") as {
  locateGrokCli: (p: string) => string | undefined;
};
const { TerminalManager, grokShellEnvValue, resolvedTerminalShell, setTerminalShellPreference } =
  require("../../out/terminal-manager") as {
    TerminalManager: new () => any;
    grokShellEnvValue: (resolved: string | true, platform?: NodeJS.Platform) => string | undefined;
    resolvedTerminalShell: () => string | true;
    setTerminalShellPreference: (pref: "auto" | "cmd") => void;
  };
const { GROK_PRIMER, isPrimerText } = require("../../out/grok-primer") as {
  GROK_PRIMER: string;
  isPrimerText: (t: string) => boolean;
};
const {
  listSessions,
  deleteSessionDir,
  clearSessions,
  resolveGrokHome,
  readContextUsage,
  sessionsDirFor,
  fallbackName,
  forkDisplayName,
} = require("../../out/sessions") as any;
const {
  makeExplicitChip,
  makeImageChip,
  removeChip,
  toggleChip,
  consumeChips,
  isImageChip,
  isVisionImagePath,
  isVisionMime,
  mimeFromPath,
  extFromMime,
  MAX_VISION_IMAGE_BYTES,
} = require("../../out/chips") as any;
const { buildPromptWithImages } = require("../../out/prompt-builder") as any;
const { matchSlashCommand } = require("../../out/slash-filter") as any;
const { decideRestoreState } = require("../../out/plan-restore") as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

export type PostFn = (msg: Record<string, unknown>) => void;

export interface DesktopHostOptions {
  cwd: string;
  post: PostFn;
  log?: (line: string) => void;
  packageVersion?: string;
  /** Absolute path to grok binary override (optional). */
  cliPath?: string;
  pickFiles?: () => Promise<string[]>;
}

type ModeId = "agent" | "plan" | "yolo";

interface SessionMeta {
  customName?: string;
  plans?: Array<{
    text: string;
    verdict: "approved" | "rejected" | "abandoned";
    afterUserMessage?: number;
  }>;
  permissions?: Array<{
    title: string;
    outcome: "allowed" | "rejected";
    toolCallId?: string;
    afterUserMessage?: number;
  }>;
  unread?: boolean;
  unreadError?: boolean;
}
type MetaMap = Record<string, SessionMeta>;

interface Chip {
  id: string;
  path: string;
  relPath: string;
  selectionStart?: number;
  selectionEnd?: number;
  hidden: boolean;
  imageIndex?: number;
  mimeType?: string;
  originRelPath?: string;
}

function metaPath(): string {
  return path.join(os.homedir(), ".grok-desk", "session-meta.json");
}

function loadMeta(): MetaMap {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), "utf8")) as MetaMap;
  } catch {
    return {};
  }
}

function saveMeta(map: MetaMap): void {
  const p = metaPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map, null, 2), "utf8");
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function openInSystemTerminal(command: string): void {
  if (process.platform === "win32") {
    // Open a new PowerShell window that runs the command and stays open.
    spawn(
      "cmd.exe",
      ["/c", "start", "powershell.exe", "-NoExit", "-Command", command],
      { detached: true, stdio: "ignore" },
    ).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  // Linux: try common terminals
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", `${command}; exec bash`]],
    ["gnome-terminal", ["--", "bash", "-lc", `${command}; exec bash`]],
    ["konsole", ["-e", "bash", "-lc", `${command}; exec bash`]],
    ["xterm", ["-e", "bash", "-lc", `${command}; exec bash`]],
  ];
  for (const [bin, args] of candidates) {
    try {
      spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
      return;
    } catch {
      /* try next */
    }
  }
}

export class DesktopHost {
  private client: any;
  private terminals = new TerminalManager();
  private gen = 0;
  private sessionId?: string;
  private busy = false;
  private autoApprove = false;
  private planActive = false;
  private priming?: Promise<void>;
  private primed = false;
  private replaying = false;
  private hasHistory = false;
  private userMessageCount = 0;
  private imageCounter = 0;
  private chips: Chip[] = [];
  private queuedSends: string[] = [];
  private lastPlanText = "";
  private steerByDefault = false;
  private showThinking = false;
  private expandCommandOutputs = false;
  private effort = "";
  private defaultModel = "";
  private meta: MetaMap = loadMeta();
  private readonly log: (line: string) => void;
  private readonly version: string;
  private readonly cwd: string;

  constructor(private opts: DesktopHostOptions) {
    this.log = opts.log ?? ((l) => console.log(`[host] ${l}`));
    this.version = opts.packageVersion ?? "0.1.0";
    this.cwd = opts.cwd;
    setTerminalShellPreference("auto");
  }

  async handle(msg: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          this.postInitialState();
          await this.boot();
          break;
        case "send":
          await this.handleSend(String(msg.text ?? ""), msg.bare === true);
          break;
        case "newSession":
          await this.restartSession();
          break;
        case "cancel":
          await this.client?.cancel("user Stop click");
          break;
        case "permissionAnswer":
          this.onPermissionAnswer(msg.requestId as number | string, String(msg.optionId));
          break;
        case "exitPlanAnswer":
          this.onExitPlanAnswer(
            msg.requestId as number | string,
            msg.verdict as "approved" | "abandoned" | "rejected",
            typeof msg.comment === "string" ? msg.comment : undefined,
          );
          break;
        case "questionAnswer":
          this.client?.respondQuestion(
            msg.requestId as number | string,
            (msg.answers as Record<string, string>) ?? {},
            (msg.annotations as Record<string, { notes?: string; preview?: string }>) ?? {},
          );
          break;
        case "questionCancel":
          this.client?.respondQuestionCancelled(msg.requestId as number | string);
          break;
        case "setMode":
          await this.setMode(msg.modeId as ModeId);
          break;
        case "setModel":
          if (this.client && typeof msg.modelId === "string") {
            try {
              await this.client.setModel(msg.modelId);
              this.defaultModel = msg.modelId;
            } catch (e) {
              this.post({ type: "error", text: `Model switch failed: ${(e as Error).message}` });
            }
          }
          break;
        case "setEffort":
          await this.setEffort(String(msg.level ?? ""));
          break;
        case "setShowThinking":
          this.showThinking = !!msg.value;
          this.post({ type: "showThinking", value: this.showThinking });
          break;
        case "setExpandCommandOutputs":
          this.expandCommandOutputs = !!msg.value;
          this.post({ type: "expandCommandOutputs", value: this.expandCommandOutputs });
          break;
        case "setSteerByDefault":
          this.steerByDefault = !!msg.value;
          this.post({ type: "steerByDefault", value: this.steerByDefault });
          break;
        case "openUrl":
          if (typeof msg.url === "string") void shell.openExternal(msg.url);
          break;
        case "openFile":
          await this.openFile(String(msg.path ?? ""));
          break;
        case "openDiff":
          await this.openDiff(
            String(msg.path ?? "file"),
            String(msg.oldText ?? ""),
            String(msg.newText ?? ""),
          );
          break;
        case "listSessions":
          this.postSessionsList({
            offset: typeof msg.offset === "number" ? msg.offset : 0,
            limit: typeof msg.limit === "number" ? msg.limit : 30,
            query: typeof msg.query === "string" ? msg.query : "",
          });
          break;
        case "resumeSession":
          if (typeof msg.id === "string") await this.resumeSession(msg.id);
          break;
        case "renameSession":
          if (typeof msg.id === "string" && typeof msg.name === "string") {
            this.renameSession(msg.id, msg.name);
          }
          break;
        case "deleteSession":
          if (typeof msg.id === "string") await this.deleteSession(msg.id);
          break;
        case "clearAllSessions":
          await this.clearAllSessions();
          break;
        case "queueSend":
          this.queueSend(String(msg.text ?? ""));
          break;
        case "dequeueSend":
          if (typeof msg.index === "number" && msg.index >= 0 && msg.index < this.queuedSends.length) {
            this.queuedSends.splice(msg.index, 1);
            this.post({ type: "queuedSends", items: [...this.queuedSends] });
          }
          break;
        case "clearQueuedSends":
          this.queuedSends = [];
          this.post({ type: "queuedSends", items: [] });
          break;
        case "steerSend":
          await this.steerSend(String(msg.text ?? ""));
          break;
        case "forkSession":
          await this.forkSession();
          break;
        case "pickFile":
          await this.pickFiles();
          break;
        case "dropFile":
          if (typeof msg.path === "string") await this.addFile(msg.path);
          break;
        case "pasteImage":
          if (typeof msg.data === "string" && typeof msg.mimeType === "string") {
            await this.pasteImage(msg.data, msg.mimeType);
          }
          break;
        case "removeChip":
          if (typeof msg.id === "string") {
            const removed = this.chips.find((c) => c.id === msg.id);
            if (removed && isImageChip(removed)) {
              void fs.promises.unlink(removed.path).catch(() => {});
            }
            this.chips = removeChip(this.chips, msg.id);
            this.postChips();
          }
          break;
        case "toggleChip":
          if (typeof msg.id === "string") {
            this.chips = toggleChip(this.chips, msg.id);
            this.postChips();
          }
          break;
        case "runInstallCmd":
          this.runInstallCmd();
          break;
        case "runGrokLogin":
          this.runGrokLogin();
          break;
        case "recheckConnection":
          await this.boot();
          break;
        case "logout":
          await this.logout();
          break;
        case "openGlobalConfig":
          void shell.openPath(path.join(resolveGrokHome(process.env), "config.toml"));
          break;
        case "openProjectConfig": {
          const p = path.join(this.cwd, ".grok", "config.toml");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          if (!fs.existsSync(p)) fs.writeFileSync(p, "# Grok project config\n", "utf8");
          void shell.openPath(p);
          break;
        }
        case "runMcpList":
          await this.handleSend("/mcp", true);
          break;
        case "showLogs":
          this.log("(logs are in the terminal that launched Grok Desk)");
          this.post({ type: "error", text: "Logs print to the terminal that launched Grok Desk." });
          break;
        case "checkGrokUpdate":
          await this.checkGrokUpdate();
          break;
        case "updateGrok":
          await this.updateGrok();
          break;
        case "pickModel":
          // Model list lives in the gear popover from the last `session` message.
          this.post({ type: "error", text: "Pick a model from the gear menu (⚙️)." });
          break;
        case "moveView":
        case "exportExpr":
        case "voiceStart":
        case "voiceStop":
          this.log(`not implemented in desktop yet: ${msg.type}`);
          break;
        default:
          this.log(`unknown webview msg: ${msg.type}`);
      }
    } catch (e) {
      this.log(`handle error: ${(e as Error).stack || (e as Error).message}`);
      this.post({ type: "error", text: (e as Error).message });
    }
  }

  dispose(): void {
    this.gen++;
    void this.client?.dispose();
    this.client = undefined;
    this.terminals.disposeAll();
  }

  private post(msg: Record<string, unknown>): void {
    this.opts.post(msg);
  }

  private postInitialState(): void {
    this.post({
      type: "initialState",
      effort: this.effort,
      cwd: this.cwd,
      useCtrlEnter: false,
      extVersion: this.version,
      showThinking: this.showThinking,
      expandCommandOutputs: this.expandCommandOutputs,
      steerByDefault: this.steerByDefault,
    });
    this.post({ type: "voiceConfigured", value: false });
    this.postChips();
    this.postMode();
  }

  private postChips(): void {
    this.post({ type: "chips", chips: this.chips });
  }

  private postMode(): void {
    const modeId: ModeId = this.planActive ? "plan" : this.autoApprove ? "yolo" : "agent";
    this.post({ type: "modeChanged", modeId });
  }

  private cliPath(): string | undefined {
    return locateGrokCli(this.opts.cliPath ?? "");
  }

  private async boot(): Promise<void> {
    const cli = this.cliPath();
    if (!cli) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    await this.startSession();
  }

  private async restartSession(): Promise<void> {
    this.post({ type: "clearMessages" });
    this.post({ type: "agentReset" });
    this.resetSessionState();
    const cli = this.cliPath();
    if (!cli) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    await this.startSession();
  }

  private resetSessionState(keepChips = false): void {
    this.primed = false;
    this.priming = undefined;
    this.planActive = false;
    this.autoApprove = false;
    this.replaying = false;
    this.hasHistory = false;
    this.userMessageCount = 0;
    this.imageCounter = 0;
    this.lastPlanText = "";
    this.busy = false;
    this.queuedSends = [];
    this.sessionId = undefined;
    if (!keepChips) {
      for (const c of this.chips) {
        if (isImageChip(c)) void fs.promises.unlink(c.path).catch(() => {});
      }
      this.chips = [];
    }
    this.post({ type: "queuedSends", items: [] });
    this.postChips();
    this.postMode();
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Load workspace .env if present
    const dotenv = path.join(this.cwd, ".env");
    if (fs.existsSync(dotenv)) {
      try {
        for (const line of fs.readFileSync(dotenv, "utf8").split(/\r?\n/)) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (!m) continue;
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!(m[1] in env)) env[m[1]] = v;
        }
      } catch {
        /* ignore */
      }
    }
    if (env["XAI_API_KEY"] && !env["GROK_CODE_XAI_API_KEY"]) {
      env["GROK_CODE_XAI_API_KEY"] = env["XAI_API_KEY"];
    }
    if (!("GROK_SHELL" in env)) {
      const grokShell = grokShellEnvValue(resolvedTerminalShell(), process.platform);
      if (grokShell) env["GROK_SHELL"] = grokShell;
    }
    return env;
  }

  private async startSession(resumeId?: string): Promise<void> {
    const cliPath = this.cliPath();
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }

    this.gen++;
    const gen = this.gen;
    if (this.client) {
      await this.client.dispose();
      this.client = undefined;
    }

    this.post({ type: "setBusy", value: true, locked: true });

    const effort = this.effort && this.effort !== "none" ? this.effort : undefined;
    const client = new AcpClient({
      cliPath,
      cwd: this.cwd,
      effort,
      env: this.buildEnv(),
      log: (m: string) => this.log(m),
    });

    client.fsRead = async (p: string) => fs.promises.readFile(p, "utf8");
    client.fsWrite = async (p: string, content: string) => {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, content, "utf8");
    };
    client.terminal = this.terminals;
    client.planActive = this.planActive;

    this.wireClient(client, gen);
    this.client = client;

    try {
      await client.start();
      if (gen !== this.gen) return;

      if (resumeId) {
        await this.loadExisting(client, resumeId, gen);
      } else {
        await client.newSession(this.defaultModel || undefined);
        if (gen !== this.gen) return;
        this.sessionId = client.sessionId;
        this.post({
          type: "session",
          sessionId: this.sessionId,
          models: client.availableModels,
          currentModelId: client.currentModelId,
        });
      }

      if (gen !== this.gen) return;
      this.postMode();
      this.post({ type: "setBusy", value: false });
      this.priming = this.runPrimer(client, gen);
      void this.priming.then(() => {
        if (gen === this.gen) void this.flushQueue();
      });
      this.postSessionsList({});
    } catch (e) {
      const text = (e as Error).message || String(e);
      this.log(`start failed: ${text}`);
      try {
        await client.dispose();
      } catch {
        /* ignore */
      }
      if (gen !== this.gen) return;
      this.client = undefined;
      this.post({ type: "setBusy", value: false });
      if (/auth|unauthor|forbidden|401|403|api[_\s-]?key|credential|sign.?in|AuthorizationRequired/i.test(text)) {
        this.post({ type: "onboarding", state: "auth-required", platform: process.platform });
      } else {
        this.post({ type: "agentError", text });
        this.post({ type: "error", text });
      }
    }
  }

  private async loadExisting(client: any, resumeId: string, gen: number): Promise<void> {
    const saved = this.meta[resumeId]?.plans ?? [];
    const savedPerms = this.meta[resumeId]?.permissions ?? [];
    if (savedPerms.length) {
      this.post({ type: "permissionHistoryQueue", permissions: savedPerms });
    }
    if (saved.length) {
      this.post({ type: "planHistoryQueue", plans: saved });
      this.lastPlanText = saved[saved.length - 1].text;
    } else {
      const planPath = path.join(sessionsDirFor(resolveGrokHome(process.env), this.cwd), resumeId, "plan.md");
      if (fs.existsSync(planPath)) {
        try {
          const planText = fs.readFileSync(planPath, "utf8");
          this.post({ type: "planHistoryQueue", plans: [{ text: planText }] });
          this.lastPlanText = planText;
        } catch {
          /* ignore */
        }
      }
    }

    this.post({ type: "clearMessages" });
    this.post({ type: "historyReplay", active: true });
    this.replaying = true;
    try {
      await client.loadSession(resumeId, this.defaultModel || undefined);
    } catch (e) {
      this.log(`loadSession error: ${(e as Error).message}`);
      // Session may still have loaded enough to continue
    } finally {
      this.replaying = false;
      this.post({ type: "historyReplay", active: false });
    }
    if (gen !== this.gen) return;

    this.sessionId = resumeId;
    this.hasHistory = true;
    this.post({
      type: "session",
      sessionId: resumeId,
      models: client.availableModels,
      currentModelId: client.currentModelId,
    });

    const decision = decideRestoreState(saved);
    this.planActive = !!decision?.planActive;
    client.planActive = this.planActive;
    try {
      await client.setMode(this.planActive ? "plan" : "agent");
    } catch {
      /* best-effort */
    }
    this.postMode();

    const usage = readContextUsage({
      fs,
      grokHome: resolveGrokHome(process.env),
      cwd: this.cwd,
      id: resumeId,
    });
    if (usage) this.post({ type: "contextUsage", used: usage.used, window: usage.window });

    // Clear unread badge
    if (this.meta[resumeId]) {
      this.meta[resumeId] = { ...this.meta[resumeId], unread: false, unreadError: false };
      saveMeta(this.meta);
    }
  }

  private wireClient(client: any, gen: number): void {
    const alive = () => gen === this.gen;

    client.on("initialized", (init: any) => {
      if (!alive()) return;
      this.post({
        type: "initialized",
        info: {
          cliPath: this.cliPath() ?? "",
          cwd: this.cwd,
          version: init?.serverInfo?.version ?? init?.version ?? null,
          init: { protocolVersion: init?.protocolVersion },
        },
      });
    });

    client.on("session", (res: any) => {
      if (!alive()) return;
      if (res?.sessionId) this.sessionId = res.sessionId;
      this.post({
        type: "session",
        sessionId: res?.sessionId ?? this.sessionId,
        models: client.availableModels,
        currentModelId: client.currentModelId,
      });
    });

    client.on("modelChanged", (id: string) => {
      if (!alive()) return;
      this.post({ type: "modelChanged", modelId: id });
    });

    client.on("modeChanged", (id: string) => {
      if (!alive()) return;
      if (id === "plan") {
        this.autoApprove = false;
        this.planActive = true;
        client.planActive = true;
      }
      this.postMode();
    });

    client.on("commandsUpdate", (cmds: unknown[]) => {
      if (!alive()) return;
      this.post({ type: "commandsUpdate", commands: cmds });
    });

    client.on("messageChunk", (text: string) => {
      if (!alive()) return;
      this.post({ type: "messageChunk", text });
    });

    client.on("thoughtChunk", (text: string) => {
      if (!alive()) return;
      this.post({ type: "thoughtChunk", text });
    });

    client.on("userMessageChunk", (text: string) => {
      if (!alive() || !this.replaying) return;
      if (isPrimerText(text)) {
        this.post({ type: "userMessageChunk", text });
        return;
      }
      this.userMessageCount += 1;
      for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
        const n = Number(m[1]);
        if (n > this.imageCounter) this.imageCounter = n;
      }
      this.post({ type: "userMessageChunk", text });
    });

    client.on("toolCall", (call: unknown) => {
      if (!alive()) return;
      this.post({ type: "toolCall", call });
    });

    client.on("toolCallUpdate", (call: unknown) => {
      if (!alive()) return;
      this.post({ type: "toolCallUpdate", call });
    });

    client.on("promptComplete", (meta: unknown) => {
      if (!alive()) return;
      this.post({ type: "promptComplete", meta });
    });

    client.on("mediaContent", (m: any) => {
      if (!alive()) return;
      void this.forwardMedia(m, gen);
    });

    client.on("permissionRequest", (req: any) => {
      if (!alive()) return;
      if (this.autoApprove) {
        const opt =
          req.options?.find((o: any) => o.kind === "allow_always") ??
          req.options?.find((o: any) => o.kind === "allow_once");
        if (opt) {
          client.respondPermission(req.id, opt.optionId);
          return;
        }
      }
      this.post({ type: "permissionRequest", req });
    });

    client.on("exitPlanRequest", (req: any) => {
      if (!alive()) return;
      if (!req.plan && this.lastPlanText) req = { ...req, plan: this.lastPlanText };
      this.planActive = true;
      client.planActive = true;
      this.post({ type: "exitPlanRequest", req });
      this.postMode();
    });

    client.on("plan", (u: any) => {
      if (!alive()) return;
      this.lastPlanText =
        (typeof u?.plan === "string" ? u.plan : "") ||
        (typeof u?.planText === "string" ? u.planText : "") ||
        (typeof u?.content === "string" ? u.content : "") ||
        this.lastPlanText;
    });

    client.on("planFileContent", (content: string) => {
      if (!alive()) return;
      if (typeof content === "string" && content.trim()) this.lastPlanText = content;
    });

    client.on("questionRequest", (req: unknown) => {
      if (!alive()) return;
      this.post({ type: "questionRequest", req });
    });

    client.on("commandDone", (info: any) => {
      if (!alive()) return;
      const MAX = 100_000;
      const over = (info.output?.length ?? 0) > MAX;
      this.post({
        type: "commandOutput",
        command: info.command,
        output: over ? info.output.slice(0, MAX) : info.output,
        exitCode: info.exitCode,
        truncated: info.truncated || over,
      });
    });

    client.on("subagentLifecycle", (u: unknown) => {
      if (!alive()) return;
      this.post({ type: "subagentUpdate", update: u });
    });

    client.on("xaiNotification", (u: any) => {
      if (!alive()) return;
      const kind = u?.sessionUpdate;
      if (kind === "subagent_spawned" || kind === "subagent_finished" || kind === "subagent_progress") {
        this.post({ type: "subagentUpdate", update: u });
      }
      if (kind === "auto_compact_completed" && typeof u?.tokens_after === "number") {
        this.post({ type: "contextUsage", used: u.tokens_after });
        this.post({ type: "autoCompactNotice", text: "Compacted." });
      }
      if (kind === "auto_compact_failed") {
        this.post({
          type: "autoCompactNotice",
          text: typeof u?.error === "string" ? `Compaction failed: ${u.error}` : "Compaction failed.",
        });
      }
      if (kind === "auto_compact_started") {
        this.post({ type: "autoCompactNotice", text: "Compacting context…" });
      }
    });

    client.on("mutationBlocked", (info: { kind: string; target: string }) => {
      if (!alive()) return;
      this.post({ type: "planBlocked", kind: info.kind, target: info.target });
    });

    client.on("exit", (code: number | null) => {
      if (!alive()) return;
      this.post({ type: "exit", code });
      this.post({ type: "setBusy", value: false });
      this.busy = false;
      this.client = undefined;
    });

    client.on("error", (err: Error) => {
      if (!alive()) return;
      this.post({ type: "agentError", text: err.message });
    });
  }

  private async forwardMedia(m: any, gen: number): Promise<void> {
    try {
      if (m.kind === "data") {
        this.post({ type: "media", media: m.media, src: `data:${m.mimeType};base64,${m.data}` });
        return;
      }
      if (m.kind === "uri") {
        this.post({ type: "media", media: m.media, url: m.uri });
        return;
      }
      if (m.path && fs.existsSync(m.path)) {
        const mime = m.mimeType || guessMime(m.path);
        const b64 = fs.readFileSync(m.path).toString("base64");
        if (gen !== this.gen) return;
        this.post({ type: "media", media: m.media, src: `data:${mime};base64,${b64}`, path: m.path, mimeType: mime });
      }
    } catch (e) {
      this.log(`media forward failed: ${(e as Error).message}`);
    }
  }

  private async runPrimer(client: any, gen: number): Promise<void> {
    try {
      await client.prompt(GROK_PRIMER);
      if (gen !== this.gen) return;
      this.primed = true;
    } catch (e) {
      this.log(`primer failed: ${(e as Error).message}`);
    }
  }

  private async ensurePrimed(client: any, gen: number): Promise<void> {
    if (this.primed) return;
    if (this.priming) {
      await this.priming;
      if (gen !== this.gen) return;
      if (this.primed) return;
    }
    this.priming = this.runPrimer(client, gen);
    await this.priming;
  }

  private async setMode(modeId: ModeId): Promise<void> {
    if (modeId === "yolo") {
      this.autoApprove = true;
      this.planActive = false;
    } else if (modeId === "plan") {
      this.autoApprove = false;
      this.planActive = true;
    } else {
      this.autoApprove = false;
      this.planActive = false;
    }
    if (this.client) this.client.planActive = this.planActive;
    try {
      if (this.client) {
        await this.client.setMode(modeId === "plan" ? "plan" : "agent");
      }
    } catch {
      /* ignore */
    }
    this.postMode();
  }

  private async setEffort(level: string): Promise<void> {
    this.effort = level === "none" ? "" : level;
    // Effort at spawn is most reliable; restart if we have a live session with no real history cost.
    if (this.client) {
      const sid = this.sessionId;
      if (this.client.currentModelSupportsEffort?.() && level && level !== "none") {
        try {
          await this.client.setReasoningEffort?.(level);
          this.post({ type: "initialState", effort: this.effort, cwd: this.cwd, useCtrlEnter: false, extVersion: this.version, showThinking: this.showThinking, expandCommandOutputs: this.expandCommandOutputs, steerByDefault: this.steerByDefault });
          return;
        } catch {
          /* fall through to restart */
        }
      }
      this.post({ type: "clearMessages" });
      this.resetSessionState(true);
      if (sid && this.hasHistory) {
        await this.startSession(sid);
      } else {
        await this.startSession();
      }
    }
  }

  private onPermissionAnswer(requestId: number | string, optionId: string): void {
    this.client?.respondPermission(requestId, optionId);
    this.post({ type: "permissionResolved", requestId, optionId });
    if (this.sessionId) {
      const outcome = /reject/i.test(optionId) ? "rejected" : "allowed";
      const entry = {
        title: `permission`,
        outcome: outcome as "allowed" | "rejected",
        afterUserMessage: this.userMessageCount,
      };
      const cur = this.meta[this.sessionId] ?? {};
      this.meta[this.sessionId] = {
        ...cur,
        permissions: [...(cur.permissions ?? []), entry],
      };
      saveMeta(this.meta);
    }
  }

  private onExitPlanAnswer(
    requestId: number | string,
    verdict: "approved" | "abandoned" | "rejected",
    comment?: string,
  ): void {
    this.client?.respondExitPlan(requestId, verdict);
    this.planActive = verdict === "rejected";
    if (this.client) this.client.planActive = this.planActive;
    this.post({ type: "planResolved", requestId, verdict });
    this.postMode();
    if (this.sessionId && this.lastPlanText) {
      const cur = this.meta[this.sessionId] ?? {};
      this.meta[this.sessionId] = {
        ...cur,
        plans: [
          ...(cur.plans ?? []),
          { text: this.lastPlanText, verdict, afterUserMessage: this.userMessageCount },
        ],
      };
      saveMeta(this.meta);
    }
    // Follow-up note for the agent when user adds a comment
    if (comment?.trim() && this.client && !this.busy) {
      void this.handleSend(`[Plan ${verdict}] ${comment.trim()}`, true);
    }
  }

  private async handleSend(text: string, bare: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      this.post({ type: "error", text: "No active session. Use Re-check connection or install/login." });
      return;
    }
    if (this.busy) {
      // Queue if busy (unless steer-by-default)
      if (this.steerByDefault && text.trim()) {
        await this.steerSend(text);
        return;
      }
      this.queueSend(text);
      return;
    }
    const gen = this.gen;
    const trimmed = text ?? "";
    if (!trimmed.trim() && !bare && this.chips.filter((c) => !c.hidden).length === 0) return;

    // Pre-read images
    const chips = bare ? [] : [...this.chips];
    const images: Array<{ index: number; mimeType: string; data: string; relPath?: string }> = [];
    for (const chip of chips) {
      if (chip.hidden || !isImageChip(chip)) continue;
      try {
        const bytes = await fs.promises.readFile(chip.path);
        if (bytes.length === 0) throw new Error("file is empty");
        images.push({
          index: chip.imageIndex!,
          mimeType: chip.mimeType ?? "image/png",
          data: bytes.toString("base64"),
          relPath: chip.originRelPath,
        });
      } catch (e) {
        this.post({
          type: "agentError",
          text: `Could not read ${chip.relPath} (${(e as Error).message}). Remove the attachment and try again.`,
        });
        return;
      }
    }
    if (gen !== this.gen) return;

    const slashCommand = matchSlashCommand(
      trimmed,
      (client.availableCommands ?? []).map((c: any) => c.name),
    );
    const { blocks } = buildPromptWithImages(
      trimmed,
      chips,
      images,
      {
        readFile: (p: string) => fs.readFileSync(p, "utf8"),
        extName: (p: string) => path.extname(p),
      },
      slashCommand != null,
    );

    if (!bare) {
      this.chips = consumeChips(this.chips, chips);
      this.postChips();
      for (const chip of chips) {
        if (isImageChip(chip)) void fs.promises.unlink(chip.path).catch(() => {});
      }
    }

    this.hasHistory = true;
    this.userMessageCount += 1;
    const sentChips = chips.filter((c: Chip) => !c.hidden);
    this.busy = true;
    this.post({ type: "userMessage", text: trimmed, chips: sentChips });
    this.post({ type: "agentStart" });
    this.post({ type: "setBusy", value: true });

    try {
      await this.ensurePrimed(client, gen);
      if (gen !== this.gen) return;
      const meta = await client.prompt(blocks);
      if (gen !== this.gen) return;
      this.post({ type: "promptComplete", meta });
      this.post({ type: "agentEnd", meta });
      if (this.sessionId) {
        const usage = readContextUsage({
          fs,
          grokHome: resolveGrokHome(process.env),
          cwd: this.cwd,
          id: this.sessionId,
        });
        if (usage) this.post({ type: "contextUsage", used: usage.used, window: usage.window });
      }
      this.postSessionsList({});
    } catch (e) {
      if (gen !== this.gen) return;
      this.post({ type: "agentError", text: (e as Error).message });
      this.post({ type: "agentEnd" });
    } finally {
      if (gen === this.gen) {
        this.busy = false;
        this.post({ type: "setBusy", value: false });
        void this.flushQueue();
      }
    }
  }

  private queueSend(text: string): void {
    if (!text.trim()) return;
    if (this.queuedSends.length) this.queuedSends[0] += "\n\n" + text;
    else this.queuedSends.push(text);
    this.post({ type: "queuedSends", items: [...this.queuedSends] });
    if (!this.busy) void this.flushQueue();
  }

  private async flushQueue(): Promise<void> {
    if (this.busy || !this.queuedSends.length || !this.client) return;
    const next = this.queuedSends.shift()!;
    this.post({ type: "queuedSends", items: [...this.queuedSends] });
    await this.handleSend(next, false);
  }

  private async steerSend(text: string): Promise<void> {
    if (!this.client || !text.trim()) return;
    try {
      const r = await this.client.interject(text);
      if (r === "unsupported") {
        this.post({ type: "steerUnavailable" });
        this.queueSend(text);
      } else {
        this.post({ type: "userMessage", text: `[steer] ${text}`, chips: [] });
      }
    } catch (e) {
      this.post({ type: "error", text: `Steer failed: ${(e as Error).message}` });
      this.queueSend(text);
    }
  }

  private async forkSession(): Promise<void> {
    if (!this.client || !this.sessionId) {
      this.post({ type: "error", text: "Nothing to fork yet." });
      return;
    }
    try {
      const r = await this.client.forkSession(this.cwd);
      if (r === "unsupported") {
        this.post({ type: "error", text: "This Grok CLI does not support session fork." });
        return;
      }
      const parentName =
        this.meta[this.sessionId]?.customName ||
        fallbackName("", Date.now());
      this.meta[r.newSessionId] = {
        ...(this.meta[r.newSessionId] ?? {}),
        customName: forkDisplayName(parentName),
      };
      saveMeta(this.meta);
      await this.resumeSession(r.newSessionId);
    } catch (e) {
      this.post({ type: "error", text: `Fork failed: ${(e as Error).message}` });
    }
  }

  private postSessionsList(opts: { offset?: number; limit?: number; query?: string }): void {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 30;
    const query = (opts.query ?? "").toLowerCase();
    let entries = listSessions({
      fs,
      grokHome: resolveGrokHome(process.env),
      cwd: this.cwd,
      overrides: this.meta,
      log: (m: string) => this.log(m),
    }).filter((e: any) => e.kind !== "subagent");

    if (query) {
      entries = entries.filter(
        (e: any) =>
          e.displayName.toLowerCase().includes(query) ||
          (e.rawSummary || "").toLowerCase().includes(query),
      );
    }

    const total = entries.length;
    const page = entries.slice(offset, offset + limit);
    // Dot union matches session-pool: working | needs-you | unread | error | none
    const dots: Record<string, string> = {};
    for (const e of page) {
      if (e.id === this.sessionId && this.busy) dots[e.id] = "working";
      else if (this.meta[e.id]?.unreadError) dots[e.id] = "error";
      else if (this.meta[e.id]?.unread) dots[e.id] = "unread";
      else dots[e.id] = "none";
    }

    this.post({
      type: "sessions",
      entries: page,
      activeId: this.sessionId,
      dots,
      offset,
      total,
      hasMore: offset + page.length < total,
      nextOffset: offset + page.length,
      query: opts.query ?? "",
    });
  }

  private async resumeSession(id: string): Promise<void> {
    this.post({ type: "clearMessages" });
    this.post({ type: "agentReset" });
    this.resetSessionState(true);
    await this.startSession(id);
  }

  private renameSession(id: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.meta[id] = { ...(this.meta[id] ?? {}), customName: n };
    saveMeta(this.meta);
    this.postSessionsList({});
  }

  private async deleteSession(id: string): Promise<void> {
    try {
      deleteSessionDir({
        fs,
        grokHome: resolveGrokHome(process.env),
        cwd: this.cwd,
        id,
      });
    } catch (e) {
      this.log(`delete failed: ${(e as Error).message}`);
    }
    delete this.meta[id];
    saveMeta(this.meta);
    if (this.sessionId === id) {
      await this.restartSession();
    } else {
      this.postSessionsList({});
    }
  }

  private async clearAllSessions(): Promise<void> {
    const exceptId = this.sessionId;
    try {
      const removed: string[] = clearSessions({
        fs,
        grokHome: resolveGrokHome(process.env),
        cwd: this.cwd,
        exceptId,
      });
      for (const id of removed) delete this.meta[id];
      saveMeta(this.meta);
    } catch (e) {
      this.post({ type: "error", text: `Clear failed: ${(e as Error).message}` });
    }
    this.postSessionsList({});
  }

  private async pickFiles(): Promise<void> {
    if (!this.opts.pickFiles) {
      this.post({ type: "error", text: "File picker unavailable." });
      return;
    }
    const paths = await this.opts.pickFiles();
    for (const p of paths) await this.addFile(p);
  }

  private async addFile(absPath: string): Promise<void> {
    const resolved = path.resolve(absPath);
    if (!fs.existsSync(resolved)) {
      this.post({ type: "error", text: `File not found: ${absPath}` });
      return;
    }
    const rel = path.relative(this.cwd, resolved) || path.basename(resolved);
    const stat = fs.statSync(resolved);
    if (isVisionImagePath(resolved) && stat.size > 0 && stat.size <= MAX_VISION_IMAGE_BYTES) {
      this.imageCounter += 1;
      const staged = path.join(os.tmpdir(), `grok-desk-img-${this.imageCounter}${path.extname(resolved)}`);
      fs.copyFileSync(resolved, staged);
      this.chips.push(makeImageChip(staged, this.imageCounter, mimeFromPath(resolved), rel.replace(/\\/g, "/")));
    } else {
      this.chips.push(makeExplicitChip(resolved, rel.replace(/\\/g, "/")));
    }
    this.postChips();
  }

  private async pasteImage(data: string, mimeType: string): Promise<void> {
    if (!isVisionMime(mimeType)) {
      this.post({ type: "error", text: `Unsupported image type: ${mimeType}` });
      return;
    }
    const buf = Buffer.from(data, "base64");
    if (buf.length > MAX_VISION_IMAGE_BYTES) {
      this.post({ type: "error", text: "Image exceeds 20 MiB limit." });
      return;
    }
    this.imageCounter += 1;
    const staged = path.join(os.tmpdir(), `grok-desk-paste-${this.imageCounter}${extFromMime(mimeType)}`);
    fs.writeFileSync(staged, buf);
    this.chips.push(makeImageChip(staged, this.imageCounter, mimeType));
    this.postChips();
  }

  private async openFile(p: string): Promise<void> {
    let target = p;
    if (!path.isAbsolute(target)) target = path.join(this.cwd, target);
    // Strip line refs like path:10-20
    target = target.replace(/:\d+(-\d+)?$/, "");
    const err = await shell.openPath(target);
    if (err) this.post({ type: "error", text: err });
  }

  private async openDiff(filePath: string, oldText: string, newText: string): Promise<void> {
    const dir = path.join(os.tmpdir(), "grok-desk-diffs");
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(filePath).replace(/[^\w.-]+/g, "_") || "file";
    const oldP = path.join(dir, `${base}.old.txt`);
    const newP = path.join(dir, `${base}.new.txt`);
    fs.writeFileSync(oldP, oldText, "utf8");
    fs.writeFileSync(newP, newText, "utf8");

    // Prefer VS Code / Cursor diff if available
    for (const bin of ["code", "cursor", "code-insiders"]) {
      try {
        const r = spawn(bin, ["--diff", oldP, newP], { detached: true, stdio: "ignore", shell: true });
        r.unref();
        return;
      } catch {
        /* try next */
      }
    }
    // Fallback: open both files
    await shell.openPath(oldP);
    await shell.openPath(newP);
  }

  private runInstallCmd(): void {
    const cmd =
      process.platform === "win32"
        ? `irm https://x.ai/cli/install.ps1 | iex; Write-Host "\`nDone. Return to Grok Desk and click Re-check connection."`
        : `curl -fsSL https://x.ai/cli/install.sh | bash; echo; echo "Done. Return to Grok Desk and click Re-check connection."`;
    openInSystemTerminal(cmd);
  }

  private runGrokLogin(): void {
    const cli = this.cliPath();
    if (!cli) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    const quoted = process.platform === "win32" ? `& '${cli.replace(/'/g, "''")}' login` : `'${cli}' login`;
    openInSystemTerminal(quoted);
  }

  private async logout(): Promise<void> {
    const cli = this.cliPath();
    if (!cli) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(cli, ["logout"], { stdio: "ignore" });
        p.on("exit", () => resolve());
        p.on("error", reject);
      });
    } catch (e) {
      this.log(`logout: ${(e as Error).message}`);
    }
    this.post({ type: "clearMessages" });
    this.resetSessionState();
    this.post({ type: "onboarding", state: "auth-required", platform: process.platform });
  }

  private async checkGrokUpdate(): Promise<void> {
    const cli = this.cliPath();
    if (!cli) return;
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(cli, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        p.stdout.on("data", (d) => (buf += d));
        p.on("exit", () => resolve(buf));
        p.on("error", reject);
      });
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      this.post({
        type: "grokUpdateStatus",
        current: m?.[1] ?? out.trim(),
        latest: null,
        updateAvailable: false,
      });
    } catch (e) {
      this.post({ type: "grokUpdateStatus", error: (e as Error).message });
    }
  }

  private async updateGrok(): Promise<void> {
    this.post({ type: "cliUpdating" });
    // Tear down sessions so Windows can replace the binary
    this.gen++;
    if (this.client) {
      await this.client.dispose();
      this.client = undefined;
    }
    openInSystemTerminal(
      process.platform === "win32"
        ? `grok update; Write-Host "\`nDone. Return to Grok Desk and click Re-check connection."`
        : `grok update; echo; echo "Done. Return to Grok Desk and click Re-check connection."`,
    );
    this.post({ type: "error", text: "Updating in a system terminal. Click Re-check when finished." });
  }
}
