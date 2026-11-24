import React from "react";

export function formatMoney(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export function BadCheckout({ totalMinor }: { totalMinor: number }) {
  async function handlePay() {
    await fetch("/api/checkout", { method: "POST" });
  }

  return (
    <div style={{ padding: "12px", border: "1px solid #000" }}>
      <input type="text" placeholder="Order note" />
      <button onClick={handlePay}>Pay {formatMoney(totalMinor)}</button>
    </div>
  );
}
