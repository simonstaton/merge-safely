/**
 * The `connections` input: a YAML map of connection id to connection (design 6.1, docs/connections.md).
 * YAML is parsed here, at the edge, and the object goes to `parseConnectionsInput` with the process environment
 * (so `apiKeyEnv: NAME` reads a step `env:` value). Every secret string is masked in the job log before anything
 * else can print it, and errors never quote input text: YAML parser messages can include source lines that hold keys.
 */
import type { SecretSet } from "@merge-safely/cli";
import type { Connection } from "@merge-safely/core";
import { parseConnectionsInput, secretValues } from "@merge-safely/providers";
import { parseDocument } from "yaml";
import { actionError, ghExpr } from "./errors.js";

export const CONNECTIONS_DOCS = "https://github.com/simonstaton/merge-safely/blob/main/docs/connections.md";

const EXAMPLE = `connections: |\n  anthropic-main: { provider: anthropic, apiKey: "${ghExpr("secrets.ANTHROPIC_API_KEY")}" }`;

export const CONNECTIONS_REQUIRED =
  `connections input is required. Add it to the step's with: block, for example\n${EXAMPLE}\n` +
  `See ${CONNECTIONS_DOCS}#the-actions-connections-input`;

const YAML_FIX =
  `Quote values that come from secrets, e.g. apiKey: "${ghExpr("secrets.ANTHROPIC_API_KEY")}", and use no YAML tags. ` +
  `See ${CONNECTIONS_DOCS}#the-actions-connections-input`;

/** Keys whose string values are credentials, wherever they appear in the input. */
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|credential)/i;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Every string in the raw input that might be a credential: secret-named keys and all header values. */
export function rawSecretStrings(input: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, key: string, inHeaders: boolean): void => {
    if (typeof x === "string") {
      // `apiKeyEnv` / `accessTokenEnv` hold variable NAMES, not secrets.
      if (inHeaders || (SECRET_KEY.test(key) && !/env$/i.test(key))) out.push(x);
      return;
    }
    if (Array.isArray(x)) {
      for (const v of x) walk(v, key, inHeaders);
      return;
    }
    if (isRecord(x)) {
      for (const [k, v] of Object.entries(x)) walk(v, k, inHeaders || k.toLowerCase() === "headers");
    }
  };
  walk(input, "", false);
  return out;
}

function yamlLine(err: unknown): string {
  if (isRecord(err) && Array.isArray(err.linePos) && isRecord(err.linePos[0])) {
    const line = err.linePos[0].line;
    if (typeof line === "number") return ` at line ${line}`;
  }
  return "";
}

/**
 * Parse YAML without ever printing it. Error objects carry the line (linePos) and a pretty excerpt in .message; only the line is used. `logLevel: "silent"` stops the library's `process.emitWarning`, whose
 * pretty-printed excerpt would quote the source line (and a key on it) before we mask anything. Errors and warnings
 * (an unresolved `!tag`, a duplicate key) both fail, reported by line number only.
 */
export function parseConnectionsYaml(text: string): unknown {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, { logLevel: "silent", uniqueKeys: true });
  } catch (_err: unknown) {
    throw actionError("CONNECTIONS_INVALID", `connections input is not valid YAML. ${YAML_FIX}`);
  }
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    throw actionError("CONNECTIONS_INVALID", `connections input is not valid YAML${yamlLine(problem)}. ${YAML_FIX}`);
  }
  try {
    return doc.toJS();
  } catch (_err: unknown) {
    throw actionError("CONNECTIONS_INVALID", `connections input is not valid YAML. ${YAML_FIX}`);
  }
}

/** Hints for the commonest mistakes, keyed off the (secret-free) validation messages. */
function hints(errors: string[]): string[] {
  const out: string[] = [];
  const joined = errors.join("\n").toLowerCase();
  if (/(apikey|accesstoken)(?!env)|empty|at least 1|no secret/.test(joined)) {
    out.push(
      `If a value comes from ${ghExpr("secrets.NAME")}, check the secret exists under Settings > Secrets and variables > ` +
        "Actions. GitHub withholds secrets from pull_request runs on fork PRs, so the value is empty there.",
    );
  }
  if (/environment variable/.test(joined)) {
    out.push(
      `apiKeyEnv: NAME reads the step's env: block; add NAME: ${ghExpr("secrets.NAME")} under env: on this step.`,
    );
  }
  return out;
}

/**
 * Parse and validate the input, masking secrets with `mask` (core.setSecret) and recording them in `secrets` for
 * error scrubbing. Throws a CliError naming each bad connection and the fix.
 */
export function parseConnections(
  text: string,
  env: NodeJS.ProcessEnv,
  mask: (secret: string) => void,
  secrets: SecretSet,
): Connection[] {
  if (text.trim() === "") throw actionError("INPUT", CONNECTIONS_REQUIRED);
  const obj = parseConnectionsYaml(text);
  const record = (s: string) => {
    if (s.trim() === "") return;
    mask(s);
    secrets.add(s);
  };
  for (const s of rawSecretStrings(obj)) record(s);
  if (!isRecord(obj)) {
    throw actionError(
      "CONNECTIONS_INVALID",
      `connections input must be a YAML map of connection id to connection, for example\n${EXAMPLE}`,
    );
  }
  const r = parseConnectionsInput(obj, env);
  for (const c of r.connections) for (const s of secretValues(c.secret)) record(s);
  if (r.errors.length) {
    const lines = r.errors.map((e) => `- ${secrets.scrub(e)}`);
    throw actionError(
      "CONNECTIONS_INVALID",
      [
        "connections input is invalid:",
        ...lines,
        ...hints(r.errors),
        `Fields and examples: ${CONNECTIONS_DOCS}#the-actions-connections-input`,
      ].join("\n"),
    );
  }
  if (r.connections.length === 0) throw actionError("INPUT", CONNECTIONS_REQUIRED);
  return r.connections;
}
