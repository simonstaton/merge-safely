import type { ToolDefinition } from "@merge-safely/core";

export const SUBMIT_REVIEW_TOOL_NAME = "submit_review";

/**
 * The structured-output channel: runners give the model this tool and treat its input as the final
 * answer, validated against `schema`. It is not proof of work, so `substantive` is false.
 */
export function submitReviewDefinition(schema: Record<string, unknown>, role: "hunter" | "judge"): ToolDefinition {
  const { $schema: _drop, ...inputSchema } = structuredClone(schema);
  const description =
    role === "hunter"
      ? "Submit your final review. Call this exactly once, after investigating the change with the read-only tools. " +
        'Use verdict "block" if any blocker exists. Every finding must cite file and line evidence you actually read.'
      : "Submit your votes on the hunters' findings. Call this exactly once, after checking each finding against the code. " +
        "Vote confirm, refute or downgrade per finding id, with a reason grounded in what you read.";
  return { name: SUBMIT_REVIEW_TOOL_NAME, description, inputSchema, substantive: false };
}
