/**
 * Minimal ACP host for the Electron shell.
 * Reuses the compiled extension core (AcpClient, TerminalManager, cli-locator).
 * Not feature-parity with the VS Code sidebar — core chat + tools + permissions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";

// Compiled parent package (run `npm run compile` at repo root first).
// Runtime requires only — do not `import type` from ../src (breaks desktop rootDir).
/* eslint-disable @typescript-eslint/no-require-imports */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { AcpClient } = require("../../out/acp") as { AcpClient: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { locateGrokCli } = require("../../out/cli-locator") as { locateGrokCli: (p: string) => string | undefined };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { TerminalManager, grokShellEnvValue, resolvedTerminalShell } = require("../../out/terminal-manager") as {
  TerminalManager: new () => {
    disposeAll(): void;
  };
  grokShellEnvValue: (resolved: string | true, platform?: NodeJS.Platform) => string | undefined;
  resolvedTerminalShell: () => string | true;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GROK_PRIMER, isPrimerText } = require("../../out/grok-primer") as {
  GROK_PRIMER: string;
  isPrimerText: (t: string) => boolean;
};
/* eslint-enable @typescript-eslint/no-require-imports */

export type PostFn = (msg: Record<string, unknown>) => void;

export interface DesktopHostOptions {
  cwd: string;
  post: PostFn;
  log?: (line: string) => void;
  packageVersion?: string;
}

type ModeId = "agent" | "plan" | "yolo";

export class DesktopHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client?: any;
  private terminals = new TerminalManager();
  private gen = 0;
  private sessionId?: string;
  private busy = false;
  private autoApprove = false;
  private planActive = false;
  private priming?: Promise<void>;
  private primed = false;
  private readonly log: (line: string) => void;
  private readonly version: string;

  constructor(private opts: DesktopHostOptions) {
    this.log = opts.log ?? ((l) => console.log(`[host] ${l}`));
    this.version = opts.packageVersion ?? "0.1.0";
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
          this.client?.respondPermission(msg.requestId as number | string, String(msg.optionId));
          this.post({ type: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId });
          break;
        case "exitPlanAnswer":
          this.client?.respondExitPlan(
            msg.requestId as number | string,
            msg.verdict as "approved" | "abandoned" | "rejected",
          );
          this.planActive = msg.verdict === "rejected";
          if (this.client) this.client.planActive = this.planActive;
          this.post({
            type: "planResolved",
            requestId: msg.requestId,
            verdict: msg.verdict,
          });
          this.postMode();
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
            } catch (e) {
              this.post({ type: "error", text: `Model switch failed: ${(e as Error).message}` });
            }
          }
          break;
        case "setShowThinking":
          this.post({ type: "showThinking", value: !!msg.value });
          break;
        case "setExpandCommandOutputs":
          this.post({ type: "expandCommandOutputs", value: !!msg.value });
          break;
        case "setSteerByDefault":
          this.post({ type: "steerByDefault", value: !!msg.value });
          break;
        case "openUrl":
          if (typeof msg.url === "string") void shell.openExternal(msg.url);
          break;
        case "openFile":
          if (typeof msg.path === "string") {
            const p = path.isAbsolute(msg.path)
              ? msg.path
              : path.join(this.opts.cwd, msg.path);
            void shell.openPath(p);
          }
          break;
        case "openDiff":
          // Desktop MVP: open the target file; full diff UI later.
          if (typeof msg.path === "string") void shell.openPath(String(msg.path));
          break;
        case "listSessions":
          this.post({
            type: "sessions",
            entries: [],
            activeId: this.sessionId,
            dots: {},
            offset: 0,
            total: 0,
            hasMore: false,
            nextOffset: 0,
            query: "",
          });
          break;
        case "queueSend":
        case "dequeueSend":
        case "clearQueuedSends":
        case "steerSend":
        case "forkSession":
        case "resumeSession":
        case "renameSession":
        case "deleteSession":
        case "clearAllSessions":
        case "pickFile":
        case "pasteImage":
        case "voiceStart":
        case "voiceStop":
        case "dropFile":
        case "removeChip":
        case "toggleChip":
        case "pickModel":
        case "setEffort":
        case "checkGrokUpdate":
        case "updateGrok":
        case "runInstallCmd":
        case "runGrokLogin":
        case "logout":
        case "recheckConnection":
        case "openGlobalConfig":
        case "openProjectConfig":
        case "runMcpList":
        case "showLogs":
        case "moveView":
        case "exportExpr":
          // Stubs — not yet implemented in desktop shell.
          this.log(`unimplemented webview msg: ${msg.type}`);
          break;
        default:
          this.log(`unknown webview msg: ${msg.type}`);
      }
    } catch (e) {
      this.log(`handle error: ${(e as Error).message}`);
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
      effort: "",
      cwd: this.opts.cwd,
      useCtrlEnter: false,
      extVersion: this.version,
      showThinking: false,
      expandCommandOutputs: false,
      steerByDefault: false,
    });
    this.post({ type: "voiceConfigured", value: false });
    this.post({ type: "chips", chips: [] });
    this.postMode();
  }

  private postMode(): void {
    const modeId: ModeId = this.planActive ? "plan" : this.autoApprove ? "yolo" : "agent";
    this.post({ type: "modeChanged", modeId });
  }

  private async boot(): Promise<void> {
    const cliPath = locateGrokCli("");
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    await this.startSession(cliPath);
  }

  private async restartSession(): Promise<void> {
    this.post({ type: "clearMessages" });
    this.post({ type: "agentReset" });
    this.primed = false;
    this.priming = undefined;
    this.planActive = false;
    this.autoApprove = false;
    const cliPath = locateGrokCli("");
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    await this.startSession(cliPath);
  }

  private async startSession(cliPath: string): Promise<void> {
    this.gen++;
    const gen = this.gen;
    if (this.client) {
      await this.client.dispose();
      this.client = undefined;
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (env["XAI_API_KEY"] && !env["GROK_CODE_XAI_API_KEY"]) {
      env["GROK_CODE_XAI_API_KEY"] = env["XAI_API_KEY"];
    }
    if (!("GROK_SHELL" in env)) {
      const grokShell = grokShellEnvValue(resolvedTerminalShell(), process.platform);
      if (grokShell) env["GROK_SHELL"] = grokShell;
    }

    const client = new AcpClient({
      cliPath,
      cwd: this.opts.cwd,
      env,
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
      const { sessionId } = await client.newSession();
      if (gen !== this.gen) return;
      this.sessionId = sessionId;
      this.post({
        type: "session",
        sessionId,
        models: client.availableModels,
        currentModelId: client.currentModelId,
      });
      this.postMode();
      // Fire-and-forget primer (same idea as the VS Code host).
      this.priming = this.runPrimer(client, gen);
      void this.priming;
    } catch (e) {
      const text = (e as Error).message || String(e);
      this.log(`start failed: ${text}`);
      if (/auth|login|401|403|unauthorized/i.test(text)) {
        this.post({ type: "onboarding", state: "auth-required", platform: process.platform });
      } else {
        this.post({ type: "agentError", text });
        this.post({ type: "error", text });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wireClient(client: any, gen: number): void {
    const alive = () => gen === this.gen;

    client.on("initialized", (init: { serverInfo?: { version?: string }; version?: string; protocolVersion?: unknown }) => {
      if (!alive()) return;
      this.post({
        type: "initialized",
        info: {
          cliPath: locateGrokCli("") ?? "",
          cwd: this.opts.cwd,
          version: init?.serverInfo?.version ?? init?.version ?? null,
          init: { protocolVersion: init?.protocolVersion },
        },
      });
    });

    client.on("session", (res: { sessionId?: string }) => {
      if (!alive()) return;
      if (res?.sessionId) this.sessionId = res.sessionId;
      this.post({
        type: "session",
        sessionId: res.sessionId,
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
      if (!alive()) return;
      // Only relevant on session load/replay — desktop MVP has no resume yet.
      if (isPrimerText(text)) return;
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

    client.on("permissionRequest", (req: {
      id: number | string;
      options: Array<{ optionId: string; kind: string }>;
      toolCall?: { kind?: string; title?: string };
    }) => {
      if (!alive()) return;
      if (this.autoApprove) {
        const opt =
          req.options.find((o) => o.kind === "allow_always") ??
          req.options.find((o) => o.kind === "allow_once");
        if (opt) {
          client.respondPermission(req.id, opt.optionId);
          return;
        }
      }
      this.post({ type: "permissionRequest", req });
      this.post({ type: "setBusy", value: true });
    });

    client.on("exitPlanRequest", (req: { id: number | string; sessionId: string; plan: string }) => {
      if (!alive()) return;
      this.planActive = true;
      client.planActive = true;
      this.post({ type: "exitPlanRequest", req });
      this.postMode();
    });

    client.on("questionRequest", (req: unknown) => {
      if (!alive()) return;
      this.post({ type: "questionRequest", req });
    });

    client.on("commandDone", (info: {
      command: string;
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }) => {
      if (!alive()) return;
      const MAX = 100_000;
      const over = info.output.length > MAX;
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

    client.on("xaiNotification", (u: unknown) => {
      if (!alive()) return;
      const kind = (u as { sessionUpdate?: string })?.sessionUpdate;
      if (kind === "subagent_spawned" || kind === "subagent_finished" || kind === "subagent_progress") {
        this.post({ type: "subagentUpdate", update: u });
      }
    });

    client.on("exit", (code: number | null) => {
      if (!alive()) return;
      this.post({ type: "exit", code });
      this.post({ type: "setBusy", value: false });
      this.busy = false;
    });

    client.on("error", (err: Error) => {
      if (!alive()) return;
      this.post({ type: "agentError", text: err.message });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async runPrimer(client: any, gen: number): Promise<void> {
    try {
      await client.prompt(GROK_PRIMER);
      if (gen !== this.gen) return;
      this.primed = true;
    } catch (e) {
      this.log(`primer failed: ${(e as Error).message}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Best-effort CLI mode (CLI may only know agent/plan).
    try {
      if (this.client) await this.client.setMode(modeId === "yolo" ? "agent" : modeId === "plan" ? "plan" : "agent");
    } catch {
      /* ignore */
    }
    this.postMode();
  }

  private async handleSend(text: string, bare: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      this.post({ type: "error", text: "No active session. Is the Grok CLI installed and logged in?" });
      return;
    }
    if (this.busy) {
      this.post({ type: "error", text: "Busy — wait for the current turn or press Stop." });
      return;
    }
    const gen = this.gen;
    const trimmed = text ?? "";
    if (!trimmed.trim() && !bare) return;

    this.busy = true;
    this.post({ type: "userMessage", text: trimmed, chips: [] });
    this.post({ type: "agentStart" });
    this.post({ type: "setBusy", value: true });

    try {
      await this.ensurePrimed(client, gen);
      if (gen !== this.gen) return;
      const meta = await client.prompt(trimmed);
      if (gen !== this.gen) return;
      this.post({ type: "promptComplete", meta });
      this.post({ type: "agentEnd", meta });
    } catch (e) {
      if (gen !== this.gen) return;
      this.post({ type: "agentError", text: (e as Error).message });
      this.post({ type: "agentEnd" });
    } finally {
      if (gen === this.gen) {
        this.busy = false;
        this.post({ type: "setBusy", value: false });
      }
    }
  }
}
