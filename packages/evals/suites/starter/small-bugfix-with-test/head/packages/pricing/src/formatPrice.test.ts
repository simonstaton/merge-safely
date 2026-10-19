import { describe, expect, it } from "vitest";
import { formatPrice } from "./formatPrice";

describe("formatPrice", () => {
  it("formats dollars and cents", () => {
    expect(formatPrice({ amountCents: 1999, currency: "USD" })).toBe("$19.99");
  });

  it("formats refunds as negative amounts", () => {
    // Math.floor(-1999 / 100) is -20 and -1999 % 100 is -99, which used to render "$-20.-99".
    expect(formatPrice({ amountCents: -1999, currency: "USD" })).toBe("-$19.99");
  });

  it("groups thousands", () => {
    expect(formatPrice({ amountCents: 123456789, currency: "USD" })).toBe("$1,234,567.89");
  });

  it("handles zero-decimal currencies", () => {
    expect(formatPrice({ amountCents: 1200, currency: "JPY" }, "en-US")).toBe("¥1,200");
  });

  it("formats zero without a sign", () => {
    expect(formatPrice({ amountCents: 0, currency: "USD" })).toBe("$0.00");
  });

  it("respects the locale", () => {
    expect(formatPrice({ amountCents: 1999, currency: "EUR" }, "de-DE")).toBe("19,99\u00a0€");
  });
});
