import type { TokenUsage } from "@merge-safely/core";

/**
 * Token usage convention shared by the API runners built on this loop (and by @merge-safely/registry pricing):
 * `in` = input tokens billed at the full input rate (i.e. EXCLUDING cached reads),
 * `cachedIn` = input tokens served from the provider's prompt cache,
 * `out` = output tokens including any reasoning/thinking tokens.
 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { in: a.in + b.in, out: a.out + b.out };
  const cached = (a.cachedIn ?? 0) + (b.cachedIn ?? 0);
  const write = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  if (cached > 0 || a.cachedIn !== undefined || b.cachedIn !== undefined) out.cachedIn = cached;
  if (write > 0 || a.cacheWrite !== undefined || b.cacheWrite !== undefined) out.cacheWrite = write;
  return out;
}
