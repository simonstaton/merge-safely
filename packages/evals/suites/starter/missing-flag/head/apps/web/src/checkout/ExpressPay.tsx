export function ExpressPay({ cartId }: { cartId: string }) {
  return (
    <section aria-label="Express checkout">
      <button type="button" onClick={() => fetch(`/api/checkout/${cartId}/express`, { method: "POST" })}>
        Pay with one click
      </button>
    </section>
  );
}
