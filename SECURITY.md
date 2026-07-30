# Security policy

Report vulnerabilities through GitHub private vulnerability reporting for this repository. Do not include private keys, seed phrases, live `PAYMENT-SIGNATURE` values, prepaid account identifiers, synthesis text, or audio in a report.

Supported security behavior:

- The API origin, network, asset, and payee are pinned by trusted local configuration.
- Wallet secrets are not accepted by MCP tool schemas.
- Payment signatures, synthesis text, request bodies, and audio bytes are not logged.
- Spend authorization uses integer atomic USDC values and a persistent rolling ledger.
- Paid transport failures are not retried automatically.
- Output paths are server-generated under one real, non-symlink root and written atomically with user-only permissions.

If a payment may have settled, inspect the wallet/facilitator/chain before taking any retry action.

