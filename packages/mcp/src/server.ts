import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  UnlimitedTtsError,
  UnlimitedTtsService,
  configFromEnv,
  type UnlimitedTtsConfig,
} from "@unlimitedtts/core";
import { z } from "zod";

const quoteInputSchema = z
  .object({
    text: z.string().min(1).max(4096),
    voice: z.string().regex(/^[a-z0-9]+_[a-z0-9-]+$/),
    speed: z.number().min(0.5).max(2).default(1),
    maxUsdc: z
      .string()
      .regex(/^[0-9]+(?:\.[0-9]{1,6})?$/)
      .optional(),
  })
  .strict();

const synthesizeInputSchema = z
  .object({
    quoteToken: z.string().min(16).max(65_536),
    text: z.string().min(1).max(4096),
    voice: z.string().regex(/^[a-z0-9]+_[a-z0-9-]+$/),
    speed: z.number().min(0.5).max(2).default(1),
    paymentSignature: z.string().min(16).max(131_072).optional(),
    output: z.enum(["auto", "inline", "file"]).default("auto"),
  })
  .strict();

const voiceCatalogSchema = z.object({
  voices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      model: z.string(),
    }),
  ),
  pricing: z.object({
    currency: z.string(),
    billingUnit: z.string(),
    ratePerCharUsd: z.string(),
  }),
  limits: z.object({
    postCharacters: z.number(),
    getCharacters: z.number(),
    speedMin: z.number(),
    speedMax: z.number(),
  }),
  fetchedAt: z.string(),
});

const quoteOutputSchema = z.object({
  quoteId: z.string(),
  quoteToken: z.string(),
  characters: z.number(),
  amount: z.object({
    atomic: z.string(),
    decimals: z.literal(6),
    display: z.string(),
    symbol: z.literal("USDC"),
  }),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  expiresAt: z.string(),
  paymentRequired: z.string(),
  selectedRequirement: z.record(z.string(), z.unknown()),
  policy: z.object({
    allowed: z.literal(true),
    approvalRequired: z.boolean(),
    decisionId: z.string(),
  }),
});

const synthesisOutputSchema = z.object({
  artifact: z.object({
    uri: z.string(),
    mimeType: z.literal("audio/mpeg"),
    bytes: z.number(),
    sha256: z.string(),
    expiresAt: z.null(),
  }),
  request: z.object({
    characters: z.number(),
    voice: z.string(),
    speed: z.number(),
  }),
  payment: z.object({
    receiptId: z.string(),
    amountAtomic: z.string(),
    asset: z.string(),
    symbol: z.literal("USDC"),
    network: z.string(),
    payer: z.string().nullable(),
    payee: z.string(),
    transaction: z.string().nullable(),
    settled: z.literal(true),
  }),
  traceId: z.string().nullable(),
});

function toolError(error: unknown): CallToolResult {
  const safe =
    error instanceof UnlimitedTtsError
      ? error.toSafeObject()
      : new UnlimitedTtsError(
          "TTS_UPSTREAM_ERROR",
          "UnlimitedTTS could not complete the tool call.",
          { cause: error },
        ).toSafeObject();
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: safe }) }],
  };
}

export type CreateUnlimitedTtsMcpServerOptions = {
  config?: UnlimitedTtsConfig;
  service?: UnlimitedTtsService;
};

export function createUnlimitedTtsMcpServer(
  options: CreateUnlimitedTtsMcpServerOptions = {},
): McpServer {
  const config = options.config ?? configFromEnv();
  const service = options.service ?? new UnlimitedTtsService(config);
  const server = new McpServer(
    {
      name: "com.unlimitedtts/tts",
      version: "0.1.0",
    },
    {
      instructions:
        "Call tts_quote before tts_synthesize. Sign only selectedRequirement from the returned x402 challenge. Never retry PAYMENT_OUTCOME_UNKNOWN or request wallet secrets.",
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/read": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "tts_list_voices",
    {
      title: "List UnlimitedTTS voices",
      description:
        "Return the live voice catalog, current character price, and synthesis limits. No payment is made.",
      inputSchema: z.object({ refresh: z.boolean().default(false) }).strict(),
      outputSchema: voiceCatalogSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ refresh }) => {
      try {
        const output = await service.listVoices(refresh);
        return {
          content: [
            {
              type: "text",
              text: `Found ${output.voices.length} live UnlimitedTTS voices at ${output.pricing.ratePerCharUsd} USD per character.`,
            },
          ],
          structuredContent: { ...output },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "tts_quote",
    {
      title: "Quote UnlimitedTTS synthesis",
      description:
        "Send the text to the pinned UnlimitedTTS x402 endpoint to obtain and policy-check a live USDC quote. This makes no payment.",
      inputSchema: quoteInputSchema,
      outputSchema: quoteOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const output = await service.quote(input);
        return {
          content: [
            {
              type: "text",
              text: `Quote ${output.quoteId}: ${output.amount.display} USDC on ${output.network}; expires ${output.expiresAt}. Approval required: ${output.policy.approvalRequired}.`,
            },
          ],
          structuredContent: { ...output },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "tts_synthesize",
    {
      title: "Pay and synthesize UnlimitedTTS audio",
      description:
        "Submit the exact quoted request with an x402 PaymentPayload, save the MP3 under the configured output root, and return a sanitized settlement receipt. Payment is irreversible and this tool is not replay-safe.",
      inputSchema: synthesizeInputSchema,
      outputSchema: synthesisOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        "com.unlimitedtts/paid": true,
        "com.unlimitedtts/replaySafe": false,
      },
    },
    async (input) => {
      try {
        const completed = await service.synthesize(input);
        const content: CallToolResult["content"] = [
          {
            type: "text",
            text: `Created ${completed.output.artifact.bytes}-byte MP3. Settlement verified: ${completed.output.payment.amountAtomic} atomic USDC. Receipt ${completed.receiptId}.`,
          },
          {
            type: "resource_link",
            uri: completed.output.artifact.uri,
            name: "UnlimitedTTS MP3",
            description:
              "Local, user-owned audio artifact. The server does not retain it remotely.",
            mimeType: "audio/mpeg",
            size: completed.output.artifact.bytes,
          },
          {
            type: "resource_link",
            uri: `unlimitedtts://receipts/${completed.receiptId}`,
            name: "UnlimitedTTS payment receipt",
            mimeType: "application/json",
          },
        ];
        if (completed.includeInlineAudio) {
          content.push({
            type: "audio",
            data: Buffer.from(completed.audio).toString("base64"),
            mimeType: "audio/mpeg",
          });
        }
        return {
          content,
          structuredContent: { ...completed.output },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerResource(
    "unlimitedtts-voices",
    "unlimitedtts://voices",
    {
      title: "UnlimitedTTS voices and pricing",
      description: "Cached live voice catalog and synthesis limits.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 300_000, cacheScope: "public" },
    },
    async (uri) => {
      const catalog = await service.listVoices();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(catalog),
          },
        ],
      };
    },
  );

  server.registerResource(
    "unlimitedtts-receipt",
    new ResourceTemplate("unlimitedtts://receipts/{receiptId}", {
      list: undefined,
    }),
    {
      title: "UnlimitedTTS sanitized receipt",
      description:
        "A local receipt without synthesis text or payment authorization.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri, variables) => {
      const receipt = await service.artifactStore.readReceipt(
        String(variables.receiptId),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(receipt),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "narrate_text",
    {
      title: "Narrate text with UnlimitedTTS",
      description:
        "Plan a quote-first narration without invoking payment automatically.",
      argsSchema: z
        .object({
          text: z.string().min(1),
          voice: z.string().optional(),
        })
        .strict(),
    },
    ({ text, voice }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Narrate the following text${voice ? ` using ${voice}` : ""}.`,
              "If it exceeds 4,096 UTF-16 code units, ask before splitting it into separately paid requests.",
              "List voices if necessary, obtain a quote, respect the budget, then synthesize once.",
              "",
              text,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
