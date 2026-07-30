import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { UnlimitedTtsError } from "./errors.js";
import type { QuoteTokenPayload } from "./types.js";

function sign(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createQuoteToken(
  payload: QuoteTokenPayload,
  secret: Uint8Array,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${sign(encoded, secret).toString("base64url")}`;
}

export function verifyQuoteToken(
  token: string,
  secret: Uint8Array,
  now = new Date(),
): QuoteTokenPayload {
  if (token.length < 16 || token.length > 65_536) {
    throw new UnlimitedTtsError("QUOTE_EXPIRED", "The quote token is invalid.");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnlimitedTtsError("QUOTE_EXPIRED", "The quote token is invalid.");
  }
  const expected = sign(parts[0], secret);
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
  } catch {
    throw new UnlimitedTtsError("QUOTE_EXPIRED", "The quote token is invalid.");
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new UnlimitedTtsError(
      "QUOTE_EXPIRED",
      "The quote token failed integrity verification.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new UnlimitedTtsError("QUOTE_EXPIRED", "The quote token is invalid.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    (payload as { version?: unknown }).version !== 1 ||
    typeof (payload as { expiresAt?: unknown }).expiresAt !== "string"
  ) {
    throw new UnlimitedTtsError("QUOTE_EXPIRED", "The quote token is invalid.");
  }
  const typed = payload as QuoteTokenPayload;
  if (
    !Number.isFinite(Date.parse(typed.expiresAt)) ||
    Date.parse(typed.expiresAt) <= now.getTime()
  ) {
    throw new UnlimitedTtsError(
      "QUOTE_EXPIRED",
      "The quote has expired. Obtain a fresh quote before signing.",
      { details: { quoteId: typed.quoteId } },
    );
  }
  return typed;
}

