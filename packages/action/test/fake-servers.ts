/**
 * Local HTTP stand-ins for the GitHub REST API and an OpenAI-compatible model endpoint, so the committed bundle can
 * run end to end without the network. Only what a docs-only PR review touches is implemented; anything else is
 * recorded in `unhandled` and answered with 404.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeGithubServer {
  url: string;
  requests: Recorded[];
  unhandled: string[];
  checkRuns: Array<Record<string, unknown> & { id: number }>;
  close(): Promise<void>;
}

export interface PrSpec {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (_err: unknown) {
    return text;
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise((resolve) => server.close(() => resolve()));
}

export async function fakeGithubServer(pr: PrSpec): Promise<FakeGithubServer> {
  const requests: Recorded[] = [];
  const unhandled: string[] = [];
  const checkRuns: FakeGithubServer["checkRuns"] = [];
  const comments: Array<{ id: number; body: string; user: { login: string; type: string } }> = [];
  const repoPath = `/repos/${pr.owner}/${pr.repo}`;
  const pull = {
    number: pr.number,
    title: "Docs: clarify setup",
    body: "Docs only.",
    html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    draft: false,
    state: "open",
    user: { login: "dev", id: 12, type: "User" },
    labels: [],
    head: { sha: pr.headSha, ref: "docs", repo: { full_name: `${pr.owner}/${pr.repo}` } },
    base: { sha: pr.baseSha, ref: "main", repo: { full_name: `${pr.owner}/${pr.repo}` } },
    additions: pr.files.reduce((n, f) => n + f.additions, 0),
    deletions: pr.files.reduce((n, f) => n + f.deletions, 0),
    changed_files: pr.files.length,
  };
  const diff = pr.files
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`)
    .join("");
  let nextId = 1000;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = await readBody(req);
    requests.push({ method, path, body });
    const accept = String(req.headers.accept ?? "");

    if (method === "GET" && path === "/app")
      return send(res, 403, { message: "Resource not accessible by integration" });
    if (method === "GET" && path === `${repoPath}/pulls/${pr.number}`) {
      return accept.includes("diff") ? send(res, 200, diff, "text/plain") : send(res, 200, pull);
    }
    if (method === "GET" && path === `${repoPath}/pulls/${pr.number}/files`) return send(res, 200, pr.files);
    if (method === "GET" && path === `${repoPath}/pulls/${pr.number}/commits`) {
      return send(res, 200, [{ sha: pr.headSha, commit: { message: "docs: clarify setup" } }]);
    }
    if (method === "GET" && /\/pulls\/\d+\/(reviews|comments)$/.test(path)) return send(res, 200, []);
    if (method === "POST" && path === `${repoPath}/pulls/${pr.number}/reviews`) return send(res, 200, { id: 1 });
    if (method === "GET" && path.startsWith(`${repoPath}/contents/`)) return send(res, 404, { message: "Not Found" });
    if (method === "GET" && path.startsWith(`${repoPath}/compare/`)) return send(res, 200, { files: pr.files });
    if (method === "GET" && /\/commits\/[^/]+\/check-runs$/.test(path)) {
      const sha = path.split("/").at(-2);
      const runs = checkRuns.filter((r) => r.head_sha === sha);
      return send(res, 200, { total_count: runs.length, check_runs: runs });
    }
    if (method === "GET" && /\/commits\/[^/]+\/status$/.test(path))
      return send(res, 200, { state: "success", statuses: [] });
    if (method === "POST" && path === `${repoPath}/check-runs`) {
      const b = (body ?? {}) as Record<string, unknown>;
      const run = {
        id: nextId++,
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
        ...b,
        output: { title: null, summary: null, text: null, ...((b.output as object) ?? {}) },
        app: { id: 15368, slug: "github-actions" },
      };
      checkRuns.push(run);
      return send(res, 201, run);
    }
    const m = /\/check-runs\/(\d+)$/.exec(path);
    if (method === "PATCH" && m) {
      const run = checkRuns.find((r) => r.id === Number(m[1]));
      if (!run) return send(res, 404, { message: "Not Found" });
      const b = (body ?? {}) as Record<string, unknown>;
      Object.assign(run, b, { output: { ...(run.output as object), ...((b.output as object) ?? {}) } });
      if (b.conclusion) run.status = "completed"; // GitHub: a conclusion implies completed
      return send(res, 200, run);
    }
    if (method === "GET" && path === `${repoPath}/issues/${pr.number}/comments`) return send(res, 200, comments);
    if (method === "POST" && path === `${repoPath}/issues/${pr.number}/comments`) {
      const c = {
        id: nextId++,
        body: String((body as { body?: string })?.body ?? ""),
        user: { login: "github-actions[bot]", type: "Bot" },
      };
      comments.push(c);
      return send(res, 201, c);
    }
    const cm = /\/issues\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && cm) {
      const c = comments.find((x) => x.id === Number(cm[1]));
      if (c) c.body = String((body as { body?: string })?.body ?? "");
      return send(res, 200, c ?? {});
    }
    unhandled.push(`${method} ${path}`);
    return send(res, 404, { message: "Not Found" });
  });
  const url = await listen(server);
  return { url, requests, unhandled, checkRuns, close: closer(server) };
}

export interface FakeModelServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** OpenAI-compatible: lists one model; completions are recorded (a docs-only PR should make none). */
export async function fakeModelServer(): Promise<FakeModelServer> {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push({ method: req.method ?? "GET", path, body: await readBody(req) });
    if (path.endsWith("/models"))
      return send(res, 200, { object: "list", data: [{ id: "test-model", object: "model" }] });
    return send(res, 500, { error: { message: "no completions in this test" } });
  });
  const url = await listen(server);
  return { url, requests, close: closer(server) };
}
