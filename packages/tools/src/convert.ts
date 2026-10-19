import type { ToolDefinition } from "@merge-safely/core";

/**
 * Shapes mirror the vendor SDK typings (checked against @anthropic-ai/sdk `Tool`, openai
 * `ChatCompletionFunctionTool` / `responses.FunctionTool`, @google/genai `FunctionDeclaration`)
 * without importing them, so this package stays SDK-free. Provider runners may adopt them.
 */

/** Anthropic Messages API `Tool`: `input_schema` must be an object schema. */
export interface AnthropicToolShape {
  name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
}

/** OpenAI Chat Completions `tools[]` entry (also used by most OpenAI-compatible servers). */
export interface OpenAIFunctionToolShape {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
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

function clone(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = structuredClone(schema);
  return rest;
}

export function toAnthropicTools(defs: readonly ToolDefinition[]): AnthropicToolShape[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: { ...clone(d.inputSchema), type: "object" },
  }));
}

export function toOpenAIFunctionTools(defs: readonly ToolDefinition[]): OpenAIFunctionToolShape[] {
  return defs.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: clone(d.inputSchema) },
  }));
}

export function toOpenAIResponsesTools(defs: readonly ToolDefinition[]): OpenAIResponsesToolShape[] {
  return defs.map((d) => ({
    type: "function",
    name: d.name,
    description: d.description,
    parameters: clone(d.inputSchema),
    strict: false,
  }));
}

export function toGeminiFunctionDeclarations(defs: readonly ToolDefinition[]): GeminiFunctionDeclarationShape[] {
  return defs.map((d) => ({ name: d.name, description: d.description, parametersJsonSchema: clone(d.inputSchema) }));
}
