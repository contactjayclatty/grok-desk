import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { looksLikeFileRef, formatRelativeTime, FILE_EXTS } from "../media/webview-helpers.js";

describe("looksLikeFileRef", () => {
  it("accepts a bare filename with a known extension", () => {
    expect(looksLikeFileRef("package.json")).toBe(true);
    expect(looksLikeFileRef("CLAUDE.md")).toBe(true);
    expect(looksLikeFileRef("AGENTS.md")).toBe(true);
    expect(looksLikeFileRef("tsconfig.json")).toBe(true);
  });

  it("accepts a path with separators", () => {
    expect(looksLikeFileRef("src/sidebar.ts")).toBe(true);
    expect(looksLikeFileRef("media/chat.js")).toBe(true);
    expect(looksLikeFileRef("test\\sessions.test.ts")).toBe(true);
  });

  it("accepts a path with a :line suffix and strips it before checking", () => {
    expect(looksLikeFileRef("src/sidebar.ts:42")).toBe(true);
    expect(looksLikeFileRef("media/chat.js:1-100")).toBe(true);
  });

  it("accepts a path with a #Lstart-Lend anchor", () => {
    expect(looksLikeFileRef("src/sidebar.ts#L10-L20")).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(looksLikeFileRef("Foo.TS")).toBe(true);
    expect(looksLikeFileRef("Bar.Json")).toBe(true);
  });

  it("rejects plain identifiers without an extension", () => {
    expect(looksLikeFileRef("undefined")).toBe(false);
    expect(looksLikeFileRef("null")).toBe(false);
    expect(looksLikeFileRef("foo")).toBe(false);
    expect(looksLikeFileRef("myVariable")).toBe(false);
  });

  it("rejects unknown extensions", () => {
    expect(looksLikeFileRef("foo.unknownextname")).toBe(false);
    expect(looksLikeFileRef("foo.xyz")).toBe(false);
  });

  it("rejects strings with whitespace or shell metacharacters", () => {
    expect(looksLikeFileRef("foo bar.ts")).toBe(false);
    expect(looksLikeFileRef("rm -rf foo.ts")).toBe(false);
    expect(looksLikeFileRef('"foo.ts"')).toBe(false);
    expect(looksLikeFileRef("a;b.ts")).toBe(false);
    expect(looksLikeFileRef("a|b.ts")).toBe(false);
    expect(looksLikeFileRef("a&b.ts")).toBe(false);
  });

  it("rejects empty, null-ish, or absurdly long strings", () => {
    expect(looksLikeFileRef("")).toBe(false);
    expect(looksLikeFileRef(null as unknown as string)).toBe(false);
    expect(looksLikeFileRef(undefined as unknown as string)).toBe(false);
    expect(looksLikeFileRef("a".repeat(201) + ".ts")).toBe(false);
  });

  it("rejects code-looking spans with a trailing dot only", () => {
    expect(looksLikeFileRef("obj.")).toBe(false);
    expect(looksLikeFileRef(".")).toBe(false);
  });

  it("FILE_EXTS exposes the configured set", () => {
    expect(FILE_EXTS.has("ts")).toBe(true);
    expect(FILE_EXTS.has("json")).toBe(true);
    expect(FILE_EXTS.has("lock")).toBe(true);
    expect(FILE_EXTS.has("env")).toBe(true);
    expect(FILE_EXTS.has("gitignore")).toBe(true);
    expect(FILE_EXTS.has("zzz")).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 4, 22, 12, 0, 0);

  it("returns '' for falsy timestamps", () => {
    expect(formatRelativeTime(0, now)).toBe("");
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime(null, now)).toBe("");
  });

  it("formats seconds when under a minute", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("5s ago");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30s ago");
  });

  it("formats minutes when under an hour", () => {
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 45 * 60_000, now)).toBe("45m ago");
  });

  it("formats hours when under a day", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
  });

  it("formats days when under a week", () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now - 6 * 86_400_000, now)).toBe("6d ago");
  });

  it("falls back to localeDateString for timestamps older than a week", () => {
    const ts = now - 30 * 86_400_000;
    const out = formatRelativeTime(ts, now);
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("uses Date.now() when no second arg is provided", () => {
    const out = formatRelativeTime(Date.now() - 2_000);
    expect(out).toMatch(/s ago$/);
  });
});
