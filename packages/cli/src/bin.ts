#!/usr/bin/env node
import { runCli } from "./cli.js";
import { defaultContext } from "./context.js";

runCli(process.argv.slice(2), defaultContext()).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error [INTERNAL]: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);
