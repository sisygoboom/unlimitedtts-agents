import { UnlimitedTtsError } from "./errors.js";

const DECIMAL_PATTERN = /^[0-9]+(?:\.[0-9]{1,6})?$/;

export function parseUsdc(value: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      `Invalid USDC decimal value: ${value}`,
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdc(atomic: bigint | string): string {
  const value = typeof atomic === "string" ? BigInt(atomic) : atomic;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function countBillableCharacters(text: string): number {
  // The live UnlimitedTTS service bills JavaScript/UTF-16 code units.
  return text.length;
}

