import { describe, expect, it } from "vitest";
import { clip, parseRepo, redactSecrets, repoKey, safeSlice, truncateMarkdown } from "./util.js";

describe("parseRepo / repoKey", () => {
  it("parses owner/name, host/owner/name and URLs", () => {
    expect(parseRepo("acme/widgets")).toEqual({ host: "github.com", owner: "acme", name: "widgets" });
    expect(parseRepo("ghe.example.com/acme/widgets")).toEqual({
      host: "ghe.example.com",
      owner: "acme",
      name: "widgets",
    });
    expect(parseRepo("https://github.com/acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widgets",
    });
  });

  it("rejects garbage", () => {
    expect(() => parseRepo("acme")).toThrow(/owner\/name/);
    expect(() => parseRepo("a/b c")).toThrow();
    expect(() => parseRepo("")).toThrow();
  });

  it("builds a case-insensitive key", () => {
    expect(repoKey({ host: "github.com", owner: "Acme", name: "Widgets" })).toBe("github.com/acme/widgets");
  });
});

describe("truncateMarkdown", () => {
  it("returns short input unchanged", () => {
    expect(truncateMarkdown("hello", 10)).toBe("hello");
  });

  it("stays within the limit and notes truncation", () => {
    const out = truncateMarkdown("x".repeat(1000), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/truncated by merge-safely/);
  });

  it("closes an open code fence", () => {
    const md = `intro\n\`\`\`ts\n${"code\n".repeat(100)}\`\`\`\n`;
    const out = truncateMarkdown(md, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect((out.match(/^\s*```/gm) ?? []).length % 2).toBe(0);
  });

  it("never splits a surrogate pair", () => {
    const s = `${"a".repeat(9)}😀`;
    expect(safeSlice(s, 10)).toBe("a".repeat(9));
    expect(clip("abcdef", 4)).toBe("abc…");
  });
});

describe("redactSecrets", () => {
  it("masks token shapes", () => {
    const out = redactSecrets(
      "ghp_abcdefghijklmnopqrstuvwxyz0123 and Authorization: token ghs_zzzzzzzzzzzzzzzzzzzzzzzz sk-ant-abcdefghijklmnopqrst",
    );
    expect(out).not.toMatch(/ghp_|ghs_z|sk-ant-a/);
    expect(out).toMatch(/\[redacted\]/);
  });
});
