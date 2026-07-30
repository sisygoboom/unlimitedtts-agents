import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { UnlimitedTtsConfig } from "./config.js";
import { parseUsdc } from "./decimal.js";
import { UnlimitedTtsError } from "./errors.js";
import type { PaymentRequirement } from "./types.js";

type LedgerState =
  | "reserved"
  | "processing"
  | "committed"
  | "released"
  | "unknown";

type LedgerEntry = {
  quoteId: string;
  amountAtomic: string;
  requestSha256: string;
  createdAt: string;
  expiresAt: string;
  state: LedgerState;
  receiptId?: string;
};

type LedgerFile = {
  version: 1;
  entries: LedgerEntry[];
};

export type PolicyDecision = {
  allowed: true;
  approvalRequired: boolean;
  decisionId: string;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export class SpendPolicyLedger {
  readonly #path: string;
  readonly #config: UnlimitedTtsConfig;
  #entries: LedgerEntry[] = [];
  #queue: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(path: string, config: UnlimitedTtsConfig) {
    this.#path = path;
    this.#config = config;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { version?: unknown }).version === 1 &&
        Array.isArray((parsed as { entries?: unknown }).entries)
      ) {
        this.#entries = (parsed as LedgerFile).entries;
        // A prior process may have exited after sending a paid request.
        for (const entry of this.#entries) {
          if (entry.state === "processing") entry.state = "unknown";
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new UnlimitedTtsError(
          "CONFIGURATION_ERROR",
          "The spend ledger could not be read.",
          { cause: error },
        );
      }
    }
    this.#initialized = true;
  }

  validateRequirement(input: {
    origin: string;
    characters: number;
    requirement: PaymentRequirement;
    callerMaxUsdc?: string | undefined;
  }): void {
    const { requirement } = input;
    if (!this.#config.allowedOrigins.includes(input.origin)) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The API origin is not allowed by local policy.",
      );
    }
    if (input.characters > this.#config.maxCharactersPerCall) {
      throw new UnlimitedTtsError(
        "INVALID_TEXT",
        `Text exceeds the configured ${this.#config.maxCharactersPerCall}-character limit.`,
      );
    }
    if (!this.#config.allowedNetworks.includes(requirement.network)) {
      throw new UnlimitedTtsError(
        "UNSUPPORTED_NETWORK",
        `Network ${requirement.network} is not allowed by local policy.`,
      );
    }
    if (
      !this.#config.allowedAssets.some(
        (asset) => asset.toLowerCase() === requirement.asset.toLowerCase(),
      )
    ) {
      throw new UnlimitedTtsError(
        "UNSUPPORTED_NETWORK",
        "The quoted asset is not allowed by local policy.",
      );
    }
    if (
      !this.#config.allowedPayees.some(
        (payee) => payee.toLowerCase() === requirement.payTo.toLowerCase(),
      )
    ) {
      throw new UnlimitedTtsError(
        "PAYMENT_REJECTED",
        "The quoted payee is not pinned by local policy.",
      );
    }
    const amount = BigInt(requirement.amount);
    const callerCap =
      input.callerMaxUsdc === undefined
        ? null
        : parseUsdc(input.callerMaxUsdc);
    if (
      amount > this.#config.maxUsdcPerCallAtomic ||
      (callerCap !== null && amount > callerCap)
    ) {
      throw new UnlimitedTtsError(
        "PRICE_LIMIT_EXCEEDED",
        "The live quote exceeds the caller or server per-call limit.",
        {
          details: {
            amountAtomic: requirement.amount,
            policyMaxAtomic: this.#config.maxUsdcPerCallAtomic.toString(),
            ...(callerCap === null
              ? {}
              : { callerMaxAtomic: callerCap.toString() }),
          },
        },
      );
    }
  }

  async reserve(input: {
    quoteId: string;
    amountAtomic: string;
    requestSha256: string;
    expiresAt: string;
    now?: Date;
  }): Promise<PolicyDecision> {
    return this.#exclusive(async () => {
      const now = input.now ?? new Date();
      this.#cleanup(now);
      if (this.#entries.some((entry) => entry.quoteId === input.quoteId)) {
        throw new UnlimitedTtsError(
          "QUOTE_EXPIRED",
          "This quote identifier has already been used.",
        );
      }
      const amount = BigInt(input.amountAtomic);
      const activeSpend = this.#entries
        .filter(
          (entry) =>
            (entry.state === "reserved" ||
              entry.state === "processing" ||
              entry.state === "committed" ||
              entry.state === "unknown") &&
            Date.parse(entry.createdAt) > now.getTime() - DAY_MS,
        )
        .reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
      if (activeSpend + amount > this.#config.rolling24hUsdcAtomic) {
        throw new UnlimitedTtsError(
          "PRICE_LIMIT_EXCEEDED",
          "The quote would exceed the rolling 24-hour spend limit.",
          {
            details: {
              amountAtomic: input.amountAtomic,
              activeSpendAtomic: activeSpend.toString(),
              rollingLimitAtomic:
                this.#config.rolling24hUsdcAtomic.toString(),
            },
          },
        );
      }

      const hasCommittedPayment = this.#entries.some(
        (entry) => entry.state === "committed",
      );
      const approvalRequired =
        this.#config.requireApproval === "every-payment" ||
        (this.#config.requireApproval ===
          "first-payment-and-over-threshold" &&
          (!hasCommittedPayment ||
            amount >= this.#config.approvalThresholdUsdcAtomic));
      const decisionId = `pd_${randomUUID().replaceAll("-", "")}`;
      this.#entries.push({
        quoteId: input.quoteId,
        amountAtomic: input.amountAtomic,
        requestSha256: input.requestSha256,
        createdAt: now.toISOString(),
        expiresAt: input.expiresAt,
        state: "reserved",
      });
      await this.#persist();
      return { allowed: true, approvalRequired, decisionId };
    });
  }

  async beginSynthesis(
    quoteId: string,
    requestSha256: string,
    now = new Date(),
  ): Promise<void> {
    await this.#exclusive(async () => {
      this.#cleanup(now);
      const entry = this.#entries.find((candidate) => candidate.quoteId === quoteId);
      if (
        !entry ||
        entry.state !== "reserved" ||
        entry.requestSha256 !== requestSha256
      ) {
        throw new UnlimitedTtsError(
          "QUOTE_EXPIRED",
          "The quote is expired, already settled, or not reserved.",
          { details: { quoteId } },
        );
      }
      entry.state = "processing";
      await this.#persist();
    });
  }

  async commit(quoteId: string, receiptId: string): Promise<void> {
    await this.#setState(quoteId, "committed", receiptId);
  }

  async markUnknown(quoteId: string): Promise<void> {
    await this.#setState(quoteId, "unknown");
  }

  async release(quoteId: string): Promise<void> {
    await this.#setState(quoteId, "released");
  }

  async restoreReservation(quoteId: string, now = new Date()): Promise<void> {
    await this.#exclusive(async () => {
      const entry = this.#entries.find((candidate) => candidate.quoteId === quoteId);
      if (!entry || entry.state !== "processing") return;
      entry.state =
        Date.parse(entry.expiresAt) > now.getTime() ? "reserved" : "released";
      await this.#persist();
    });
  }

  async snapshot(): Promise<ReadonlyArray<Readonly<LedgerEntry>>> {
    return this.#exclusive(async () =>
      this.#entries.map((entry) => ({ ...entry })),
    );
  }

  async #setState(
    quoteId: string,
    state: LedgerState,
    receiptId?: string,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const entry = this.#entries.find((candidate) => candidate.quoteId === quoteId);
      if (
        !entry ||
        (entry.state !== "reserved" && entry.state !== "processing")
      ) {
        throw new UnlimitedTtsError(
          "QUOTE_EXPIRED",
          "The quote is no longer reserved.",
          { details: { quoteId } },
        );
      }
      entry.state = state;
      if (receiptId !== undefined) entry.receiptId = receiptId;
      await this.#persist();
    });
  }

  #cleanup(now: Date): void {
    const cutoff = now.getTime() - DAY_MS;
    for (const entry of this.#entries) {
      if (
        entry.state === "reserved" &&
        Date.parse(entry.expiresAt) <= now.getTime()
      ) {
        entry.state = "released";
      }
    }
    this.#entries = this.#entries.filter(
      (entry) =>
        entry.state === "reserved" ||
        entry.state === "processing" ||
        entry.state === "unknown" ||
        Date.parse(entry.createdAt) > cutoff,
    );
  }

  async #persist(): Promise<void> {
    await atomicJsonWrite(this.#path, {
      version: 1,
      entries: this.#entries,
    } satisfies LedgerFile);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
