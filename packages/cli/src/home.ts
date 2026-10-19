import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HOME_ENV } from "@merge-safely/providers";

/** `--home`, else `MERGE_SAFELY_HOME`, else `~/.merge-safely`. */
export function resolveHome(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag && flag.trim() !== "") return resolve(flag);
  const fromEnv = env[HOME_ENV];
  if (fromEnv && fromEnv.trim() !== "") return resolve(fromEnv);
  return join(homedir(), ".merge-safely");
}

export interface HomePaths {
  home: string;
  connections: string;
  store: string;
  sqlite: string;
  repos: string;
}

export function homePaths(home: string, connectionsOverride?: string): HomePaths {
  return {
    home,
    connections: connectionsOverride ? resolve(connectionsOverride) : join(home, "connections.json"),
    store: join(home, "store"),
    sqlite: join(home, "merge-safely.db"),
    repos: join(home, "repos"),
  };
}
