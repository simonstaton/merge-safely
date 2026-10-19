import type { ToolDefinition } from "@merge-safely/core";

/** Anthropic Messages API `tools[]` entry. */
export interface AnthropicToolShape {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** OpenAI Chat Completions `tools[]` entry (also used by most OpenAI-compatible servers). */
export interface OpenAIFunctionToolShape {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** OpenAI Responses API `tools[]` entry (flat function shape). */
export interface OpenAIResponsesToolShape {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}

/** Gemini `functionDeclarations[]` entry. */
export interface GeminiFunctionDeclarationShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function clone(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = structuredClone(schema);
  return rest;
}

export function toAnthropicTools(defs: readonly ToolDefinition[]): AnthropicToolShape[] {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: clone(d.inputSchema) }));
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

/** Keys Gemini's OpenAPI-subset `Schema` accepts; anything else (e.g. additionalProperties, $schema) is dropped. */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && isRecord(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items" || k === "anyOf") {
      out[k] = toGeminiSchema(v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

export function toGeminiFunctionDeclarations(defs: readonly ToolDefinition[]): GeminiFunctionDeclarationShape[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: toGeminiSchema(d.inputSchema) as Record<string, unknown>,
  }));
}
