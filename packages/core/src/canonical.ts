import { createHash } from "node:crypto";

import type { SynthesisRequest } from "./types.js";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export function createRequestBody(request: SynthesisRequest): string {
  // Preserve this property order on both the unpaid request and paid retry.
  return JSON.stringify({
    text: request.text,
    voice: request.voice,
    speed: request.speed,
  });
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

