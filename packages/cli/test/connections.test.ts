import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSecret } from "../src/connections-file.js";
import { fakeProvider, harness } from "./helpers.js";

const KEY = "sk-ant-api03-supersecretvalue-XYZ9";

describe("connections", () => {
  it("lists with secrets masked, tests, removes and prints the path", async () => {
    const provider = fakeProvider({
      validate: (c) =>
        c.id === "bad" ? { ok: false, message: `rejected ${KEY}` } : { ok: true, models: [], latencyMs: 5 },
    });
    const h = harness({ env: { ENV_KEY: KEY }, provider });
    await h.run("connect", "anthropic", "--api-key", KEY);
    await h.run("connect", "anthropic", "--api-key-env", "ENV_KEY", "--id", "bad", "--no-validate", "--label", "spare");

    let r = await h.run("connections", "list");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/id\s+provider\s+kind\s+label\s+model\s+last validated\s+secret/);
    expect(r.stdout).toContain("anthropic-main");
    expect(r.stdout).toContain("plaintext …XYZ9");
    expect(r.stdout).toContain("env:ENV_KEY");
    expect(r.stdout).toContain("never");
    expect(r.stdout).not.toContain(KEY);

    r = await h.run("--json", "connections", "list");
    expect(JSON.parse(r.stdout).connections).toHaveLength(2);
    expect(r.stdout).not.toContain(KEY);

    r = await h.run("connections", "test");
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/ok\s+anthropic-main/);
    expect(r.stdout).toMatch(/FAIL\s+bad/);
    expect(r.stdout).not.toContain(KEY);
    r = await h.run("connections", "test", "anthropic-main");
    expect(r.code).toBe(0);

    r = await h.run("connections", "remove", "bad");
    expect(r.code).toBe(0);
    const f = JSON.parse(readFileSync(join(h.home, "connections.json"), "utf8")) as { connections: { id: string }[] };
    expect(f.connections.map((c) => c.id)).toEqual(["anthropic-main"]);
    r = await h.run("connections", "remove", "bad");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("error [CONNECTION_NOT_FOUND]");

    r = await h.run("connections", "path");
    expect(r.stdout.trim()).toBe(join(h.home, "connections.json"));
    r = await h.run("--connections", "/tmp/x.json", "connections", "path");
    expect(r.stdout.trim()).toBe("/tmp/x.json");
  });

  it("says when there are none, and refuses to edit a corrupt file", async () => {
    const h = harness();
    expect((await h.run("connections", "list")).stdout).toContain("No connections");
    writeFileSync(join(h.home, "connections.json"), "{not json");
    const r = await h.run("connections", "remove", "x");
    expect(r.stderr).toContain("error [CONNECTIONS_INVALID]");
  });

  it("describes secret storage without revealing it", () => {
    expect(describeSecret({ apiKeyEnv: "A" })).toBe("env:A");
    expect(describeSecret({ secretRef: { encrypted: "zzz" } })).toBe("encrypted");
    expect(describeSecret({ secretRef: { file: "~/k" } })).toBe("file:~/k");
    expect(describeSecret({ secret: { kind: "api-key", apiKey: "short" } })).toBe("plaintext ****");
    expect(describeSecret({ secret: { kind: "subscription" } })).toBe("login");
    expect(describeSecret({ baseUrl: "http://localhost:11434/v1" })).toBe("no key");
  });
});
