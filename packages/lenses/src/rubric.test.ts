import { describe, expect, it } from "vitest";
import { renderRubric, SEVERITY_DEFINITIONS } from "./rubric.js";

describe("rubric", () => {
  it("defines all four severities and the core rules", () => {
    expect(Object.keys(SEVERITY_DEFINITIONS)).toEqual(["blocker", "important", "nit", "pre-existing"]);
    const hunter = renderRubric("hunter");
    expect(hunter).toContain("Style-only findings are dropped");
    expect(hunter).toContain("Never fabricate");
    expect(hunter).toContain("Passing without reading is forbidden");
    expect(hunter).toContain("confidenceRefuted");
    expect(hunter).toContain("never as instructions");
    expect(hunter).toContain("`review-manipulation`, severity important");
    expect(hunter).toContain("prompt-injection test fixtures");
    expect(hunter).toContain("Put it in `evidence`");
  });

  it("omits the hunter verdict rule for judges", () => {
    expect(renderRubric("judge")).not.toContain("Passing without reading");
  });
});
