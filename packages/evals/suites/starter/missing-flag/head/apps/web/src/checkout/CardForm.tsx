export function CardForm({ cartId }: { cartId: string }) {
  return (
    <form method="post" action={`/api/checkout/${cartId}/card`}>
      <label>
        Card number
        <input name="card" autoComplete="cc-number" inputMode="numeric" />
      </label>
      <button type="submit">Pay</button>
    </form>
  );
}
