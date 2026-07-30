export type JsonObject = { [key: string]: unknown };

export type PaymentRequirement = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: JsonObject;
  [key: string]: unknown;
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: JsonObject;
  accepts: PaymentRequirement[];
  [key: string]: unknown;
};

export type SynthesisRequest = {
  text: string;
  voice: string;
  speed: number;
};

export type Voice = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

export type VoiceCatalog = {
  voices: Voice[];
  pricing: {
    currency: string;
    billingUnit: string;
    ratePerCharUsd: string;
  };
  limits: {
    postCharacters: number;
    getCharacters: number;
    speedMin: number;
    speedMax: number;
  };
  fetchedAt: string;
};

export type QuoteTokenPayload = {
  version: 1;
  quoteId: string;
  createdAt: string;
  expiresAt: string;
  origin: string;
  method: "POST";
  url: string;
  bodySha256: string;
  characters: number;
  policyDecisionId: string;
  selectedRequirement: PaymentRequirement;
  paymentRequired: string;
};

export type QuoteResult = {
  quoteId: string;
  quoteToken: string;
  characters: number;
  amount: {
    atomic: string;
    decimals: 6;
    display: string;
    symbol: "USDC";
  };
  network: string;
  asset: string;
  payTo: string;
  expiresAt: string;
  paymentRequired: string;
  selectedRequirement: PaymentRequirement;
  policy: {
    allowed: true;
    approvalRequired: boolean;
    decisionId: string;
  };
};

export type Artifact = {
  id: string;
  uri: string;
  resourceUri: string;
  mimeType: "audio/mpeg";
  bytes: number;
  sha256: string;
  expiresAt: null;
};

export type SanitizedReceipt = {
  receiptId: string;
  quoteId: string;
  requestSha256: string;
  characters: number;
  voice: string;
  speed: number;
  amountAtomic: string;
  asset: string;
  network: string;
  payer: string | null;
  payee: string;
  transaction: string | null;
  settled: true;
  traceId: string | null;
  createdAt: string;
};

export type SynthesisOutput = {
  artifact: Omit<Artifact, "id" | "resourceUri">;
  request: {
    characters: number;
    voice: string;
    speed: number;
  };
  payment: {
    receiptId: string;
    amountAtomic: string;
    asset: string;
    symbol: "USDC";
    network: string;
    payer: string | null;
    payee: string;
    transaction: string | null;
    settled: true;
  };
  traceId: string | null;
};

export interface X402SignerAdapter {
  getAddresses(): Promise<Array<{ network: string; address: string }>>;
  signExactPayment(input: {
    paymentRequired: unknown;
    selectedRequirement: unknown;
    request: {
      method: "GET" | "POST";
      url: string;
      bodySha256?: string;
    };
    policyDecisionId: string;
  }): Promise<{ paymentSignature: string; payerAddress: string }>;
}
