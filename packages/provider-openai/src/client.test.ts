import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY, apiKeyConn, compatConn } from "../test/helpers.js";
import { defaultClientFactory } from "./client.js";

interface Captured {
  url: string;
  headers: Headers;
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: { headers?: ConstructorParameters<typeof Headers>[0] }) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(
      JSON.stringify({ object: "list", data: [{ id: "gpt-5", object: "model", created: 0, owned_by: "openai" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  return calls;
}

const HEADER_SECRET = "hdr-secret-PROBE-123456";

describe("defaultClientFactory ignores the ambient environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function poisonEnv() {
    vi.stubEnv("OPENAI_API_KEY", "sk-env-should-never-be-used-000000");
    vi.stubEnv("OPENAI_BASE_URL", "http://attacker.invalid/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    vi.stubEnv("OPENAI_LOG", "debug");
  }

  it("api-key: fixed base URL, connection key, no env org/project, no SDK logging", async () => {
    poisonEnv();
    const calls = stubFetch();
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const res = await defaultClientFactory(apiKeyConn()).models.list();
    expect(res.data[0]?.id).toBe("gpt-5");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers.get("openai-organization")).toBeNull();
    expect(calls[0]?.headers.get("openai-project")).toBeNull();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("openai-compatible: base URL and headers from the connection; OPENAI_LOG cannot print them", async () => {
    poisonEnv();
    const calls = stubFetch();
    const printed: string[] = [];
    for (const m of ["log", "debug", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
    const conn = compatConn({
      secret: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        headers: { "X-Api-Token": HEADER_SECRET },
      },
    });
    await defaultClientFactory(conn).models.list();
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer not-needed");
    expect(calls[0]?.headers.get("x-api-token")).toBe(HEADER_SECRET);
    expect(printed.join("\n")).not.toContain(HEADER_SECRET);
    expect(printed).toHaveLength(0);
  });
});
