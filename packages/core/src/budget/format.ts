/** Private formatting helpers for budget messages (not re-exported from the barrel). */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
