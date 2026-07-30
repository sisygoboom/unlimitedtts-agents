export const errorCodes = [
  "INVALID_TEXT",
  "INVALID_VOICE",
  "INVALID_SPEED",
  "QUOTE_EXPIRED",
  "PRICE_LIMIT_EXCEEDED",
  "UNSUPPORTED_NETWORK",
  "INSUFFICIENT_FUNDS",
  "PAYMENT_REJECTED",
  "PAYMENT_OUTCOME_UNKNOWN",
  "RATE_LIMITED",
  "TTS_UPSTREAM_ERROR",
  "OUTPUT_TOO_LARGE",
  "AUDIO_NOT_AVAILABLE",
  "CONFIGURATION_ERROR",
] as const;

export type UnlimitedTtsErrorCode = (typeof errorCodes)[number];

export class UnlimitedTtsError extends Error {
  readonly code: UnlimitedTtsErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: UnlimitedTtsErrorCode,
    message: string,
    options: {
      cause?: unknown;
      details?: Record<string, unknown>;
      retryable?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UnlimitedTtsError";
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  toSafeObject(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.details,
    };
  }
}

export function asUnlimitedTtsError(error: unknown): UnlimitedTtsError {
  if (error instanceof UnlimitedTtsError) {
    return error;
  }
  return new UnlimitedTtsError(
    "TTS_UPSTREAM_ERROR",
    "UnlimitedTTS could not complete the request.",
    { cause: error },
  );
}

