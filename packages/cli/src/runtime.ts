import type { Connection, Logger } from "@merge-safely/core";
import type { OctokitLike } from "@merge-safely/github";
import { type ProviderRegistry, readConnectionsFile, secretValues } from "@merge-safely/providers";
import { CliError, SecretSet } from "./errors.js";
import type { Exec } from "./exec.js";
import type { GateFactory } from "./gate-types.js";
import type { GithubApi } from "./github-api.js";
import { type HomePaths, homePaths, resolveHome } from "./home.js";
import { type CliIO, type Colour, makeColour } from "./io.js";
import { noPrompter, type Prompter, ttyPrompter } from "./prompt.js";

/** Everything a command needs from the outside world. Tests replace any of it. */
export interface CliContext {
  io: CliIO;
  env: NodeJS.ProcessEnv;
  cwd: string;
  exec: Exec;
  gateFactory: GateFactory;
  registry: () => ProviderRegistry;
  github: (token: string, logger?: Logger) => GithubApi;
  /** Raw GitHub client, for `eval` suites with GitHub-sourced cases. Optional: without it those cases are skipped. */
  octokit?: (token: string, logger?: Logger) => OctokitLike;
  /** Subscribe to SIGINT/SIGTERM; returns an unsubscribe. Absent: no interrupt handling (tests inject a fake). */
  onSignal?: (handler: (signal: string) => void) => () => void;
  now: () => Date;
  /** Defaults to a TTY prompter when stdin is a TTY, else one that refuses with a hint. */
  prompter?: Prompter;
}

export interface GlobalOptions {
  home?: string;
  connections?: string;
  verbose?: boolean;
  json?: boolean;
  color?: boolean;
}

/** Per-invocation helpers built from the context and the global flags. */
export class Runtime {
  readonly paths: HomePaths;
  readonly colour: Colour;
  readonly secrets = new SecretSet();
  readonly logger: Logger;

  constructor(
    readonly ctx: CliContext,
    readonly globals: GlobalOptions,
  ) {
    this.paths = homePaths(resolveHome(globals.home, ctx.env), globals.connections);
    this.colour = makeColour({ isTTY: ctx.io.stdoutIsTTY, env: ctx.env, flag: globals.color });
    const verbose = globals.verbose === true;
    const line = (level: string, msg: string) => this.err(`${level}: ${this.secrets.scrub(msg)}`);
    this.logger = {
      debug: (m) => {
        if (verbose) line("debug", m);
      },
      info: (m) => {
        if (verbose) line("info", m);
      },
      warn: (m) => line(this.colour.yellow("warning"), m),
      error: (m) => line(this.colour.red("error"), m),
    };
  }

  get json(): boolean {
    return this.globals.json === true;
  }

  out(s = ""): void {
    this.ctx.io.stdout.write(`${s}\n`);
  }

  err(s: string): void {
    this.ctx.io.stderr.write(`${s}\n`);
  }

  warn(s: string): void {
    this.logger.warn(s);
  }

  printJson(value: unknown): void {
    this.out(this.secrets.scrub(JSON.stringify(value, null, 2)));
  }

  get prompter(): Prompter {
    if (this.ctx.prompter) return this.ctx.prompter;
    if (this.ctx.io.stdinIsTTY) return ttyPrompter(this.ctx.io);
    return noPrompter("stdin is not a terminal; pass the missing values as flags");
  }

  get interactive(): boolean {
    return this.ctx.prompter !== undefined || this.ctx.io.stdinIsTTY;
  }

  /** Load connections, registering their secrets for masking. Bad entries are warned about and skipped. */
  async loadConnections(opts: { required?: boolean } = {}): Promise<Connection[]> {
    const r = await readConnectionsFile(this.paths.connections, this.ctx.env, { now: this.ctx.now });
    for (const w of r.warnings) this.warn(w);
    for (const c of r.connections) this.secrets.add(...secretValues(c.secret));
    for (const e of r.errors) this.warn(e);
    if (r.missing && this.globals.connections) {
      throw new CliError("CONNECTIONS_NOT_FOUND", `connections file not found: ${this.paths.connections}`);
    }
    if (opts.required && r.connections.length === 0) {
      throw new CliError(
        "NO_CONNECTIONS",
        `no usable connections in ${this.paths.connections}; add one with \`merge-safely connect <provider>\``,
      );
    }
    return r.connections;
  }
}
