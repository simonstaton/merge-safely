/** JSON-schema helpers for function-tool parameters. */

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep copy without the `$schema` meta keyword, which most function-calling APIs reject. A *property* that is
 * literally named `$schema` (a key of a `properties` map) is data, not the keyword, and is kept.
 */
export function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, isPropertyMap = false): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (!isObj(v)) return v;
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "$schema" && !isPropertyMap) continue;
      out[k] = walk(x, !isPropertyMap && (k === "properties" || k === "patternProperties"));
    }
    return out;
  };
  const r = walk(schema);
  return isObj(r) ? r : {};
}

/** Keywords OpenAI strict mode has historically rejected; conservatively treat them as non-strict. */
const STRICT_UNSUPPORTED = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "patternProperties",
  "minProperties",
  "maxProperties",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "oneOf",
]);

/**
 * True when a schema satisfies OpenAI's strict structured-output subset: every object closes
 * `additionalProperties: false` and lists every property as required, with no unsupported keywords.
 */
export function isStrictCompatible(schema: unknown): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 10) return false;
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1));
    if (!isObj(v)) return true;
    for (const k of Object.keys(v)) if (STRICT_UNSUPPORTED.has(k)) return false;
    const type = v.type;
    const isObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));
    if (isObjectType || isObj(v.properties)) {
      if (v.additionalProperties !== false) return false;
      const props = isObj(v.properties) ? Object.keys(v.properties) : [];
      const req = Array.isArray(v.required) ? v.required : [];
      if (!props.every((p) => req.includes(p))) return false;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === "enum" || k === "const" || k === "required" || k === "description" || k === "title") continue;
      if (k === "properties" && isObj(x)) {
        if (!Object.values(x).every((p) => walk(p, depth + 1))) return false;
      } else if (!walk(x, depth + 1)) return false;
    }
    return true;
  };
  return walk(schema, 0);
}
