import { describe, expect, it } from "vitest";
import { applySettlement } from "./payments.js";
import type { Store } from "./types.js";

const storeWithPendingOrder = (): Pick<Store, "orders" | "entitlements"> => ({
  orders: [
    {
      id: "order-1",
      userId: "user-1",
      bookIds: ["book-a", "book-b"],
      totalMinor: 5000,
      currency: "SAR",
      status: "PENDING",
      createdAt: new Date().toISOString(),
    },
  ],
  entitlements: [],
});

describe("applySettlement", () => {
  it("grants the ordered books once the payment is confirmed", () => {
    const store = storeWithPendingOrder();
    expect(applySettlement(store, "order-1", true)).toBe(true);
    expect(store.orders[0].status).toBe("COMPLETED");
    expect(store.entitlements).toEqual([
      { userId: "user-1", bookId: "book-a" },
      { userId: "user-1", bookId: "book-b" },
    ]);
  });

  it("grants nothing when the payment did not succeed", () => {
    const store = storeWithPendingOrder();
    expect(applySettlement(store, "order-1", false)).toBe(true);
    expect(store.orders[0].status).toBe("CANCELLED");
    expect(store.entitlements).toEqual([]);
  });

  it("stays idempotent across repeated webhook deliveries", () => {
    const store = storeWithPendingOrder();
    applySettlement(store, "order-1", true);
    expect(applySettlement(store, "order-1", true)).toBe(false);
    expect(store.entitlements).toHaveLength(2);
  });

  it("never revokes a paid order when a failure event arrives late", () => {
    const store = storeWithPendingOrder();
    applySettlement(store, "order-1", true);
    expect(applySettlement(store, "order-1", false)).toBe(false);
    expect(store.orders[0].status).toBe("COMPLETED");
    expect(store.entitlements).toHaveLength(2);
  });

  it("ignores an unknown order", () => {
    const store = storeWithPendingOrder();
    expect(applySettlement(store, "order-missing", true)).toBe(false);
    expect(store.entitlements).toEqual([]);
  });
});
