// Review one pull request with the merge-safely orchestrator, wired by hand from the published packages.
// This is the same wiring the CLI uses for `merge-safely run --repo <owner/name> --pr <n> --report github --store checkrun`.
//
//   GITHUB_TOKEN=<App installation or Actions token> REPO=my-org/my-repo PR=1234 npx tsx examples/programmatic/gate.ts
//
// Check runs (the merge signal and the verdict store here) need an App installation or Actions token; with a
// personal token use commitStatusReporter and a store-fs / store-sqlite verdict store instead.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createGate,
  findInCatalog,
  loadPolicy,
  type ModelInfo,
  type ModelRef,
  type Pricing,
  type PromptBuilders,
} from "@merge-safely/core";
import {
  checkRunReporter,
  checkRunStore,
  githubSource,
  octokitFromToken,
  parseRepo,
  prReviewReporter,
  trustFromPolicy,
} from "@merge-safely/github";
import { buildHunterPrompt, buildJudgePrompt, requireLens } from "@merge-safely/lenses";
import { allProviders } from "@merge-safely/provider-compatible";
import { buildCatalog, catalogLookup, createProviderRegistry, loadConnectionsFile } from "@merge-safely/providers";
import { cheaperModel, normaliseModelId, priceUsage, withPricing } from "@merge-safely/registry";
import { sqliteStores } from "@merge-safely/store-sqlite";
import { createReadOnlyTools } from "@merge-safely/tools";
import { localWorkspace } from "@merge-safely/workspace-local";
import { parse } from "yaml";

async function readPolicy(path: string): Promise<unknown> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (_err: unknown) {
    return {}; // no policy file: the conservative defaults apply
  }
}

// Core takes pricing and prompts as injected functions, because it depends on neither the registry nor the lenses.
const pricing: Pricing = {
  withPricing,
  normalise: normaliseModelId,
  price: (model, usage) => priceUsage(withPricing(model), usage),
  cheaper: (ref: ModelRef, models: ModelInfo[]): ModelRef | undefined => {
    const current = findInCatalog(models, ref.name, { normalise: normaliseModelId });
    const next = current ? cheaperModel(ref.provider, current) : undefined;
    return next ? { connectionId: ref.connectionId, provider: ref.provider, name: next.name } : undefined;
  },
};

const prompts: PromptBuilders = {
  hunter: (lens, input, opts) => buildHunterPrompt(requireLens(lens), input, opts ?? {}),
  judge: (input, opts) => buildJudgePrompt(input, opts ?? {}),
};

export async function reviewPullRequest(repoSlug: string, number: number, token: string) {
  const repo = parseRepo(repoSlug);
  // Read the policy from your trusted copy of the base branch, never from the PR head.
  const policy = loadPolicy(await readPolicy(".merge-safely.yml"));
  // $MERGE_SAFELY_HOME/connections.json; encrypted entries need MERGE_SAFELY_MASTER_KEY.
  const connections = await loadConnectionsFile();
  const registry = createProviderRegistry(allProviders());
  const catalog = catalogLookup(await buildCatalog(registry, connections));
  const octokit = octokitFromToken(token);
  const home = process.env.MERGE_SAFELY_HOME ?? join(homedir(), ".merge-safely");
  const { ledger, close } = sqliteStores({ path: join(home, "merge-safely.db") });

  const gate = createGate({
    source: githubSource({ octokit }),
    // A disposable bare-mirror checkout of the head SHA per seat. Never point this at your working copy.
    workspace: localWorkspace({
      cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
      token,
      cacheDir: join(home, "repos", `${repo.owner}__${repo.name}.git`),
    }),
    providers: (conn) => registry.forConnection(conn),
    connections,
    catalog,
    store: checkRunStore({ octokit, policy }),
    ledger,
    reporters: [checkRunReporter({ octokit, policy }), prReviewReporter({ octokit, policy })],
    trust: trustFromPolicy(policy, octokit),
    policy,
    tools: createReadOnlyTools,
    prompts,
    pricing,
    installationId: `${repo.owner}/${repo.name}`,
  });

  try {
    const estimate = await gate.estimate({ repo, number });
    console.error(estimate.summary);
    const result = await gate.review({ repo, number });
    console.log(result.digest.text);
    return result.verdict.decision;
  } finally {
    close();
  }
}

const token = process.env.GITHUB_TOKEN;
const repoArg = process.env.REPO;
const prArg = Number(process.env.PR);
if (token && repoArg && Number.isInteger(prArg) && prArg > 0) {
  const decision = await reviewPullRequest(repoArg, prArg, token);
  process.exitCode = decision === "pass" ? 0 : decision === "block" ? 1 : 2;
}
