# @unlimitedtts/openclaw

OpenClaw native package containing the UnlimitedTTS stdio MCP server and agent skill.

```bash
openclaw plugins install clawhub:@unlimitedtts/openclaw
openclaw gateway restart
```

The default payment mode is non-custodial external signature. Configure spend caps and the output directory under `plugins.entries.unlimitedtts.config`.

`environment` defaults to `production`, pinned to `https://api.unlimitedtts.com` and Base mainnet. Set it explicitly to `staging` only for `https://staging-api.unlimitedtts.com` and Base Sepolia validation. Base Sepolia is rejected outside the staging environment.
