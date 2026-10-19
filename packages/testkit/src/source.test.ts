import { describe, expect, it } from "vitest";
import { sampleFixtures } from "./fixtures.js";
import { changeRef, fakeSha, fakeSource, makeChange, makeFile } from "./source.js";

describe("fakeSource", () => {
  const fixture = () => ({ ...sampleFixtures.smallLogic, deltas: { abc: "diff --git a/x b/x\n" } });

  it("serves the change, the full diff, deltas and untrusted context", async () => {
    const f = fixture();
    const src = fakeSource(f);
    const ref = changeRef(f.change);
    const change = await src.getChange(ref);
    expect(change).toEqual(f.change);
    change.title = "mutated";
    expect((await src.getChange(ref)).title).toBe(f.change.title);
    expect(await src.getDiff(ref)).toBe(f.diff);
    expect(await src.getDiff(ref, { headSha: f.change.headSha })).toBe(f.diff);
    expect(await src.getDiff(ref, { sinceSha: "abc" })).toBe("diff --git a/x b/x\n");
    expect(await src.getUntrustedContext(ref)).toEqual({
      commitMessages: f.commitMessages,
      comments: f.comments,
    });
    expect(src.calls.map((c) => c.method)).toEqual([
      "getChange",
      "getChange",
      "getDiff",
      "getDiff",
      "getDiff",
      "getUntrustedContext",
    ]);
  });

  it("serves the diff for a pinned older head, like the GitHub source", async () => {
    const f = { ...fixture(), diffs: { [fakeSha("old-head")]: "diff --git a/old b/old\n" } };
    const src = fakeSource(f);
    const ref = changeRef(f.change);
    expect(await src.getDiff(ref, { headSha: fakeSha("old-head") })).toBe("diff --git a/old b/old\n");
    expect(await src.getDiff(ref, { headSha: f.change.headSha })).toBe(f.diff);
  });

  it("throws only for an unknown head, an unknown delta or an unknown change", async () => {
    const f = fixture();
    const src = fakeSource(f);
    const ref = changeRef(f.change);
    await expect(src.getDiff(ref, { headSha: fakeSha("other") })).rejects.toThrow(/no diff fixture for head/);
    await expect(src.getDiff(ref, { sinceSha: "nope" })).rejects.toThrow(/no delta/);
    await expect(src.getChange({ ...ref, number: 999 })).rejects.toThrow(/no change/);
  });

  it("lists open, non-draft changes for a repo", async () => {
    const all = sampleFixtures.all();
    const draft = { ...sampleFixtures.docsOnly, change: makeChange({ number: 7, draft: true }) };
    const src = fakeSource([...all, draft]);
    const refs: number[] = [];
    for await (const r of src.listOpenChanges(all[0]?.change.repo ?? makeChange().repo)) refs.push(r.number);
    expect(refs).toEqual([101, 102, 103]);
  });
});

describe("makeChange / makeFile", () => {
  it("computes stats from files unless given", () => {
    const c = makeChange({ files: [makeFile("a.ts", { additions: 3, deletions: 1 }), makeFile("b.ts")] });
    expect(c.stats).toEqual({ additions: 4, deletions: 1, files: 2 });
    expect(makeChange({ stats: { additions: 9, deletions: 9, files: 9 } }).stats.files).toBe(9);
    expect(c.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.headSha).not.toBe(c.baseSha);
  });

  it("fakeSha is deterministic", () => {
    expect(fakeSha("x")).toBe(fakeSha("x"));
    expect(fakeSha("x")).not.toBe(fakeSha("y"));
  });
});
