/**
 * The setup page (design 7.4): one plain HTML page, inline CSS and one inline script, no external assets.
 *
 * Auth: every data view and every POST needs `Authorization: Bearer <SETUP_TOKEN>`. No cookies, no query-string
 * tokens. A browser without the header gets a shell with a token box; the inline script keeps the token in
 * sessionStorage and sends it as a header on fetch(), so a cross-site form cannot ride on ambient credentials (CSRF).
 * Every string rendered into HTML goes through `esc`, and the CSP forbids any script but the shell's nonce'd one.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Connection,
  type ConnectionKind,
  type ConnectionSecret,
  type CostLedger,
  DEFAULT_POLICY,
  type ModelInfo,
} from "@merge-safely/core";
import {
  allowedKindsForProvider,
  CONNECTION_KINDS,
  connectionIdSchema,
  connectionSecretSchema,
  type InlineConnection,
  inferConnectionKind,
  isGateway,
  LOCAL_PROVIDERS,
  normaliseProvider,
  OPENAI_COMPATIBLE_GATEWAYS,
  type ProviderRegistry,
  scrubText,
  secretValues,
} from "@merge-safely/providers";
import { installationSpend } from "./alerts.js";
import type { CatalogCache } from "./catalog-cache.js";
import type { AppDb, StoredConnection } from "./db.js";
import { estimateTiers, pickEstimateModel, TYPICAL_PR_LINES } from "./estimate.js";
import { BodyTooLargeError, FORM_BODY_LIMIT, hasBearer, header, parseForm, readBody, send } from "./http.js";
import { type AppLogger, errText, type SecretSet } from "./logger.js";
import {
  BUDGET_KEYS,
  BUDGET_LABELS,
  type BudgetKey,
  type BudgetOverrides,
  loadBudgetOverrides,
  parseOverrideField,
  saveBudgetOverrides,
} from "./settings.js";

export interface SetupDeps {
  db: AppDb;
  registry: ProviderRegistry;
  ledger: CostLedger;
  catalogCache: CatalogCache;
  setupToken: string;
  logger: AppLogger;
  secrets: SecretSet;
  now?: () => Date;
  validateTimeoutMs?: number;
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** HTML-escape for text and (double-quoted) attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESC[c] ?? c);
}

// ---------------------------------------------------------------------------
// Providers shown on the page
// ---------------------------------------------------------------------------

export const PROVIDER_CHOICES = [
  "anthropic",
  "openai",
  "gemini",
  "openai-compatible",
  "anthropic-compatible",
  ...Object.keys(LOCAL_PROVIDERS),
  ...Object.keys(OPENAI_COMPATIBLE_GATEWAYS),
  "bedrock",
  "vertex",
  "azure-openai",
] as const;

export interface ProviderChoice {
  id: string;
  kinds: readonly ConnectionKind[];
  /** An adapter in this build can serve at least one of its kinds. */
  served: boolean;
  note?: string;
}

export function providerChoices(registry: ProviderRegistry): ProviderChoice[] {
  return PROVIDER_CHOICES.map((id) => {
    const kinds = allowedKindsForProvider(id);
    const target = normaliseProvider(id, undefined).provider;
    const served =
      registry.has(target) ||
      (kinds.includes("openai-compatible") && registry.has("openai-compatible")) ||
      (kinds.includes("anthropic-compatible") && registry.has("anthropic-compatible"));
    const choice: ProviderChoice = { id, kinds, served };
    if (isGateway(id)) choice.note = "gateway (OpenAI-compatible)";
    else if (Object.hasOwn(LOCAL_PROVIDERS, id)) choice.note = `local server, default ${LOCAL_PROVIDERS[id]}`;
    return choice;
  });
}

// ---------------------------------------------------------------------------
// Form -> Connection
// ---------------------------------------------------------------------------

export type FormResult = { ok: true; conn: Connection } | { ok: false; error: string };

function parseHeaders(raw: string | undefined): Record<string, string> | { error: string } | undefined {
  const lines = (raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i <= 0) return { error: "headers must be one 'Name: value' per line" };
    const name = l.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { error: "header names may only contain letters, digits and '-'" };
    out[name] = l.slice(i + 1).trim();
  }
  return out;
}

const opt = (v: string | undefined) => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

export function connectionFromForm(form: Record<string, string>, now: Date): FormResult {
  const rawProvider = opt(form.provider);
  if (!rawProvider) return { ok: false, error: "choose a provider" };
  const id = connectionIdSchema.safeParse(opt(form.id) ?? "");
  if (!id.success) return { ok: false, error: "connection id must be 1-64 letters, digits, '.', '_' or '-'" };
  const headers = parseHeaders(form.headers);
  if (headers && "error" in headers && typeof headers.error === "string") return { ok: false, error: headers.error };
  const hdrs = headers as Record<string, string> | undefined;

  const secretField = opt(form.secret);
  const { provider, label, defaultBaseUrl } = normaliseProvider(rawProvider, opt(form.label));
  const baseUrl = opt(form.baseUrl) ?? defaultBaseUrl;

  let kind: ConnectionKind;
  const explicit = opt(form.kind);
  if (explicit && explicit !== "auto") {
    if (!(CONNECTION_KINDS as readonly string[]).includes(explicit))
      return { ok: false, error: "unknown connection kind" };
    kind = explicit as ConnectionKind;
    if (!allowedKindsForProvider(rawProvider).includes(kind)) {
      return {
        ok: false,
        error: `provider ${rawProvider} does not support kind ${kind} (supported: ${allowedKindsForProvider(rawProvider).join(", ")})`,
      };
    }
  } else {
    const inline: InlineConnection = { provider: rawProvider };
    if (secretField) inline.apiKey = secretField;
    if (opt(form.baseUrl)) inline.baseUrl = opt(form.baseUrl);
    if (opt(form.region)) inline.region = opt(form.region);
    if (opt(form.projectOrResource)) inline.projectOrResource = opt(form.projectOrResource);
    const inferred = inferConnectionKind(inline);
    if (typeof inferred !== "string") return { ok: false, error: inferred.error };
    kind = inferred;
  }

  let secret: ConnectionSecret;
  switch (kind) {
    case "api-key":
      if (!secretField) return { ok: false, error: "an API key is required for kind api-key" };
      secret = { kind, apiKey: secretField };
      break;
    case "openai-compatible":
      if (!baseUrl) return { ok: false, error: "a base URL is required for kind openai-compatible" };
      secret = { kind, baseUrl, ...(secretField ? { apiKey: secretField } : {}), ...(hdrs ? { headers: hdrs } : {}) };
      break;
    case "anthropic-compatible":
      if (!baseUrl || !secretField)
        return { ok: false, error: "a base URL and an API key are required for kind anthropic-compatible" };
      secret = { kind, baseUrl, apiKey: secretField, ...(hdrs ? { headers: hdrs } : {}) };
      break;
    case "oauth":
      if (!secretField) return { ok: false, error: "an access token is required for kind oauth" };
      secret = { kind, accessToken: secretField };
      break;
    case "cloud":
      secret = {
        kind,
        ...(opt(form.region) ? { region: opt(form.region) } : {}),
        ...(opt(form.projectOrResource) ? { projectOrResource: opt(form.projectOrResource) } : {}),
      };
      break;
    case "subscription":
      secret = { kind };
      break;
  }
  const parsedSecret = connectionSecretSchema.safeParse(secret);
  if (!parsedSecret.success) {
    const issue = parsedSecret.error.issues[0];
    return {
      ok: false,
      error: `invalid connection: ${issue?.path.join(".") || "secret"} ${issue?.message ?? ""}`.trim(),
    };
  }
  const conn: Connection = {
    id: id.data,
    provider,
    kind,
    createdAt: now.toISOString(),
    createdBy: "setup-page",
    secret: parsedSecret.data,
  };
  if (label) conn.label = label;
  if (opt(form.defaultModel)) conn.defaultModel = opt(form.defaultModel);
  if (form.runner === "cli") conn.options = { runner: "cli" };
  return { ok: true, conn };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
p.muted,.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
label{display:block;margin:8px 0 2px;font-weight:600}input,select,textarea{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px}button{margin:12px 8px 0 0;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
.ok{color:var(--ok)}.bad{color:var(--bad)}code{font-family:ui-monospace,monospace;font-size:13px}.flash{border-left:4px solid var(--line);padding:8px 12px;margin:12px 0}
.flash.ok{border-color:var(--ok)}.flash.bad{border-color:var(--bad)}
`;

const SCRIPT = `(function(){
var KEY="merge-safely-setup-token";
function tok(){try{return sessionStorage.getItem(KEY)||""}catch(e){return ""}}
function setTok(t){try{sessionStorage.setItem(KEY,t)}catch(e){}}
var app=document.getElementById("app");
function login(msg){app.innerHTML='<form id="login" class="card"><label for="token">Setup token</label><input id="token" name="token" type="password" autocomplete="off" required><button type="submit">Open setup</button><p class="muted"></p></form>';app.querySelector("p").textContent=msg||"Enter the SETUP_TOKEN configured on the server. It is kept in this tab only and sent as a bearer header.";}
function load(url,opts){opts=opts||{};var h=opts.headers||{};h.Authorization="Bearer "+tok();h["X-Setup-Fragment"]="1";opts.headers=h;
return fetch(url,opts).then(function(r){if(r.status===401){login("That token was rejected.");return null}return r.text()}).then(function(t){if(t!==null)app.innerHTML=t}).catch(function(){login("Could not reach the server.")});}
document.addEventListener("submit",function(e){var f=e.target;if(!(f instanceof HTMLFormElement))return;
if(f.id==="login"){e.preventDefault();setTok(f.elements.token.value);load(location.pathname+location.search);return}
if(f.hasAttribute("data-ajax")){e.preventDefault();var fd=new FormData(f,e.submitter||undefined);var body=new URLSearchParams();fd.forEach(function(v,k){body.append(k,String(v))});
load(f.getAttribute("action"),{method:"POST",body:body.toString(),headers:{"content-type":"application/x-www-form-urlencoded"}})}});
if(app.getAttribute("data-loaded")!=="1"){if(tok())load(location.pathname+location.search);else login()}
})();`;

export function renderShell(fragment: string, loaded: boolean, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Merge Safely setup</title><style>${CSS}</style></head><body><main><h1>Merge Safely setup</h1>
<p class="muted">Connections, budgets and spend for this self-hosted App.</p>
<div id="app" data-loaded="${loaded ? "1" : "0"}">${fragment}</div></main><script nonce="${esc(nonce)}">${SCRIPT}</script></body></html>`;
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface Flash {
  ok: boolean;
  title: string;
  lines?: string[];
  models?: ModelInfo[];
  estimate?: { model: ModelInfo; tiers: ReturnType<typeof estimateTiers> };
}

export interface SetupView {
  installations: { id: number; account: string }[];
  installationId?: number;
  connections: StoredConnection[];
  providers: ProviderChoice[];
  overrides: BudgetOverrides;
  spend?: { windowUsd: number; allTimeUsd: number; monthlyUsd: number; windowDays: number };
  flash?: Flash;
  error?: string;
}

const money = (n: number) => `$${n.toFixed(n !== 0 && n < 0.1 ? 3 : 2)}`;

function renderFlash(f: Flash): string {
  const lines = (f.lines ?? []).map((l) => `<div>${esc(l)}</div>`).join("");
  let models = "";
  if (f.models && f.models.length > 0) {
    models = `<details><summary>${esc(f.models.length)} reachable model(s)</summary><table><tr><th>Model</th><th>Tier</th><th>Price (in/out per MTok)</th></tr>${f.models
      .slice(0, 200)
      .map(
        (m) =>
          `<tr><td><code>${esc(m.name)}</code></td><td>${esc(m.tier)}</td><td>${
            m.zeroCost
              ? "zero cost"
              : m.pricing
                ? `${esc(money(m.pricing.inPerMTok))} / ${esc(money(m.pricing.outPerMTok))}`
                : "unknown (pessimistic fallback)"
          }</td></tr>`,
      )
      .join("")}</table></details>`;
  }
  let est = "";
  if (f.estimate) {
    est = `<p>Estimated cost of one review of a typical ${TYPICAL_PR_LINES}-line PR on <code>${esc(f.estimate.model.name)}</code> (default panels; rough and on the high side):</p>
<table><tr><th>Tier</th><th>Seats</th><th>Estimate</th></tr>${f.estimate.tiers
      .map(
        (t) =>
          `<tr><td>T${t.tier}</td><td>${esc(t.hunters)} hunters + ${esc(t.judges)} judge runs</td><td>${
            t.zeroCost ? "zero cost" : `${esc(money(t.usd))}${t.estimated ? " (pessimistic pricing)" : ""}`
          }</td></tr>`,
      )
      .join("")}</table>`;
  }
  return `<div class="flash ${f.ok ? "ok" : "bad"}"><strong class="${f.ok ? "ok" : "bad"}">${esc(f.title)}</strong>${lines}${est}${models}</div>`;
}

export function renderSetup(v: SetupView): string {
  const parts: string[] = [];
  if (v.error) parts.push(`<div class="flash bad"><strong class="bad">${esc(v.error)}</strong></div>`);
  if (v.installations.length === 0) {
    parts.push(
      `<div class="card"><p>No installations yet. Install the GitHub App on an organisation or repositories; it appears here as soon as GitHub delivers the <code>installation</code> webhook.</p></div>`,
    );
    return parts.join("");
  }
  parts.push(
    `<p>Installation: ${v.installations
      .map((i) =>
        i.id === v.installationId
          ? `<strong>${esc(i.account)} (${esc(i.id)})</strong>`
          : `<a href="/setup?installation=${esc(encodeURIComponent(String(i.id)))}">${esc(i.account)} (${esc(i.id)})</a>`,
      )
      .join(" · ")}</p>`,
  );
  if (v.installationId === undefined) {
    parts.push(`<p class="muted">Choose an installation above.</p>`);
    return parts.join("");
  }
  const inst = esc(v.installationId);
  if (v.flash) parts.push(renderFlash(v.flash));

  // Connections
  parts.push(`<h2>Connections</h2>`);
  if (v.connections.length === 0) {
    parts.push(`<p class="muted">No connections yet. Add one below; reviews cannot seat a panel without one.</p>`);
  } else {
    parts.push(
      `<table><tr><th>Id</th><th>Provider / kind</th><th>Secret</th><th>Default model</th><th>Validated</th><th></th></tr>${v.connections
        .map(
          (
            c,
          ) => `<tr><td><code>${esc(c.record.id)}</code>${c.record.label ? `<div class="muted">${esc(c.record.label)}</div>` : ""}</td>
<td>${esc(c.record.provider)} / ${esc(c.record.kind)}</td><td><code>${esc(c.hint)}</code></td><td>${esc(c.record.defaultModel ?? "")}</td>
<td>${esc(c.record.lastValidatedAt ?? "never")}</td>
<td><form method="post" action="/setup/connections/delete" data-ajax><input type="hidden" name="installation" value="${inst}"><input type="hidden" name="id" value="${esc(c.record.id)}"><button type="submit">Remove</button></form></td></tr>`,
        )
        .join("")}</table>`,
    );
  }

  // Providers
  parts.push(
    `<h2>Providers</h2><table><tr><th>Provider</th><th>Connection kinds</th><th></th></tr>${v.providers
      .map(
        (p) =>
          `<tr><td><code>${esc(p.id)}</code>${p.note ? `<div class="muted">${esc(p.note)}</div>` : ""}</td><td>${esc(p.kinds.join(", "))}</td><td>${
            p.served ? "" : '<span class="muted">no adapter in this build</span>'
          }</td></tr>`,
      )
      .join("")}</table>`,
  );

  // Add connection
  const providerOptions = v.providers
    .filter((p) => p.served)
    .map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`)
    .join("");
  const kindOptions = ["auto", ...CONNECTION_KINDS].map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
  parts.push(`<h2>Add a connection</h2><form class="card" method="post" action="/setup/connections" data-ajax autocomplete="off">
<input type="hidden" name="installation" value="${inst}">
<div class="grid"><div><label for="f-provider">Provider</label><select id="f-provider" name="provider">${providerOptions}</select></div>
<div><label for="f-kind">Kind</label><select id="f-kind" name="kind">${kindOptions}</select></div>
<div><label for="f-id">Connection id</label><input id="f-id" name="id" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*" maxlength="64" placeholder="anthropic-main"></div>
<div><label for="f-label">Label</label><input id="f-label" name="label" maxlength="120"></div></div>
<label for="f-secret">API key / access token</label><input id="f-secret" name="secret" type="password" autocomplete="off">
<div class="grid"><div><label for="f-base">Base URL (compatible kinds)</label><input id="f-base" name="baseUrl" placeholder="https://gateway.example.com/v1"></div>
<div><label for="f-model">Default model</label><input id="f-model" name="defaultModel" placeholder="optional"></div>
<div><label for="f-runner">Runner</label><select id="f-runner" name="runner"><option value="">API (default)</option><option value="cli">Claude Code CLI (anthropic only)</option></select></div></div>
<div class="grid"><div><label for="f-region">Region (cloud)</label><input id="f-region" name="region"></div>
<div><label for="f-project">Project / resource (cloud)</label><input id="f-project" name="projectOrResource"></div></div>
<label for="f-headers">Extra headers (compatible kinds, one "Name: value" per line; stored encrypted)</label><textarea id="f-headers" name="headers" rows="2"></textarea>
<button type="submit" name="intent" value="test">Validate only</button><button type="submit" name="intent" value="save">Validate and save</button>
<p class="muted">The key is validated against the provider immediately and stored envelope-encrypted under this installation. It is never shown again; only a masked tail is displayed. Re-using an id replaces that connection (that is how you rotate a key).</p></form>`);

  // Budgets
  const policyDefault = (k: BudgetKey) => {
    const d = DEFAULT_POLICY.budget[k];
    return d === null ? "unset" : money(d);
  };
  parts.push(`<h2>Budget ceilings</h2><form class="card" method="post" action="/setup/budget" data-ajax>
<input type="hidden" name="installation" value="${inst}">
<p class="muted">Leave a field <strong>empty</strong> for "never configured": the repository's <code>.merge-safely.yml</code> (or the built-in default) applies. Enter <strong>0</strong> to explicitly <strong>disable</strong> that ceiling. Any other value (USD) replaces the policy value for every repository of this installation. Ceilings are checked when a review is admitted and every minute; alerts fire once at 50/80/100%.</p>
<div class="grid">${BUDGET_KEYS.map(
    (k) =>
      `<div><label for="b-${esc(k)}">${esc(BUDGET_LABELS[k])}</label><input id="b-${esc(k)}" name="${esc(k)}" inputmode="decimal" value="${
        v.overrides[k] === null ? "" : esc(v.overrides[k])
      }" placeholder="default: ${esc(policyDefault(k))}"></div>`,
  ).join("")}</div><button type="submit">Save ceilings</button></form>`);

  // Spend
  if (v.spend) {
    parts.push(`<h2>Spend (this gate's ledger)</h2><table>
<tr><td>Last ${esc(v.spend.windowDays)} days</td><td>${esc(money(v.spend.windowUsd))}</td></tr>
<tr><td>This calendar month (UTC)</td><td>${esc(money(v.spend.monthlyUsd))}</td></tr>
<tr><td>All time</td><td>${esc(money(v.spend.allTimeUsd))}</td></tr></table>
<p class="muted">Enforcement uses these numbers, never the provider's own account usage.</p>`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function parseInstallation(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

async function buildView(
  deps: SetupDeps,
  installationId: number | undefined,
  extra: Partial<SetupView> = {},
): Promise<SetupView> {
  const installations = deps.db.listInstallations().map((i) => ({ id: i.id, account: i.account }));
  const known = installationId !== undefined && installations.some((i) => i.id === installationId);
  const chosen = known ? installationId : installations.length === 1 ? installations[0]?.id : undefined;
  const view: SetupView = {
    installations,
    connections: [],
    providers: providerChoices(deps.registry),
    overrides: { perChangeUsd: null, windowUsd: null, spendLimitUsd: null, perInstallationMonthlyUsd: null },
    ...extra,
  };
  if (installationId !== undefined && !known && !view.error) view.error = "Unknown installation.";
  if (chosen === undefined) return view;
  view.installationId = chosen;
  view.connections = deps.db.listConnections(chosen);
  view.overrides = loadBudgetOverrides(deps.db, chosen, deps.logger);
  try {
    view.spend = await installationSpend(
      deps.ledger,
      chosen,
      (deps.now ?? (() => new Date()))(),
      DEFAULT_POLICY.budget.windowDays,
    );
  } catch (err: unknown) {
    deps.logger.warn("could not read spend for the setup page", { error: errText(err) });
  }
  return view;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Validate a connection through its provider and (on intent=save) store it encrypted. */
export async function submitConnection(
  deps: SetupDeps,
  installationId: number,
  form: Record<string, string>,
): Promise<Flash> {
  const now = (deps.now ?? (() => new Date()))();
  const parsed = connectionFromForm(form, now);
  if (!parsed.ok) return { ok: false, title: "Not saved", lines: [parsed.error] };
  const conn = parsed.conn;
  const secrets = secretValues(conn.secret);
  deps.secrets.add(...secrets);
  const scrub = (s: string) => scrubText(s, secrets);
  let provider: ReturnType<ProviderRegistry["forConnection"]>;
  try {
    provider = deps.registry.forConnection(conn);
  } catch (err: unknown) {
    return { ok: false, title: "Not saved", lines: [scrub(errText(err))] };
  }
  const timeout = deps.validateTimeoutMs ?? 30_000;
  let result: Awaited<ReturnType<typeof provider.validate>>;
  try {
    result = await withTimeout(provider.validate(conn), timeout, "validation");
  } catch (err: unknown) {
    result = { ok: false, message: errText(err) };
  }
  if (!result.ok) {
    return {
      ok: false,
      title: "Validation failed; not saved",
      lines: [scrub(result.message ?? "the provider rejected the connection")],
    };
  }
  let models = result.models ?? [];
  if (models.length === 0) {
    try {
      models = await withTimeout(provider.models(conn), timeout, "model listing");
    } catch (err: unknown) {
      deps.logger.warn("model listing failed after validation", { connection: conn.id, error: scrub(errText(err)) });
    }
  }
  const lines: string[] = [];
  if (result.latencyMs !== undefined) lines.push(`Reachable in ${result.latencyMs} ms.`);
  if (conn.defaultModel && models.length > 0 && !models.some((m) => m.name === conn.defaultModel)) {
    lines.push(`Warning: default model "${conn.defaultModel}" is not among the models this connection lists.`);
  }
  const estModel = pickEstimateModel(models, conn.defaultModel);
  const flash: Flash = { ok: true, title: "Connection is valid", lines, models };
  if (estModel) flash.estimate = { model: estModel, tiers: estimateTiers(estModel) };
  if (form.intent === "save") {
    conn.lastValidatedAt = now.toISOString();
    deps.db.saveConnection(installationId, conn);
    deps.catalogCache.invalidate(installationId);
    deps.logger.info("connection saved", {
      installationId,
      connection: conn.id,
      provider: conn.provider,
      kind: conn.kind,
    });
    flash.title = `Saved connection "${conn.id}"`;
  } else {
    lines.push("Validated only; nothing was saved.");
  }
  return flash;
}

export function parseBudgetForm(
  form: Record<string, string>,
): { ok: true; value: BudgetOverrides } | { ok: false; error: string } {
  const out: BudgetOverrides = {
    perChangeUsd: null,
    windowUsd: null,
    spendLimitUsd: null,
    perInstallationMonthlyUsd: null,
  };
  for (const k of BUDGET_KEYS) {
    const r = parseOverrideField(form[k]);
    if (!r.ok)
      return { ok: false, error: `${BUDGET_LABELS[k]}: enter a non-negative number, 0 to disable, or leave empty` };
    out[k] = r.value;
  }
  return { ok: true, value: out };
}

export async function setupHandler(
  deps: SetupDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const nonce = randomBytes(16).toString("base64");
  const fragmentOnly = header(req, "x-setup-fragment") === "1";
  const html = (status: number, fragment: string, loaded: boolean) =>
    send(res, status, fragmentOnly ? fragment : renderShell(fragment, loaded, nonce), "text/html; charset=utf-8", {
      "content-security-policy": contentSecurityPolicy(nonce),
      ...(status === 401 ? { "www-authenticate": 'Bearer realm="merge-safely-setup"' } : {}),
    });

  if (!hasBearer(req, deps.setupToken)) {
    if (req.method !== "GET") req.resume();
    html(401, "", false);
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/setup") {
      const view = await buildView(
        deps,
        parseInstallation(url.searchParams.get("installation") ?? url.searchParams.get("installation_id")),
      );
      html(200, renderSetup(view), true);
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "method not allowed");
      return;
    }
    let form: Record<string, string>;
    try {
      form = parseForm(await readBody(req, FORM_BODY_LIMIT));
    } catch (err: unknown) {
      send(res, err instanceof BodyTooLargeError ? 413 : 400, "bad request");
      return;
    }
    const inst = parseInstallation(form.installation);
    const known = inst !== undefined && deps.db.listInstallations().some((i) => i.id === inst);
    if (inst === undefined || !known) {
      html(400, renderSetup(await buildView(deps, inst, { error: "Unknown installation." })), true);
      return;
    }
    let flash: Flash;
    if (url.pathname === "/setup/connections") {
      flash = await submitConnection(deps, inst, form);
    } else if (url.pathname === "/setup/connections/delete") {
      const removed = deps.db.deleteConnection(inst, form.id ?? "");
      deps.catalogCache.invalidate(inst);
      if (removed) deps.logger.info("connection removed", { installationId: inst, connection: form.id });
      flash = removed
        ? { ok: true, title: `Removed connection "${form.id ?? ""}"` }
        : { ok: false, title: "No such connection" };
    } else if (url.pathname === "/setup/budget") {
      const parsed = parseBudgetForm(form);
      if (parsed.ok) {
        saveBudgetOverrides(deps.db, inst, parsed.value);
        deps.logger.info("budget ceilings updated", { installationId: inst, ...parsed.value });
        flash = { ok: true, title: "Budget ceilings saved" };
      } else {
        flash = { ok: false, title: "Not saved", lines: [parsed.error] };
      }
    } else {
      send(res, 404, "not found");
      return;
    }
    html(flash.ok ? 200 : 422, renderSetup(await buildView(deps, inst, { flash })), true);
  } catch (err: unknown) {
    deps.logger.error("setup request failed", { error: errText(err) });
    send(res, 500, "internal error");
  }
}
