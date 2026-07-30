import { describe, expect, it } from "vitest";

import { quoteOutputSchema } from "../src/server.js";

describe("quoteOutputSchema", () => {
  it("accepts a structured payment requirement payload", () => {
    const result = quoteOutputSchema.safeParse({
      quoteId: "quote_123",
      quoteToken: "token_123",
      characters: 128,
      amount: {
        atomic: "1000000",
        decimals: 6,
        display: "1.000000",
        symbol: "USDC",
      },
      network: "base-sepolia",
      asset: "USDC",
      payTo: "0xabc123",
      expiresAt: "2026-07-31T00:00:00.000Z",
      paymentRequired: "x402",
      selectedRequirement: {
        scheme: "exact",
        network: "base-sepolia",
        amount: "1000000",
        asset: "USDC",
        payTo: "0xabc123",
        maxTimeoutSeconds: 60,
        extra: { foo: "bar" },
      },
      policy: {
        allowed: true,
        approvalRequired: false,
        decisionId: "policy_123",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a payment requirement missing required fields", () => {
    const result = quoteOutputSchema.safeParse({
      quoteId: "quote_123",
      quoteToken: "token_123",
      characters: 128,
      amount: {
        atomic: "1000000",
        decimals: 6,
        display: "1.000000",
        symbol: "USDC",
      },
      network: "base-sepolia",
      asset: "USDC",
      payTo: "0xabc123",
      expiresAt: "2026-07-31T00:00:00.000Z",
      paymentRequired: "x402",
      selectedRequirement: {
        scheme: "exact",
        network: "base-sepolia",
        amount: "1000000",
        asset: "USDC",
        payTo: "0xabc123",
      },
      policy: {
        allowed: true,
        approvalRequired: false,
        decisionId: "policy_123",
      },
    });

    expect(result.success).toBe(false);
  });
});
