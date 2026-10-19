export function LegacyCheckout({ cartId }: { cartId: string }) {
  return <iframe title="Checkout" src={`/legacy/checkout?cart=${encodeURIComponent(cartId)}`} />;
}
