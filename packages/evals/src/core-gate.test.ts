import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, Pricing, PromptBuilders, ToolExecutorFactory } from "@merge-safely/core";
import { confirmAll, fakeModel, fakeProvider, passOutput } from "@merge-safely/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_CASES, SUITE_YML, tempDir, writeSuite } from "../test/helpers.js";
import { coreGateFactory } from "./gate.js";
import { runSuite } from "./runner.js";

const CONN: Connection = {
  id: "fake-main",
  provider: "fake",
  kind: "api-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  secret: { kind: "api-key", apiKey: "sk-fake" },
};
const MODELS = [fakeModel({ name: "fake-frontier", tier: "frontier" }), fakeModel({ name: "fake-mid", tier: "mid" })];
const pricing: Pricing = {
  withPricing: (m) => m,
  price: (m, u) => ({
    usd: (u.in * (m.pricing?.inPerMTok ?? 20) + u.out * (m.pricing?.outPerMTok ?? 80)) / 1_000_000,
    estimated: false,
  }),
  cheaper: () => undefined,
};
const prompts: PromptBuilders = {
  hunter: (lens, input) => ({ system: `hunter:${lens}`, user: input.diff }),
  judge: () => ({ system: "judge", user: "votes" }),
};

describe("coreGateFactory: the real orchestrator over fixture workspaces", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    await writeSuite(dir, SUITE_YML, STANDARD_CASES);
  });
  afterEach(() => cleanup());

  it("runs createGate per case; seats see the head tree; recall and false-block come from real verdicts", async () => {
    const seen: Record<string, string> = {};
    const tools: ToolExecutorFactory = (ws) => {
      // Read what a seat's read_file would see at acquisition time.
      const record = readFile(join(ws.cwd, "src/auth/login.ts"), "utf8")
        .then((t) => {
          seen[ws.headSha] = t;
        })
        .catch(() => undefined);
      return {
        definitions: () => [{ name: "read_file", description: "read", inputSchema: {}, substantive: true }],
        execute: async () => {
          await record;
          return { ok: true, output: "" };
        },
        audit: () => ({ substantiveCalls: 0, totalCalls: 0, filesRead: [], commandsRun: [] }),
      };
    };
    const provider = fakeProvider({
      id: "fake",
      models: MODELS,
      script: (seat, input) => {
        if (seat.role === "judge") return confirmAll(input.candidateFindings);
        if (seat.lens === "security" && input.change.files.some((f) => f.path === "src/auth/login.ts")) {
          return {
            verdict: "block",
            summary: "check() always returns true",
            findings: [
              {
                id: "x",
                severity: "blocker",
                class: "authn-bypass",
                title: "Login check always passes",
                detail: "check ignores its argument.",
                file: "src/auth/login.ts",
                line: 1,
              },
            ],
          };
        }
        return passOutput();
      },
    });
    const factory = coreGateFactory({
      providers: () => provider,
      connections: [CONN],
      catalog: () => MODELS,
      reporters: [],
      tools,
      prompts,
      pricing,
    });
    const r = await runSuite(dir, { gateFactory: factory });
    const byId = Object.fromEntries(r.cases.map((c) => [c.id, c]));
    expect(byId["incident-auth"]?.actual).toMatchObject({ status: "ok", decision: "block", tier: 3 });
    expect(byId["incident-auth"]?.passed).toBe(true);
    expect(byId["incident-auth"]?.actual.findings[0]).toMatchObject({
      class: "authn-bypass",
      lens: "security",
      models: ["fake-mid"],
    });
    expect(byId["clean-docs"]?.actual).toMatchObject({ decision: "pass", triage: "auto-pass", seats: 0 });
    expect(byId["clean-code"]?.actual).toMatchObject({ decision: "pass", tier: 0 });
    expect(r.summary).toMatchObject({ recall: 1, falseBlockRate: 0, unresolved: 0, ok: true });
    // The incident's seats read the head version of the file from a real checkout of headSha.
    expect(Object.values(seen)).toContain("export const check = (_ok: boolean) => true;\n");
  });
});
