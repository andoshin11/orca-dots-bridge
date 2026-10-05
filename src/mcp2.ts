#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcp2Server } from "./mcp2-server.js";

// Isolated opt-in entry. The existing mcp.mjs and running tunnel remain unchanged.
serveStdio(() =>
  createMcp2Server({
    statusOnly: process.env.ORCA_BRIDGE_STATUS_ONLY === "1",
    enableSend: process.env.ORCA_BRIDGE_ENABLE_SEND === "1",
  }),
);
