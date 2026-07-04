// DOM-level test for issue #30 — a permission that resolves to a *single* edit
// must stay expandable so its diff ("N → M lines" + "open diff →") remains
// reviewable, both live and after a session restore. Drives the REAL shipped
// media/chat.js in a happy-dom window.
//
// Root cause guarded here: closeToolGroup() used to flatten ANY lone tool call
// into a `.tool-flat` (icon + label only — no chevron, no body), discarding the
// diff preview that attachDiffPreviewToToolItem appends to the tool-item in the
// body. A read+edit batch (≥2 calls) stayed an expandable `.tool-group`, so its
// diff survived — exactly the contrast the reporter saw. The fix keeps a lone
// edit as a group; these tests pin that in both orderings.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };
const EDIT_CALL = { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" };

describe("single-edit tool group stays expandable (#30)", () => {
  it("keeps a lone edit as an expandable group with its diff, not a flat row (live)", () => {
    const { window, posted, doc } = bootWebview();

    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} }); // turn boundary → closeToolGroup

    const group = doc.querySelector(".tool-group");
    expect(group).not.toBeNull(); // NOT collapsed into a bare `.tool-flat`
    expect(doc.querySelector(".tool-flat")).toBeNull();
    expect(group!.querySelector(".tool-chevron")).not.toBeNull(); // an expander exists

    const link = group!.querySelector(".tool-group-body .preview-link") as HTMLButtonElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("open diff");
    expect(group!.querySelector(".tool-item-subtitle")!.textContent).toContain("2 → 3 lines");

    click(window, link);
    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toMatchObject({ path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" });
  });

  it("expands and collapses the body when its header is clicked", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} });

    const group = doc.querySelector(".tool-group") as HTMLElement;
    const body = group.querySelector(".tool-group-body") as HTMLElement;
    const header = group.querySelector(".tool-group-header") as HTMLElement;
    expect(body.hidden).toBe(true); // collapsed by default, like a multi-tool batch

    click(window, header);
    expect(body.hidden).toBe(false);
    expect(group.classList.contains("expanded")).toBe(true);

    click(window, header);
    expect(body.hidden).toBe(true);
    expect(group.classList.contains("expanded")).toBe(false);
  });

  it("still flattens a lone non-edit (a read) into a `.tool-flat`", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "toolCall", call: { toolCallId: "r1", kind: "read", title: "Read src/foo.ts" } });
    dispatch(window, { type: "promptComplete", meta: {} });

    expect(doc.querySelector(".tool-flat")).not.toBeNull();
    expect(doc.querySelector(".tool-group")).toBeNull();
  });

  it("survives restore: a completed edit that carries its own diff still shows 'open diff'", () => {
    const { window, posted, doc } = bootWebview();

    // grok's REAL session/load wire (captured from the live CLI, 0.2.82): a
    // completed edit replays as a SINGLE `tool_call` — kind:"edit",
    // status:"completed" — that carries the diff in its own `content`. There is
    // NO follow-up `tool_call_update` (unlike live, where the tool_call is a bare
    // "StrReplace" and the diff rides a later update). So the diff extraction must
    // run on the `tool_call` itself; if it only ran on `tool_call_update` (the old
    // bug), the restored edit kept its expandable group but had no diff inside —
    // exactly the "diff disappears on restore" report (#30).
    const REPLAYED_EDIT = { ...EDIT_CALL, status: "completed", content: [DIFF] };

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "permissionHistoryQueue",
      permissions: [{ toolCallId: "tc1", title: "Edit src/foo.ts", outcome: "allowed" }],
    });
    dispatch(window, { type: "toolCall", call: REPLAYED_EDIT }); // single message, diff included
    dispatch(window, { type: "historyReplay", active: false });

    const group = doc.querySelector(".tool-group");
    expect(group).not.toBeNull();
    expect(doc.querySelector(".tool-flat")).toBeNull();
    const link = group!.querySelector(".tool-group-body .preview-link") as HTMLButtonElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("open diff");
    expect(group!.querySelector(".tool-item-subtitle")!.textContent).toContain("2 → 3 lines");

    click(window, link);
    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toMatchObject({ path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" });

    // The answered permission card replays right at the tool it gated.
    expect(doc.querySelector(".card.permission.perm-resolved")).not.toBeNull();
  });
});
