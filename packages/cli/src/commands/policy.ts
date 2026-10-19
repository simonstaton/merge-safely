import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listEntries, readRawConnections } from "../connections-file.js";
import { CliError } from "../errors.js";
import { lintPolicy, POLICY_FILE, POLICY_TEMPLATE } from "../policy.js";
import type { Runtime } from "../runtime.js";

export async function policyLint(rt: Runtime, path: string | undefined): Promise<number> {
  const file = resolve(rt.ctx.cwd, path ?? POLICY_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (_err: unknown) {
    throw new CliError(
      "POLICY_NOT_FOUND",
      `policy file not found: ${file} (create one with \`merge-safely policy init\`)`,
    );
  }
  let ids: string[] | undefined;
  try {
    const { file: raw, missing } = await readRawConnections(rt.paths.connections);
    ids = missing ? [] : listEntries(raw).map((c) => c.id);
  } catch (err: unknown) {
    rt.warn(`connections not checked: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = lintPolicy(text, file, ids);
  if (rt.json) {
    rt.printJson({ path: file, ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings });
  } else {
    const c = rt.colour;
    for (const e of r.errors) rt.out(`${c.red("error")}  ${e}`);
    for (const w of r.warnings) rt.out(`${c.yellow("warning")}  ${w}`);
    if (r.errors.length === 0) {
      rt.out(
        `${c.green("ok")}  ${file}${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"})` : ""}`,
      );
    }
  }
  return r.errors.length ? 1 : 0;
}

export async function policyInit(rt: Runtime, path: string | undefined): Promise<number> {
  const file = resolve(rt.ctx.cwd, path ?? POLICY_FILE);
  try {
    await writeFile(file, POLICY_TEMPLATE, { encoding: "utf8", flag: "wx" });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") {
      throw new CliError("POLICY_EXISTS", `${file} already exists; not overwriting it`);
    }
    throw new CliError("POLICY_WRITE_FAILED", `could not write ${file}`);
  }
  if (rt.json) rt.printJson({ path: file, written: true });
  else rt.out(`Wrote ${file}. Check it with: merge-safely policy lint`);
  return 0;
}
