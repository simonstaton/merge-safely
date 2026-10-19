import { describe, expect, it } from "vitest";
import { change, digest, finding, repo, seatRun, verdict } from "../test/builders.js";
import { callsTo, fakeOctokit } from "../test/fake-octokit.js";
import { checkRunReporter } from "./check-run.js";
import { checkRunStore, parseVerdictText, serializeVerdict, VERDICT_MARKER } from "./check-run-store.js";
import { renderIndex, toIndexEntry } from "./verdict-index.js";

const key = { repo, number: 7, headSha: "head1" };

describe("serializeVerdict / parseVerdictText", () => {
  it("round-trips and compacts seats", () => {
    const v = verdict();
    const text = serializeVerdict(v);
    expect(text.startsWith(`${VERDICT_MARKER}\n\`\`\`json\n`)).toBe(true);
    const back = parseVerdictText(text);
    expect(back).not.toBeNull();
    expect(back?.findings).toEqual(v.findings);
    expect(back?.quorum).toEqual(v.quorum);
    expect(back?.cost).toEqual(v.cost);
    expect(back?.downgrades).toEqual(v.downgrades);
    expect(back?.addressed).toEqual(["f0"]);
    expect(back?.carried).toEqual(["f1"]);
    expect(back?.seats[0]?.audit.filesRead).toHaveLength(20);
    expect(back?.seats[0]?.output?.findings).toEqual([]);
    expect(back?.seats[0]?.audit.substantiveCalls).toBe(3);
  });

  it("stays under 65,535 chars for huge verdicts, keeping the decision and blockers first", () => {
    const big = "z".repeat(3000);
    const findings = Array.from({ length: 200 }, (_, i) =>
      finding({ id: `f${i}`, severity: i === 199 ? "blocker" : "nit", detail: big, evidence: [big, big] }),
    );
    const seats = Array.from({ length: 20 }, () => seatRun({ error: big }));
    const text = serializeVerdict(verdict({ findings, seats }));
    expect(text.length).toBeLessThanOrEqual(65_535);
    const back = parseVerdictText(text);
    expect(back?.decision).toBe("block");
    expect(back?.findings.length).toBeGreaterThan(0);

    const huge = Array.from({ length: 3000 }, (_, i) =>
      finding({ id: `g${i}`, severity: i === 2999 ? "blocker" : "nit", title: big.slice(0, 200) }),
    );
    const t2 = serializeVerdict(verdict({ findings: huge }));
    expect(t2.length).toBeLessThanOrEqual(65_535);
    expect(parseVerdictText(t2)?.findings[0]?.id).toBe("g2999");
  });

  it("returns null on garbage", () => {
    expect(parseVerdictText(null)).toBeNull();
    expect(parseVerdictText("no marker")).toBeNull();
    expect(parseVerdictText(`${VERDICT_MARKER}\n\`\`\`json\n{not json\n\`\`\``)).toBeNull();
    expect(parseVerdictText(`${VERDICT_MARKER}\n\`\`\`json\n{"decision":"pass"}\n\`\`\``)).toBeNull();
    const bad = JSON.stringify({ ...verdict(), decision: "maybe" });
    expect(parseVerdictText(`${VERDICT_MARKER}\n\`\`\`json\n${bad}\n\`\`\``)).toBeNull();
  });
});

describe("checkRunStore", () => {
  it("returns null when there is no run or no verdict in it", async () => {
    const { octokit } = fakeOctokit();
    const store = checkRunStore({ octokit });
    expect(await store.get(key)).toBeNull();
    await checkRunReporter({ octokit }).report({ type: "pending", change: change(), round: 1 });
    expect(await store.get(key)).toBeNull();
  });

  it("creates a completed run on first put and round-trips", async () => {
    const { octokit, state } = fakeOctokit();
    const store = checkRunStore({ octokit });
    const res = await store.put(verdict({ decision: "pass", findings: [] }), { version: null });
    expect(res.ok).toBe(true);
    expect(state.checkRuns[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      name: "merge-safely/verdict",
    });
    const got = await store.get(key);
    expect(got?.verdict.decision).toBe("pass");
    expect(got?.version).toBe(res.version);
  });

  it("enforces compare-and-set", async () => {
    const { octokit } = fakeOctokit();
    const store = checkRunStore({ octokit });
    const first = await store.put(verdict(), { version: null });
    // A stale writer that thinks nothing exists.
    const stale = await store.put(verdict({ decision: "pass" }), { version: null });
    expect(stale).toEqual({ ok: false, version: first.version });
    // A writer with the current version wins, and the version moves.
    const second = await store.put(verdict({ round: 2 }), { version: first.version });
    expect(second.ok).toBe(true);
    expect(second.version).not.toBe(first.version);
    // The old version is now stale.
    expect((await store.put(verdict({ round: 3 }), { version: first.version })).ok).toBe(false);
    expect((await store.get(key))?.verdict.round).toBe(2);
  });

  it("keeps reporter-written title and summary when updating text", async () => {
    const { octokit, state, calls } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    const store = checkRunStore({ octokit });
    const current = await store.get(key);
    const res = await store.put(verdict({ round: 2 }), { version: current?.version ?? null });
    expect(res.ok).toBe(true);
    const lastUpdate = callsTo(calls, "checks.update").pop();
    expect(lastUpdate?.params).not.toHaveProperty("conclusion");
    expect(state.checkRuns[0]?.output).toMatchObject({ title: digest().headline, summary: digest().markdown });
  });

  it("store block, then report a contested pass on the same sha: the stored verdict is still the block", async () => {
    const { octokit } = fakeOctokit();
    const store = checkRunStore({ octokit });
    expect((await store.put(verdict({ decision: "block" }), { version: null })).ok).toBe(true);
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict({ decision: "pass", contested: true, round: 2, findings: [] }),
      digest: digest({ headline: "contested" }),
    });
    const got = await store.get(key);
    expect(got?.verdict.decision).toBe("block");
    expect(got?.verdict.findings).toHaveLength(1);
  });

  it("report first, then put(expect null) succeeds on the reporter's run", async () => {
    const { octokit, state } = fakeOctokit();
    await checkRunReporter({ octokit }).report({
      type: "verdict",
      change: change(),
      verdict: verdict(),
      digest: digest(),
    });
    const res = await checkRunStore({ octokit }).put(verdict(), { version: null });
    expect(res.ok).toBe(true);
    expect(state.checkRuns).toHaveLength(1);
    expect(state.checkRuns[0]?.conclusion).toBe("failure");
  });

  it("ignores forged runs from other apps, even newer ones", async () => {
    const { octokit, state } = fakeOctokit();
    const store = checkRunStore({ octokit });
    await store.put(verdict(), { version: null });
    state.writerApp = { id: 666, slug: "evil" };
    await octokit.checks.create({
      owner: "acme",
      repo: "widgets",
      name: "merge-safely/verdict",
      head_sha: "head1",
      conclusion: "success",
      output: { title: "x", summary: "x", text: serializeVerdict(verdict({ kind: "human", decision: "pass" })) },
    });
    expect((await store.get(key))?.verdict).toMatchObject({ decision: "block", kind: "machine" });
  });

  it("matches the github-actions app when GET /app is unavailable (Action mode)", async () => {
    const { octokit, state, calls } = fakeOctokit({ self: null, botLogin: "github-actions[bot]" });
    const store = checkRunStore({ octokit });
    await store.put(verdict(), { version: null });
    expect(state.checkRuns[0]?.app?.slug).toBe("github-actions");
    expect((await store.get(key))?.verdict.decision).toBe("block");
    expect(callsTo(calls, "apps.getAuthenticated")).toHaveLength(1); // memoised
  });

  it("lists verdicts per commit, newest last, when no index exists", async () => {
    const { octokit, state } = fakeOctokit({
      commits: [
        { sha: "c1", commit: { message: "one" } },
        { sha: "c2", commit: { message: "two" } },
      ],
    });
    const store = checkRunStore({ octokit });
    await store.put(verdict({ headSha: "c1" }), { version: null });
    state.issueComments = []; // simulate a PR with verdicts but no index
    expect((await store.listForChange(repo, 7)).map((v) => v.headSha)).toEqual(["c1"]);
  });

  it("keeps round history across a force-push via the index comment", async () => {
    const { octokit, state } = fakeOctokit({ commits: [{ sha: "c1", commit: { message: "one" } }] });
    const store = checkRunStore({ octokit });
    await store.put(verdict({ headSha: "c1", round: 1, createdAt: "2026-01-01T00:00:01Z" }), { version: null });
    await store.put(verdict({ headSha: "c2", round: 2, createdAt: "2026-01-01T00:00:02Z" }), { version: null });
    // Same SHA, later round: the run holds round 3; round 2 for c2 survives only in the index.
    const v3 = await store.get({ repo, number: 7, headSha: "c2" });
    await store.put(verdict({ headSha: "c2", round: 3, createdAt: "2026-01-01T00:00:03Z" }), {
      version: v3?.version ?? null,
    });
    expect(state.issueComments).toHaveLength(1); // one index comment, updated in place
    // Force-push: c1 and c2 are no longer reachable, and c1's check run is gone too.
    state.commits = [{ sha: "c9", commit: { message: "rewritten" } }];
    state.checkRuns = state.checkRuns.filter((r) => r.head_sha !== "c1");
    const list = await store.listForChange(repo, 7);
    expect(list.map((v) => [v.headSha, v.round])).toEqual([
      ["c1", 1],
      ["c2", 2],
      ["c2", 3],
    ]);
    expect(list[0]?.seats).toEqual([]); // hydrated from the index
    expect(list[0]?.findings[0]).toMatchObject({ id: "f1", severity: "blocker", file: "src/a.ts", line: 2 });
    expect(list[2]?.seats.length).toBe(1); // full verdict from the check run
    expect(list[1]?.seats).toEqual([]); // older round on the same SHA comes from the index
  });

  it("ignores index comments not posted by our bot", async () => {
    const { octokit, state } = fakeOctokit({ commits: [] });
    state.issueComments.push({
      id: 1,
      body: renderIndex([toIndexEntry(verdict({ headSha: "zz", round: 1 }))]),
      user: { login: "mallory", type: "User" },
    });
    const store = checkRunStore({ octokit });
    expect(await store.listForChange(repo, 7)).toEqual([]);
    await store.put(verdict(), { version: null });
    expect(state.issueComments).toHaveLength(2);
  });
});
