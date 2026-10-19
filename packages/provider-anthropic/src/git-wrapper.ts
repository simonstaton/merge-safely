#!/usr/bin/env node
/**
 * `ms-git` entry point. The CLI runner writes a launcher that pins MS_GIT_CWD to the workspace and execs this file.
 * Only `Bash(ms-git:*)` is allowed to the model; raw git is denied.
 */
import { runGitWrapper } from "./git-guard.js";

const cwd = process.env.MS_GIT_CWD;
if (!cwd) {
  process.stderr.write("ms-git: MS_GIT_CWD is not set\n");
  process.exit(2);
}
process.exit(runGitWrapper(process.argv.slice(2), cwd));
