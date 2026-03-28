#!/usr/bin/env node

/**
 * mcp-entra-auth-proxy — Local stdio MCP proxy with Microsoft Entra ID authentication
 *
 * Runs as a local stdio MCP server, proxies all requests to a remote
 * MCP server, automatically acquiring and refreshing Microsoft Entra ID bearer
 * tokens via the `az` CLI.
 *
 * Token refresh is proactive: the token is refreshed when it is within
 * TOKEN_REFRESH_MARGIN_MS of expiry, before any request fails.
 *
 * Fallback: if `az` is unavailable (e.g. CI), the MCP_ENTRA_TOKEN env var
 * is used instead (no auto-refresh in that case).
 *
 * Configuration (environment variables):
 *   MCP_ENTRA_SERVER_URL    — (required) URL of the remote MCP server
 *   MCP_ENTRA_RESOURCE      — (required) Microsoft Entra ID resource URI for token acquisition
 *   MCP_ENTRA_TOKEN         — (optional) Pre-acquired bearer token (skips az CLI)
 *   MCP_ENTRA_TENANT        — (optional) Microsoft Entra ID tenant ID for az login
 *   MCP_ENTRA_REFRESH_MARGIN — (optional) Token refresh margin in minutes (default: 5)
 *   MCP_ENTRA_TOOL_TIMEOUT  — (optional) Tool call timeout in seconds (default: 120)
 *   MCP_ENTRA_HEADERS       — (optional) Extra headers as JSON, e.g. '{"X-Custom":"val"}'
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Auto-install dependencies if missing ---

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, "node_modules"))) {
  process.stderr.write("[mcp-entra-auth-proxy] Installing dependencies...\n");
  execSync("npm install --no-audit --no-fund", {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  process.stderr.write("[mcp-entra-auth-proxy] Dependencies installed.\n");
}

// --- Dynamic imports (resolved after auto-install) ---

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { SSEClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/sse.js"
);
const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = await import("@modelcontextprotocol/sdk/types.js");

// --- Configuration ---

const REMOTE_URL = process.env.MCP_ENTRA_SERVER_URL;
const AZURE_RESOURCE = process.env.MCP_ENTRA_RESOURCE;
const AZURE_TENANT = process.env.MCP_ENTRA_TENANT || "";
const TOKEN_REFRESH_MARGIN_MS =
  (parseInt(process.env.MCP_ENTRA_REFRESH_MARGIN, 10) || 5) * 60 * 1000;
const TOOL_TIMEOUT_MS =
  (parseInt(process.env.MCP_ENTRA_TOOL_TIMEOUT, 10) || 120) * 1000;

let EXTRA_HEADERS = {};
if (process.env.MCP_ENTRA_HEADERS) {
  try {
    EXTRA_HEADERS = JSON.parse(process.env.MCP_ENTRA_HEADERS);
  } catch (err) {
    process.stderr.write(
      `[mcp-entra-auth-proxy] Warning: MCP_ENTRA_HEADERS is not valid JSON, ignoring.\n`
    );
  }
}

if (!REMOTE_URL) {
  process.stderr.write(
    "[mcp-entra-auth-proxy] Error: MCP_ENTRA_SERVER_URL environment variable is required.\n"
  );
  process.exit(1);
}

if (!AZURE_RESOURCE && !process.env.MCP_ENTRA_TOKEN) {
  process.stderr.write(
    "[mcp-entra-auth-proxy] Error: MCP_ENTRA_RESOURCE or MCP_ENTRA_TOKEN environment variable is required.\n"
  );
  process.exit(1);
}

// --- Token Management ---

let cachedToken = null; // { accessToken: string, expiresOn: Date }

function log(msg) {
  process.stderr.write(`[mcp-entra-auth-proxy] ${msg}\n`);
}

function acquireTokenViaAz() {
  if (!AZURE_RESOURCE) return null;
  try {
    const tenantArg = AZURE_TENANT ? ` --tenant "${AZURE_TENANT}"` : "";
    const raw = execSync(
      `az account get-access-token --resource "${AZURE_RESOURCE}"${tenantArg} --output json`,
      { encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(raw);
    return {
      accessToken: parsed.accessToken,
      expiresOn: new Date(parsed.expiresOn),
    };
  } catch (err) {
    log(`az token acquisition failed: ${err.message}`);
    return null;
  }
}

function acquireTokenFromEnv() {
  const token = process.env.MCP_ENTRA_TOKEN;
  if (token) {
    log("Using MCP_ENTRA_TOKEN from environment (no auto-refresh)");
    return {
      accessToken: token,
      expiresOn: new Date(Date.now() + 60 * 60 * 1000), // assume 1h validity
    };
  }
  return null;
}

function getToken() {
  // Return cached token if still valid
  if (cachedToken) {
    const remaining = cachedToken.expiresOn.getTime() - Date.now();
    if (remaining > TOKEN_REFRESH_MARGIN_MS) {
      return cachedToken.accessToken;
    }
    log("Token near expiry, refreshing...");
  }

  // Try az first, then fall back to env var
  cachedToken = acquireTokenViaAz() || acquireTokenFromEnv();

  if (!cachedToken) {
    throw new Error(
      "Cannot acquire token. Run 'az login' or set MCP_ENTRA_TOKEN."
    );
  }

  const expiresInMin = Math.round(
    (cachedToken.expiresOn.getTime() - Date.now()) / 60_000
  );
  log(`Token acquired, expires in ~${expiresInMin} min`);
  return cachedToken.accessToken;
}

// --- Remote Client Management ---

let remoteClient = null;

async function ensureRemoteClient() {
  const token = getToken();

  // If we have a client, check if we need to reconnect (token changed)
  if (remoteClient && remoteClient._currentToken === token) {
    return remoteClient;
  }

  // Close existing client if any
  if (remoteClient) {
    log("Reconnecting with fresh token...");
    try {
      await remoteClient.close();
    } catch {
      // ignore close errors
    }
  }

  const client = new Client({
    name: "mcp-entra-auth-proxy",
    version: "0.1.0",
  });

  const headers = {
    Authorization: `Bearer ${token}`,
    ...EXTRA_HEADERS,
  };

  // Try Streamable HTTP first, fall back to SSE
  let transport;
  try {
    transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
      requestInit: { headers },
    });
    await client.connect(transport);
    log("Connected via Streamable HTTP");
  } catch (err) {
    log(`Streamable HTTP failed (${err.message}), trying SSE...`);
    transport = new SSEClientTransport(new URL(REMOTE_URL), {
      requestInit: { headers },
    });
    await client.connect(transport);
    log("Connected via SSE");
  }

  // Tag the client with the token for staleness detection
  client._currentToken = token;
  remoteClient = client;
  return client;
}

// --- Local Server Setup ---

// Acquire token eagerly so we fail fast if az is not logged in
getToken();

const server = new Server(
  { name: "mcp-entra-auth-proxy", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// --- Tool handlers ---

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.listTools(request.params);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.callTool(request.params, undefined, {
    timeout: TOOL_TIMEOUT_MS,
  });
});

// --- Resource handlers ---

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.listResources(request.params);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.readResource(request.params);
});

server.setRequestHandler(
  ListResourceTemplatesRequestSchema,
  async (request) => {
    const client = await ensureRemoteClient();
    return await client.listResourceTemplates(request.params);
  }
);

// --- Prompt handlers ---

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.listPrompts(request.params);
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const client = await ensureRemoteClient();
  return await client.getPrompt(request.params);
});

// --- Start stdio transport ---

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Proxy started — forwarding to ${REMOTE_URL}`);
