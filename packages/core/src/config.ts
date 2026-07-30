import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { parseUsdc } from "./decimal.js";
import { UnlimitedTtsError } from "./errors.js";

export const DEFAULT_API_ORIGIN = "https://api.unlimitedtts.com";
export const DEFAULT_NETWORK = "eip155:8453";
export const DEFAULT_USDC_ASSET =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DEFAULT_PAYEE =
  "0x88E7960011C59BeE0088650CA52d7519B00381C8";
export const STAGING_API_ORIGIN = "https://staging-api.unlimitedtts.com";
export const STAGING_NETWORK = "eip155:84532";
export const STAGING_USDC_ASSET =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const STAGING_PAYEE =
  "0x88E7960011C59BeE0088650CA52d7519B00381C8";

export type UnlimitedTtsEnvironment = "production" | "staging";

export type ApprovalPolicy =
  | "every-payment"
  | "first-payment-and-over-threshold"
  | "never";

export type UnlimitedTtsConfig = {
  environment: UnlimitedTtsEnvironment;
  apiOrigin: string;
  allowedOrigins: string[];
  allowedNetworks: string[];
  allowedAssets: string[];
  allowedPayees: string[];
  maxUsdcPerCallAtomic: bigint;
  rolling24hUsdcAtomic: bigint;
  maxCharactersPerCall: number;
  maxPriceIncreaseBps: number;
  requireApproval: ApprovalPolicy;
  approvalThresholdUsdcAtomic: bigint;
  quoteTtlSeconds: number;
  quoteTokenSecret: Uint8Array;
  outputRoot: string;
  inlineAudioMaxBytes: number;
  maximumAudioBytes: number;
  discoveryTimeoutMs: number;
  synthesisTimeoutMs: number;
};

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      `${name} must be a positive integer.`,
    );
  }
  return parsed;
}

function quoteSecret(value: string | undefined): Uint8Array {
  if (!value) return randomBytes(32);
  return createHash("sha256").update(value, "utf8").digest();
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "UNLIMITEDTTS_API_ORIGIN must be an absolute URL.",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "UNLIMITEDTTS_API_ORIGIN must contain only a scheme and host.",
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "UNLIMITEDTTS_API_ORIGIN must use HTTPS.",
    );
  }
  return url.origin;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): UnlimitedTtsConfig {
  const environment = env.UNLIMITEDTTS_ENVIRONMENT ?? "production";
  if (environment !== "production" && environment !== "staging") {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "UNLIMITEDTTS_ENVIRONMENT must be production or staging.",
    );
  }
  const preset =
    environment === "staging"
      ? {
          origin: STAGING_API_ORIGIN,
          network: STAGING_NETWORK,
          asset: STAGING_USDC_ASSET,
          payee: STAGING_PAYEE,
        }
      : {
          origin: DEFAULT_API_ORIGIN,
          network: DEFAULT_NETWORK,
          asset: DEFAULT_USDC_ASSET,
          payee: DEFAULT_PAYEE,
        };
  const apiOrigin = parseOrigin(
    env.UNLIMITEDTTS_API_ORIGIN ?? preset.origin,
  );
  if (apiOrigin === STAGING_API_ORIGIN && environment !== "staging") {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "The staging API requires UNLIMITEDTTS_ENVIRONMENT=staging.",
    );
  }
  if (environment === "staging" && apiOrigin !== STAGING_API_ORIGIN) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "The staging environment is restricted to the staging API origin.",
    );
  }
  const allowedNetworks = splitCsv(env.UNLIMITEDTTS_ALLOWED_NETWORKS, [
    preset.network,
  ]);
  const allowedAssets = splitCsv(env.UNLIMITEDTTS_ALLOWED_ASSETS, [
    preset.asset,
  ]);
  if (
    allowedNetworks.includes(STAGING_NETWORK) &&
    environment !== "staging"
  ) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "Base Sepolia is allowed only in the staging environment.",
    );
  }
  if (
    allowedAssets.some(
      (asset) => asset.toLowerCase() === STAGING_USDC_ASSET.toLowerCase(),
    ) &&
    environment !== "staging"
  ) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "The Base Sepolia USDC asset is allowed only in the staging environment.",
    );
  }
  const requireApproval =
    env.UNLIMITEDTTS_REQUIRE_APPROVAL ??
    "first-payment-and-over-threshold";
  if (
    requireApproval !== "every-payment" &&
    requireApproval !== "first-payment-and-over-threshold" &&
    requireApproval !== "never"
  ) {
    throw new UnlimitedTtsError(
      "CONFIGURATION_ERROR",
      "UNLIMITEDTTS_REQUIRE_APPROVAL has an unsupported value.",
    );
  }

  return {
    environment,
    apiOrigin,
    allowedOrigins: [apiOrigin],
    allowedNetworks,
    allowedAssets,
    allowedPayees: splitCsv(env.UNLIMITEDTTS_ALLOWED_PAYEES, [preset.payee]),
    maxUsdcPerCallAtomic: parseUsdc(
      env.UNLIMITEDTTS_MAX_USDC_PER_CALL ?? "0.10",
    ),
    rolling24hUsdcAtomic: parseUsdc(
      env.UNLIMITEDTTS_ROLLING_24H_USDC ?? "1.00",
    ),
    maxCharactersPerCall: parsePositiveInteger(
      "UNLIMITEDTTS_MAX_CHARACTERS_PER_CALL",
      env.UNLIMITEDTTS_MAX_CHARACTERS_PER_CALL,
      4096,
    ),
    maxPriceIncreaseBps: parsePositiveInteger(
      "UNLIMITEDTTS_MAX_PRICE_INCREASE_BPS",
      env.UNLIMITEDTTS_MAX_PRICE_INCREASE_BPS,
      100,
    ),
    requireApproval,
    approvalThresholdUsdcAtomic: parseUsdc(
      env.UNLIMITEDTTS_APPROVAL_THRESHOLD_USDC ?? "0.05",
    ),
    quoteTtlSeconds: Math.min(
      parsePositiveInteger(
        "UNLIMITEDTTS_QUOTE_TTL_SECONDS",
        env.UNLIMITEDTTS_QUOTE_TTL_SECONDS,
        90,
      ),
      90,
    ),
    quoteTokenSecret: quoteSecret(env.UNLIMITEDTTS_QUOTE_TOKEN_SECRET),
    outputRoot: resolve(
      env.UNLIMITEDTTS_OUTPUT_DIRECTORY ??
        resolve(process.cwd(), ".unlimitedtts-artifacts"),
    ),
    inlineAudioMaxBytes: parsePositiveInteger(
      "UNLIMITEDTTS_INLINE_AUDIO_MAX_BYTES",
      env.UNLIMITEDTTS_INLINE_AUDIO_MAX_BYTES,
      1_048_576,
    ),
    maximumAudioBytes: parsePositiveInteger(
      "UNLIMITEDTTS_MAXIMUM_AUDIO_BYTES",
      env.UNLIMITEDTTS_MAXIMUM_AUDIO_BYTES,
      16_777_216,
    ),
    discoveryTimeoutMs: parsePositiveInteger(
      "UNLIMITEDTTS_DISCOVERY_TIMEOUT_MS",
      env.UNLIMITEDTTS_DISCOVERY_TIMEOUT_MS,
      15_000,
    ),
    synthesisTimeoutMs: parsePositiveInteger(
      "UNLIMITEDTTS_SYNTHESIS_TIMEOUT_MS",
      env.UNLIMITEDTTS_SYNTHESIS_TIMEOUT_MS,
      120_000,
    ),
  };
}
