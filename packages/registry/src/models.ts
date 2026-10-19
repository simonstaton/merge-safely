/**
 * The model registry: versioned, data-only. No functions with behaviour live here (see lookup.ts / pricing.ts).
 *
 * Ordering is meaningful: within one provider, models are listed in *preference order* (the model we would
 * recommend first for a tier comes first). Seating's automatic model choice and `cheaperModel` both pick the
 * first model of a tier in this order, so e.g. `claude-opus-5-5` (the recommended Opus) precedes the pricier
 * `claude-fable-5-1`, and the current generation precedes older ones.
 *
 * Pricing is USD per million tokens at standard (non-batch, non-priority) list rates.
 * Where a provider has prompt-length rate cards, the HIGHER card is recorded: budgets may only ever over-estimate.
 *
 * Sources and retrieval dates:
 * - Anthropic: the claude-api skill's model and pricing tables (cached 2026-10-06), retrieved 2026-10-19.
 *   Cache writes are the 5-minute TTL rate (1.25x input). Cache reads are 0.1x input except where noted.
 * - OpenAI: public pricing aggregators (morphllm.com, metacto.com, pricepertoken.com, developers.openai.com model
 *   pages), retrieved 2026-10-19. OpenAI has no cache-write charge.
 * - Gemini: ai.google.dev/pricing and aggregators (morphllm.com, benchlm.ai), retrieved 2026-10-19.
 *   Cached input recorded at 10% of input; cache storage fees are not modelled.
 * Entries marked `confidence: "estimated"` in a trailing comment were not confirmed against a first-party page.
 */
import type { ModelInfo } from "@merge-safely/core";

export const REGISTRY_VERSION = "2026-10";

const SRC = REGISTRY_VERSION;

const CLAUDE_CURRENT_EFFORT = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_46_EFFORT = ["low", "medium", "high", "max"];
const OPENAI_GPT5_EFFORT = ["minimal", "low", "medium", "high"];
const OPENAI_O_EFFORT = ["low", "medium", "high"];

/** Shorthand for an Anthropic entry: cache read defaults to 0.1x input, cache write to 1.25x input. */
function claude(
  name: string,
  displayName: string,
  tier: ModelInfo["tier"],
  inPerMTok: number,
  outPerMTok: number,
  opts: { contextTokens: number; maxOutputTokens: number; cachedInPerMTok?: number; effortLevels?: string[] },
): ModelInfo {
  return {
    provider: "anthropic",
    name,
    displayName,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: opts.contextTokens,
    maxOutputTokens: opts.maxOutputTokens,
    pricing: {
      inPerMTok,
      outPerMTok,
      cachedInPerMTok: opts.cachedInPerMTok ?? round(inPerMTok * 0.1),
      cacheWritePerMTok: round(inPerMTok * 1.25),
    },
    tier,
    ...(opts.effortLevels ? { effortLevels: opts.effortLevels } : {}),
    source: SRC,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const M = 1_000_000;
const K200 = 200_000;

const ANTHROPIC: ModelInfo[] = [
  // Frontier. Opus 5.5 first: the recommended default judge; Fable 5.1 is stronger but 2.5x the price.
  claude("claude-opus-5-5", "Claude Opus 5.5", "frontier", 4, 20, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    cachedInPerMTok: 0.2,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-fable-5-1", "Claude Fable 5.1", "frontier", 10, 50, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    cachedInPerMTok: 0.25,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-fable-5", "Claude Fable 5", "frontier", 10, 50, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    cachedInPerMTok: 1,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-opus-5", "Claude Opus 5", "frontier", 5, 25, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-opus-4-8", "Claude Opus 4.8", "frontier", 5, 25, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-opus-4-7", "Claude Opus 4.7", "frontier", 5, 25, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-opus-4-6", "Claude Opus 4.6", "frontier", 5, 25, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_46_EFFORT,
  }),
  claude("claude-opus-4-5", "Claude Opus 4.5", "frontier", 5, 25, {
    contextTokens: K200,
    maxOutputTokens: 64_000,
    effortLevels: ["low", "medium", "high"],
  }),
  claude("claude-opus-4-1", "Claude Opus 4.1", "frontier", 15, 75, { contextTokens: K200, maxOutputTokens: 32_000 }),
  claude("claude-opus-4-0", "Claude Opus 4", "frontier", 15, 75, { contextTokens: K200, maxOutputTokens: 32_000 }),
  // Mid
  claude("claude-sonnet-5-5", "Claude Sonnet 5.5", "mid", 2, 10, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    cachedInPerMTok: 0.2,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-sonnet-5", "Claude Sonnet 5", "mid", 2, 10, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", "mid", 3, 15, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_46_EFFORT,
  }),
  claude("claude-sonnet-4-5", "Claude Sonnet 4.5", "mid", 3, 15, { contextTokens: K200, maxOutputTokens: 64_000 }),
  claude("claude-sonnet-4-0", "Claude Sonnet 4", "mid", 3, 15, { contextTokens: K200, maxOutputTokens: 64_000 }),
  // Small. Haiku 5.5 has two rate cards ($0.10/$0.50 up to 100K-token prompts, $0.50/$2.50 above);
  // review prompts routinely exceed 100K, so the higher card is recorded.
  claude("claude-haiku-5-5", "Claude Haiku 5.5", "small", 0.5, 2.5, {
    contextTokens: M,
    maxOutputTokens: 128_000,
    effortLevels: CLAUDE_CURRENT_EFFORT,
  }),
  claude("claude-haiku-4-5", "Claude Haiku 4.5", "small", 1, 5, { contextTokens: K200, maxOutputTokens: 64_000 }),
];

function openai(
  name: string,
  displayName: string,
  tier: ModelInfo["tier"],
  pricing: { in: number; out: number; cachedIn?: number },
  opts: { contextTokens: number; maxOutputTokens: number; effortLevels?: string[] },
): ModelInfo {
  return {
    provider: "openai",
    name,
    displayName,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: opts.contextTokens,
    maxOutputTokens: opts.maxOutputTokens,
    pricing: {
      inPerMTok: pricing.in,
      outPerMTok: pricing.out,
      // No published cached rate: charge cached input at the full input rate (over-estimate).
      cachedInPerMTok: pricing.cachedIn ?? pricing.in,
    },
    tier,
    ...(opts.effortLevels ? { effortLevels: opts.effortLevels } : {}),
    source: SRC,
  };
}

const OPENAI: ModelInfo[] = [
  // Frontier
  openai(
    "gpt-5",
    "GPT-5",
    "frontier",
    { in: 1.25, out: 10, cachedIn: 0.125 },
    { contextTokens: 400_000, maxOutputTokens: 128_000, effortLevels: OPENAI_GPT5_EFFORT },
  ),
  // confidence: "estimated" (third-party price tables only; codex cached rate unpublished)
  openai(
    "gpt-5-codex",
    "GPT-5 Codex",
    "frontier",
    { in: 1.25, out: 10 },
    { contextTokens: 400_000, maxOutputTokens: 128_000, effortLevels: ["low", "medium", "high"] },
  ),
  // confidence: "estimated" (third-party price tables; context/output limits assumed)
  openai(
    "gpt-5.5",
    "GPT-5.5",
    "frontier",
    { in: 5, out: 30, cachedIn: 0.5 },
    { contextTokens: 1_000_000, maxOutputTokens: 128_000, effortLevels: OPENAI_GPT5_EFFORT },
  ),
  openai(
    "o3",
    "o3",
    "frontier",
    { in: 2, out: 8, cachedIn: 0.5 },
    { contextTokens: 200_000, maxOutputTokens: 100_000, effortLevels: OPENAI_O_EFFORT },
  ),
  // Mid
  openai(
    "gpt-5-mini",
    "GPT-5 mini",
    "mid",
    { in: 0.25, out: 2, cachedIn: 0.025 },
    { contextTokens: 400_000, maxOutputTokens: 128_000, effortLevels: OPENAI_GPT5_EFFORT },
  ),
  openai(
    "gpt-4.1",
    "GPT-4.1",
    "mid",
    { in: 2, out: 8, cachedIn: 0.5 },
    { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  ),
  // cached rate conflicts between sources ($0.275 vs $0.14); the higher is recorded.
  openai(
    "o4-mini",
    "o4-mini",
    "mid",
    { in: 1.1, out: 4.4, cachedIn: 0.275 },
    { contextTokens: 200_000, maxOutputTokens: 100_000, effortLevels: OPENAI_O_EFFORT },
  ),
  // Small
  openai(
    "gpt-5-nano",
    "GPT-5 nano",
    "small",
    { in: 0.05, out: 0.4, cachedIn: 0.005 },
    { contextTokens: 400_000, maxOutputTokens: 128_000, effortLevels: OPENAI_GPT5_EFFORT },
  ),
  openai(
    "gpt-4.1-mini",
    "GPT-4.1 mini",
    "small",
    { in: 0.4, out: 1.6, cachedIn: 0.1 },
    { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  ),
  // confidence: "estimated" for the cached rate (unpublished; charged at full input)
  openai(
    "gpt-4.1-nano",
    "GPT-4.1 nano",
    "small",
    { in: 0.1, out: 0.4 },
    { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  ),
];

function gemini(
  name: string,
  displayName: string,
  tier: ModelInfo["tier"],
  inPerMTok: number,
  outPerMTok: number,
): ModelInfo {
  return {
    provider: "gemini",
    name,
    displayName,
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inPerMTok, outPerMTok, cachedInPerMTok: round(inPerMTok * 0.1) },
    tier,
    source: SRC,
  };
}

const GEMINI: ModelInfo[] = [
  // Pro models: the >200K-token prompt card is recorded (2.5 Pro: $1.25/$10 below, $2.50/$15 above;
  // 3.1 Pro: $2/$12 below, $4/$18 above).
  gemini("gemini-3.1-pro", "Gemini 3.1 Pro", "frontier", 4, 18),
  gemini("gemini-2.5-pro", "Gemini 2.5 Pro", "frontier", 2.5, 15),
  // confidence: "estimated" for 3.x Flash rates (aggregators agree; first-party page not fully retrieved)
  gemini("gemini-3.5-flash", "Gemini 3.5 Flash", "mid", 1.5, 9),
  gemini("gemini-3-flash", "Gemini 3 Flash", "mid", 0.5, 3),
  gemini("gemini-2.5-flash", "Gemini 2.5 Flash", "mid", 0.3, 2.5),
  gemini("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", "small", 0.25, 1.5),
  gemini("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", "small", 0.1, 0.4),
];

function local(name: string, displayName: string, tier: ModelInfo["tier"], contextTokens: number): ModelInfo {
  return {
    provider: "ollama",
    name,
    displayName,
    // Tool calling works on these via Ollama's API, but quality varies; structured output via `format`.
    supportsTools: true,
    supportsStructuredOutput: true,
    contextTokens,
    maxOutputTokens: 32_768,
    zeroCost: true,
    tier,
    source: SRC,
  };
}

const OLLAMA: ModelInfo[] = [
  local("gpt-oss", "gpt-oss (local)", "mid", 131_072),
  local("qwen3-coder", "Qwen3 Coder (local)", "mid", 262_144),
  local("qwen2.5-coder", "Qwen2.5 Coder (local)", "mid", 32_768),
  local("deepseek-r1", "DeepSeek-R1 (local)", "mid", 131_072),
  local("llama3.3", "Llama 3.3 (local)", "mid", 131_072),
  local("llama3.1", "Llama 3.1 (local)", "small", 131_072),
];

export const MODELS: ModelInfo[] = [...ANTHROPIC, ...OPENAI, ...GEMINI, ...OLLAMA];
