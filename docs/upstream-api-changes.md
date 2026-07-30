# Upstream API contract

The local external-signature MCP can operate against the current production API. The following contracts are required before UnlimitedTTS enables unattended automatic payment or a hosted MCP.

## Required for unattended payment

1. `POST /x402/tts` must advertise and enforce the official x402 Payment Identifier extension. An exact replay within the advertised window must return the original audio and settlement receipt without creating a second charge.
2. `GET /.well-known/x402-service-metadata` must publish signed network, asset, payee, pricing, validity, and key-rotation metadata. Clients bootstrap trust from an out-of-band pinned key and never from an untrusted payment challenge.

All crypto TTS charges are final. No refund mechanism, refund endpoint, or refund workflow is required or planned. Idempotent response replay is the recovery mechanism.

If a payment may have settled but neither the audio nor a replayable cached response can be recovered, the client records `PAYMENT_OUTCOME_UNKNOWN`, does not retry automatically, and requires explicit approval before creating a new quote.

## Strongly recommended

3. Provide a hash-bound quote endpoint that accepts text length, text SHA-256, model, voice, and speed without receiving raw text during the unpaid challenge.
4. State whether unpaid-challenge text is logged, retained, or forwarded to the synthesis provider.
5. Publish x402 Bazaar discovery metadata with the JSON input schema and `audio/mpeg` output metadata.
6. Add a crypto-paid async or batch endpoint before agents automate long-form, multi-call narration.

Staging currently exposes these contracts for integration validation. Production remains the default environment; Base Sepolia is staging-only.
