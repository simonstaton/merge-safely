import { describe, expect, it } from "vitest";
import { loadPolicy } from "../policy/index.js";
import type { PolicyInput } from "../policy/schema.js";
import type { Change, ConnectionRecord, ModelInfo, ModelTierClass, Tier } from "../types.js";
import { SeatingError } from "./errors.js";
import { matchGlob } from "./glob.js";
import { describeSeating, planFallback, seat } from "./index.js";

const info = (provider: string, name: string, tier: ModelTierClass, priced = true): ModelInfo => ({
  provider,
  name,
  tier,
  supportsTools: true,
  supportsStructuredOutput: true,
  contextTokens: 1_000_000,
  maxOutputTokens: 64_000,
  ...(priced ? { pricing: { inPerMTok: 1, outPerMTok: 2 } } : {}),
  effortLevels: ["low", "medium", "high"],
});

const CATALOGS: Record<string, ModelInfo[]> = {
  "anthropic-main": [
    info("anthropic", "claude-opus-5-5", "frontier"),
    info("anthropic", "claude-sonnet-5-5", "mid"),
    info("anthropic", "claude-haiku-5-5", "small"),
  ],
  "openai-main": [info("openai", "gpt-5", "frontier"), info("openai", "gpt-5-mini", "mid")],
  local: [info("ollama", "llama3.1", "small", false)],
};
const catalog = (id: string): ModelInfo[] => CATALOGS[id] ?? [];
const conn = (id: string, provider: string): ConnectionRecord => ({
  id,
  provider,
  kind: "api-key",
  createdAt: "2026-10-01T00:00:00Z",
});
const ANTHROPIC = conn("anthropic-main", "anthropic");
const OPENAI = conn("openai-main", "openai");

const tier = (level: Tier["level"]): Tier => ({
  level,
  score: level * 25,
  factors: { loc: 10, files: 1, modules: 1, criticalPathHits: [] },
  reasons: [],
});
const change = (paths: string[]): Change => ({
  repo: { host: "github.com", owner: "o", name: "r" },
  number: 1,
  headSha: "h",
  baseSha: "b",
  baseRef: "main",
  headRef: "feat",
  title: "t",
  body: "",
  author: { kind: "human", login: "dev" },
  files: paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 1 })),
  stats: { additions: paths.length, deletions: paths.length, files: paths.length },
  labels: [],
  draft: false,
  ciStatus: "success",
});
const BACKEND = change(["src/server/handler.ts"]);
const UI = change(["apps/web/src/components/Button.tsx"]);

function run(policyIn: PolicyInput, level: Tier["level"], c: Change, connections = [ANTHROPIC]) {
  return seat({ tier: tier(level), change: c, policy: loadPolicy(policyIn), connections, catalog });
}

describe("glob", () => {
  it("matches whole segments", () => {
    expect(matchGlob("**/*.tsx", "a/b/C.tsx")).toBe(true);
    expect(matchGlob("**/*.tsx", "C.tsx")).toBe(true);
    expect(matchGlob("**/auth/**", "src/auth/x.ts")).toBe(true);
    expect(matchGlob("**/auth/**", "src/author/x.ts")).toBe(false);
    expect(matchGlob("**/components/**", "components/a/b.ts")).toBe(true);
    expect(matchGlob("docs/**", "docs/a.md")).toBe(true);
    expect(matchGlob("*.md", "docs/a.md")).toBe(false);
    expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("**/*.css", "a/b.scss")).toBe(false);
    expect(matchGlob("a/**/b/**/c.ts", "a/x/y/b/c.ts")).toBe(true);
  });
});

describe("seat: lens sets", () => {
  it("tier 0 and 1 use t1", () => {
    for (const level of [0, 1] as const) {
      const r = run({}, level, BACKEND);
      expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual(["correctness", "repro"]);
      expect(r.seats.filter((s) => s.role === "judge")).toHaveLength(1);
      expect(r.secondJudgeRound).toBe(false);
    }
  });

  it("tier 3 seats the t3 set with two judges and a second judge round", () => {
    const r = run({}, 3, BACKEND);
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.lens)).toEqual([
      "intent",
      "correctness",
      "repro",
      "security",
      "perf",
      "rollout",
      "blast-radius",
    ]);
    expect(r.seats.filter((s) => s.role === "judge").map((s) => s.id)).toEqual(["judge:1", "judge:2"]);
    expect(r.secondJudgeRound).toBe(true);
  });

  it("uses stable seat ids", () => {
    const r = run({}, 1, BACKEND);
    expect(r.seats.map((s) => s.id)).toEqual(["hunter:correctness:1", "hunter:repro:1", "judge:1"]);
  });

  it("budgets come from policy", () => {
    const r = run({ budget: { perSeatUsd: 2, seatMaxTurns: 10 } }, 1, BACKEND);
    expect(r.seats[0]?.budget).toEqual({ maxTurns: 10, maxUsd: 2, deadlineMs: 600_000 });
  });
});

describe("seat: conditional lenses", () => {
  it("design-fidelity is gated on UI paths", () => {
    expect(run({}, 2, BACKEND).seats.map((s) => s.lens)).not.toContain("design-fidelity");
    expect(run({}, 2, UI).seats.map((s) => s.lens)).toContain("design-fidelity");
  });

  it("a rename's previous path also counts", () => {
    const c = change(["src/x.ts"]);
    (c.files[0] as { previousPath?: string }).previousPath = "src/ui/x.tsx";
    expect(run({}, 2, c).seats.map((s) => s.lens)).toContain("design-fidelity");
  });

  it("throws when gating leaves no hunters", () => {
    expect(() =>
      run({ panel: { t1: { hunters: ["design-fidelity"], judges: 1 } }, models: {} }, 1, BACKEND),
    ).toThrowError(SeatingError);
  });
});

describe("seat: model selection", () => {
  it("automatic: judges frontier, hunters mid", () => {
    const r = run({}, 1, BACKEND);
    expect(r.seats.find((s) => s.role === "hunter")?.model).toEqual({
      connectionId: "anthropic-main",
      provider: "anthropic",
      name: "claude-sonnet-5-5",
    });
    expect(r.seats.find((s) => s.role === "judge")?.model.name).toBe("claude-opus-5-5");
  });

  it("hunters fall back to frontier when no mid model is reachable", () => {
    CATALOGS.solo = [info("x", "big", "frontier")];
    const r = run({}, 1, BACKEND, [conn("solo", "x")]);
    expect(r.seats.every((s) => s.model.name === "big")).toBe(true);
    delete CATALOGS.solo;
  });

  it("explicit hunters/judges selections apply, per-lens override wins", () => {
    const r = run(
      {
        models: {
          hunters: { connection: "anthropic-main", model: "claude-haiku-5-5" },
          judges: { connection: "anthropic-main", model: "claude-sonnet-5-5", effort: "high" },
          perLens: { repro: { connection: "anthropic-main", model: "claude-opus-5-5" } },
        },
      },
      1,
      BACKEND,
    );
    const byId = Object.fromEntries(r.seats.map((s) => [s.id, s.model]));
    expect(byId["hunter:correctness:1"]?.name).toBe("claude-haiku-5-5");
    expect(byId["hunter:repro:1"]?.name).toBe("claude-opus-5-5");
    expect(byId["judge:1"]).toMatchObject({ name: "claude-sonnet-5-5", effort: "high" });
  });

  it("accepts a date-suffixed id for a catalog model", () => {
    const r = run(
      { models: { hunters: { connection: "anthropic-main", model: "claude-sonnet-5-5-20260301" } } },
      1,
      BACKEND,
    );
    expect(r.seats[0]?.model.name).toBe("claude-sonnet-5-5-20260301");
  });

  it("unreachable connection throws with a fix hint", () => {
    try {
      run({ models: { judges: { connection: "openai-main", model: "gpt-5" } } }, 1, BACKEND);
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SeatingError);
      const e = err as SeatingError;
      expect(e.message).toContain('"openai-main"');
      expect(e.policyKey).toBe("models.judges");
      expect(e.fix).toContain("anthropic-main");
    }
  });

  it("unreachable model throws with a fix hint listing reachable models", () => {
    try {
      run({ models: { perLens: { security: { connection: "anthropic-main", model: "gpt-5" } } } }, 3, BACKEND);
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SeatingError);
      const e = err as SeatingError;
      expect(e.policyKey).toBe("models.perLens.security");
      expect(e.fix).toContain("claude-sonnet-5-5");
    }
  });

  it("no connections throws", () => {
    expect(() => run({}, 1, BACKEND, [])).toThrowError(SeatingError);
    expect(() => run({}, 1, BACKEND, [conn("empty", "x")])).toThrowError(/offers any model/);
  });

  it("trusts a connection without a model list via its default model, with a warning", () => {
    const r = run({}, 1, BACKEND, [{ ...conn("gw", "openai-compatible"), defaultModel: "my-model" }]);
    expect(r.seats.every((s) => s.model.name === "my-model")).toBe(true);
    expect(r.warnings.some((w) => w.includes("unverified"))).toBe(true);
  });

  it("warns about unpriced models and invalid effort", () => {
    const r = run({ models: { hunters: { connection: "local", model: "llama3.1", effort: "max" } } }, 1, BACKEND, [
      ANTHROPIC,
      conn("local", "ollama"),
    ]);
    expect(r.warnings.some((w) => w.includes("pessimistic"))).toBe(true);
    expect(r.warnings.some((w) => w.includes('effort "max"'))).toBe(true);
  });
});

describe("seat: decorrelation", () => {
  it("alternates hunters across connections and puts judges on the minority connection", () => {
    const r = run({}, 3, BACKEND, [ANTHROPIC, OPENAI]);
    const hunters = r.seats.filter((s) => s.role === "hunter").map((s) => s.model.connectionId);
    expect(hunters).toEqual([
      "anthropic-main",
      "openai-main",
      "anthropic-main",
      "openai-main",
      "anthropic-main",
      "openai-main",
      "anthropic-main",
    ]);
    expect(r.seats.filter((s) => s.role === "hunter")[1]?.model.name).toBe("gpt-5-mini");
    const judges = r.seats.filter((s) => s.role === "judge");
    expect(judges.every((j) => j.model.connectionId === "openai-main" && j.model.name === "gpt-5")).toBe(true);
  });

  it("is off when decorrelate is false", () => {
    const r = run({ models: { decorrelate: false } }, 3, BACKEND, [ANTHROPIC, OPENAI]);
    expect(r.seats.every((s) => s.model.connectionId === "anthropic-main")).toBe(true);
  });

  it("starts the rotation at the explicitly configured hunter connection", () => {
    const r = run({ models: { hunters: { connection: "openai-main", model: "gpt-5" } } }, 1, BACKEND, [
      ANTHROPIC,
      OPENAI,
    ]);
    expect(r.seats.filter((s) => s.role === "hunter").map((s) => s.model.name)).toEqual(["gpt-5", "claude-sonnet-5-5"]);
  });

  it("keeps explicit judges even when decorrelating", () => {
    const r = run({ models: { judges: { connection: "anthropic-main", model: "claude-opus-5-5" } } }, 2, BACKEND, [
      ANTHROPIC,
      OPENAI,
    ]);
    expect(r.seats.filter((s) => s.role === "judge").every((j) => j.model.connectionId === "anthropic-main")).toBe(
      true,
    );
  });
});

describe("planFallback", () => {
  const policy = loadPolicy({ models: { fallback: { connection: "openai-main", model: "gpt-5" } } });
  const s = run({}, 1, BACKEND).seats[0];

  it("returns the fallback ref when reachable", () => {
    expect(s && planFallback(s, policy, [ANTHROPIC, OPENAI], catalog)).toEqual({
      connectionId: "openai-main",
      provider: "openai",
      name: "gpt-5",
    });
  });

  it("is undefined when unconfigured, disconnected, unreachable or identical", () => {
    if (!s) throw new Error("no seat");
    expect(planFallback(s, loadPolicy({}), [ANTHROPIC, OPENAI], catalog)).toBeUndefined();
    expect(planFallback(s, policy, [ANTHROPIC], catalog)).toBeUndefined();
    const bad = loadPolicy({ models: { fallback: { connection: "openai-main", model: "nope" } } });
    expect(planFallback(s, bad, [ANTHROPIC, OPENAI], catalog)).toBeUndefined();
    const same = loadPolicy({ models: { fallback: { connection: "anthropic-main", model: s.model.name } } });
    expect(planFallback(s, same, [ANTHROPIC], catalog)).toBeUndefined();
  });
});

describe("describeSeating", () => {
  it("summarises the panel", () => {
    const { seats } = run({}, 1, BACKEND);
    const text = describeSeating(seats, () => 1.5);
    expect(text.split("\n")[0]).toBe("Panel: 2 hunters, 1 judge");
    expect(text).toContain("hunter:correctness:1");
    expect(text).toContain("anthropic-main/claude-sonnet-5-5");
    expect(text).toContain("est $1.50");
    const down = describeSeating([{ ...(seats[0] as (typeof seats)[0]), downgradedFrom: seats[2]?.model }]);
    expect(down).toContain("downgraded from anthropic-main/claude-opus-5-5");
  });
});
