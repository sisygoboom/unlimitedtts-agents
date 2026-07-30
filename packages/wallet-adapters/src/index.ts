export type { X402SignerAdapter } from "@unlimitedtts/core";

export const externalSignatureMode = {
  id: "external",
  description:
    "A separate wallet tool signs the exact selected x402 requirement; this package never receives a private key.",
} as const;

