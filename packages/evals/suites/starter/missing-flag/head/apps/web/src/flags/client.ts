import { logger } from "../lib/logger";
import { FLAGS } from "./definitions";

type RemoteFlags = Record<string, boolean>;
let remote: RemoteFlags = {};

export function hydrateFlags(values: RemoteFlags): void {
  remote = values;
}

/**
 * Read a flag. Unknown names fail closed (false) and are reported to error tracking on every call so a typo or a
 * flag missing in this environment is noticed.
 */
export function isEnabled(name: string): boolean {
  if (name in remote) return remote[name] === true;
  if (name in FLAGS) return FLAGS[name as keyof typeof FLAGS].default;
  logger.error("feature flag not found", { flag: name });
  return false;
}
