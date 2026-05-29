import { ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as os from "node:os";

export interface TerminalCreateParams {
  command: string; // single shell-quoted string per ACP
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}

export interface TerminalOutputResult {
  output: string;
  exitStatus: { exitCode: number } | null;
  truncated: boolean;
}

interface TerminalEntry {
  proc: ChildProcess;
  buf: string;
  byteLen: number;
  truncated: boolean;
  exitCode: number | null;
  exitListeners: Array<(code: number) => void>;
  byteLimit: number;
  // Buffers incomplete multi-byte UTF-8 sequences across chunk boundaries so a
  // character split by streaming (or by truncation) never becomes a U+FFFD.
  decoder: StringDecoder;
}

const DEFAULT_BYTE_LIMIT = 40_000;

/**
 * Resolve a child's reported `(code, signal)` to a single exit code. A process
 * killed by a signal reports `code === null`; the old `code ?? 0` masked that as
 * a clean success, so the agent assumed an interrupted command had finished OK.
 * Map signal kills to the shell convention `128 + signum` (SIGTERM → 143).
 */
export function resolveExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code != null) return code;
  if (signal) {
    const num = (os.constants.signals as Record<string, number>)[signal];
    return num ? 128 + num : 1;
  }
  return 0;
}

export type KillPlan =
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "taskkill"; file: string; args: string[] };

/**
 * On Windows `spawn(..., { shell: true })` wraps the command in `cmd.exe`, and
 * `proc.kill("SIGTERM")` only terminates that wrapper — long-running descendants
 * (npm, node, …) survive as orphans holding file locks. `taskkill /T /F` kills
 * the whole tree. POSIX keeps the direct signal. (Args, not a shell string, so
 * there's no shell to interpret anything — pid is numeric anyway.)
 */
export function buildKillPlan(pid: number, platform: NodeJS.Platform = process.platform): KillPlan {
  if (platform === "win32") {
    return { kind: "taskkill", file: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  return { kind: "signal", signal: "SIGTERM" };
}

/**
 * Manages background processes spawned on behalf of the agent's `terminal/*`
 * ACP requests. Each terminal is a headless shell child process (cmd.exe on
 * Windows, /bin/sh elsewhere — picked by Node when `shell: true`) whose
 * stdout+stderr is captured into a single rolling buffer respecting
 * `outputByteLimit`.
 */
export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();
  private nextId = 1;

  create(params: TerminalCreateParams): { terminalId: string } {
    const env = this.envFromParams(params.env);
    const cwd = params.cwd || process.cwd();
    const byteLimit = params.outputByteLimit ?? DEFAULT_BYTE_LIMIT;
    const proc = spawn(params.command, { cwd, env, shell: true });

    const entry: TerminalEntry = {
      proc,
      buf: "",
      byteLen: 0,
      truncated: false,
      exitCode: null,
      exitListeners: [],
      byteLimit,
      decoder: new StringDecoder("utf8"),
    };

    const onChunk = (d: Buffer) => {
      if (entry.byteLen >= entry.byteLimit) {
        entry.truncated = true;
        return;
      }
      const remaining = entry.byteLimit - entry.byteLen;
      const slice = d.length > remaining ? d.subarray(0, remaining) : d;
      // decoder.write emits only complete characters; any bytes that fall on a
      // truncation/chunk boundary mid-character are held back, not corrupted.
      entry.buf += entry.decoder.write(slice);
      entry.byteLen += slice.length;
      if (d.length > remaining) entry.truncated = true;
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (err) => {
      entry.buf += `\n[spawn error] ${err.message}`;
      entry.exitCode = -1;
      for (const l of entry.exitListeners) l(-1);
      entry.exitListeners = [];
    });
    proc.on("exit", (code, signal) => {
      if (entry.exitCode != null) return; // spawn error already set it; don't clobber
      // Flush any trailing complete bytes for a clean run. Skip when truncated:
      // the decoder may hold a partial of a *dropped* char, and end() would turn
      // that into a U+FFFD.
      if (!entry.truncated) entry.buf += entry.decoder.end();
      entry.exitCode = resolveExitCode(code, signal);
      for (const l of entry.exitListeners) l(entry.exitCode!);
      entry.exitListeners = [];
    });

    const terminalId = `t-${this.nextId++}`;
    this.terminals.set(terminalId, entry);
    return { terminalId };
  }

  output(terminalId: string): TerminalOutputResult {
    const t = this.required(terminalId);
    return {
      output: t.buf,
      exitStatus: t.exitCode != null ? { exitCode: t.exitCode } : null,
      truncated: t.truncated,
    };
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number }> {
    const t = this.required(terminalId);
    if (t.exitCode != null) return Promise.resolve({ exitCode: t.exitCode });
    return new Promise((resolve) => {
      t.exitListeners.push((code) => resolve({ exitCode: code }));
    });
  }

  kill(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    const pid = t.proc.pid;
    try {
      const plan: KillPlan = pid != null ? buildKillPlan(pid) : { kind: "signal", signal: "SIGTERM" };
      if (plan.kind === "taskkill") {
        // Fire-and-forget; the tree may already be gone (ignore the error).
        execFile(plan.file, plan.args, () => { /* best-effort */ });
      } else {
        t.proc.kill(plan.signal);
      }
    } catch {
      /* ignore */
    }
  }

  release(terminalId: string): void {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
  }

  disposeAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.release(id);
  }

  private required(terminalId: string): TerminalEntry {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`unknown terminalId: ${terminalId}`);
    return t;
  }

  private envFromParams(envParam: TerminalCreateParams["env"]): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (Array.isArray(envParam)) {
      for (const e of envParam) env[e.name] = e.value;
    }
    return env;
  }
}
