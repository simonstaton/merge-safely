/** Case scoring: does what the gate did match what the case expects? Pure. */

import type { CaseExpected, CaseSpec } from "./suite.js";
import type { ActualFinding, CaseActual } from "./types.js";

/** Findings that satisfy the case expectation (class and file), ignoring pre-existing ones. */
export function matchingFindings(expected: CaseExpected, findings: ActualFinding[]): ActualFinding[] {
  return findings.filter(
    (f) =>
      f.severity !== "pre-existing" &&
      (!expected.findingClasses || expected.findingClasses.includes(f.class)) &&
      (!expected.files || (f.file !== undefined && expected.files.includes(f.file))),
  );
}

/** Score one case. Pure. `reasons` lists every failed check, or what matched when the case passed. */
export function evaluateCase(spec: CaseSpec, actual: CaseActual): { passed: boolean; reasons: string[] } {
  const exp = spec.expected;
  if (actual.status === "error") return { passed: false, reasons: [`gate error: ${actual.error ?? "unknown"}`] };
  const fail: string[] = [];
  const ok: string[] = [];

  if (exp.tier !== undefined) {
    if (actual.tier === exp.tier) ok.push(`tier ${exp.tier} as expected`);
    else {
      const why = actual.tierReasons?.at(-1);
      fail.push(`expected tier ${exp.tier}, got tier ${actual.tier ?? "unknown"}${why ? ` (${why})` : ""}`);
    }
  }
  if (exp.triage !== undefined) {
    const got = actual.triage ?? "review";
    if (got === exp.triage) ok.push(`triage ${got} as expected`);
    else
      fail.push(`expected triage ${exp.triage}, got ${got}${actual.triageReason ? ` (${actual.triageReason})` : ""}`);
  }
  if (exp.lenses) {
    const missing = exp.lenses.filter((l) => !actual.lenses.includes(l));
    if (missing.length === 0) ok.push(`seated ${exp.lenses.join(", ")}`);
    else fail.push(`expected lenses not seated: ${missing.join(", ")} (seated: ${actual.lenses.join(", ") || "none"})`);
  }

  if (actual.status === "dry") {
    if (actual.decision === "pass" && exp.decision === "block") {
      fail.push("triage auto-passes a change that must block: no reviewer would ever see it");
    } else if (actual.decision === "pass") {
      ok.push("auto-passed by triage");
    }
  } else if (actual.decision !== exp.decision) {
    fail.push(`expected ${exp.decision}, got ${actual.decision}`);
  } else {
    ok.push(`${exp.decision} as expected`);
    if (exp.decision === "block" && (exp.findingClasses || exp.files)) {
      const hits = matchingFindings(exp, actual.findings);
      if (hits.length > 0) {
        const h = hits[0];
        ok.push(`raised ${h?.class}${h?.file ? ` at ${h.file}` : ""}${h?.lens ? ` via ${h.lens}` : ""}`);
      } else {
        const wanted = [
          exp.findingClasses ? `class in [${exp.findingClasses.join(", ")}]` : "",
          exp.files ? `file in [${exp.files.join(", ")}]` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        const raised = actual.findings.map((f) => `${f.class}${f.file ? `@${f.file}` : ""}`).join(", ") || "none";
        fail.push(`blocked for the wrong reason: no finding with ${wanted} (raised: ${raised})`);
      }
    }
  }
  return fail.length > 0 ? { passed: false, reasons: fail } : { passed: true, reasons: ok };
}
