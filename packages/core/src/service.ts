import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import { UnlimitedTtsApiClient } from "./api-client.js";
import { ArtifactStore } from "./artifact-store.js";
import { createRequestBody, sha256 } from "./canonical.js";
import type { UnlimitedTtsConfig } from "./config.js";
import { countBillableCharacters, formatUsdc } from "./decimal.js";
import { UnlimitedTtsError } from "./errors.js";
import { SpendPolicyLedger } from "./policy-ledger.js";
import { createQuoteToken, verifyQuoteToken } from "./quote-token.js";
import type {
  QuoteResult,
  SanitizedReceipt,
  SynthesisOutput,
  SynthesisRequest,
  VoiceCatalog,
  X402SignerAdapter,
} from "./types.js";
import {
  settlementTransaction,
  validatePaymentSignature,
} from "./x402.js";

const VOICE_ID_PATTERN = /^[a-z0-9]+_[a-z0-9-]+$/;

export type QuoteInput = {
  text: string;
  voice: string;
  speed?: number | undefined;
  maxUsdc?: string | undefined;
};

export type SynthesizeInput = {
  quoteToken: string;
  text: string;
  voice: string;
  speed?: number | undefined;
  paymentSignature?: string | undefined;
  output?: "auto" | "inline" | "file" | undefined;
};

export type CompletedSynthesis = {
  output: SynthesisOutput;
  audio: Uint8Array;
  artifactId: string;
  receiptId: string;
  includeInlineAudio: boolean;
};

export type ServiceOptions = {
  apiClient?: UnlimitedTtsApiClient;
  artifactStore?: ArtifactStore;
  ledger?: SpendPolicyLedger;
  signer?: X402SignerAdapter;
};

export class UnlimitedTtsService {
  readonly #config: UnlimitedTtsConfig;
  readonly #api: UnlimitedTtsApiClient;
  readonly #artifacts: ArtifactStore;
  readonly #ledger: SpendPolicyLedger;
  readonly #signer: X402SignerAdapter | undefined;
  readonly #quoteCache = new Map<
    string,
    { expiresAtMs: number; result: QuoteResult }
  >();
  #initialized = false;

  constructor(config: UnlimitedTtsConfig, options: ServiceOptions = {}) {
    this.#config = config;
    this.#api = options.apiClient ?? new UnlimitedTtsApiClient(config);
    this.#artifacts =
      options.artifactStore ??
      new ArtifactStore(config.outputRoot, config.maximumAudioBytes);
    this.#ledger =
      options.ledger ??
      new SpendPolicyLedger(
        join(config.outputRoot, ".spend-ledger.json"),
        config,
      );
    this.#signer = options.signer;
  }

  get artifactStore(): ArtifactStore {
    return this.#artifacts;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#artifacts.initialize();
    await this.#ledger.initialize();
    this.#initialized = true;
  }

  async listVoices(refresh = false): Promise<VoiceCatalog> {
    await this.initialize();
    return this.#api.getCatalog(refresh);
  }

  async quote(input: QuoteInput): Promise<QuoteResult> {
    await this.initialize();
    const request = await this.#validateRequest(input);
    const characters = countBillableCharacters(request.text);
    const requestBody = createRequestBody(request);
    const cacheKey = `${sha256(requestBody)}:${input.maxUsdc ?? ""}`;
    const cached = this.#quoteCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return structuredClone(cached.result);
    }
    for (const [key, entry] of this.#quoteCache) {
      if (entry.expiresAtMs <= Date.now()) this.#quoteCache.delete(key);
    }
    const live = await this.#api.quote(request);
    const quoteId = `q_${randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date();
    const ttlSeconds = Math.max(
      1,
      Math.min(
        this.#config.quoteTtlSeconds,
        live.selectedRequirement.maxTimeoutSeconds,
      ) - 1,
    );
    const expiresAt = new Date(
      createdAt.getTime() + ttlSeconds * 1_000,
    ).toISOString();
    const bodySha256 = sha256(live.body);

    this.#ledger.validateRequirement({
      origin: this.#config.apiOrigin,
      characters,
      requirement: live.selectedRequirement,
      callerMaxUsdc: input.maxUsdc,
    });
    const decision = await this.#ledger.reserve({
      quoteId,
      amountAtomic: live.selectedRequirement.amount,
      requestSha256: bodySha256,
      expiresAt,
      now: createdAt,
    });
    const quoteToken = createQuoteToken(
      {
        version: 1,
        quoteId,
        createdAt: createdAt.toISOString(),
        expiresAt,
        origin: this.#config.apiOrigin,
        method: "POST",
        url: `${this.#config.apiOrigin}/x402/tts`,
        bodySha256,
        characters,
        policyDecisionId: decision.decisionId,
        selectedRequirement: live.selectedRequirement,
        paymentRequired: live.paymentRequired,
      },
      this.#config.quoteTokenSecret,
    );
    const result: QuoteResult = {
      quoteId,
      quoteToken,
      characters,
      amount: {
        atomic: live.selectedRequirement.amount,
        decimals: 6,
        display: formatUsdc(live.selectedRequirement.amount),
        symbol: "USDC",
      },
      network: live.selectedRequirement.network,
      asset: live.selectedRequirement.asset,
      payTo: live.selectedRequirement.payTo,
      expiresAt,
      paymentRequired: live.paymentRequired,
      selectedRequirement: live.selectedRequirement,
      policy: decision,
    };
    this.#quoteCache.set(cacheKey, {
      expiresAtMs: Date.parse(expiresAt),
      result,
    });
    return structuredClone(result);
  }

  async synthesize(input: SynthesizeInput): Promise<CompletedSynthesis> {
    await this.initialize();
    const request = await this.#validateRequest(input);
    const body = createRequestBody(request);
    const bodySha256 = sha256(body);
    const token = verifyQuoteToken(
      input.quoteToken,
      this.#config.quoteTokenSecret,
    );
    if (
      token.origin !== this.#config.apiOrigin ||
      token.url !== `${this.#config.apiOrigin}/x402/tts` ||
      token.method !== "POST" ||
      token.bodySha256 !== bodySha256 ||
      token.characters !== countBillableCharacters(request.text)
    ) {
      throw new UnlimitedTtsError(
        "PAYMENT_REJECTED",
        "The synthesis request does not match the signed quote token.",
        { details: { quoteId: token.quoteId } },
      );
    }
    this.#ledger.validateRequirement({
      origin: token.origin,
      characters: token.characters,
      requirement: token.selectedRequirement,
    });

    let paymentSignature = input.paymentSignature;
    let payer: string | null = null;
    if (paymentSignature === undefined) {
      if (!this.#signer) {
        throw new UnlimitedTtsError(
          "CONFIGURATION_ERROR",
          "External-signature mode requires paymentSignature from a wallet tool.",
        );
      }
      const signed = await this.#signer.signExactPayment({
        paymentRequired: JSON.parse(
          Buffer.from(token.paymentRequired, "base64").toString("utf8"),
        ) as unknown,
        selectedRequirement: token.selectedRequirement,
        request: {
          method: token.method,
          url: token.url,
          bodySha256: token.bodySha256,
        },
        policyDecisionId: token.policyDecisionId,
      });
      paymentSignature = signed.paymentSignature;
      payer = signed.payerAddress;
    }
    const validated = validatePaymentSignature(
      paymentSignature,
      token.selectedRequirement,
    );
    if (
      payer !== null &&
      validated.payer !== null &&
      payer.toLowerCase() !== validated.payer.toLowerCase()
    ) {
      throw new UnlimitedTtsError(
        "PAYMENT_REJECTED",
        "The signer-reported payer does not match the signed authorization.",
      );
    }
    payer = validated.payer;

    await this.#ledger.beginSynthesis(token.quoteId, bodySha256);
    let paid;
    try {
      paid = await this.#api.synthesizePaid(body, paymentSignature);
    } catch (error) {
      if (
        error instanceof UnlimitedTtsError &&
        (error.code === "PAYMENT_OUTCOME_UNKNOWN" ||
          error.details.settled === true)
      ) {
        await this.#ledger.markUnknown(token.quoteId);
        this.#evictCachedQuote(token.quoteId);
        throw new UnlimitedTtsError(error.code, error.message, {
          cause: error,
          retryable: false,
          details: {
            ...error.details,
            quoteId: token.quoteId,
            payer,
            amountAtomic: token.selectedRequirement.amount,
            requestSha256: bodySha256,
          },
        });
      }
      await this.#ledger.restoreReservation(token.quoteId);
      throw error;
    }

    const transaction = settlementTransaction(paid.settlement);
    const receiptNetwork = paid.settlement.network;
    const receiptPayer = paid.settlement.payer;
    if (
      paid.settlement.success !== true ||
      transaction === null ||
      receiptNetwork !== token.selectedRequirement.network ||
      typeof receiptPayer !== "string" ||
      receiptPayer.toLowerCase() !== payer?.toLowerCase()
    ) {
      await this.#ledger.markUnknown(token.quoteId);
      this.#evictCachedQuote(token.quoteId);
      throw new UnlimitedTtsError(
        "PAYMENT_OUTCOME_UNKNOWN",
        "PAYMENT-RESPONSE did not conclusively match the quoted settlement. Do not authorize another payment.",
        {
          details: {
            quoteId: token.quoteId,
            payer,
            amountAtomic: token.selectedRequirement.amount,
            requestSha256: bodySha256,
          },
        },
      );
    }

    const receiptId = randomBytes(16).toString("hex");
    const receipt: SanitizedReceipt = {
      receiptId,
      quoteId: token.quoteId,
      requestSha256: bodySha256,
      characters: token.characters,
      voice: request.voice,
      speed: request.speed,
      amountAtomic: token.selectedRequirement.amount,
      asset: token.selectedRequirement.asset,
      network: token.selectedRequirement.network,
      payer,
      payee: token.selectedRequirement.payTo,
      transaction,
      settled: true,
      traceId: paid.traceId,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.#ledger.commit(token.quoteId, receiptId);
      this.#evictCachedQuote(token.quoteId);
      await this.#artifacts.writeReceipt(receipt);
      const artifact = await this.#artifacts.writeAudio(paid.audio);
      const output: SynthesisOutput = {
        artifact: {
          uri: artifact.uri,
          mimeType: artifact.mimeType,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          expiresAt: null,
        },
        request: {
          characters: token.characters,
          voice: request.voice,
          speed: request.speed,
        },
        payment: {
          receiptId,
          amountAtomic: token.selectedRequirement.amount,
          asset: token.selectedRequirement.asset,
          symbol: "USDC",
          network: token.selectedRequirement.network,
          payer,
          payee: token.selectedRequirement.payTo,
          transaction,
          settled: true,
        },
        traceId: paid.traceId,
      };
      return {
        output,
        audio: paid.audio,
        artifactId: artifact.id,
        receiptId,
        includeInlineAudio:
          input.output !== "file" &&
          paid.audio.byteLength <= this.#config.inlineAudioMaxBytes,
      };
    } catch (cause) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "Payment settled, but the local receipt or audio artifact could not be saved. Do not pay again.",
        {
          cause,
          details: {
            settled: true,
            quoteId: token.quoteId,
            receiptId,
            transaction,
          },
        },
      );
    }
  }

  #evictCachedQuote(quoteId: string): void {
    for (const [key, entry] of this.#quoteCache) {
      if (entry.result.quoteId === quoteId) {
        this.#quoteCache.delete(key);
      }
    }
  }

  async #validateRequest(input: {
    text: string;
    voice: string;
    speed?: number | undefined;
  }): Promise<SynthesisRequest> {
    const characters = countBillableCharacters(input.text);
    if (characters === 0 || characters > this.#config.maxCharactersPerCall) {
      throw new UnlimitedTtsError(
        "INVALID_TEXT",
        `Text must contain 1–${this.#config.maxCharactersPerCall} UTF-16 code units.`,
        { details: { characters } },
      );
    }
    if (!VOICE_ID_PATTERN.test(input.voice)) {
      throw new UnlimitedTtsError(
        "INVALID_VOICE",
        "Voice must use a provider-prefixed id such as openai_nova.",
      );
    }
    const speed = input.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      throw new UnlimitedTtsError(
        "INVALID_SPEED",
        "Speed must be between 0.5 and 2.",
      );
    }
    const catalog = await this.#api.getCatalog();
    if (!catalog.voices.some((voice) => voice.id === input.voice)) {
      throw new UnlimitedTtsError(
        "INVALID_VOICE",
        "Voice is not present in the live catalog. Call tts_list_voices.",
        { details: { voice: input.voice } },
      );
    }
    if (characters > catalog.limits.postCharacters) {
      throw new UnlimitedTtsError(
        "INVALID_TEXT",
        `Text exceeds the live ${catalog.limits.postCharacters}-character POST limit.`,
      );
    }
    return { text: input.text, voice: input.voice, speed };
  }
}
