import type { ModelInfo, TokenUsage } from "@merge-safely/core";

/**
 * Token usage convention shared by every runner in this package:
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

/**
 * Price a usage delta from the model's pricing. Returns undefined when pricing is unknown
 * (the caller must then treat maxUsd as unenforceable). Zero-cost models price at 0.
 */
export function priceUsage(tokens: TokenUsage, model: Pick<ModelInfo, "pricing" | "zeroCost">): number | undefined {
  if (model.zeroCost) return 0;
  const p = model.pricing;
  if (!p) return undefined;
  const perTok = (perMTok: number) => perMTok / 1_000_000;
  const cached = tokens.cachedIn ?? 0;
  const write = tokens.cacheWrite ?? 0;
  return (
    tokens.in * perTok(p.inPerMTok) +
    cached * perTok(p.cachedInPerMTok ?? p.inPerMTok) +
    write * perTok(p.cacheWritePerMTok ?? p.inPerMTok) +
    tokens.out * perTok(p.outPerMTok)
  );
}
