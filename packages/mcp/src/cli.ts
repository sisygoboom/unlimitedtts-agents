#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createUnlimitedTtsMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createUnlimitedTtsMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("UnlimitedTTS MCP server running on stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`UnlimitedTTS MCP startup failed: ${message}`);
  process.exitCode = 1;
});

