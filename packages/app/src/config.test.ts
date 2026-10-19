import { describe, expect, it } from "vitest";
import { ConfigError, configSecrets, loadConfig, MASTER_KEY_HELP, normalisePem } from "./config.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
const base = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_WEBHOOK_SECRET: "w".repeat(20),
  MERGE_SAFELY_MASTER_KEY: "f".repeat(64),
  SETUP_TOKEN: "s".repeat(24),
};

function problems(env: Record<string, string | undefined>, readFile?: (p: string) => string): string[] {
  try {
    loadConfig(env, readFile ? { readFile } : {});
  } catch (err: unknown) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      appId: "123",
      port: 8080,
      concurrency: 2,
      logLevel: "info",
      dataDir: "/data",
      dbPath: "/data/app.db",
    });
    expect(c.publicUrl).toBeUndefined();
    expect(c.slackWebhookUrl).toBeUndefined();
  });

  it("reads every optional variable", () => {
    const c = loadConfig({
      ...base,
      MERGE_SAFELY_DATA_DIR: "/srv/ms",
      PORT: "3000",
      PUBLIC_URL: "https://gate.example.com/",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
      CONCURRENCY: "4",
      LOG_LEVEL: "DEBUG",
    });
    expect(c).toMatchObject({
      dataDir: "/srv/ms",
      dbPath: "/srv/ms/app.db",
      port: 3000,
      concurrency: 4,
      logLevel: "debug",
    });
    expect(c.publicUrl).toBe("https://gate.example.com");
  });

  it("refuses to start without a master key and explains how to make one", () => {
    const { MERGE_SAFELY_MASTER_KEY: _omit, ...env } = base;
    const p = problems(env);
    expect(p).toContain(MASTER_KEY_HELP);
    expect(MASTER_KEY_HELP).toContain("openssl rand -hex 32");
  });

  it("requires the setup token, webhook secret and app id", () => {
    const p = problems({ GITHUB_APP_PRIVATE_KEY: PEM, MERGE_SAFELY_MASTER_KEY: "f".repeat(64) });
    expect(p.join("\n")).toMatch(/SETUP_TOKEN/);
    expect(p.join("\n")).toMatch(/GITHUB_WEBHOOK_SECRET/);
    expect(p.join("\n")).toMatch(/GITHUB_APP_ID/);
  });

  it("rejects bad values without echoing secrets", () => {
    const p = problems({
      ...base,
      PORT: "99999",
      CONCURRENCY: "0",
      LOG_LEVEL: "loud",
      SLACK_WEBHOOK_URL: "http://x",
      SETUP_TOKEN: "short",
    });
    expect(p.length).toBeGreaterThanOrEqual(5);
    expect(p.join("\n")).not.toContain("short\n");
  });

  it("reads the private key from a file, or refuses both forms at once", () => {
    const { GITHUB_APP_PRIVATE_KEY: _k, ...env } = base;
    const c = loadConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem" }, { readFile: () => PEM });
    expect(c.privateKey).toBe(`${PEM}\n`);
    expect(problems({ ...base, GITHUB_APP_PRIVATE_KEY_FILE: "/k.pem" }, () => PEM)[0]).toMatch(/not both/);
    expect(problems({ ...env }).join()).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    expect(problems({ ...base, GITHUB_APP_PRIVATE_KEY: "nope" }).join()).toMatch(/not a PEM/);
  });

  it("normalises escaped newlines in an inline PEM", () => {
    expect(normalisePem("-----BEGIN X PRIVATE KEY-----\\nabc\\n-----END X PRIVATE KEY-----")).toBe(
      "-----BEGIN X PRIVATE KEY-----\nabc\n-----END X PRIVATE KEY-----\n",
    );
  });

  it("lists every secret for the scrubber", () => {
    const c = loadConfig({ ...base, SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" });
    expect(configSecrets(c)).toEqual(
      expect.arrayContaining([
        base.GITHUB_WEBHOOK_SECRET,
        base.MERGE_SAFELY_MASTER_KEY,
        base.SETUP_TOKEN,
        "https://hooks.slack.com/services/T/B/x",
      ]),
    );
  });
});
