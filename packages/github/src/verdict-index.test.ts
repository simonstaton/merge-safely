import { describe, expect, it } from "vitest";
import { finding, repo, verdict } from "../test/builders.js";
import { hydrateEntry, INDEX_MARKER, parseIndex, renderIndex, toIndexEntry, upsertEntry } from "./verdict-index.js";

describe("verdict index", () => {
  it("round-trips entries and upserts by (sha, round)", () => {
    const a = toIndexEntry(verdict({ headSha: "a", round: 1, createdAt: "2026-01-01T00:00:01Z" }));
    const b = toIndexEntry(
      verdict({ headSha: "b", round: 2, createdAt: "2026-01-01T00:00:02Z", kind: "human", decision: "pass" }),
    );
    let entries = upsertEntry(upsertEntry([], b), a);
    expect(entries.map((e) => e.headSha)).toEqual(["a", "b"]);
    entries = upsertEntry(entries, { ...a, decision: "pass" });
    expect(entries).toHaveLength(2);
    const body = renderIndex(entries);
    expect(body.startsWith(INDEX_MARKER)).toBe(true);
    expect(parseIndex(body)).toEqual(entries.sort((x, y) => x.createdAt.localeCompare(y.createdAt)));
    const h = hydrateEntry(b, repo, 7);
    expect(h).toMatchObject({
      kind: "human",
      decision: "pass",
      round: 2,
      seats: [],
      triaged: false,
      tier: { level: 2 },
    });
    expect(h.cost).toEqual({ tokens: { in: 0, out: 0 }, bySeat: {} });
  });

  it("caps at the limit by dropping finding details oldest-first, never sha/round/decision", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ id: `f${i}`, title: "t".repeat(190), file: "x".repeat(100) }),
    );
    const entries = Array.from({ length: 30 }, (_, i) =>
      toIndexEntry(
        verdict({
          headSha: `s${i}`,
          round: i + 1,
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
          findings: many,
        }),
      ),
    );
    const body = renderIndex(entries, 65_535);
    expect(body.length).toBeLessThanOrEqual(65_535);
    const back = parseIndex(body) ?? [];
    expect(back.map((e) => [e.headSha, e.round, e.decision])).toEqual(
      entries.map((e) => [e.headSha, e.round, e.decision]),
    );
    expect(back[0]?.findings[0]).toEqual({ id: "f0", severity: "blocker" }); // oldest stripped
    expect(back[29]?.findings[0]?.title).toBeDefined(); // newest intact

    const tiny = parseIndex(renderIndex(entries, 6000)) ?? [];
    expect(tiny).toHaveLength(30);
    expect(tiny[0]?.findings).toEqual([]);
  });

  it("returns null on garbage and skips malformed entries", () => {
    expect(parseIndex(null)).toBeNull();
    expect(parseIndex("nothing")).toBeNull();
    expect(parseIndex(`${INDEX_MARKER}\n\`\`\`json\n{oops\n\`\`\``)).toBeNull();
    const ok = toIndexEntry(verdict());
    expect(
      parseIndex(`${INDEX_MARKER}\n\`\`\`json\n${JSON.stringify({ v: 1, entries: [ok, { headSha: 1 }] })}\n\`\`\``),
    ).toEqual([ok]);
  });
});
