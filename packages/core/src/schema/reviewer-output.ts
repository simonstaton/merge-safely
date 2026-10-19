import { z } from "zod";
import type { JudgeOutput, ReviewerOutput } from "../types.js";

/**
 * JSON schema enforced at the runner on the final message. Kept as plain JSON so any provider's
 * structured-output feature can consume it; zod mirrors it for validation inside the core.
 */

export const SEVERITIES = ["blocker", "important", "nit", "pre-existing"] as const;

const findingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "class", "title", "detail"],
  properties: {
    severity: { type: "string", enum: [...SEVERITIES] },
    class: { type: "string", description: "kebab-case bug class, e.g. n-plus-one, missing-flag, logic-error" },
    title: { type: "string", maxLength: 200 },
    detail: { type: "string" },
    file: { type: "string" },
    line: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    suggestedFix: { type: "string" },
  },
} as const;

export const REVIEWER_OUTPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ReviewerOutput",
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "block"] },
    summary: { type: "string" },
    findings: { type: "array", items: findingJsonSchema },
    confidenceRefuted: { type: "array", items: { type: "string" } },
    addressed: { type: "array", items: { type: "string" }, description: "Known finding ids verified as addressed" },
  },
} as const;

export const JUDGE_OUTPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "JudgeOutput",
  type: "object",
  additionalProperties: false,
  required: ["votes"],
  properties: {
    votes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "decision"],
        properties: {
          findingId: { type: "string" },
          decision: { type: "string", enum: ["confirm", "refute", "downgrade"] },
          severity: { type: "string", enum: [...SEVERITIES] },
          reason: { type: "string" },
        },
      },
    },
    newFindings: { type: "array", items: findingJsonSchema },
    summary: { type: "string" },
  },
} as const;

const findingZ = z.object({
  id: z.string().optional(),
  severity: z.enum(SEVERITIES),
  class: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  detail: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  evidence: z.array(z.string()).optional(),
  suggestedFix: z.string().optional(),
});

export const reviewerOutputZ = z.object({
  verdict: z.enum(["pass", "block"]),
  summary: z.string(),
  findings: z.array(findingZ),
  confidenceRefuted: z.array(z.string()).optional(),
  addressed: z.array(z.string()).optional(),
});

export const judgeOutputZ = z.object({
  votes: z.array(
    z.object({
      findingId: z.string(),
      decision: z.enum(["confirm", "refute", "downgrade"]),
      severity: z.enum(SEVERITIES).optional(),
      reason: z.string().optional(),
    }),
  ),
  newFindings: z.array(findingZ).optional(),
  summary: z.string().optional(),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse a hunter's final JSON. Finding ids are placeholders here; the core assigns fingerprints. */
export function parseReviewerOutput(raw: unknown): ParseResult<ReviewerOutput> {
  const r = reviewerOutputZ.safeParse(raw);
  if (!r.success)
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return {
    ok: true,
    value: { ...r.data, findings: r.data.findings.map((f) => ({ ...f, id: f.id ?? "" })) },
  };
}

export function parseJudgeOutput(raw: unknown): ParseResult<JudgeOutput> {
  const r = judgeOutputZ.safeParse(raw);
  if (!r.success)
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return {
    ok: true,
    value: { ...r.data, newFindings: r.data.newFindings?.map((f) => ({ ...f, id: f.id ?? "" })) },
  };
}

/** Extract the first JSON object from free text (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      // keep trying
    }
  }
  return undefined;
}
