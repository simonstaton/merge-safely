export interface Money {
  amountCents: number;
  currency: string;
}

/**
 * Format an amount for display, e.g. { 1999, "USD" } -> "$19.99".
 * Delegates to Intl so negative amounts (refunds), zero-decimal currencies (JPY) and grouping are correct.
 */
export function formatPrice({ amountCents, currency }: Money, locale = "en-US"): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountCents / 10 ** digits);
}
