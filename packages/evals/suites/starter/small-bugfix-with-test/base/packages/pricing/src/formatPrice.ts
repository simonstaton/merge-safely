export interface Money {
  amountCents: number;
  currency: string;
}

/** Format an amount for display, e.g. { 1999, "USD" } -> "$19.99". */
export function formatPrice({ amountCents, currency }: Money, locale = "en-US"): string {
  const whole = Math.floor(amountCents / 100);
  const cents = amountCents % 100;
  const symbol = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0)
    .find((p) => p.type === "currency")?.value ?? currency;
  return `${symbol}${whole}.${String(cents).padStart(2, "0")}`;
}
