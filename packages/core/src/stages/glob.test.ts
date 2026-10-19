import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_PATHS } from "../policy/schema.js";
import { expandBraces, firstMatch, matchAny, matchPath, wildcardMatch } from "./glob.js";

/** Small deterministic PRNG (mulberry32) so property tests are reproducible without a dependency. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["src", "auth", "author", "lib", "db", "migrations", "app", "x", ".github", "a.b", "index.ts", "jobs"];
function randomPath(r: () => number): string {
  const n = 1 + Math.floor(r() * 5);
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)] ?? "x").join("/");
}

describe("matchPath", () => {
  it("matches whole segments only: auth vs author", () => {
    expect(matchPath("**/auth/**", "src/auth/login.ts")).toBe(true);
    expect(matchPath("**/auth/**", "auth/login.ts")).toBe(true);
    expect(matchPath("**/auth/**", "src/author/bio.ts")).toBe(false);
    expect(matchPath("**/auth/**", "src/oauth/x.ts")).toBe(false);
    expect(matchPath("**/auth/**", "src/auth.ts")).toBe(false);
    expect(matchPath("**/auth/**", "src/auth")).toBe(false);
    expect(matchPath("**/backfill*/**", "src/jobs/backfillJob.ts")).toBe(false);
    expect(matchPath("**/backfill*/**", "src/backfills/run.ts")).toBe(true);
  });

  it("matches basenames under globstar", () => {
    expect(matchPath("**/schema.prisma", "prisma/schema.prisma")).toBe(true);
    expect(matchPath("**/schema.prisma", "schema.prisma")).toBe(true);
    expect(matchPath("**/schema.prisma", "prisma/schema.prisma.bak")).toBe(false);
    expect(matchPath("**/schema.prisma", "prisma/myschema.prisma")).toBe(false);
  });

  it("treats slash-less patterns as basename matches anywhere", () => {
    expect(matchPath("*.sql", "db/migrations/0001.sql")).toBe(true);
    expect(matchPath("*.sql", "top.sql")).toBe(true);
    expect(matchPath("Dockerfile", "services/api/Dockerfile")).toBe(true);
    expect(matchPath("Dockerfile", "services/api/Dockerfile.dev")).toBe(false);
  });

  it("anchors patterns that contain a slash at the root", () => {
    expect(matchPath(".github/workflows/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchPath(".github/workflows/**", "sub/.github/workflows/ci.yml")).toBe(false);
    expect(matchPath("docs/**", "docs/a/b.md")).toBe(true);
    expect(matchPath("docs/**", "src/docs/a.md")).toBe(false);
  });

  it("supports * and ? within one segment", () => {
    expect(matchPath("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchPath("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(matchPath("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchPath("src/?.ts", "src/ab.ts")).toBe(false);
    expect(matchPath("**/jobs/**/backfill*", "services/api/src/jobs/backfillUsers.ts")).toBe(true);
    expect(matchPath("**/jobs/**/backfill*", "services/api/src/jobs/x/backfill.ts")).toBe(true);
    expect(matchPath("**/jobs/**/backfill*", "services/api/src/jobs/rebackfill.ts")).toBe(false);
    expect(matchPath("**/queries/**/*Raw.*", "packages/db/queries/userRaw.ts")).toBe(true);
    expect(matchPath("**/docker-compose*.yml", "docker-compose.prod.yml")).toBe(true);
  });

  it("supports {a,b} alternatives within a segment", () => {
    expect(matchPath("**/*.{ts,tsx}", "src/a.tsx")).toBe(true);
    expect(matchPath("**/*.{ts,tsx}", "src/a.ts")).toBe(true);
    expect(matchPath("**/*.{ts,tsx}", "src/a.js")).toBe(false);
    expect(matchPath("{src,lib}/**", "lib/x.ts")).toBe(true);
    expect(matchPath("{src,lib}/**", "app/x.ts")).toBe(false);
    expect(matchPath("**/{auth,authz}/**", "a/authz/b")).toBe(true);
    expect(matchPath("**/{auth,authz}/**", "a/author/b")).toBe(false);
  });

  it("is case-insensitive by default, with an opt-out", () => {
    expect(matchPath("**/auth/**", "src/Auth/login.ts")).toBe(true);
    expect(matchPath("**/payments/**", "src/Payments/Charge.cs")).toBe(true);
    expect(matchPath("**/migrations/**", "db/Migrations/001.sql")).toBe(true);
    expect(matchPath("**/*.sql", "db/X.SQL")).toBe(true);
    expect(matchPath("**/Dockerfile", "dockerfile")).toBe(true);
    expect(matchPath("**/auth/**", "src/Author/bio.ts")).toBe(false);
    expect(matchPath("**/Auth/**", "src/auth/x.ts", { caseInsensitive: false })).toBe(false);
    expect(matchPath("**/*.md", "README.MD", { caseInsensitive: false })).toBe(false);
  });

  it("treats a trailing slash as a directory", () => {
    expect(matchPath("docs/", "docs/a.md")).toBe(true);
    expect(matchPath("docs/", "src/docs/a.md")).toBe(true);
    expect(matchPath("docs/", "docs")).toBe(false);
    expect(matchPath("docs/", "src/docs.md")).toBe(false);
    expect(matchPath("site/docs/", "site/docs/x/y.md")).toBe(true);
    expect(matchPath("site/docs/", "other/site/docs/x.md")).toBe(false);
  });

  it("stays fast on pathological patterns", () => {
    const longSeg = "a".repeat(5000);
    const deep = Array.from({ length: 200 }, () => "a").join("/");
    const start = performance.now();
    expect(matchPath("*a*a*a*a*a*a*a*a*b", longSeg)).toBe(false);
    expect(matchPath("**/a/**/a/**/a/**/a/**/b", deep)).toBe(false);
    expect(matchPath("{a,b}*{a,b}*{a,b}*{a,b}*c", longSeg)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("expands braces with a cap", () => {
    expect(expandBraces("x.{ts,tsx}")).toEqual(["x.ts", "x.tsx"]);
    expect(expandBraces("{a,b}{c,d}")).toEqual(["ac", "ad", "bc", "bd"]);
    expect(expandBraces("{unclosed")).toEqual(["{unclosed"]);
    expect(expandBraces("{a,b,c,d}".repeat(6)).length).toBe(256);
  });

  it("matches single-segment wildcards", () => {
    expect(wildcardMatch("*.ts", "a.ts")).toBe(true);
    expect(wildcardMatch("a?c", "abc")).toBe(true);
    expect(wildcardMatch("a?c", "ac")).toBe(false);
    expect(wildcardMatch("*", "")).toBe(true);
    expect(wildcardMatch("a*b*c", "axxbyyc")).toBe(true);
    expect(wildcardMatch("a*b*c", "axxbyy")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    expect(matchPath("a.b/c+d/(x)", "a.b/c+d/(x)")).toBe(true);
    expect(matchPath("a.b/**", "aXb/c")).toBe(false);
    expect(matchPath("[abc]", "a")).toBe(false);
    expect(matchPath("{unclosed", "{unclosed")).toBe(true);
  });

  it("normalises leading ./ and / and rejects empty input", () => {
    expect(matchPath("src/**", "./src/a.ts")).toBe(true);
    expect(matchPath("/src/**", "src/a.ts")).toBe(true);
    expect(matchPath("", "src/a.ts")).toBe(false);
    expect(matchPath("**", "")).toBe(false);
  });

  it("matches dot directories with globstar", () => {
    expect(matchPath("**/secrets/**", ".config/secrets/key.pem")).toBe(true);
  });

  it("covers the default critical paths", () => {
    expect(firstMatch(DEFAULT_CRITICAL_PATHS, "db/migrations/0012_add.sql")).toBe("**/migrations/**");
    expect(firstMatch(DEFAULT_CRITICAL_PATHS, "infra/main.tf")).toBe("**/infra/**");
    expect(matchAny(DEFAULT_CRITICAL_PATHS, "src/components/author/Bio.tsx")).toBe(false);
    expect(matchAny(DEFAULT_CRITICAL_PATHS, "src/payments/charge.ts")).toBe(true);
  });

  describe("properties", () => {
    const r = rng(1234);
    const paths = Array.from({ length: 400 }, () => randomPath(r));

    it("a/** needs at least one segment under a, a/**/b allows zero between", () => {
      expect(matchPath("docs/**", "docs")).toBe(false);
      expect(matchPath("a/**/b", "a/b")).toBe(true);
      expect(matchPath("a/**/b", "a/x/y/b")).toBe(true);
    });

    it("** matches every non-empty path", () => {
      for (const p of paths) expect(matchPath("**", p)).toBe(true);
    });

    it("a literal path matches itself", () => {
      for (const p of paths) expect(matchPath(p, p)).toBe(true);
    });

    it("**/<seg>/** matches iff a non-final segment equals <seg>", () => {
      for (const p of paths) {
        const dirs = p.split("/").slice(0, -1);
        expect(matchPath("**/auth/**", p)).toBe(dirs.includes("auth"));
      }
    });

    it("a basename pattern matches iff the last segment equals it", () => {
      for (const p of paths) expect(matchPath("index.ts", p)).toBe(p.split("/").at(-1) === "index.ts");
    });

    it("prefixing a path never makes a **/-rooted pattern stop matching", () => {
      for (const p of paths) {
        if (matchPath("**/db/**", p)) expect(matchPath("**/db/**", `extra/${p}`)).toBe(true);
      }
    });

    it("* never crosses a slash", () => {
      for (const p of paths) expect(matchPath("*/*", p)).toBe(p.split("/").length === 2);
    });
  });
});
