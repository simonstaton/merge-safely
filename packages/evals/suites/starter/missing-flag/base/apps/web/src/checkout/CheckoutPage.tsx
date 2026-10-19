import { isEnabled } from "../flags/client";
import { CardForm } from "./CardForm";
import { LegacyCheckout } from "./LegacyCheckout";

export function CheckoutPage({ cartId }: { cartId: string }) {
  if (isEnabled("checkout-legacy-fallback")) {
    return <LegacyCheckout cartId={cartId} />;
  }
  return (
    <main>
      <h1>Checkout</h1>
      <CardForm cartId={cartId} />
    </main>
  );
}
