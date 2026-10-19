import type { ToolDefinition } from "@merge-safely/core";
import { sanitizeSchema } from "./runner/schema.js";

/**
 * Shapes mirror the vendor SDK typings (checked against @anthropic-ai/sdk `Tool`, openai
 * `ChatCompletionFunctionTool` / `responses.FunctionTool`, @google/genai `FunctionDeclaration`)
 * without importing them, so this package stays SDK-free. Every API runner converts its tools through these.
 */

/** A tool to convert: a shared ToolDefinition, optionally asking for provider-side strict schema adherence. */
export type ConvertibleTool = Pick<ToolDefinition, "name" | "description" | "inputSchema"> & { strict?: boolean };

/** Anthropic Messages API `Tool`: `input_schema` must be an object schema. */
export interface AnthropicToolShape {
  name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
}

/** OpenAI Chat Completions `tools[]` entry (also used by most OpenAI-compatible servers). */
export interface OpenAIFunctionToolShape {
  type: "function";
  /** `strict` is only present when true: many OpenAI-compatible servers reject the field outright. */
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: true };
}

/** OpenAI Responses API `FunctionTool` (flat shape; `strict` is required by the typings). */
export interface OpenAIResponsesToolShape {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/**
 * Gemini `FunctionDeclaration` using `parametersJsonSchema`, which accepts full JSON Schema
 * (so no lossy conversion to the OpenAPI-subset `parameters` is needed).
 */
export interface GeminiFunctionDeclarationShape {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

/** Deep copy without any `$schema` keyword, which most function-calling APIs reject. */
function clone(schema: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSchema(schema);
}

export function toAnthropicTools(defs: readonly ConvertibleTool[]): AnthropicToolShape[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: { ...clone(d.inputSchema), type: "object" },
  }));
}

export function toOpenAIFunctionTools(defs: readonly ConvertibleTool[]): OpenAIFunctionToolShape[] {
  return defs.map((d) => ({
    type: "function",
    function: {
      name: d.name,
      description: d.description,
      parameters: clone(d.inputSchema),
      ...(d.strict ? { strict: true as const } : {}),
    },
  }));
}

/** The Responses API defaults `strict` to true, so it is always set explicitly. */
export function toOpenAIResponsesTools(defs: readonly ConvertibleTool[]): OpenAIResponsesToolShape[] {
  return defs.map((d) => ({
    type: "function",
    name: d.name,
    description: d.description,
    parameters: clone(d.inputSchema),
    strict: d.strict === true,
  }));
}

export function toGeminiFunctionDeclarations(defs: readonly ConvertibleTool[]): GeminiFunctionDeclarationShape[] {
  return defs.map((d) => ({ name: d.name, description: d.description, parametersJsonSchema: clone(d.inputSchema) }));
}
