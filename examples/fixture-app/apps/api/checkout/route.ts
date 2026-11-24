export function formatMoney(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export async function POST() {
  const apiKey = process.env.PAYMENT_GATEWAY_KEY;
  if (!apiKey) {
    return Response.json({ error: "Missing key" }, { status: 500 });
  }
  return Response.json({ ok: true, mode: process.env.NODE_ENV });
}
