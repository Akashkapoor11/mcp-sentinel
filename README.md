# MCP Sentinel

**A zero-dependency CLI smoke tester for [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) servers over Streamable HTTP.**

MCP Sentinel validates the full MCP 2025-11-25 protocol handshake, checks tool-list schema consistency, optionally executes a named tool, and emits console, JSON, or JUnit XML output — making it directly usable in CI pipelines.

---

## Why MCP Sentinel?

Building an MCP Streamable HTTP server involves several non-obvious protocol details:

- SSE framing and multi-line `data:` continuation
- ID-matched response selection (progress notifications arrive before the RPC response)
- Empty HTTP 202/204 acknowledgements that are valid *only* for notifications
- `inputSchema` consistency (`required` entries must all appear in `properties`)
- Correct `Mcp-Protocol-Version` negotiation

MCP Sentinel catches all of these without requiring a full MCP SDK dependency.

---

## Install

```bash
# Run directly with npx — no install needed
npx mcp-sentinel http://localhost:8000/mcp

# Or install globally
npm install -g mcp-sentinel

# Or as a dev dependency in your project
npm install --save-dev mcp-sentinel
```

**Requirements:** Node.js 22+

---

## Usage

```
mcp-sentinel <endpoint> [options]

Options:
  --call-tool NAME        Call a specific tool after discovery
  --arguments JSON        Arguments for --call-tool (default: {})
  --expect-tools a,b,c   Assert these tool names are advertised
  --timeout MS            Request timeout in milliseconds (default: 15000)
  --junit FILE            Write JUnit XML report to file
  --json                  Emit JSON report to stdout
  --verbose               Show full detail for each check
  --help, -h              Show this help message
```

---

## Example output

```
$ npx mcp-sentinel http://localhost:8000/mcp --call-tool search_devices --arguments '{"query":"air purifier"}' --verbose

MCP Sentinel — http://localhost:8000/mcp
Protocol : 2025-11-25
Duration : 312ms total

  ✓  initialize (98ms): Negotiated MCP protocol 2025-11-25 (server: fixrelay-api 2.0.0).
  ✓  initialized notification (12ms): Server accepted the initialized notification (HTTP 200/202/204).
  ✓  tools/list (76ms): Discovered 1 tool(s); validated names and input schemas.
  ✓  tools/call (126ms): Executed search_devices; received 1 content block(s). Preview: {"devices":[{"name":"PureAir 450"...

  4 passed · 0 failed
  Tools: search_devices
```

**JSON output** (`--json`):

```json
{
  "endpoint": "http://localhost:8000/mcp",
  "protocolVersion": "2025-11-25",
  "checks": [
    { "name": "initialize", "status": "passed", "detail": "Negotiated MCP protocol 2025-11-25 (server: fixrelay-api 2.0.0).", "durationMs": 98 },
    { "name": "initialized notification", "status": "passed", "detail": "Server accepted the initialized notification (HTTP 200/202/204).", "durationMs": 12 },
    { "name": "tools/list", "status": "passed", "detail": "Discovered 1 tool(s); validated names and input schemas.", "durationMs": 76 },
    { "name": "tools/call", "status": "passed", "detail": "Executed search_devices; received 1 content block(s). Preview: ...", "durationMs": 126 }
  ],
  "tools": [{ "name": "search_devices", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } } }],
  "passed": 4,
  "failed": 0,
  "totalDurationMs": 312
}
```

---

## What it checks

| Check | Description |
|---|---|
| **Endpoint hygiene** | HTTP/HTTPS only; no credentials embedded in URL |
| **initialize** | Sends JSON-RPC init with protocol `2025-11-25`; validates response ID, version family, and envelope shape |
| **notifications/initialized** | Sends notification; accepts HTTP 200/202/204 — rejects this for non-notification requests |
| **tools/list** | Calls `tools/list`; validates tool names (format, no duplicates), `inputSchema.type`, `properties` shape, and `required` vs declared properties |
| **--expect-tools** | Asserts that specific tool names are advertised by the server |
| **--call-tool** | Only calls a tool if it was advertised; validates the successful result structure |

---

## CI integration

```yaml
# .github/workflows/mcp-check.yml
- name: MCP Sentinel smoke test
  run: npx mcp-sentinel http://localhost:8000/mcp --call-tool search_devices --arguments '{"query":"test"}' --junit mcp-sentinel.xml
- uses: actions/upload-artifact@v4
  with:
    name: mcp-sentinel-report
    path: mcp-sentinel.xml
```

Exit code `0` = all checks passed. Exit code `1` = one or more checks failed. Exit code `2` = argument or configuration error.

---

## Programmatic API

```typescript
import { runSentinel } from 'mcp-sentinel';
import type { Options } from 'mcp-sentinel';

const report = await runSentinel({
  endpoint: 'http://localhost:8000/mcp',
  callTool: 'search_devices',
  argumentsJson: '{"query":"air purifier"}',
  expectTools: ['search_devices'],
  json: false,
  timeoutMs: 10_000,
  verbose: false,
});

console.log(`${report.passed} passed, ${report.failed} failed`);
if (report.failed > 0) process.exitCode = 1;
```

Protocol helpers are also importable directly:

```typescript
import { parseEventStream, validateToolList, validateEndpointUrl } from 'mcp-sentinel/protocol';
```

---

## Limitations

MCP Sentinel is a smoke tester, not a full conformance suite. It does not cover:

- Authentication and authorization quality
- Every transport edge case or TLS configuration
- Tool correctness or application-layer safety
- Mutation tools — never run writes against production without explicit authorization

A passing result proves only what the checks above describe.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Add a regression test for every bug or new check before opening a pull request.
