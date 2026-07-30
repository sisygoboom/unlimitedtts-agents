type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
};

const environmentMapping = {
  environment: "UNLIMITEDTTS_ENVIRONMENT",
  maxUsdcPerCall: "UNLIMITEDTTS_MAX_USDC_PER_CALL",
  rolling24hUsdc: "UNLIMITEDTTS_ROLLING_24H_USDC",
  approvalThresholdUsdc: "UNLIMITEDTTS_APPROVAL_THRESHOLD_USDC",
  requireApproval: "UNLIMITEDTTS_REQUIRE_APPROVAL",
  outputDirectory: "UNLIMITEDTTS_OUTPUT_DIRECTORY",
  allowedPayees: "UNLIMITEDTTS_ALLOWED_PAYEES",
} as const;

export default {
  id: "unlimitedtts",
  name: "UnlimitedTTS",
  description: "Wallet-paid text-to-speech for OpenClaw agents.",
  register(api: OpenClawPluginApi): void {
    const config = api.pluginConfig ?? {};
    for (const [configKey, environmentKey] of Object.entries(
      environmentMapping,
    )) {
      const value = config[configKey];
      if (typeof value === "string" && value.length > 0) {
        process.env[environmentKey] = value;
      } else if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        process.env[environmentKey] = value.join(",");
      }
    }
    api.logger?.info(
      "UnlimitedTTS configured in non-custodial external-signature mode.",
    );
  },
};
