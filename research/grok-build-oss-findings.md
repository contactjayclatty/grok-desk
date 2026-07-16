# Grok Build CLI open-source drop — what our ACP feedback can now become

**Basis:** https://github.com/xai-org/grok-build cloned to `C:\github\grok-build-CLI` (2026-07-16).
Single squashed commit ("Publish harness and TUI open-source"), synced periodically from xAI's
monorepo; crate versions are lockstep dev placeholders (`0.1.220-alpha.4` / `0.2.0-dev`), so the
tree can't be pinned to a shipped 0.2.x — but it contains the `exit_plan_mode` outcome semantics we
first observed on **0.2.101**, so it is at least that new. **External contributions are not
accepted** (CONTRIBUTING.md), so "implement" below means *client-side in grok-build-vscode*; the
source access additionally lets [docs/ACP-feedback.md](../docs/ACP-feedback.md) cite exact
file:line, which makes each ask trivially actionable for xAI.

**Every "implement now" item still needs a live probe against the shipped Windows stable build
before we build on it** — the OSS tree may be ahead of what `x.ai/cli/install.ps1` ships. Paths
below are relative to `C:\github\grok-build-CLI\crates\codegen\`.

---

## The headline: three discoveries that change our architecture

### 1. §2.11 / issue #49 — machine-dependent permission prompts: ROOT CAUSE FOUND

grok silently merges **Claude Code's settings** into its permission policy. The resolver
(`xai-grok-workspace/src/permission/resolution.rs:493-498` → `find_claude_settings_paths`,
`claude_settings.rs:374-430`) reads, per host:

- `~/.claude/settings.local.json`, `~/.claude/settings.json` (global, per-user)
- every project `.claude/settings*.json` from cwd up to the repo root

`permissions.defaultMode: "acceptEdits"` becomes a synthetic **Allow Edit** rule
(`resolution.rs:60-67`); `"bypassPermissions"` becomes **Allow Any** (`:52-59`); an
edit-covering `permissions.allow` entry translates directly (`claude_settings.rs:50-72`). Any of
these makes the policy evaluation return Allow, which short-circuits **before the prompter**
(`manager.rs:1320-1336`) — so `session/request_permission` is never sent. The client's
`support_permission` capability is read and then **explicitly ignored** (`spawn.rs:217`).

So: a dev box that also runs Claude Code with `acceptEdits`/`bypassPermissions`/edit-allow in
`~/.claude/settings.json` gets zero edit prompts; a pristine VM prompts every time. Identical grok
config. Exactly the #49 symptom.

Other machine-dependent inputs on the same path:
- `~/.grok/config.toml` `[claude_compat].imported = true` (or env `_GROK_CLAUDE_MARKER_OVERRIDE=1`)
  **disables** the whole `.claude` fallback (`claude_settings.rs:512-554`) — a user-side remedy.
- `~/.grok/sessions/<encoded-cwd>/permission.toml` — persisted per-project grants (`manager.rs:935`).
- Managed layers: `requirements.toml`, `managed-settings.json` (`resolution.rs:194-210, 508-524`).
- `defaultMode: "dontAsk"` produces the *opposite* failure (auto-deny instead of prompt,
  `manager.rs:1476-1484`).

**Implement:** extend `src/grok-config.ts` to read the Claude-settings chain (+
`permission.toml`, `[claude_compat].imported`) and (a) show an honest mode label
("Auto accept — from ~/.claude/settings.json") like we already do for `[ui] permission_mode`,
(b) explain *why* no permission cards appear, with the remedy. Then answer #49 with the root
cause. Also check this dev box's `~/.claude/settings.json` — it is almost certainly the reason
our machine never prompts.

### 2. The `x.ai/session_notification` live rail — we were listening on the wrong method

There are **two rails** for xAI session events, and they are not the same:

- `_x.ai/session/update` — the **persist** tag written to `updates.jsonl`
  (`xai-grok-shell/src/session/storage/mod.rs:96,156`). Never pushed live. On `session/load` the
  surviving lines are re-forwarded re-tagged **`x.ai/session/update`** (`agent/mvp_agent/mod.rs:1307-1351`).
- **`x.ai/session_notification`** — the **live** push. Both emitters are unconditional (no
  capability/config gate): the session actor's `send_xai_notification`
  (`session/acp_session_impl/updates.rs:701-744` — persists *and* sends the ExtNotification) and
  the subagent coordinator's `emit_subagent_notification` (`agent/subagent/mod.rs:2216-2242`).

Our `acp.ts` routes `_x.ai/session/update` — the disk-only rail — which is why we live-verified
"zero lifecycle events arrive while `updates.jsonl` fills" (§2.4). The live events ride a method
we never subscribed to.

Payloads on this one rail (`extensions/notification.rs`):
- `SubagentSpawned` (`:560-595` — model, persona, role, capability_mode) and `SubagentFinished`
  (`:629-657` — **duration_ms, tokens_used, output, will_wake**); `SubagentProgress` (live-only,
  not persisted, `subagent/mod.rs:2291-2293`).
- `AutoCompactStarted` / **`AutoCompactCompleted { tokens_before, tokens_after }`**
  (`:369-392`) — **also fired by a manual `/compact`** (`session/compaction.rs:629-639`).
- `TurnCompleted { usage }` (billing usage per turn, `session/turn_completion.rs:18-33`).
- `ImageDropped { notes }` (`acp_session_impl/turn.rs:189-196`) — the "silently dropped
  attachment" from §2.5, not silent after all.

**Implement:** one new notification handler in `acp.ts` for `x.ai/session_notification` (+ the
`x.ai/session/update` replay form) unlocks, in one shot: real subagent lifecycle UI
(duration/tokens without envelope parsing), the post-`/compact` token count (**delete the hidden
`/session-info` scrape turn**, `refreshContextAfterCompact`), and a user-visible dropped-image
notice. **Probe first:** confirm the shipped stable build emits it (our 0.2.93 evidence only
covers the persist rail).

### 3. §2.6 — session list/search/rename/delete/fork RPCs already exist, unadvertised

The `ext_method` router (`agent/mvp_agent/acp_agent.rs:3164-3508`) dispatches — unconditionally,
no feature gate, just never advertised in `initialize`:

- `x.ai/session/list` + `x.ai/sessions/list` (:3168), `x.ai/session/search` (:3181 — the SQLite
  FTS index behind `grok sessions search`), `x.ai/session/rename`, `x.ai/session/delete`,
  `x.ai/session/fork` (:3189, handlers in `extensions/session_admin.rs`), `x.ai/session/info`,
  `x.ai/session/close`, `x.ai/session/load_history`, `x.ai/session/updates`, `x.ai/session/repair`.
- List rows carry **`sessionKind`** in item `_meta` (`session/unified_list/row.rs:18-53`,
  `mod.rs:400`) — subagent filtering without reading `summary.json`.

**Implement (staged):** probe the request/response schemas, then adopt **rename/delete** first
(kills the `grok.sessionMeta` rename-override store and our `deleteSessionDir`), then
**list/search** (replaces `indexSessions`/`readSessionEntries`/`sessionCache` disk scraping — §
History pagination). Keep the disk path as fallback for older builds. `fork` is a future feature.
The full router table (git, worktree, interject, rewind, task/scheduler, compact_conversation…)
is in the same match — see "Roadmap unlocks" below.

---

## The rest, by feedback section

### §2.1 Plan mode

- **The terminal hole is confirmed present at HEAD.** `plan_mode_edit_gate`
  (`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:166-181`) rejects only
  `AccessKind::Edit`; `Bash` falls to `_ => PlanEditGate::Allow` — its own doc-comment says bash
  is never gated there. Our client-side gate (`src/plan-gate.ts`) remains the only barrier; keep
  it. Upstream fix would be ~10 lines in that one function (the caller already maps any
  non-Allow verdict to a rejection message) — worth citing in ACP-feedback.md.
- **Semantic rejection exists — we've been using the wrong shape.** The client should reply to
  `x.ai/exit_plan_mode` with a JSON-RPC **success** carrying
  `{"outcome": "approved" | "cancelled" | "abandoned"}` (+ optional feedback)
  (`xai-grok-tools/src/implementations/grok_build/exit_plan_mode/types.rs:18-25`, mapped at
  `tool_calls.rs:193-203`; unknown → cancelled, fail-closed). `cancelled` = keep planning (the CLI
  itself tells the model "user wants to revise", `tool_calls.rs:1266-1287`); `abandoned` =
  deactivate plan mode. A JSON-RPC **error** — what we send today — is treated as *client
  disconnect* (`ext_method_no_client`, `tool_calls.rs:215-220`), not a verdict.
  **Implement:** map Keep planning → `outcome:"cancelled"` + comment as feedback; Cancel →
  probably `"abandoned"`; Approve → `"approved"`. If the shipped build honors this, the CLI
  handles the model-facing messaging itself — which may make the primer's
  `[Plan approved/rejected/cancelled]` protocol obsolete. Probe.
- `planContent: null` conditions pinned: plan.md empty/whitespace, missing, or unreadable
  (`tool_calls.rs:106-113, 1204-1227`). Keep the plan.md fallback.
- `[ui] require_plan_approval` (config) forces plan approval even in yolo
  (`util/config/permissions.rs:254-270`).

### §2.2 Slash commands

- Position-0 rule confirmed and test-pinned (`session/slash_commands.rs:1052-1074`, tests
  `:1192-1200`): first text block, leading `/` after trim. No structured invoke exists — but
  **`x.ai/compact_conversation`** (router `:3438`) may be a position-proof structured compact;
  probe it. `x.ai/commands/list` (listing only) also exists.
- `/context` over stdio is literally `ok_end_turn(0, None)` — streams nothing
  (`slash_exec.rs:82`). Keep hiding it.
- **Correction to our doc:** over ACP, `/always-approve` does **not** write `config.toml` — it
  flips an in-memory per-process yolo atomic (`slash_exec.rs:18-52` →
  `permission/manager.rs:456-477`). The config write is a TUI-side effect
  (`permission/prompter.rs:40-44`). Re-probe #31: it may now be a clean per-session server-side
  Auto-accept toggle we could use instead of (or alongside) client-side auto-approval.

### §2.3 Context accounting

- `usage_update`: **does not exist anywhere** (zero hits). `_meta.totalTokens = 0` on
  `/compact`/`/session-info` is a hardcoded `ok_end_turn(0, None)` (`slash_exec.rs:16, 371` →
  `session/commands.rs:63-72`); sibling fields are the *previous* inference turn's usage
  (`acp_agent.rs:2326-2329`).
- `signals.json` recompute timing confirmed: `update_context_usage` is called only from the
  next turn's pre-sampling auto-compact check (`session/compaction.rs:1779-1781`), persisted at
  that turn's end (`turn.rs:1643-1647`). Our probe-derived model was exactly right.
- The true post-compact size **is** in memory at compact end and ships in
  `AutoCompactCompleted.tokens_after` (`compaction.rs:629-639`) → replace the `/session-info`
  scrape via discovery #2. The scrape's format string is confirmed at `slash_exec.rs:354-369`
  (`"**Context:** {} / {} tokens ({:.0}%)"`) — our regex is in sync as the fallback.
- `session/load` response carries no token info (`acp_agent.rs:1857-1937`); `readContextUsage`
  from `signals.json` stays for cold restore. `x.ai/session/info` (ext method) is worth probing
  as a structured alternative.

### §2.4 Subagents

- Lifecycle transmission: solved by discovery #2 (wrong method name, not a missing feature).
- Background-spawn "completed" ack confirmed structural: the `run_in_background` branch returns
  `Ok(ToolOutput::Text("Subagent started in background…"))` synchronously
  (`xai-grok-tools/src/implementations/grok_build/task/mod.rs:328-368`; text
  `xai-tool-types/src/task.rs:258-271`). Keep our skip; `SubagentFinished`/auto-wake carries the
  real result.
- The envelope we strip is current: `<subagent_meta>` + `<subagent_result>` built at
  `task.rs:276-313`; the "This is the output of the subagent:"/"Agent ID:" wrap survives only as
  a legacy *parser* (`reminders/task_completion.rs:522-544`) — `cleanSubagentOutput`'s
  all-patterns-optional design is right.
- `_meta["x.ai/tool"]` stamping points: `stamp_tool_meta` (`tool_calls.rs:260-274`) on ToolCall
  stub/refined/permission-update/bash-dispatch; unresolved wire names (uninitialized MCP,
  backend-hosted tools) legitimately lack it (`normalization.rs:27-41`) — keep title-independent
  fallbacks.

### §2.5 Capabilities and media

- `promptCapabilities.image: false` is a hardcoded omission — the builder only sets
  `.embedded_context(true)` (`acp_agent.rs:394-413`); image blocks are accepted and used
  (`session/prompt_parser.rs:119`). No config flips it. Keep behavior-over-advertisement + the
  `capabilities` live-drift test.
- Too-small drops: floors are **8×8 px** and **512 total px**
  (`session/image_normalize.rs:51-55, 429-439`); the model gets an `<image_dropped_notice>`, the
  client gets `ImageDropped` (discovery #2). **Implement:** client-side pre-validation (reject
  <8×8 / <512 px at attach time, like the 20MiB cap) + surface the notification.
- Generated media: the reporter is platform-agnostic JSON-in-text **plus a typed `rawOutput`**
  (`session/acp_conversion.rs:536-548`; `xai-grok-tools/src/types/output.rs:108-123` —
  `{path, filename, session_folder, message}`). The Windows "prose" was the JSON's `message`
  field + un-normalized `\\?\` paths (the media writer never dunce-strips, `storage.rs:101`,
  unlike read_file/search_replace). **Implement:** make `extractGeneratedMediaPaths` prefer
  `rawOutput.path`, keep text parsing as fallback. No ACP image/resource_link path exists at HEAD.
- Pasted-image asset paths are deliberately surfaced to the model in an `<image_files>` block
  (`session/image_describe.rs:329-341`) — keep our do-not-Read hint.

### §2.6 Sessions and models (beyond discovery #3)

- Versioned `set_model` echo root cause: the echo returns the catalog **entry's `.model`** while
  `availableModels` ids are the catalog **keys** (`handlers/model_switch.rs:231-235`,
  `acp_session_impl/model_switch.rs:13`, `agent/config.rs:4788-4795`; `resolve_catalog_key`
  accepts either, `agent/models.rs:1616-1629`). For `grok-build` key ≠ model (`grok-build-0.1`
  comes from the remote catalog); for `grok-4.5` they coincide. `resolveModelId` stays.
- Agent lock: `MODEL_SWITCH_INCOMPATIBLE_AGENT` fires only when `turn_count > 0`
  (`model_switch.rs:65-88`); at zero turns the harness is **rebuilt in place** (`:89-113`) —
  which is why our pre-primer `set_model` works.
- Replay filters only blank/rewind/ACU lines (`session/storage/mod.rs:1106-1196`) —
  `<system-reminder>` and protocol-marker replay is structural; keep client-side filters.
  Resolved `request_permission`s are never persisted (request/response RPC, not a session
  update) — keep our re-injection. `_meta.noReplay` on `session/load` skips replay entirely
  (`mod.rs:355`).
- Title generation locks onto the **first non-empty text** of message #1, no synthetic-turn skip
  (`session/summary.rs:58-97`) — the primer-title pollution is structural; fixed for real by
  moving the primer out of the message stream (below).

### §2.7 Session configuration

- **Reasoning effort is settable per-session over ACP** — no process restart:
  `session/set_model` reads `_meta.reasoningEffort` (`"minimal"|"low"|"medium"|"high"|"xhigh"`…)
  via `parse_reasoning_effort_meta` (`xai-grok-sampling-types/src/types.rs:852, 865-874`),
  applies + persists it per-session and broadcasts `ModelChanged`
  (`handlers/model_switch.rs:24, 117-134, 206-215`). It is also *reported*: models[]
  `_meta.reasoningEffort`/`supportsReasoningEffort` in `session/new`/`session/load`
  (`agent_ops.rs:2258-2274`) and `x.ai/sessionConfig.options`. **Implement:** `setEffort` via
  live `set_model` (same-model + effort meta), keep the restart path as fallback for old builds.
- Permission mode: still invisible over ACP (only telemetry + a remote-settings default on the
  `x.ai/settings/update` notification), no setter — the §2.7 ask stands, now with the #49
  root-cause framing (discovery #1 is the *real* fix for the trust problem).

### §2.9 Terminal shell dialect

- Root cause: everything the model is told about the shell derives from the **grok host
  process** (`detect_windows_shell()`, `xai-grok-config/src/shell.rs:30-106`) — the
  `Shell:` line in the first user message (`session/user_message.rs:33-81`), the bash tool
  description, chain separator, and unix-utility hints (`template_renderer.rs:53-163`) — while
  ACP execution hands the **raw** command to the *client's* shell with no wrapping
  (`terminal/acp_terminal.rs:15-26`, comment acknowledges it). Standalone wraps in the detected
  host shell (`local_terminal.rs:57-63`), so detection == execution there. No initialize field
  carries a client shell, and nothing consumes one from `clientCapabilities.meta`.
- **Implement:** set **`GROK_SHELL`** in the env when spawning `grok agent stdio` on Windows,
  matched to what `terminal-manager` resolved (`pwsh` | `powershell` | `cmd`; the override is
  read first in the cascade, `shell.rs:10-11, 25-69`, cached per process). That realigns *all*
  model-facing shell signals with the shell we actually run. Optionally reinforce with a
  `_meta.rules` line ("host shell is PowerShell; never `(cd x; y)`; chain with `;`").
- Execution-model split confirmed as one code path keyed on the client `terminal` capability:
  `client_terminal ? AcpTerminalRunner : TerminalRunner` (`agent_ops.rs:2830-2847, 2943-2958`) —
  the cursor/Composer CLI-side persistent shell is `TerminalRunner`.

### §2.10 Edit diffs

- The three delivery shapes and their `_meta` split confirmed exactly as documented: pre-write
  echo computes block-level `{old_line,new_line}` from the **pre-edit** file
  (`tool_calls.rs:1558-1587`; whole-file Write echo → `oldText:""`, `_meta:{}`,
  `:1774-1785`); the completed update carries `details[]`
  (`acp_conversion.rs:218-233`); session/load replays the persisted completed shape verbatim.
  Our `_diffSig` content-keyed idempotency is the right client fix; the echo is distinguishable
  only by its missing `status`.
- `details[].old_line` is post-edit because sites are located in the **rebuilt** `new_text`
  (`search_replace/helpers.rs:108-121` — `old_line == new_line` by construction).
- `line_suffix`: the struct simply lacks the field (`types/output.rs:314-335`); at the call
  site (`search_replace/mod.rs:717`) the full original content is in scope, so the upstream fix
  is one threaded parameter — cite it. Nothing more we can do client-side.

### §2.8 Transport (historical)

Now moot as "documentation asks": the source *is* the documentation. The `x.ai/`-vs-`_x.ai/`
prefix mystery is resolved (persist rail vs live rail, discovery #2); the
`ask_user_question`/`exit_plan_mode` response schemas are readable in
`xai-grok-tools/src/implementations/grok_build/*/types.rs`.

---

## Roadmap unlocks (beyond the feedback doc)

From the full `ext_method` router (`acp_agent.rs:3164-3508`) and docs
(`crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md`):

- **`_meta.rules` on `session/new`** → appended to the system prompt as `<human_rules>`
  (`agent/mvp_agent/mod.rs:1036-1058`); `_meta.systemPromptOverride` replaces it and is re-synced
  on resume (`:1024-1082`, `acp_agent.rs:1643`); `_meta.agentProfile` selects a profile.
  **This is the sanctioned home for our plan-mode primer** — it would end primer-titled
  sessions, empty-primer sweeps, replay hiding, `/compact` re-priming, and the priming race,
  all at once. Probe on shipped build first (and verify rules survive `/compact` + `session/load`).
- `x.ai/git/worktree/{create,remove,apply,list,gc}` + `x.ai/session/fork` — the "Worktree UI"
  roadmap item has a full server-side API.
- `x.ai/interject` — mid-turn interjection (the TUI's Ctrl+L) over ACP.
- `x.ai/rewind/*` (+ `rewind_points.jsonl`), `x.ai/prompt_history`, `x.ai/suggest`,
  `x.ai/compact_conversation`, `x.ai/session_summaries/*`, `x.ai/task/*`, `x.ai/scheduler/*`.
- `GROK_AGENT_METADATA` env merges arbitrary keys into `initialize._meta` (`acp_agent.rs:417`).
- `grok sessions list/search` CLI subcommands (SQLite FTS) as a non-ACP fallback.

---

## Recommended order (all pending live probes against shipped stable)

1. **#49 / permissions honesty** (§2.11) — pure client-side read of `~/.claude/settings*.json` +
   `permission.toml` + `[claude_compat]`; answers an open user-trust issue. No CLI dependency.
2. **`x.ai/session_notification` handler** (§2.3/§2.4/§2.5) — one handler, three features;
   removes the `/session-info` scrape.
3. **Plan verdict via `outcome`** (§2.1) — replace the JSON-RPC-error reject with
   `{outcome:"cancelled"}`; then re-evaluate how much of the primer protocol remains necessary.
4. **`GROK_SHELL` at spawn** (§2.9) — two lines in `acp.ts` env + probe.
5. **Effort via `set_model` `_meta.reasoningEffort`** (§2.7) — ends effort-change restarts.
6. **Primer → `_meta.rules`** — biggest simplification, touches the most machinery; probe
   thoroughly (compact/restore interaction) before migrating.
7. **Session RPCs adoption** (§2.6) — rename/delete first, list/search second; disk path stays
   as fallback.
8. **Media `rawOutput` path parsing + client-side min-size check** (§2.5) — small, independent.

Probe harness: extend `research/*.cjs` with a `oss-surfaces-probe.cjs` that, against the shipped
binary, (a) sends `x.ai/session/list`/`rename`/`delete`, (b) subscribes for
`x.ai/session_notification` around a `/compact` and a subagent spawn, (c) replies
`{outcome:"cancelled"}` to `exit_plan_mode`, (d) sets `_meta.reasoningEffort` on `set_model`,
(e) passes `_meta.rules` on `session/new` and checks the system-prompt effect, (f) spawns with
`GROK_SHELL=powershell` and inspects the first user message's `Shell:` line via
`chat_history.jsonl`.
