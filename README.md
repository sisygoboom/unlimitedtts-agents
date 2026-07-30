# UnlimitedTTS for Agents

Non-custodial, quote-first text-to-speech for AI agents:

- `@unlimitedtts/core` validates live x402 challenges, enforces spend policy, persists sanitized receipts, and writes private MP3 artifacts.
- `@unlimitedtts/mcp` exposes `tts_list_voices`, `tts_quote`, and irreversible `tts_synthesize` tools over stdio.
- `@unlimitedtts/openclaw` bundles the MCP server and the `unlimitedtts` agent skill.
- `skills/unlimitedtts` supports MCP-guided and direct wallet-aware HTTP workflows.

The implemented v1 path is external-signature mode. A separate wallet tool creates the x402 v2 `PAYMENT-SIGNATURE`; this code never accepts a seed phrase or private key.

## Install and build

Node.js 20 or newer and pnpm are required.

```bash
pnpm install --frozen-lockfile
pnpm check
```

Run the local server from this checkout:

```bash
pnpm --filter @unlimitedtts/mcp build
node packages/mcp/dist/cli.js
```

Generic MCP configuration after npm publication:

```json
{
  "mcpServers": {
    "unlimitedtts": {
      "command": "npx",
      "args": ["-y", "@unlimitedtts/mcp@0.1.0"],
      "env": {
        "UNLIMITEDTTS_MAX_USDC_PER_CALL": "0.10",
        "UNLIMITEDTTS_ROLLING_24H_USDC": "1.00",
        "UNLIMITEDTTS_OUTPUT_DIRECTORY": "/absolute/approved/output"
      }
    }
  }
}
```

OpenClaw local development:

```bash
pnpm --filter @unlimitedtts/openclaw build
openclaw plugins install -l ./packages/openclaw
openclaw plugins enable unlimitedtts
openclaw gateway restart
openclaw plugins inspect unlimitedtts --runtime --json
openclaw plugins doctor
```

## Payment flow

1. `tts_list_voices` retrieves `/docs` and `/tts/voices` and caches the result for five minutes.
2. `tts_quote` sends the exact synthesis body to `/x402/tts` without payment, validates the returned `PAYMENT-REQUIRED`, enforces local policy, reserves rolling budget, and returns a short-lived HMAC token.
3. A wallet signs only the returned `selectedRequirement`.
4. `tts_synthesize` verifies the token, unchanged body hash, complete x402 v2 `accepted` entry, exact-EVM payee and value, then sends one paid retry.
5. A successful call requires both `audio/mpeg` and `PAYMENT-RESPONSE`. It commits the budget, writes a sanitized receipt, atomically stores the MP3 with mode `0600`, and returns structured metadata plus MCP audio/resource content.

`PAYMENT_OUTCOME_UNKNOWN` permanently quarantines that quote in the local ledger. The server never automatically submits or authorizes a second payment.

## Configuration

| Environment variable | Default |
|---|---|
| `UNLIMITEDTTS_ENVIRONMENT` | `production`; set `staging` explicitly for the staging API and Base Sepolia |
| `UNLIMITEDTTS_API_ORIGIN` | `https://api.unlimitedtts.com` |
| `UNLIMITEDTTS_ALLOWED_NETWORKS` | `eip155:8453` |
| `UNLIMITEDTTS_ALLOWED_ASSETS` | Base USDC contract |
| `UNLIMITEDTTS_ALLOWED_PAYEES` | Payee pinned from the verified 30 July 2026 release contract |
| `UNLIMITEDTTS_MAX_USDC_PER_CALL` | `0.10` |
| `UNLIMITEDTTS_ROLLING_24H_USDC` | `1.00` |
| `UNLIMITEDTTS_APPROVAL_THRESHOLD_USDC` | `0.05` |
| `UNLIMITEDTTS_REQUIRE_APPROVAL` | `first-payment-and-over-threshold` |
| `UNLIMITEDTTS_OUTPUT_DIRECTORY` | `.unlimitedtts-artifacts` under the server working directory |
| `UNLIMITEDTTS_QUOTE_TOKEN_SECRET` | Random per process; configure a secret for multi-instance deployments |

Payee rotation must be released through trusted configuration. The server never learns an allowed payee from an untrusted challenge.

Production remains the default and is pinned to Base mainnet. For staging validation, set `UNLIMITEDTTS_ENVIRONMENT=staging`; this selects `https://staging-api.unlimitedtts.com`, Base Sepolia (`eip155:84532`), and staging USDC. The core rejects the staging origin, network, or asset when the environment is not explicitly `staging`.

## Scope

This checkout implements the portable local MCP, external wallet adapter contract, agent skill, OpenClaw package, tests, and registry metadata. Hosted Streamable HTTP, temporary R2 storage, prepaid-card synthesis, and a concrete managed automatic signer are intentionally not advertised as completed v1 features.

See [required and recommended upstream changes](docs/upstream-api-changes.md) before enabling unattended automatic signing or a hosted service.
