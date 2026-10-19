import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDb, type JobRow } from "./db.js";
import { createLogger, SecretSet } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { backoffMs, classifyError, Worker, type WorkerOptions } from "./queue.js";
import { TEST_MASTER_KEY } from "./testing.js";

let dir: string;
let db: AppDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ms-app-q-"));
  db = new AppDb({ path: join(dir, "app.db"), masterKey: TEST_MASTER_KEY });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const gateError = (code: string) => Object.assign(new Error(`gate ${code}`), { name: "GateError", code });
const job = { installationId: 1, repo: "o/r", number: 7, headSha: "a".repeat(40), event: "pull_request.opened" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function worker(run: WorkerOptions["run"], over: Partial<WorkerOptions> = {}): Worker {
  return new Worker({
    db,
    run,
    logger: createLogger({ level: "error", write: () => {} }),
    secrets: new SecretSet(),
    metrics: new MetricsRegistry(),
    pollMs: 5,
    backoffBaseMs: 1,
    tickMs: 60_000,
    ...over,
  });
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

describe("classifyError", () => {
  it("retries transient gate errors and fails configuration errors", () => {
    expect(classifyError(gateError("source"))).toBe("retry");
    expect(classifyError(gateError("internal"))).toBe("retry");
    expect(classifyError(gateError("store-conflict"))).toBe("retry");
    expect(classifyError(gateError("seating"))).toBe("fail");
    expect(classifyError(gateError("policy"))).toBe("fail");
    expect(classifyError(gateError("budget"))).toBe("fail");
    expect(classifyError(gateError("head-moved"))).toBe("superseded");
    expect(classifyError(Object.assign(new Error("x"), { name: "SeatingError" }))).toBe("fail");
    expect(classifyError(Object.assign(new Error("nf"), { status: 404 }))).toBe("fail");
    expect(classifyError(Object.assign(new Error("rl"), { status: 429 }))).toBe("retry");
    expect(classifyError(new Error("ECONNRESET"))).toBe("retry");
  });

  it("backs off exponentially", () => {
    expect([1, 2, 3].map((a) => backoffMs(100, a))).toEqual([100, 200, 400]);
  });
});

describe("Worker", () => {
  it("runs a job to done", async () => {
    const { id } = db.enqueue(job);
    const w = worker(async () => ({ outcome: "pass" }));
    w.start();
    await until(() => db.getJob(id)?.state === "done");
    expect(db.getJob(id)?.outcome).toBe("pass");
    await w.stop();
  });

  it("retries a retryable error with backoff, up to 3 retries, then fails and reports", async () => {
    const { id } = db.enqueue(job);
    let attempts = 0;
    const failures: string[] = [];
    const w = worker(
      async () => {
        attempts++;
        throw gateError("source");
      },
      { onFinalFailure: async (_j, m) => void failures.push(m) },
    );
    w.start();
    await until(() => db.getJob(id)?.state === "failed");
    expect(attempts).toBe(4);
    expect(db.getJob(id)?.attempts).toBe(4);
    expect(failures).toEqual(["gate source"]);
    await w.stop();
  });

  it("succeeds on a later attempt", async () => {
    const { id } = db.enqueue(job);
    let n = 0;
    const w = worker(async () => {
      n++;
      if (n < 3) throw gateError("internal");
      return { outcome: "block" };
    });
    w.start();
    await until(() => db.getJob(id)?.state === "done");
    expect(n).toBe(3);
    await w.stop();
  });

  it("does not retry seating/policy/budget errors", async () => {
    const { id } = db.enqueue(job);
    let n = 0;
    const w = worker(async () => {
      n++;
      throw gateError("budget");
    });
    w.start();
    await until(() => db.getJob(id)?.state === "failed");
    await sleep(30);
    expect(n).toBe(1);
    await w.stop();
  });

  it("marks a running job superseded when a newer SHA arrives, then runs the newer one", async () => {
    const first = db.enqueue(job);
    let release: () => void = () => {};
    const ran: string[] = [];
    const w = worker(async (j: JobRow) => {
      ran.push(j.head_sha);
      if (j.id === first.id) await new Promise<void>((r) => (release = r));
      return { outcome: "pass" };
    });
    w.start();
    await until(() => db.getJob(first.id)?.state === "running");
    const second = db.enqueue({ ...job, headSha: "b".repeat(40) });
    await sleep(30);
    expect(ran).toEqual(["a".repeat(40)]); // one review per PR at a time
    release();
    await until(() => db.getJob(second.id)?.state === "done");
    expect(db.getJob(first.id)?.state).toBe("superseded");
    expect(ran).toEqual(["a".repeat(40), "b".repeat(40)]);
    await w.stop();
  });

  it("respects concurrency", async () => {
    for (let n = 1; n <= 4; n++) db.enqueue({ ...job, number: n });
    let active = 0;
    let peak = 0;
    const w = worker(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(20);
        active--;
        return { outcome: "pass" };
      },
      { concurrency: 2 },
    );
    w.start();
    await until(() => db.countByState().done === 4);
    expect(peak).toBe(2);
    await w.stop();
  });

  it("recovers jobs left running by a crash", async () => {
    const { id } = db.enqueue(job);
    db.claimNext(); // simulate a crash mid-job: row stays running
    expect(db.getJob(id)?.state).toBe("running");
    const w = worker(async () => ({ outcome: "pass" }));
    w.start();
    await until(() => db.getJob(id)?.state === "done");
    await w.stop();
  });

  it("graceful stop waits for running jobs; past the deadline they stay running for the next boot", async () => {
    const a = db.enqueue(job);
    let release: () => void = () => {};
    const w = worker(async () => {
      await new Promise<void>((r) => (release = r));
      return { outcome: "pass" };
    });
    w.start();
    await until(() => db.getJob(a.id)?.state === "running");
    expect(await w.stop(20)).toBe(1);
    expect(db.getJob(a.id)?.state).toBe("running");
    release();
    await w.drain();

    const b = db.enqueue({ ...job, number: 9 });
    const w2 = worker(async () => {
      await sleep(20);
      return { outcome: "pass" };
    });
    w2.start();
    await until(() => db.getJob(b.id)?.state === "running");
    expect(await w2.stop(2000)).toBe(0);
    expect(db.getJob(b.id)?.state).toBe("done");
    // Nothing new is claimed after stop.
    const c = db.enqueue({ ...job, number: 10 });
    await sleep(30);
    expect(db.getJob(c.id)?.state).toBe("queued");
  });

  it("runs the tick hook", async () => {
    let ticks = 0;
    const w = worker(async () => ({ outcome: "x" }), { onTick: async () => void ticks++ });
    await w.tick();
    expect(ticks).toBe(1);
  });
});
