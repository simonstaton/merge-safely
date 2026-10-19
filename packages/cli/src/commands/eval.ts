import { evalCommand, type GateFactory } from "@merge-safely/evals";
import type { OctokitLike } from "@merge-safely/github";
import { evalGateFactory } from "../gate.js";
import type { Runtime } from "../runtime.js";
import { discoverGithubToken } from "../token.js";

/**
 * `merge-safely eval …` and `merge-safely eval init <dir>`: arguments after `eval` go to @merge-safely/evals verbatim
 * (it parses them strictly) and its exit code is passed through: 0 gates hold, 1 a gate failed, 2 usage/validation.
 * Full runs use the real orchestrator over this CLI's connections; `--dry` needs no connections at all.
 */
export async function evalCliCommand(rt: Runtime, rawArgv: string[]): Promise<number> {
  // Global --json means the JSON report unless a --format was given explicitly.
  const hasFormat = rawArgv.some((a) => a === "--format" || a.startsWith("--format="));
  const argv = rt.json && rawArgv[0] !== "init" && !hasFormat ? [...rawArgv, "--format", "json"] : rawArgv;
  const isInit = argv[0] === "init";
  const dry = argv.some((a) => a === "--dry" || (a.startsWith("--dry=") && !/=(false|0|no|off)$/i.test(a)));
  const help = argv.includes("--help");
  let gateFactory: GateFactory | undefined;
  let github: { octokit: OctokitLike } | undefined;
  if (!isInit && !help) {
    if (!dry) {
      const connections = await rt.loadConnections();
      if (connections.length > 0) gateFactory = await evalGateFactory(connections, rt.ctx.registry(), rt.logger);
    }
    // A dry run makes no calls of its own: only an already-exported token is used, `gh auth token` is not run.
    const token = rt.ctx.octokit ? await discoverGithubToken(rt.ctx.env, rt.ctx.exec, { allowGh: !dry }) : undefined;
    if (token && rt.ctx.octokit) {
      rt.secrets.add(token.token);
      github = { octokit: rt.ctx.octokit(token.token, rt.logger) };
    }
  }
  return evalCommand(argv, {
    ...(gateFactory ? { gateFactory } : {}),
    ...(github ? { github } : {}),
    stdout: (t) => rt.ctx.io.stdout.write(rt.secrets.scrub(t)),
    stderr: (t) => rt.ctx.io.stderr.write(rt.secrets.scrub(t)),
  });
}
