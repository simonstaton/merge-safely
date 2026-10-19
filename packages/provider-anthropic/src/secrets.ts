import type { Connection } from "@merge-safely/core";
import { secretValues as connectionSecretValues } from "@merge-safely/providers";
import { REDACTED, redactWithSecrets } from "@merge-safely/tools";

export { REDACTED };

/** Every secret string carried by a connection, so output and error text can be scrubbed of them. */
export function secretValues(conn: Connection): string[] {
  // Very short values would redact ordinary words; real credentials are long.
  return connectionSecretValues(conn.secret).filter((v) => v.length >= 8);
}

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PAT)S?$|(^|_)(KEY|TOKEN|SECRET|AUTH)_/i;

/** Values of credential-looking variables in an environment (e.g. the gate's own process.env). */
export function envSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.length >= 8 && SECRET_ENV_NAME.test(k)) out.push(v);
  }
  return out;
}

/** Remove known secret values (longest first), then anything shaped like a credential (core's redactor). */
export function scrub(text: string, secrets: readonly string[] = []): string {
  return redactWithSecrets(text, secrets, 1);
}

/** Deep-scrub every string in a JSON-shaped value. */
export function scrubDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return scrub(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, secrets);
    return out as T;
  }
  return value;
}
