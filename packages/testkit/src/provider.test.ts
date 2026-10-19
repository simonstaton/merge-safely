import type { Connection, Finding, ReviewerInput, Seat, WorkspaceHandle } from "@merge-safely/core";
import { parseJudgeOutput, parseReviewerOutput } from "@merge-safely/core";
import { describe, expect, it } from "vitest";
import { FALLBACK_USD, fakeModel, fakeProvider } from "./provider.js";
import { scenarios, scriptedRuns } from "./scripted.js";
import { makeChange, makeFile } from "./source.js";

const conn: Connection = {
  id: "fake-1",
  provider: "fake",
  kind: "api-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: "k" },
};
const ws: WorkspaceHandle = { cwd: "/tmp/x", headSha: "h", dispose: async () => {} };

function seat(role: "hunter" | "judge", lens = "correctness", n = 1): Seat {
  return {
    id: `${role}:${lens}:${n}`,
    lens,
    role,
    model: { connectionId: "fake-1", provider: "fake", name: "fake-model" },
    budget: { maxTurns: 8, deadlineMs: 60_000, maxUsd: 0.25 },
  };
}

function input(candidateFindings?: Finding[]): ReviewerInput {
  const change = makeChange({ files: [makeFile("src/a.ts"), makeFile("src/b.ts")] });
  return {
    change,
    tier: { level: 1, score: 20, factors: { loc: 2, files: 2, modules: 1, criticalPathHits: [] }, reasons: [] },
    round: 1,
    diff: "",
    diffIsDelta: false,
    untrusted: { title: change.title, body: change.body },
    knownFindings: [],
    allowedCommands: [],
    prompt: { system: "s", user: "u" },
    outputSchema: {},
    ...(candidateFindings ? { candidateFindings } : {}),
  };
}

const runOnce = (p: ReturnType<typeof fakeProvider>, s: Seat, i = input()) =>
  p.createRunner(conn, fakeModel()).run(s, i, ws);

describe("fakeProvider", () => {
  it("defaults: hunters pass with a passing audit, priced from the model", async () => {
    const p = fakeProvider();
    const run = await runOnce(p, seat("hunter"));
    expect(run.status).toBe("ok");
    expect(run.output).toEqual({ verdict: "pass", summary: "No issues found.", findings: [] });
    expect(parseReviewerOutput(run.output).ok).toBe(true);
    expect(run.audit).toMatchObject({ substantiveCalls: 5, tokens: { in: 1000, out: 200 } });
    expect(run.audit.filesRead).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
    // 1000 * $1/MTok + 200 * $5/MTok
    expect(run.audit.costUsd).toBeCloseTo(0.002, 10);
    expect(run.headSha).toBe(input().change.headSha);
    expect(Date.parse(run.finishedAt) - Date.parse(run.startedAt)).toBe(run.audit.wallMs);
  });

  it("usd falls back to 0.01 without pricing and 0 for zero-cost models", async () => {
    const p = fakeProvider();
    const { pricing: _p, ...unpriced } = fakeModel();
    const a = await p.createRunner(conn, unpriced).run(seat("hunter"), input(), ws);
    expect(a.audit.costUsd).toBe(FALLBACK_USD);
    const b = await p.createRunner(conn, fakeModel({ zeroCost: true })).run(seat("hunter"), input(), ws);
    expect(b.audit.costUsd).toBe(0);
  });

  it("honours the script and records every call", async () => {
    const p = fakeProvider({
      script: (s) =>
        s.lens === "security"
          ? { verdict: "block", summary: "bad", findings: [] }
          : { status: "schema-invalid", output: null, error: "bad json" },
    });
    const sec = await runOnce(p, seat("hunter", "security"));
    const cor = await runOnce(p, seat("hunter", "correctness"));
    expect(sec.output?.verdict).toBe("block");
    expect(cor).toMatchObject({ status: "schema-invalid", output: null, error: "bad json" });
    expect(cor.audit.substantiveCalls).toBe(5); // defaults survive a partial run
    expect(p.calls.map((c) => c.seat.lens)).toEqual(["security", "correctness"]);
    expect(p.calls[0]?.connection.id).toBe("fake-1");
    expect(p.runnersCreated).toBe(2);
    p.reset();
    expect(p.calls).toHaveLength(0);
  });

  it("maps a thrown or returned Error to status error", async () => {
    const thrown = await runOnce(
      fakeProvider({
        script: () => {
          throw new Error("boom");
        },
      }),
      seat("hunter"),
    );
    expect(thrown).toMatchObject({ status: "error", error: "boom", output: null });
    expect(thrown.audit.substantiveCalls).toBe(0);
  });

  it("streams usage through onUsage in deltas that sum to the run total", async () => {
    const p = fakeProvider({ usageChunks: 3, tokens: { in: 1001, out: 202 } });
    const deltas: Array<{ in: number; out: number; usd: number }> = [];
    const run = await p
      .createRunner(conn, fakeModel(), {
        onUsage: (d) => deltas.push({ in: d.tokens.in, out: d.tokens.out, usd: d.usd ?? 0 }),
      })
      .run(seat("hunter"), input(), ws);
    expect(deltas).toHaveLength(3);
    expect(deltas.reduce((n, d) => n + d.in, 0)).toBe(1001);
    expect(deltas.reduce((n, d) => n + d.out, 0)).toBe(202);
    expect(deltas.reduce((n, d) => n + d.usd, 0)).toBeCloseTo(run.audit.costUsd ?? -1, 12);
    expect(p.calls[0]?.usage).toHaveLength(3);
  });

  it("returns timeout when the signal aborts during the simulated latency", async () => {
    const p = fakeProvider({ delayMs: 5_000 });
    const ctl = new AbortController();
    const pending = p.createRunner(conn, fakeModel()).run(seat("hunter"), input(), ws, ctl.signal);
    ctl.abort();
    const run = await pending;
    expect(run.status).toBe("timeout");
    expect(run.output).toBeNull();
  });

  it("validate and models", async () => {
    const p = fakeProvider({ id: "acme", validate: { ok: false, message: "invalid key" } });
    expect(p.id).toBe("acme");
    expect(await p.validate(conn)).toEqual({ ok: false, message: "invalid key" });
    expect((await p.models(conn))[0]?.provider).toBe("acme");
    expect(p.validated).toHaveLength(1);
  });
});

describe("scriptedRuns", () => {
  const candidates: Finding[] = [
    { id: "f1", severity: "blocker", class: "logic-error", title: "t", detail: "d" },
    { id: "f2", severity: "important", class: "n-plus-one", title: "t", detail: "d" },
  ];

  it("allPass: hunters pass, judges confirm (no candidates)", async () => {
    const p = fakeProvider({ script: scenarios.allPass() });
    expect((await runOnce(p, seat("hunter"))).output?.verdict).toBe("pass");
    expect((await runOnce(p, seat("judge"))).judgeOutput).toMatchObject({ votes: [] });
  });

  it("oneBlocker: only the named lens blocks, with a valid blocker finding", async () => {
    const p = fakeProvider({ script: scenarios.oneBlocker("security") });
    const blocked = await runOnce(p, seat("hunter", "security"));
    expect(blocked.output?.verdict).toBe("block");
    expect(blocked.output?.findings[0]).toMatchObject({ severity: "blocker", file: "src/a.ts" });
    expect(parseReviewerOutput(blocked.output).ok).toBe(true);
    expect((await runOnce(p, seat("hunter", "perf"))).output?.verdict).toBe("pass");
  });

  it("judgesRefuteAll: every candidate refuted", async () => {
    const p = fakeProvider({ script: scenarios.judgesRefuteAll() });
    const run = await runOnce(p, seat("judge"), input(candidates));
    expect(run.judgeOutput?.votes.map((v) => [v.findingId, v.decision])).toEqual([
      ["f1", "refute"],
      ["f2", "refute"],
    ]);
    expect(parseJudgeOutput(run.judgeOutput).ok).toBe(true);
  });

  it("default judges confirm every candidate; downgrade carries a severity", async () => {
    const confirm = await runOnce(fakeProvider({ script: scriptedRuns() }), seat("judge"), input(candidates));
    expect(confirm.judgeOutput?.votes.every((v) => v.decision === "confirm")).toBe(true);
    const down = await runOnce(
      fakeProvider({ script: scriptedRuns({ judges: { "*": "downgrade" } }) }),
      seat("judge"),
      input(candidates),
    );
    expect(down.judgeOutput?.votes[0]).toMatchObject({ decision: "downgrade", severity: "nit" });
  });

  it.each([
    ["seatTimesOut", scenarios.seatTimesOut, "timeout"],
    ["seatErrors", scenarios.seatErrors, "error"],
    ["insufficientWork", scenarios.insufficientWork, "insufficient-work"],
    ["budgetExceeded", scenarios.budgetExceeded, "budget-exceeded"],
  ] as const)("%s affects only the keyed seat", async (_name, make, status) => {
    const p = fakeProvider({ script: make("hunter:perf:1") });
    const hit = await runOnce(p, seat("hunter", "perf"));
    const other = await runOnce(p, seat("hunter", "perf", 2));
    expect(hit.status).toBe(status);
    expect(other.status).toBe("ok");
  });

  it("failure audits look like what a runner would observe", async () => {
    const p = fakeProvider({
      script: scriptedRuns({ hunters: { perf: "insufficient-work", security: "budget-exceeded" } }),
    });
    const lazy = await runOnce(p, seat("hunter", "perf"));
    expect(lazy.audit.substantiveCalls).toBe(0);
    expect(lazy.audit.filesRead).toEqual([]);
    const spent = await runOnce(p, seat("hunter", "security"));
    expect(spent.audit.costUsd).toBe(0.25);
    expect(spent.output).toBeNull();
  });

  it("lookup order: seat id beats persona beats lens beats *", async () => {
    const script = scriptedRuns({
      hunters: { "*": "error", correctness: "block", skeptic: "timeout", "hunter:correctness:2": "pass" },
    });
    const p = fakeProvider({ script });
    expect((await runOnce(p, seat("hunter", "perf"))).status).toBe("error");
    expect((await runOnce(p, seat("hunter"))).output?.verdict).toBe("block");
    expect((await runOnce(p, { ...seat("hunter"), persona: "skeptic" })).status).toBe("timeout");
    expect((await runOnce(p, seat("hunter", "correctness", 2))).output?.verdict).toBe("pass");
  });
});
