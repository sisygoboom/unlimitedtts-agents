import { stableJson } from "./canonical.js";
import { UnlimitedTtsError } from "./errors.js";
import type {
  JsonObject,
  PaymentRequired,
  PaymentRequirement,
} from "./types.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeBase64Json(
  encoded: string,
  label: string,
  maximumBytes = 65_536,
): JsonObject {
  const compact = encoded.trim();
  if (
    compact.length === 0 ||
    compact.length > maximumBytes * 2 ||
    compact.length % 4 !== 0 ||
    !BASE64_PATTERN.test(compact)
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      `${label} is not valid base64.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(compact, "base64");
  } catch (cause) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      `${label} could not be decoded.`,
      { cause },
    );
  }
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      `${label} has an invalid decoded size.`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(parsed)) throw new Error("Expected a JSON object");
    return parsed;
  } catch (cause) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      `${label} is not a valid JSON object.`,
      { cause },
    );
  }
}

export function parsePaymentRequired(encoded: string): PaymentRequired {
  const parsed = decodeBase64Json(encoded, "PAYMENT-REQUIRED");
  if (parsed.x402Version !== 2 || !Array.isArray(parsed.accepts)) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The API returned an unsupported x402 challenge.",
    );
  }
  const accepts = parsed.accepts.filter(isObject) as PaymentRequirement[];
  if (accepts.length === 0) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The x402 challenge did not contain a payment requirement.",
    );
  }
  return { ...parsed, x402Version: 2, accepts } as PaymentRequired;
}

export function selectExactRequirement(
  challenge: PaymentRequired,
  input: {
    origin: string;
    allowedNetworks: string[];
    allowedAssets: string[];
    allowedPayees: string[];
  },
): PaymentRequirement {
  if (
    !isObject(challenge.resource) ||
    typeof challenge.resource.url !== "string"
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The x402 challenge is missing its resource URL.",
    );
  }
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(challenge.resource.url);
  } catch {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The x402 challenge resource URL is invalid.",
    );
  }
  if (
    resourceUrl.origin !== input.origin ||
    resourceUrl.pathname !== "/x402/tts" ||
    resourceUrl.search ||
    resourceUrl.hash ||
    resourceUrl.username ||
    resourceUrl.password
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The x402 challenge is bound to an unexpected resource.",
    );
  }

  const selected = challenge.accepts.find((candidate) => {
    return (
      candidate.scheme === "exact" &&
      typeof candidate.network === "string" &&
      input.allowedNetworks.includes(candidate.network) &&
      typeof candidate.asset === "string" &&
      input.allowedAssets.some(
        (asset) => asset.toLowerCase() === candidate.asset.toLowerCase(),
      ) &&
      typeof candidate.payTo === "string" &&
      input.allowedPayees.some(
        (payee) => payee.toLowerCase() === candidate.payTo.toLowerCase(),
      )
    );
  });

  if (!selected) {
    throw new UnlimitedTtsError(
      "UNSUPPORTED_NETWORK",
      "No x402 requirement matched the configured network, asset, and payee policy.",
    );
  }
  if (
    typeof selected.amount !== "string" ||
    !/^[0-9]+$/.test(selected.amount) ||
    BigInt(selected.amount) <= 0n ||
    typeof selected.maxTimeoutSeconds !== "number" ||
    !Number.isSafeInteger(selected.maxTimeoutSeconds) ||
    selected.maxTimeoutSeconds <= 0
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The selected x402 requirement has invalid amount or expiry data.",
    );
  }
  return selected;
}

export type ValidatedPaymentSignature = {
  payer: string | null;
  decoded: JsonObject;
};

export function validatePaymentSignature(
  encoded: string,
  selected: PaymentRequirement,
): ValidatedPaymentSignature {
  const decoded = decodeBase64Json(encoded, "PAYMENT-SIGNATURE");
  if (decoded.x402Version !== 2 || !isObject(decoded.accepted)) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "PAYMENT-SIGNATURE must be an x402 v2 PaymentPayload with accepted.",
    );
  }
  if (stableJson(decoded.accepted) !== stableJson(selected)) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "PAYMENT-SIGNATURE is not bound to the selected quote requirement.",
    );
  }
  if (!isObject(decoded.payload)) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "PAYMENT-SIGNATURE is missing its exact-EVM payload.",
    );
  }
  const signature = decoded.payload.signature;
  const authorization = decoded.payload.authorization;
  if (
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
    !isObject(authorization)
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "PAYMENT-SIGNATURE has an invalid exact-EVM authorization.",
    );
  }
  if (
    typeof authorization.to !== "string" ||
    authorization.to.toLowerCase() !== selected.payTo.toLowerCase() ||
    typeof authorization.from !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(authorization.from) ||
    typeof authorization.value !== "string" ||
    authorization.value !== selected.amount ||
    typeof authorization.validAfter !== "string" ||
    !/^[0-9]+$/.test(authorization.validAfter) ||
    typeof authorization.validBefore !== "string" ||
    !/^[0-9]+$/.test(authorization.validBefore) ||
    typeof authorization.nonce !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)
  ) {
    throw new UnlimitedTtsError(
      "PAYMENT_REJECTED",
      "The exact-EVM authorization does not match the quoted payee and amount.",
    );
  }
  const payer = authorization.from;
  return { payer, decoded };
}

export function parseSettlementReceipt(encoded: string): JsonObject {
  return decodeBase64Json(encoded, "PAYMENT-RESPONSE");
}

export function settlementTransaction(receipt: JsonObject): string | null {
  for (const key of ["transaction", "transactionHash", "txHash"]) {
    if (typeof receipt[key] === "string") return receipt[key];
  }
  return null;
}
