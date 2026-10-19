# Changelog

All notable changes to MCP Sentinel are documented here.
This project follows [Semantic Versioning](https://semver.org/).

---

## [1.1.0] — 2026-10-18

### Added
- **`--expect-tools` flag** — assert that specific tool names are advertised by the server; fails with a clear message listing what is missing.
- **`--timeout MS` flag** — configure per-request timeout (default 15 000 ms); useful for slow or remote servers.
- **`--verbose` flag** — show full detail for every check in console output (previously only failures were verbose).
- **Per-check timing** — every check now records `durationMs`; shown in console output and included in JSON and JUnit XML.
- **`totalDurationMs`** in the JSON report.
- **`summarizeToolResult`** helper — extracts a readable preview from a tool-call result or error for console output.
- **`validateProtocolVersion`** helper — exported so consumers can re-use the 2025-11-25-family check.
- **`validateEndpointUrl`** helper — exported for reuse; validates HTTP/HTTPS and rejects embedded credentials.
- **`exports` map in package.json** — `mcp-sentinel/protocol` subpath for importing individual helpers.
- **`files` whitelist** in package.json — only ships `dist/`, docs, and LICENSE.
- **`prepublishOnly` script** — enforces `npm test && npm run build` before any `npm publish`.
- **Server name/version in `initialize` output** — shown when the server returns `serverInfo`.
- **Comprehensive test suite (40 tests)** — covers all exported functions, error paths, SSE edge cases, and all new features via mocked fetch.

### Changed
- JUnit XML now includes `time` attributes on `<testsuite>` and each `<testcase>`.
- Console output header now shows `Duration` line.
- `tools/call` check now lists all advertised tool names in the error message when the requested tool is missing.
- `initialized notification` check now mentions accepted HTTP status codes in the pass detail.

### Fixed
- `isAcceptedNoContentNotification` now uses `envelope['method']` bracket notation for strict TypeScript compatibility.

---

## [1.0.0] — 2026-10-11

### Initial release
- Initialize handshake, notifications/initialized, tools/list, optional tools/call.
- JSON and JUnit XML output.
- Strict `2025-11-25` protocol version check.
- SSE multi-line `data:` continuation and ID-matched response selection.
- 5 unit/integration tests.
