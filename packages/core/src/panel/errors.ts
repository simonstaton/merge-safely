/** Seating failures. Thrown loudly so a misconfigured policy never silently runs a weaker panel (design 4.2 step 4). */
export class SeatingError extends Error {
  /** A concrete, user-facing hint for how to fix the policy or installation. */
  readonly fix: string;
  /** The policy key at fault, when there is one (e.g. "models.judges"). */
  readonly policyKey?: string;

  constructor(message: string, fix: string, policyKey?: string) {
    super(message);
    this.name = "SeatingError";
    this.fix = fix;
    if (policyKey !== undefined) this.policyKey = policyKey;
  }
}
