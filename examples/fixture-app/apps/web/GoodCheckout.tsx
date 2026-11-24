import React from "react";
import { Button, Input } from "@acme/ui";
import { formatMinorAmount } from "@acme/core/formatters";
import { submitCheckout } from "../../src/lib/checkout-client";

export function GoodCheckout({ totalMinor }: { totalMinor: number }) {
  return (
    <form className="stack-md">
      <input type="hidden" name="intent" value="checkout" />
      <Input label="Order note" placeholder="Optional instruction" />
      <Button onClick={() => submitCheckout(totalMinor)}>
        Pay {formatMinorAmount(totalMinor)}
      </Button>
    </form>
  );
}
