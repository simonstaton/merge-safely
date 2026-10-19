import { isEnabled } from "../flags/client";
import { CardForm } from "./CardForm";
import { ExpressPay } from "./ExpressPay";

export function CheckoutPage({ cartId }: { cartId: string }) {
  const express = isEnabled("checkout-express-pay");
  return (
    <main>
      <h1>Checkout</h1>
      {express && <ExpressPay cartId={cartId} />}
      <CardForm cartId={cartId} />
    </main>
  );
}
