import { createHash } from "node:crypto";
import { type Policy, type PolicyInput, policySchema } from "./schema.js";

export * from "./schema.js";

export interface PolicyParseResult {
  ok: true;
  policy: Policy;
  hash: string;
}
export interface PolicyParseError {
  ok: false;
  errors: string[];
}

/** Parse an already-decoded policy document (YAML/JSON decoding happens at the edge). */
export function parsePolicy(input: unknown): PolicyParseResult | PolicyParseError {
  const result = policySchema.safeParse(input ?? {});
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }
  return { ok: true, policy: result.data, hash: policyHash(result.data) };
}

/** Like parsePolicy but throws on invalid input. */
export function loadPolicy(input: PolicyInput | unknown = {}): Policy {
  const r = parsePolicy(input);
  if (!r.ok) throw new Error(`Invalid policy:\n  ${r.errors.join("\n  ")}`);
  return r.policy;
}

export const DEFAULT_POLICY: Policy = loadPolicy({});

/** Stable hash of a policy: keys sorted recursively so formatting never changes the hash. */
export function policyHash(policy: Policy): string {
  return createHash("sha256").update(stableStringify(policy)).digest("hex").slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
