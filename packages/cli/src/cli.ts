import { Command, CommanderError } from "commander";
import { CONNECT_PROVIDERS, type ConnectOptions, connectCommand } from "./commands/connect.js";
import { connectionsList, connectionsPath, connectionsRemove, connectionsTest } from "./commands/connections.js";
import { policyInit, policyLint } from "./commands/policy.js";
import {
  estimateCommand,
  explainCommand,
  type RunOptions,
  runCommand,
  type VerdictOptions,
  verdictCommand,
} from "./commands/review.js";
import { EXIT, exitCodeFor, formatError } from "./errors.js";
import { type CliContext, type GlobalOptions, Runtime } from "./runtime.js";
import { CLI_VERSION } from "./version.js";

type Handler<O> = (rt: Runtime, opts: O, ...args: string[]) => Promise<number>;

/** Build the commander program. `done` receives each command's exit code. */
export function buildProgram(ctx: CliContext, done: (code: number) => void): Command {
  const program = new Command("merge-safely");
  program
    .description("Adversarial, risk-tiered AI code review gate with a commit-pinned merge signal")
    .version(CLI_VERSION, "-V, --version")
    .option("--home <dir>", "state directory (default $MERGE_SAFELY_HOME or ~/.merge-safely)")
    .option("--connections <path>", "connections file (default <home>/connections.json)")
    .option("--verbose", "log progress to stderr")
    .option("--json", "machine-readable output on stdout")
    .option("--no-color", "disable colour")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.io.stdout.write(s),
      writeErr: (s) => ctx.io.stderr.write(s),
      outputError: () => {},
    })
    .showHelpAfterError(false);

  const wrap =
    <O>(fn: Handler<O>) =>
    async (...raw: unknown[]): Promise<void> => {
      const cmd = raw[raw.length - 1] as Command;
      const args = raw.slice(0, -2).filter((a): a is string => typeof a === "string");
      const opts = cmd.optsWithGlobals<O & GlobalOptions>();
      const rt = new Runtime(ctx, opts);
      try {
        done(await fn(rt, opts, ...args));
      } catch (err: unknown) {
        rt.err(formatError(err, rt.secrets));
        done(exitCodeFor(err));
      }
    };

  program
    .command("connect")
    .description(`connect a model provider: ${CONNECT_PROVIDERS.join(", ")}`)
    .argument("<provider>", "provider to connect")
    .option("--id <id>", "connection id referenced by policy (default <provider>-main)")
    .option("--api-key-env <ENV>", "store a reference to this environment variable instead of the key")
    .option("--api-key <key>", "the key itself (lands in shell history; prefer the prompt or --api-key-env)")
    .option("--base-url <url>", "base URL for compatible endpoints and gateways")
    .option("--model <name>", "default model for this connection")
    .option("--runner <runner>", 'runner preference; "cli" uses the Claude Code CLI (anthropic)')
    .option("--subscription", "use your Claude Code login (anthropic; your terms, opt-in)")
    .option("--label <text>", "label shown in listings")
    .option("--no-validate", "save without calling the provider")
    .action(wrap<ConnectOptions>((rt, opts, provider) => connectCommand(rt, provider ?? "", opts)));

  const conns = program.command("connections").description("manage saved connections");
  conns
    .command("list")
    .description("list connections (secrets masked)")
    .action(wrap((rt) => connectionsList(rt)));
  conns
    .command("test")
    .description("validate one or every connection")
    .argument("[id]")
    .action(wrap((rt, _o, id) => connectionsTest(rt, id)));
  conns
    .command("remove")
    .description("remove a connection")
    .argument("<id>")
    .action(wrap((rt, _o, id) => connectionsRemove(rt, id ?? "")));
  conns
    .command("path")
    .description("print the connections file path")
    .action(wrap((rt) => connectionsPath(rt)));

  const prOptions = (c: Command) =>
    c
      .option("--repo <owner/name>", "GitHub repository")
      .option("--pr <n>", "pull request number")
      .option("--policy <path>", "policy file (default: .merge-safely.yml on the PR's base branch)");

  prOptions(program.command("run").description("review a pull request, or the working tree with --local"))
    .option("--local", "review the working tree against --base (no store, nothing posted)")
    .option("--base <ref>", "base ref for --local (default: origin/HEAD, else main)")
    .option("--report <kind>", "github | status | stdout | json (default github with an App token, else status)")
    .option("--store <kind>", "fs | sqlite | checkrun (default fs)")
    .option("--head <sha>", "pin the head SHA to review")
    .option("--slack-webhook <url>", "escalate to this Slack webhook (or $MERGE_SAFELY_SLACK_WEBHOOK)")
    .option("--dry-run", "run the review but write nothing to GitHub or the store")
    .action(wrap<RunOptions>((rt, opts) => runCommand(rt, opts)));

  prOptions(program.command("estimate").description("tier, seats, models and estimated cost; no model calls"))
    .option("--local", "estimate the working tree against --base")
    .option("--base <ref>", "base ref for --local")
    .action(wrap<RunOptions>((rt, opts) => estimateCommand(rt, opts)));

  prOptions(program.command("explain").description("print the digest of the latest verdict for a PR"))
    .option("--store <kind>", "fs | sqlite | checkrun (default fs)")
    .action(wrap<RunOptions>((rt, opts) => explainCommand(rt, opts)));

  prOptions(program.command("verdict").description("record a SHA-bound human verdict"))
    .option("--sha <sha>", "head SHA the decision applies to")
    .option("--decision <decision>", "pass | block")
    .option("--reason <text>", "what you checked")
    .option("--as <login>", "who is signing (default: the gh user, else $GITHUB_ACTOR)")
    .option("--report <kind>", "github | status | stdout | json")
    .option("--store <kind>", "fs | sqlite | checkrun (default fs)")
    .action(wrap<VerdictOptions>((rt, opts) => verdictCommand(rt, opts)));

  const policy = program.command("policy").description("policy tools");
  policy
    .command("lint")
    .description("validate a policy file and the connections it names")
    .argument("[path]")
    .action(wrap((rt, _o, path) => policyLint(rt, path)));
  policy
    .command("init")
    .description("write a commented .merge-safely.yml with the defaults")
    .argument("[path]")
    .action(wrap((rt, _o, path) => policyInit(rt, path)));

  program
    .command("version")
    .description("print the version")
    .action(
      wrap(async (rt) => {
        if (rt.json) rt.printJson({ version: CLI_VERSION });
        else rt.out(CLI_VERSION);
        return 0;
      }),
    );

  return program;
}

/** Run the CLI with user arguments (no node/script prefix). Resolves to the process exit code; never throws. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  let code: number = EXIT.pass;
  const program = buildProgram(ctx, (c) => {
    code = c;
  });
  if (argv.length === 0) {
    program.outputHelp();
    return EXIT.pass;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err: unknown) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") {
        return EXIT.pass;
      }
      const msg = err.message.replace(/^error:\s*/i, "");
      ctx.io.stderr.write(`error [USAGE]: ${msg}\n`);
      return EXIT.error;
    }
    ctx.io.stderr.write(`${formatError(err)}\n`);
    return EXIT.error;
  }
  return code;
}
