import { describe, expect, it } from "vitest";
import { formatPrice } from "./formatPrice";

describe("formatPrice", () => {
  it("formats dollars and cents", () => {
    expect(formatPrice({ amountCents: 1999, currency: "USD" })).toBe("$19.99");
  });
});
