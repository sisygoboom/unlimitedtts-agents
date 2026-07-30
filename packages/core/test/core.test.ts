import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_API_ORIGIN,
  DEFAULT_NETWORK,
  DEFAULT_PAYEE,
  DEFAULT_USDC_ASSET,
  STAGING_API_ORIGIN,
  STAGING_NETWORK,
  STAGING_PAYEE,
  STAGING_USDC_ASSET,
  SpendPolicyLedger,
  UnlimitedTtsApiClient,
  UnlimitedTtsError,
  UnlimitedTtsService,
  configFromEnv,
  countBillableCharacters,
  createQuoteToken,
  createRequestBody,
  formatUsdc,
  parseUsdc,
  parsePaymentRequired,
  selectExactRequirement,
  sha256,
  validatePaymentSignature,
  verifyQuoteToken,
  type LiveQuote,
  type PaidSynthesisResponse,
  type SynthesisRequest,
  type UnlimitedTtsConfig,
  type VoiceCatalog,
} from "../src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function testConfig(
  overrides: Partial<UnlimitedTtsConfig> = {},
): Promise<UnlimitedTtsConfig> {
  const outputRoot = await mkdtemp(join(tmpdir(), "unlimitedtts-test-"));
  temporaryDirectories.push(outputRoot);
  return {
    ...configFromEnv({}),
    outputRoot,
    quoteTokenSecret: new Uint8Array(32).fill(7),
    ...overrides,
  };
}

const requirement = {
  scheme: "exact",
  network: DEFAULT_NETWORK,
  amount: "198",
  asset: DEFAULT_USDC_ASSET,
  payTo: DEFAULT_PAYEE,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const catalog: VoiceCatalog = {
  voices: [
    {
      id: "openai_nova",
      name: "Nova",
      provider: "openai",
      model: "tts-1",
    },
  ],
  pricing: {
    currency: "USD",
    billingUnit: "character",
    ratePerCharUsd: "0.000018",
  },
  limits: {
    postCharacters: 4096,
    getCharacters: 1500,
    speedMin: 0.5,
    speedMax: 2,
  },
  fetchedAt: new Date().toISOString(),
};

function paymentSignature(selected = requirement): string {
  return encoded({
    x402Version: 2,
    accepted: selected,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: `0x${"11".repeat(20)}`,
        to: selected.payTo,
        value: selected.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
  });
}

class FakeApiClient {
  paidCalls = 0;
  quoteCalls = 0;
  paidError: UnlimitedTtsError | null = null;

  async getCatalog(): Promise<VoiceCatalog> {
    return catalog;
  }

  async quote(request: SynthesisRequest): Promise<LiveQuote> {
    this.quoteCalls += 1;
    const body = createRequestBody(request);
    const challenge = {
      x402Version: 2,
      resource: {
        url: `${DEFAULT_API_ORIGIN}/x402/tts`,
        mimeType: "audio/mpeg",
      },
      accepts: [requirement],
    };
    return {
      body,
      paymentRequired: encoded(challenge),
      challenge,
      selectedRequirement: requirement,
    };
  }

  async synthesizePaid(
    body: string,
    signature: string,
  ): Promise<PaidSynthesisResponse> {
    this.paidCalls += 1;
    expect(JSON.parse(body)).toEqual({
      text: "Hello world",
      voice: "openai_nova",
      speed: 1,
    });
    expect(signature).toBe(paymentSignature());
    if (this.paidError) throw this.paidError;
    return {
      audio: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      settlement: {
        success: true,
        transaction: `0x${"33".repeat(32)}`,
        network: DEFAULT_NETWORK,
        payer: `0x${"11".repeat(20)}`,
      },
      traceId: "trace-test",
    };
  }
}

describe("USDC and character arithmetic", () => {
  it("never uses floating point for authorization amounts", () => {
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("1.234567")).toBe(1_234_567n);
    expect(formatUsdc(73_728n)).toBe("0.073728");
    expect(() => parseUsdc("0.0000001")).toThrow(UnlimitedTtsError);
  });

  it("matches the live API's UTF-16 billing semantics", () => {
    expect(countBillableCharacters("é")).toBe(1);
    expect(countBillableCharacters("😀")).toBe(2);
  });
});

describe("environment pins", () => {
  it("keeps Base mainnet as the production default", () => {
    const config = configFromEnv({});
    expect(config.environment).toBe("production");
    expect(config.apiOrigin).toBe(DEFAULT_API_ORIGIN);
    expect(config.allowedNetworks).toEqual([DEFAULT_NETWORK]);
    expect(config.allowedAssets).toEqual([DEFAULT_USDC_ASSET]);
    expect(config.allowedPayees).toEqual([DEFAULT_PAYEE]);
  });

  it("selects Base Sepolia only for an explicit staging environment", () => {
    const config = configFromEnv({
      UNLIMITEDTTS_ENVIRONMENT: "staging",
    });
    expect(config.environment).toBe("staging");
    expect(config.apiOrigin).toBe(STAGING_API_ORIGIN);
    expect(config.allowedNetworks).toEqual([STAGING_NETWORK]);
    expect(config.allowedAssets).toEqual([STAGING_USDC_ASSET]);
    expect(config.allowedPayees).toEqual([STAGING_PAYEE]);
  });

  it("rejects staging origin, network, or asset in production", () => {
    expect(() =>
      configFromEnv({ UNLIMITEDTTS_API_ORIGIN: STAGING_API_ORIGIN }),
    ).toThrowError(/requires UNLIMITEDTTS_ENVIRONMENT=staging/);
    expect(() =>
      configFromEnv({ UNLIMITEDTTS_ALLOWED_NETWORKS: STAGING_NETWORK }),
    ).toThrowError(/Base Sepolia is allowed only/);
    expect(() =>
      configFromEnv({ UNLIMITEDTTS_ALLOWED_ASSETS: STAGING_USDC_ASSET }),
    ).toThrowError(/Base Sepolia USDC asset is allowed only/);
  });
});

describe("x402 validation", () => {
  it("selects only the locally pinned exact requirement", () => {
    const challenge = parsePaymentRequired(
      encoded({
        x402Version: 2,
        resource: { url: `${DEFAULT_API_ORIGIN}/x402/tts` },
        accepts: [requirement],
      }),
    );
    expect(
      selectExactRequirement(challenge, {
        origin: DEFAULT_API_ORIGIN,
        allowedNetworks: [DEFAULT_NETWORK],
        allowedAssets: [DEFAULT_USDC_ASSET],
        allowedPayees: [DEFAULT_PAYEE],
      }),
    ).toEqual(requirement);
  });

  it("rejects a signature for a different payee", () => {
    const different = {
      ...requirement,
      payTo: `0x${"44".repeat(20)}`,
    };
    expect(() =>
      validatePaymentSignature(paymentSignature(different), requirement),
    ).toThrowError(/selected quote requirement/);
  });
});

describe("quote tokens", () => {
  it("binds request hashes and detects tampering", () => {
    const now = new Date();
    const token = createQuoteToken(
      {
        version: 1,
        quoteId: "q_test",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        origin: DEFAULT_API_ORIGIN,
        method: "POST",
        url: `${DEFAULT_API_ORIGIN}/x402/tts`,
        bodySha256: sha256("body"),
        characters: 4,
        policyDecisionId: "pd_test",
        selectedRequirement: requirement,
        paymentRequired: encoded({
          x402Version: 2,
          accepts: [requirement],
        }),
      },
      new Uint8Array(32).fill(7),
    );
    expect(
      verifyQuoteToken(token, new Uint8Array(32).fill(7), now).bodySha256,
    ).toBe(sha256("body"));
    const [payload, signature] = token.split(".");
    const tamperedPayload = `${payload![0] === "A" ? "B" : "A"}${payload!.slice(1)}`;
    expect(() =>
      verifyQuoteToken(
        `${tamperedPayload}.${signature}`,
        new Uint8Array(32).fill(7),
      ),
    ).toThrow(UnlimitedTtsError);
  });
});

describe("spend policy ledger", () => {
  it("reserves rolling spend atomically and persists no synthesis text", async () => {
    const config = await testConfig({ rolling24hUsdcAtomic: 300n });
    const path = join(config.outputRoot, ".ledger.json");
    const ledger = new SpendPolicyLedger(path, config);
    await ledger.initialize();
    const expiry = new Date(Date.now() + 60_000).toISOString();
    await ledger.reserve({
      quoteId: "q_one",
      amountAtomic: "198",
      requestSha256: sha256("first"),
      expiresAt: expiry,
    });
    await expect(
      ledger.reserve({
        quoteId: "q_two",
        amountAtomic: "198",
        requestSha256: sha256("second"),
        expiresAt: expiry,
      }),
    ).rejects.toMatchObject({ code: "PRICE_LIMIT_EXCEEDED" });
    expect(await readFile(path, "utf8")).not.toContain("first");
  });
});

describe("end-to-end service flow", () => {
  it("quotes, settles once, and writes private receipt and audio artifacts", async () => {
    const config = await testConfig();
    const api = new FakeApiClient();
    const service = new UnlimitedTtsService(config, {
      apiClient: api as unknown as UnlimitedTtsApiClient,
    });
    const quote = await service.quote({
      text: "Hello world",
      voice: "openai_nova",
      maxUsdc: "0.01",
    });
    expect(quote.amount.atomic).toBe("198");
    expect(quote.policy.approvalRequired).toBe(true);
    const repeatedQuote = await service.quote({
      text: "Hello world",
      voice: "openai_nova",
      maxUsdc: "0.01",
    });
    expect(repeatedQuote.quoteId).toBe(quote.quoteId);
    expect(api.quoteCalls).toBe(1);

    const result = await service.synthesize({
      quoteToken: quote.quoteToken,
      text: "Hello world",
      voice: "openai_nova",
      paymentSignature: paymentSignature(),
    });
    expect(result.output.payment.settled).toBe(true);
    expect(result.output.artifact.uri).toMatch(/^file:/);
    expect(await service.artifactStore.readAudio(result.artifactId)).toEqual(
      new Uint8Array([0x49, 0x44, 0x33, 0x04]),
    );
    const receipt = await service.artifactStore.readReceipt(result.receiptId);
    expect(receipt).not.toHaveProperty("text");
    expect(JSON.stringify(receipt)).not.toContain(paymentSignature());

    const postCommitQuote = await service.quote({
      text: "Hello world",
      voice: "openai_nova",
      maxUsdc: "0.01",
    });
    expect(postCommitQuote.quoteId).not.toBe(quote.quoteId);
    expect(api.quoteCalls).toBe(2);

    await expect(
      service.synthesize({
        quoteToken: quote.quoteToken,
        text: "Hello world",
        voice: "openai_nova",
        paymentSignature: paymentSignature(),
      }),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(api.paidCalls).toBe(1);
  });

  it("quarantines an ambiguous paid attempt and never sends it twice", async () => {
    const config = await testConfig();
    const api = new FakeApiClient();
    api.paidError = new UnlimitedTtsError(
      "PAYMENT_OUTCOME_UNKNOWN",
      "connection ended",
    );
    const service = new UnlimitedTtsService(config, {
      apiClient: api as unknown as UnlimitedTtsApiClient,
    });
    const quote = await service.quote({
      text: "Hello world",
      voice: "openai_nova",
    });
    const input = {
      quoteToken: quote.quoteToken,
      text: "Hello world",
      voice: "openai_nova",
      paymentSignature: paymentSignature(),
    };
    await expect(service.synthesize(input)).rejects.toMatchObject({
      code: "PAYMENT_OUTCOME_UNKNOWN",
    });
    await expect(service.synthesize(input)).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
    });
    expect(api.paidCalls).toBe(1);
  });
});

describe("paid HTTP ambiguity handling", () => {
  it("treats a 5xx after payment submission as non-retryable unknown", async () => {
    const config = await testConfig();
    const client = new UnlimitedTtsApiClient(
      config,
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "INTERNAL_ERROR" },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await expect(
      client.synthesizePaid("{}", paymentSignature()),
    ).rejects.toMatchObject({
      code: "PAYMENT_OUTCOME_UNKNOWN",
      retryable: false,
      details: { status: 503 },
    });
  });

  it("treats a successful audio response without a receipt as unknown", async () => {
    const config = await testConfig();
    const client = new UnlimitedTtsApiClient(
      config,
      async () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    await expect(
      client.synthesizePaid("{}", paymentSignature()),
    ).rejects.toMatchObject({ code: "PAYMENT_OUTCOME_UNKNOWN" });
  });

  it("marks an oversized response as already settled", async () => {
    const config = await testConfig({ maximumAudioBytes: 2 });
    const client = new UnlimitedTtsApiClient(
      config,
      async () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-length": "3",
            "payment-response": encoded({ success: true }),
          },
        }),
    );
    await expect(
      client.synthesizePaid("{}", paymentSignature()),
    ).rejects.toMatchObject({
      code: "OUTPUT_TOO_LARGE",
      details: { settled: true },
    });
  });

  it("stops reading a chunked response at the configured byte limit", async () => {
    const config = await testConfig({ maximumAudioBytes: 3 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x49, 0x44]));
        controller.enqueue(new Uint8Array([0x33, 0x04]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new UnlimitedTtsApiClient(
      config,
      async () =>
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "payment-response": encoded({ success: true }),
          },
        }),
    );
    await expect(
      client.synthesizePaid("{}", paymentSignature()),
    ).rejects.toMatchObject({
      code: "OUTPUT_TOO_LARGE",
      details: { bytesAtLeast: 4, settled: true },
    });
    expect(cancelled).toBe(true);
  });

  it("treats a malformed settlement receipt as unknown", async () => {
    const config = await testConfig();
    const client = new UnlimitedTtsApiClient(
      config,
      async () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "payment-response": "not-base64",
          },
        }),
    );
    await expect(
      client.synthesizePaid("{}", paymentSignature()),
    ).rejects.toMatchObject({ code: "PAYMENT_OUTCOME_UNKNOWN" });
  });
});
