import { createRequestBody } from "./canonical.js";
import type { UnlimitedTtsConfig } from "./config.js";
import { UnlimitedTtsError } from "./errors.js";
import type {
  JsonObject,
  PaymentRequired,
  PaymentRequirement,
  SynthesisRequest,
  VoiceCatalog,
} from "./types.js";
import {
  parsePaymentRequired,
  parseSettlementReceipt,
  selectExactRequirement,
} from "./x402.js";

type Fetch = typeof globalThis.fetch;

type CachedCatalog = {
  expiresAt: number;
  value: VoiceCatalog;
};

async function readResponseBodyWithLimit(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new UnlimitedTtsError(
      "PAYMENT_OUTCOME_UNKNOWN",
      "The settled audio response did not contain a readable body. Do not authorize another payment.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - totalBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnlimitedTtsError(
          "OUTPUT_TOO_LARGE",
          "The settled audio exceeds the configured artifact size limit.",
          {
            details: {
              bytesAtLeast: totalBytes + value.byteLength,
              settled: true,
            },
          },
        );
      }
      if (value.byteLength > 0) {
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
  } catch (cause) {
    if (cause instanceof UnlimitedTtsError) throw cause;
    throw new UnlimitedTtsError(
      "PAYMENT_OUTCOME_UNKNOWN",
      "The settled audio response ended before it could be read. Do not authorize another payment.",
      { cause },
    );
  } finally {
    reader.releaseLock();
  }

  const audio = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function safeErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    if (
      isObject(body) &&
      isObject(body.error) &&
      typeof body.error.code === "string"
    ) {
      return body.error.code;
    }
  } catch {
    // Deliberately ignore untrusted/non-JSON upstream error bodies.
  }
  return null;
}

export type LiveQuote = {
  body: string;
  paymentRequired: string;
  challenge: PaymentRequired;
  selectedRequirement: PaymentRequirement;
};

export type PaidSynthesisResponse = {
  audio: Uint8Array;
  settlement: JsonObject;
  traceId: string | null;
};

export class UnlimitedTtsApiClient {
  readonly #config: UnlimitedTtsConfig;
  readonly #fetch: Fetch;
  #catalog: CachedCatalog | null = null;

  constructor(config: UnlimitedTtsConfig, fetchImpl: Fetch = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async getCatalog(refresh = false): Promise<VoiceCatalog> {
    const now = Date.now();
    if (!refresh && this.#catalog && this.#catalog.expiresAt > now) {
      return this.#catalog.value;
    }
    const [voicesResponse, docsResponse] = await Promise.all([
      this.#fetchWithTimeout(
        `${this.#config.apiOrigin}/tts/voices`,
        { headers: { accept: "application/json" } },
        this.#config.discoveryTimeoutMs,
      ),
      this.#fetchWithTimeout(
        `${this.#config.apiOrigin}/docs`,
        { headers: { accept: "application/json" } },
        this.#config.discoveryTimeoutMs,
      ),
    ]);
    if (!voicesResponse.ok || !docsResponse.ok) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "Live voice or API documentation discovery failed.",
        {
          details: {
            voicesStatus: voicesResponse.status,
            docsStatus: docsResponse.status,
          },
          retryable: true,
        },
      );
    }
    const voicesPayload: unknown = await voicesResponse.json();
    const docsPayload: unknown = await docsResponse.json();
    if (
      !isObject(voicesPayload) ||
      !Array.isArray(voicesPayload.voices) ||
      !isObject(voicesPayload.pricing)
    ) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "The live voice catalog has an unsupported shape.",
      );
    }
    const voices = voicesPayload.voices
      .filter(isObject)
      .map((voice) => ({
        id: String(voice.id ?? ""),
        name: String(voice.name ?? voice.voice ?? ""),
        provider: String(voice.provider ?? ""),
        model: String(
          voice.model ??
            (isObject(voicesPayload.pricing)
              ? voicesPayload.pricing.model
              : "") ??
            "",
        ),
      }))
      .filter((voice) => voice.id.length > 0);
    if (voices.length === 0) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "The live voice catalog is empty.",
      );
    }
    const limits =
      isObject(docsPayload) && isObject(docsPayload.limits)
        ? docsPayload.limits
        : {};
    const catalog: VoiceCatalog = {
      voices,
      pricing: {
        currency: String(voicesPayload.pricing.currency ?? "USD"),
        billingUnit: String(
          voicesPayload.pricing.billingUnit ?? "character",
        ),
        ratePerCharUsd: String(
          voicesPayload.pricing.ratePerCharUsd ?? "0.000018",
        ),
      },
      limits: {
        postCharacters: Number(limits.maxTextLength ?? 4096),
        getCharacters: Number(limits.getTtsMaxTextLength ?? 1500),
        speedMin: 0.5,
        speedMax: 2,
      },
      fetchedAt: new Date().toISOString(),
    };
    this.#catalog = { value: catalog, expiresAt: now + 5 * 60_000 };
    return catalog;
  }

  async quote(request: SynthesisRequest): Promise<LiveQuote> {
    const body = createRequestBody(request);
    const response = await this.#fetchWithTimeout(
      `${this.#config.apiOrigin}/x402/tts`,
      {
        method: "POST",
        headers: {
          accept: "application/json, audio/mpeg",
          "content-type": "application/json",
        },
        body,
      },
      this.#config.discoveryTimeoutMs,
    );
    if (response.status !== 402) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "UnlimitedTTS did not return the expected unpaid x402 challenge.",
        {
          details: { status: response.status },
          retryable: response.status >= 500,
        },
      );
    }
    const paymentRequired = response.headers.get("payment-required");
    if (!paymentRequired) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "The x402 challenge omitted PAYMENT-REQUIRED.",
      );
    }
    const challenge = parsePaymentRequired(paymentRequired);
    const selectedRequirement = selectExactRequirement(challenge, {
      origin: this.#config.apiOrigin,
      allowedNetworks: this.#config.allowedNetworks,
      allowedAssets: this.#config.allowedAssets,
      allowedPayees: this.#config.allowedPayees,
    });
    return { body, paymentRequired, challenge, selectedRequirement };
  }

  async synthesizePaid(
    body: string,
    paymentSignature: string,
  ): Promise<PaidSynthesisResponse> {
    let response: Response;
    try {
      response = await this.#fetchWithTimeout(
        `${this.#config.apiOrigin}/x402/tts`,
        {
          method: "POST",
          headers: {
            accept: "audio/mpeg",
            "content-type": "application/json",
            "payment-signature": paymentSignature,
          },
          body,
        },
        this.#config.synthesisTimeoutMs,
      );
    } catch (cause) {
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "The paid request ended without a conclusive HTTP response. Do not authorize another payment.",
        { cause },
      );
    }
    if (response.status === 429) {
      throw new UnlimitedTtsError(
        "RATE_LIMITED",
        "UnlimitedTTS rate-limited the paid request.",
        {
          details: {
            retryAfter: response.headers.get("retry-after"),
          },
          retryable: true,
        },
      );
    }
    if ([400, 401, 402, 403].includes(response.status)) {
      const code = await safeErrorCode(response);
      throw new UnlimitedTtsError(
        code === "INSUFFICIENT_FUNDS"
          ? "INSUFFICIENT_FUNDS"
          : "PAYMENT_REJECTED",
        "UnlimitedTTS rejected the payment authorization without synthesis.",
        { details: { status: response.status, upstreamCode: code } },
      );
    }
    if (response.status >= 500) {
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "The paid endpoint failed after receiving the payment authorization. Settlement is unknown; do not authorize another payment.",
        {
          details: { status: response.status },
        },
      );
    }
    if (!response.ok) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "UnlimitedTTS returned an error and no settlement receipt.",
        {
          details: {
            status: response.status,
            upstreamCode: await safeErrorCode(response),
          },
          retryable: false,
        },
      );
    }
    const paymentResponse = response.headers.get("payment-response");
    if (!paymentResponse) {
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "The audio response omitted PAYMENT-RESPONSE. Do not authorize another payment.",
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("audio/mpeg")) {
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "The settled response did not contain MPEG audio. Do not authorize another payment.",
      );
    }
    const contentLength = response.headers.get("content-length");
    const declaredLength =
      contentLength !== null && /^[0-9]+$/.test(contentLength)
        ? Number(contentLength)
        : null;
    if (
      declaredLength !== null &&
      Number.isSafeInteger(declaredLength) &&
      declaredLength > this.#config.maximumAudioBytes
    ) {
      throw new UnlimitedTtsError(
        "OUTPUT_TOO_LARGE",
        "The settled audio exceeds the configured artifact size limit.",
        { details: { declaredLength, settled: true } },
      );
    }
    const audio = await readResponseBodyWithLimit(
      response,
      this.#config.maximumAudioBytes,
    );
    let settlement: JsonObject;
    try {
      settlement = parseSettlementReceipt(paymentResponse);
    } catch (cause) {
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "PAYMENT-RESPONSE could not be verified. Do not authorize another payment.",
        { cause },
      );
    }
    return {
      audio,
      settlement,
      traceId: response.headers.get("x-trace-id"),
    };
  }

  async #fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal });
    } catch (cause) {
      throw new UnlimitedTtsError(
        "TTS_UPSTREAM_ERROR",
        "UnlimitedTTS could not be reached.",
        { cause, retryable: true },
      );
    }
  }
}
