#!/usr/bin/env node
"use strict";

// src/stubs/import-meta-url.ts
var import_node_url = require("node:url");
var import_meta_url = (0, import_node_url.pathToFileURL)(__filename).href;

// ../provider-anthropic/dist/git-guard.js
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var GIT_SUBCOMMANDS = ["diff", "log", "blame", "show"];
var GitGuardError = class extends Error {
};
var SAFE_FLAGS = /* @__PURE__ */ new Set(["--stat", "-p", "--oneline", "--follow", "--name-only", "--name-status", "--no-color"]);
var SAFE_FLAG_PATTERNS = [/^-n\d{1,6}$/, /^-\d{1,6}$/, /^--max-count=\d{1,6}$/, /^-U\d{1,4}$/];
var FORBIDDEN_FLAGS = ["--output", "--no-index", "--ext-diff", "--textconv", "-O", "--exec", "--upload-pack"];
var NAMED_FORMATS = /* @__PURE__ */ new Set(["oneline", "short", "medium", "full", "fuller"]);
var SAFE_PLACEHOLDERS = [
  "an",
  "ae",
  "ad",
  "ar",
  "aI",
  "cn",
  "cd",
  "cr",
  "cI",
  "H",
  "h",
  "T",
  "t",
  "P",
  "p",
  "s",
  "b",
  "n",
  "%"
];
var FORBIDDEN_REVISION = /@\{|:\/|\^\{\//;
var GIT_SAFE_CONFIG = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=never"
];
function gitEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith("GIT_"))
      env[k] = v;
  }
  return {
    ...env,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1"
  };
}
function gitResolver(cwd2, env = process.env) {
  return (rev) => {
    if (!rev || rev.startsWith("-") || FORBIDDEN_REVISION.test(rev) || /[\0\s]/.test(rev))
      return void 0;
    try {
      const out = (0, import_node_child_process.execFileSync)("git", [...GIT_SAFE_CONFIG, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { cwd: cwd2, env: gitEnv(env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1e4 }).trim();
      return /^[0-9a-f]{40,64}$/.test(out) ? out : void 0;
    } catch {
      return void 0;
    }
  };
}
function checkPath(cwd2, p) {
  if (!p || p.includes("\0"))
    throw new GitGuardError("empty or invalid path");
  const rel = (0, import_node_path.relative)(cwd2, (0, import_node_path.resolve)(cwd2, p));
  if (rel.startsWith("..") || (0, import_node_path.isAbsolute)(rel))
    throw new GitGuardError(`path is outside the workspace: ${p}`);
  return rel || ".";
}
function checkFormat(value) {
  if (NAMED_FORMATS.has(value))
    return;
  const body = value.replace(/^t?format:/, "");
  for (let i = body.indexOf("%"); i !== -1; i = body.indexOf("%", i + 1)) {
    const rest = body.slice(i + 1);
    const ph = SAFE_PLACEHOLDERS.find((p) => rest.startsWith(p));
    if (!ph)
      throw new GitGuardError(`format placeholder not allowed: %${rest.slice(0, 2)}`);
    i += ph.length;
  }
}
function checkFlag(cwd2, sub, flag) {
  const name = flag.split("=")[0] ?? flag;
  if (FORBIDDEN_FLAGS.some((f) => name === f || f === "-O" && flag.startsWith("-O"))) {
    throw new GitGuardError(`option not allowed: ${name}`);
  }
  if (SAFE_FLAGS.has(flag) || SAFE_FLAG_PATTERNS.some((re) => re.test(flag)))
    return flag;
  const fmt = flag.match(/^--(format|pretty)=(.*)$/s);
  if (fmt) {
    checkFormat(fmt[2] ?? "");
    return flag;
  }
  const range = flag.match(/^-L(\d{1,7}),([+-]?\d{1,7})(?::(.+))?$/s);
  if (range && (sub === "blame" || sub === "log")) {
    if (range[3] !== void 0)
      return `-L${range[1]},${range[2]}:${checkPath(cwd2, range[3])}`;
    if (sub === "log")
      throw new GitGuardError("log -L needs a file: -L<start>,<end>:<path>");
    return flag;
  }
  throw new GitGuardError(`option not allowed: ${flag}. Allowed: --stat -p --oneline -n<N> --max-count=<N> -L<start>,<end> --follow --name-only --name-status -U<N> --no-color --format=/--pretty= (safe placeholders)`);
}
function planGit(argv, cwd2, resolveCommit) {
  const [subRaw, ...rest] = argv;
  if (!subRaw || !GIT_SUBCOMMANDS.includes(subRaw)) {
    throw new GitGuardError(`subcommand not allowed: ${subRaw ?? "(none)"}. Use one of: ${GIT_SUBCOMMANDS.join(", ")}`);
  }
  const sub = subRaw;
  const flags = [];
  const revs = [];
  const paths = [];
  let afterDashDash = false;
  const mustResolve = (rev, what = rev) => {
    if (FORBIDDEN_REVISION.test(rev))
      throw new GitGuardError(`revision syntax not allowed: ${what}`);
    const sha = resolveCommit(rev);
    if (!sha)
      throw new GitGuardError(`unknown revision: ${what}`);
    return sha;
  };
  for (const tok of rest) {
    if (afterDashDash) {
      paths.push(checkPath(cwd2, tok));
      continue;
    }
    if (tok === "--") {
      afterDashDash = true;
      continue;
    }
    if (tok.startsWith("-")) {
      flags.push(checkFlag(cwd2, sub, tok));
      continue;
    }
    if (FORBIDDEN_REVISION.test(tok))
      throw new GitGuardError(`revision syntax not allowed: ${tok}`);
    const rangeMatch = tok.match(/^([^.]*?)(\.\.\.?)([^.]*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[3])) {
      const a = mustResolve(rangeMatch[1] || "HEAD", tok);
      const b = mustResolve(rangeMatch[3] || "HEAD", tok);
      revs.push(`${a}${rangeMatch[2]}${b}`);
      continue;
    }
    const colon = tok.indexOf(":");
    if (sub === "show" && colon > 0) {
      revs.push(`${mustResolve(tok.slice(0, colon), tok)}:${checkPath(cwd2, tok.slice(colon + 1))}`);
      continue;
    }
    const sha = resolveCommit(tok);
    if (sha) {
      revs.push(sha);
      continue;
    }
    const p = checkPath(cwd2, tok);
    if (!(0, import_node_fs.existsSync)((0, import_node_path.resolve)(cwd2, p)))
      throw new GitGuardError(`unknown revision or path: ${tok}`);
    paths.push(p);
  }
  const hardening = sub === "blame" ? ["--no-textconv"] : ["--no-ext-diff", "--no-textconv"];
  return [...GIT_SAFE_CONFIG, sub, ...hardening, ...flags, ...revs, "--", ...paths];
}
function runGitWrapper(argv, cwd2, io = { stderr: (s) => process.stderr.write(s) }, env = process.env) {
  let args;
  try {
    args = planGit(argv, cwd2, gitResolver(cwd2, env));
  } catch (err) {
    io.stderr(`ms-git: ${err instanceof Error ? err.message : String(err)}
`);
    return 2;
  }
  const r = (0, import_node_child_process.spawnSync)("git", args, { cwd: cwd2, env: gitEnv(env), stdio: ["ignore", "inherit", "inherit"], timeout: 6e4 });
  if (r.error) {
    io.stderr(`ms-git: git failed to start: ${r.error.message}
`);
    return 127;
  }
  return r.status ?? 1;
}

// ../provider-anthropic/dist/git-wrapper.js
var cwd = process.env.MS_GIT_CWD;
if (!cwd) {
  process.stderr.write("ms-git: MS_GIT_CWD is not set\n");
  process.exit(2);
}
process.exit(runGitWrapper(process.argv.slice(2), cwd));
