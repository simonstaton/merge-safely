/**
 * Zod schemas for connections: the secret shapes per kind, the non-secret record, and the user-facing
 * input shapes (the connections file and the Action/App inline map from design section 6.1).
 */
import type { ConnectionKind, ConnectionRecord, ConnectionSecret } from "@merge-safely/core";
import { z } from "zod";

export const CONNECTION_KINDS = [
  "api-key",
  "openai-compatible",
  "anthropic-compatible",
  "oauth",
  "cloud",
  "subscription",
] as const satisfies readonly ConnectionKind[];

export const connectionKindSchema = z.enum(CONNECTION_KINDS);

/** Connection ids are what policy refers to; keep them boring so they are safe in file names, URLs and logs. */
export const connectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "connection id must be letters, digits, '.', '_' or '-'");

const headersSchema = z.record(z.string(), z.string());
const urlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "baseUrl must be http(s)");

export const apiKeySecretSchema = z.object({ kind: z.literal("api-key"), apiKey: z.string().min(1) }).strict();
export const openaiCompatibleSecretSchema = z
  .object({
    kind: z.literal("openai-compatible"),
    baseUrl: urlSchema,
    apiKey: z.string().min(1).optional(),
    headers: headersSchema.optional(),
  })
  .strict();
export const anthropicCompatibleSecretSchema = z
  .object({
    kind: z.literal("anthropic-compatible"),
    baseUrl: urlSchema,
    apiKey: z.string().min(1),
    headers: headersSchema.optional(),
  })
  .strict();
export const oauthSecretSchema = z
  .object({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.string().optional(),
  })
  .strict();
export const cloudSecretSchema = z
  .object({
    kind: z.literal("cloud"),
    region: z.string().optional(),
    projectOrResource: z.string().optional(),
    credentialsRef: z.string().optional(),
  })
  .strict();
export const subscriptionSecretSchema = z
  .object({ kind: z.literal("subscription"), credentialFileRef: z.string().optional() })
  .strict();

export const connectionSecretSchema: z.ZodType<ConnectionSecret> = z.discriminatedUnion("kind", [
  apiKeySecretSchema,
  openaiCompatibleSecretSchema,
  anthropicCompatibleSecretSchema,
  oauthSecretSchema,
  cloudSecretSchema,
  subscriptionSecretSchema,
]);

const optionsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const connectionRecordSchema: z.ZodType<ConnectionRecord> = z.object({
  id: connectionIdSchema,
  provider: z.string().min(1),
  kind: connectionKindSchema,
  label: z.string().optional(),
  createdBy: z.string().optional(),
  createdAt: z.string().min(1),
  lastValidatedAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  options: optionsSchema.optional(),
});

export const secretRefSchema = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ encrypted: z.string().min(1) }).strict(),
]);
export type SecretRef = z.infer<typeof secretRefSchema>;

/** One entry of `connections.json`. */
export const connectionFileEntrySchema = z
  .object({
    id: connectionIdSchema,
    provider: z.string().min(1),
    kind: connectionKindSchema,
    label: z.string().optional(),
    createdBy: z.string().optional(),
    createdAt: z.string().optional(),
    lastValidatedAt: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    options: optionsSchema.optional(),
    secret: connectionSecretSchema.optional(),
    secretRef: secretRefSchema.optional(),
    /** Non-secret parts of compatible kinds may sit inline next to a `secretRef.env` / `apiKeyEnv`. */
    baseUrl: urlSchema.optional(),
    headers: headersSchema.optional(),
    /** Shorthand for `secretRef: { env }`. */
    apiKeyEnv: z.string().min(1).optional(),
  })
  .strict();
export type ConnectionFileEntry = z.infer<typeof connectionFileEntrySchema>;

export const connectionsFileSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(connectionFileEntrySchema),
  })
  .strict();
export type ConnectionsFile = z.infer<typeof connectionsFileSchema>;

/** One value of the Action/App inline map (design 6.1). The key of the map is the connection id. */
export const inlineConnectionSchema = z
  .object({
    provider: z.string().min(1),
    kind: connectionKindSchema.optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: urlSchema.optional(),
    headers: headersSchema.optional(),
    accessToken: z.string().optional(),
    accessTokenEnv: z.string().min(1).optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.string().optional(),
    subscription: z.boolean().optional(),
    credentialFileRef: z.string().optional(),
    region: z.string().optional(),
    projectOrResource: z.string().optional(),
    credentialsRef: z.string().optional(),
    model: z.string().optional(),
    runner: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
export type InlineConnection = z.infer<typeof inlineConnectionSchema>;

export const inlineConnectionsMapSchema = z.record(connectionIdSchema, inlineConnectionSchema);

/** Anything a user may hand us: the connections file shape or the inline map shape. */
export const connectionInputSchema = z.union([connectionsFileSchema, inlineConnectionsMapSchema]);
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
