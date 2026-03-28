# mcp-entra-auth-proxy

> **Workaround solution.** This proxy exists because most MCP clients do not yet natively support Microsoft Entra ID authentication. If your MCP client supports Entra ID auth natively, prefer using its built-in authentication flow instead of this proxy.

Local stdio MCP proxy that forwards requests to a remote MCP server, authenticating via Microsoft Entra ID tokens from the `az` CLI.

Use it to connect any MCP-compatible AI client (VS Code Copilot, Claude Desktop, OpenCode, Cursor, etc.) to a remote Microsoft Entra ID-protected MCP server — without embedding credentials in the client config.

## How it works

```
┌─────────────┐  stdio   ┌──────────────────────┐  HTTP(S)  ┌──────────────┐
│  AI Client   │◄────────►│ mcp-entra-auth-proxy │◄─────────►│ Remote MCP   │
│ (VS Code,    │          │       (local)        │ + Bearer  │ Server       │
│  Claude, …)  │          │                      │   token   │ (Entra ID    │
└─────────────┘          └──────────────────────┘           │  protected)  │
                                                             └──────────────┘
```

1. Your AI client spawns `mcp-entra-auth-proxy` as a local stdio MCP server
2. The proxy acquires a Microsoft Entra ID token via `az account get-access-token`
3. All MCP requests (tools, resources, prompts) are forwarded to the remote server with the Bearer token
4. Tokens are refreshed proactively before they expire

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`) installed and logged in

```bash
az login
```

### Azure CLI pre-approval requirement

The Azure CLI (`az`) must be **pre-approved as a client application** for the Entra ID resource (the API your remote MCP server is protected by). This is required because the proxy uses `az account get-access-token` to acquire tokens on behalf of the user, which performs a token exchange against the target resource.

Specifically, in the Azure portal you must:

1. Navigate to the **App Registration** for your MCP server's API (the one identified by `MCP_ENTRA_RESOURCE`, e.g. `api://your-azure-app-client-id`)
2. Under **Expose an API**, add the Azure CLI's well-known client ID (`04b07795-a71b-4346-935c-a98c21680faa`) as an **Authorized client application**
3. Grant it all the **scopes** (delegated permissions) that the MCP server requires

Without this pre-approval, `az account get-access-token --resource <MCP_ENTRA_RESOURCE>` will fail because Azure will not issue a token for a resource that has not authorized the Azure CLI as a permitted client.

## Quick start

No installation needed — use `npx` directly in your MCP client config:

### VS Code (Copilot) / Cursor

Add to your project-level `.vscode/mcp.json`:

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "mcp-entra-auth-proxy@latest"],
      "env": {
        "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
        "MCP_ENTRA_RESOURCE": "api://your-azure-app-client-id"
      }
    }
  }
}
```

### Claude Desktop

Add to your project-level `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "mcp-entra-auth-proxy@latest"],
      "env": {
        "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
        "MCP_ENTRA_RESOURCE": "api://your-azure-app-client-id"
      }
    }
  }
}
```

### OpenCode

Add to your project-level `.opencode/mcp.json`:

```json
{
  "my-server": {
    "command": "npx",
    "args": ["-y", "mcp-entra-auth-proxy@latest"],
    "env": {
      "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
      "MCP_ENTRA_RESOURCE": "api://your-azure-app-client-id"
    }
  }
}
```

## Configuration

All configuration is done through environment variables:

| Variable | Required | Description |
|---|---|---|
| `MCP_ENTRA_SERVER_URL` | **Yes** | URL of the remote MCP server |
| `MCP_ENTRA_RESOURCE` | **Yes**\* | Microsoft Entra ID resource URI (`api://...`) for token acquisition |
| `MCP_ENTRA_TOKEN` | No | Pre-acquired bearer token (bypasses `az` CLI, no auto-refresh) |
| `MCP_ENTRA_TENANT` | No | Microsoft Entra ID tenant ID (passed as `--tenant` to `az`) |
| `MCP_ENTRA_REFRESH_MARGIN` | No | Minutes before expiry to refresh token (default: `5`) |
| `MCP_ENTRA_TOOL_TIMEOUT` | No | Tool call timeout in seconds (default: `120`) |
| `MCP_ENTRA_HEADERS` | No | Extra HTTP headers as JSON string, e.g. `'{"X-Custom":"value"}'` |

\* Either `MCP_ENTRA_RESOURCE` or `MCP_ENTRA_TOKEN` must be provided.

## Authentication modes

### 1. Azure CLI (recommended)

The proxy calls `az account get-access-token --resource <MCP_ENTRA_RESOURCE>` to acquire tokens. Tokens are cached and refreshed automatically before they expire.

Make sure you are logged in:

```bash
az login
```

If your server requires a specific tenant:

```json
{
  "env": {
    "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
    "MCP_ENTRA_RESOURCE": "api://your-azure-app-client-id",
    "MCP_ENTRA_TENANT": "your-tenant-id"
  }
}
```

### 2. Static token (CI / service accounts)

If the Azure CLI is not available, provide a token directly:

```json
{
  "env": {
    "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
    "MCP_ENTRA_TOKEN": "eyJ0eXAiOiJKV1Q..."
  }
}
```

> **Note:** Static tokens are not refreshed automatically. You are responsible for ensuring the token remains valid for the duration of the session.

## Custom headers

Some servers require additional headers beyond the Bearer token:

```json
{
  "env": {
    "MCP_ENTRA_SERVER_URL": "https://your-server.example.com/mcp/",
    "MCP_ENTRA_RESOURCE": "api://your-azure-app-client-id",
    "MCP_ENTRA_HEADERS": "{\"X-Api-Key\":\"abc123\",\"X-Custom\":\"value\"}"
  }
}
```

## Transport fallback

The proxy first attempts to connect using [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport. If that fails, it automatically falls back to [SSE](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse) transport. This ensures compatibility with both newer and older MCP server implementations.

## Troubleshooting

Diagnostic messages are written to stderr (visible in your client's MCP output panel).

| Message | Cause | Fix |
|---|---|---|
| `MCP_ENTRA_SERVER_URL environment variable is required` | Missing server URL | Set `MCP_ENTRA_SERVER_URL` in your env config |
| `MCP_ENTRA_RESOURCE or MCP_ENTRA_TOKEN environment variable is required` | No auth configured | Set either `MCP_ENTRA_RESOURCE` or `MCP_ENTRA_TOKEN` |
| `az token acquisition failed` | `az` CLI error | Run `az login` and ensure the resource URI is correct |
| `Cannot acquire token` | Both `az` and env token failed | Run `az login` or set `MCP_ENTRA_TOKEN` |

## License

MIT
