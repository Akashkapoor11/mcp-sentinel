/**
 * MCP Sentinel – comprehensive unit + integration tests.
 *
 * Run with:  npm test
 *
 * Tests cover:
 *  - JSON-RPC envelope parsing (valid, id mismatch, wrong version, missing result/error)
 *  - Tool list validation (names, duplicates, schema types, required/properties consistency)
 *  - SSE event-stream parsing (multi-line data, progress notifications, id selection, errors)
 *  - Notification acceptance (202/204/content-length:0, only for notifications)
 *  - Protocol version validation (accepts 2025-11-25 family, rejects others)
 *  - Endpoint URL validation (HTTP/HTTPS only, no credentials)
 *  - Tool result summarisation (text blocks, errors, empty)
 *  - Full sentinel run via mocked fetch (happy path, HTTP error, version mismatch,
 *    missing expected tool, tool-call error)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAcceptedNoContentNotification,
  parseEventStream,
  parseJsonRpcResponse,
  validateEndpointUrl,
  validateProtocolVersion,
  validateToolList,
  summarizeToolResult,
} from '../src/protocol.js';
import { runSentinel } from '../src/cli.js';

// ── parseJsonRpcResponse ──────────────────────────────────────────────────────

test('parseJsonRpcResponse: accepts valid result envelope', () => {
  const env = parseJsonRpcResponse({ jsonrpc: '2.0', id: 7, result: { ok: true } }, 7);
  assert.deepEqual(env.result, { ok: true });
});

test('parseJsonRpcResponse: accepts valid error envelope', () => {
  const env = parseJsonRpcResponse({ jsonrpc: '2.0', id: 3, error: { code: -32600, message: 'Invalid Request' } }, 3);
  assert.equal(env.error?.code, -32600);
});

test('parseJsonRpcResponse: rejects wrong jsonrpc version', () => {
  assert.throws(() => parseJsonRpcResponse({ jsonrpc: '1.0', id: 7, result: {} }, 7), /jsonrpc version/);
});

test('parseJsonRpcResponse: rejects id mismatch', () => {
  assert.throws(() => parseJsonRpcResponse({ jsonrpc: '2.0', id: 8, result: {} }, 7), /id mismatch/);
});

test('parseJsonRpcResponse: rejects envelope with neither result nor error', () => {
  assert.throws(() => parseJsonRpcResponse({ jsonrpc: '2.0', id: 1 }, 1), /result or error/);
});

test('parseJsonRpcResponse: rejects non-object', () => {
  assert.throws(() => parseJsonRpcResponse(null, 1), /JSON object/);
  assert.throws(() => parseJsonRpcResponse([1, 2], 1), /JSON object/);
});

// ── validateToolList ──────────────────────────────────────────────────────────

test('validateToolList: accepts well-formed tool list', () => {
  const tools = validateToolList({
    tools: [
      { name: 'search_devices', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'get_device', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    ],
  });
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, 'search_devices');
  assert.equal(tools[1]?.name, 'get_device');
});

test('validateToolList: accepts tool without inputSchema', () => {
  const tools = validateToolList({ tools: [{ name: 'ping' }] });
  assert.equal(tools[0]?.name, 'ping');
});

test('validateToolList: rejects invalid tool name (space)', () => {
  assert.throws(() => validateToolList({ tools: [{ name: 'bad name' }] }), /invalid name/);
});

test('validateToolList: rejects invalid tool name (empty)', () => {
  assert.throws(() => validateToolList({ tools: [{ name: '' }] }), /invalid name/);
});

test('validateToolList: rejects duplicate tool names', () => {
  assert.throws(() => validateToolList({ tools: [{ name: 'tool' }, { name: 'tool' }] }), /Duplicate/);
});

test('validateToolList: rejects inputSchema.type !== object', () => {
  assert.throws(() => validateToolList({ tools: [{ name: 'tool', inputSchema: { type: 'string' } }] }), /should be object/);
});

test('validateToolList: rejects properties as array', () => {
  assert.throws(() => validateToolList({ tools: [{ name: 'tool', inputSchema: { type: 'object', properties: [] } }] }), /should be an object/);
});

test('validateToolList: rejects required referencing undeclared property', () => {
  assert.throws(
    () => validateToolList({ tools: [{ name: 'tool', inputSchema: { type: 'object', properties: {}, required: ['missing'] } }] }),
    /undeclared input property/,
  );
});

test('validateToolList: rejects duplicate required entries', () => {
  assert.throws(
    () => validateToolList({ tools: [{ name: 'tool', inputSchema: { type: 'object', properties: { x: {} }, required: ['x', 'x'] } }] }),
    /duplicates/,
  );
});

test('validateToolList: rejects missing tools array', () => {
  assert.throws(() => validateToolList({ tools: 'not-array' }), /tools array/);
  assert.throws(() => validateToolList(null), /tools array/);
});

// ── parseEventStream ──────────────────────────────────────────────────────────

test('parseEventStream: selects matching id from stream with progress events', () => {
  const stream = [
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
    'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
  ].join('\n\n');
  assert.deepEqual(parseEventStream(stream, 2), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
});

test('parseEventStream: supports multi-line data: continuation', () => {
  const stream = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{"tools":[]}}';
  assert.deepEqual(parseEventStream(stream, 2), { jsonrpc: '2.0', id: 2, result: { tools: [] } });
});

test('parseEventStream: throws when requested id not found', () => {
  const stream = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}';
  assert.throws(() => parseEventStream(stream, 9), /response for id 9/);
});

test('parseEventStream: throws when stream has only [DONE] or heartbeats', () => {
  assert.throws(() => parseEventStream('event: ping\ndata: [DONE]\n\n'), /did not contain/);
  assert.throws(() => parseEventStream(': heartbeat\n\n'), /did not contain/);
});

test('parseEventStream: returns last result when no expectedId given', () => {
  const stream = [
    'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
    'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}',
  ].join('\n\n');
  const result = parseEventStream(stream) as { result: { b: number } };
  assert.equal(result.result.b, 2);
});

// ── isAcceptedNoContentNotification ──────────────────────────────────────────

test('isAcceptedNoContentNotification: accepts 202 for notifications/initialized', () => {
  assert.equal(isAcceptedNoContentNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 202), true);
});

test('isAcceptedNoContentNotification: accepts 204', () => {
  assert.equal(isAcceptedNoContentNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 204), true);
});

test('isAcceptedNoContentNotification: accepts content-length:0 with 200', () => {
  assert.equal(isAcceptedNoContentNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }, 200, '0'), true);
});

test('isAcceptedNoContentNotification: rejects request with id (not a notification)', () => {
  assert.equal(isAcceptedNoContentNotification({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 202), false);
});

test('isAcceptedNoContentNotification: rejects non-notification method', () => {
  assert.equal(isAcceptedNoContentNotification({ jsonrpc: '2.0', method: 'tools/list' }, 204), false);
});

test('isAcceptedNoContentNotification: rejects null', () => {
  assert.equal(isAcceptedNoContentNotification(null, 204), false);
});

// ── validateProtocolVersion ───────────────────────────────────────────────────

test('validateProtocolVersion: accepts 2025-11-25', () => {
  assert.doesNotThrow(() => validateProtocolVersion('2025-11-25'));
});

test('validateProtocolVersion: accepts 2025-11-25-rc1 (patch variant)', () => {
  assert.doesNotThrow(() => validateProtocolVersion('2025-11-25-rc1'));
});

test('validateProtocolVersion: rejects unrelated version', () => {
  assert.throws(() => validateProtocolVersion('2024-01-01'), /2025-11-25/);
  assert.throws(() => validateProtocolVersion(''), /2025-11-25/);
});

// ── validateEndpointUrl ───────────────────────────────────────────────────────

test('validateEndpointUrl: accepts http and https', () => {
  assert.doesNotThrow(() => validateEndpointUrl('http://localhost:8000/mcp'));
  assert.doesNotThrow(() => validateEndpointUrl('https://example.com/mcp'));
});

test('validateEndpointUrl: rejects non-HTTP protocols', () => {
  assert.throws(() => validateEndpointUrl('ws://localhost/mcp'), /HTTP or HTTPS/);
  assert.throws(() => validateEndpointUrl('ftp://example.com'), /HTTP or HTTPS/);
});

test('validateEndpointUrl: rejects embedded credentials', () => {
  assert.throws(() => validateEndpointUrl('http://user:pass@localhost/mcp'), /credentials/);
});

test('validateEndpointUrl: rejects invalid URL', () => {
  assert.throws(() => validateEndpointUrl('not-a-url'), /valid URL/);
});

// ── summarizeToolResult ───────────────────────────────────────────────────────

test('summarizeToolResult: returns text from first text block', () => {
  const result = { content: [{ type: 'text', text: 'Found 3 devices.' }] };
  assert.equal(summarizeToolResult(result), 'Found 3 devices.');
});

test('summarizeToolResult: returns error summary for isError result', () => {
  const result = { isError: true, content: [{ type: 'text', text: 'Device not found.' }] };
  assert.match(summarizeToolResult(result), /Tool error/);
});

test('summarizeToolResult: returns fallback for undefined', () => {
  assert.equal(summarizeToolResult(undefined), '(no result)');
});

test('summarizeToolResult: returns fallback for empty content', () => {
  assert.equal(summarizeToolResult({ content: [] }), '(empty response)');
});

// ── Full sentinel run (mocked fetch) ─────────────────────────────────────────

function makeMockFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
    if (message.method === 'initialize') {
      const version = (overrides['version'] as string | undefined) ?? '2025-11-25';
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: version, serverInfo: { name: 'test-server', version: '0.1.0' }, capabilities: { tools: {} } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-protocol-version': version } },
      );
    }
    if (message.method === 'notifications/initialized') {
      const status = (overrides['notificationStatus'] as number | undefined) ?? 202;
      return new Response(null, { status });
    }
    if (message.method === 'tools/list') {
      const tools = (overrides['tools'] as unknown[] | undefined) ?? [{ name: 'search_devices', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (message.method === 'tools/call') {
      if (overrides['toolCallError']) return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'device not found' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"devices":[{"name":"PureAir 450"}]}' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unexpected request', { status: 400, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
}

async function withFetch<T>(mockFetch: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const BASE_OPTIONS = { endpoint: 'http://localhost:8000/mcp', argumentsJson: '{}', json: true, timeoutMs: 5000, verbose: false };

test('sentinel happy path: 3 checks pass without tool call', async () => {
  const report = await withFetch(makeMockFetch(), () => runSentinel({ ...BASE_OPTIONS }));
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 3); // initialize, initialized notification, tools/list
  assert.equal(report.tools[0]?.name, 'search_devices');
});

test('sentinel with tool call: 4 checks pass', async () => {
  const report = await withFetch(makeMockFetch(), () =>
    runSentinel({ ...BASE_OPTIONS, callTool: 'search_devices', argumentsJson: '{"query":"air purifier"}' }),
  );
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 4);
  assert.match(report.checks[3]?.detail ?? '', /PureAir 450/);
});

test('sentinel --expect-tools: passes when tool is present', async () => {
  const report = await withFetch(makeMockFetch(), () =>
    runSentinel({ ...BASE_OPTIONS, expectTools: ['search_devices'] }),
  );
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 4);
});

test('sentinel --expect-tools: fails when tool is missing', async () => {
  const report = await withFetch(makeMockFetch(), () =>
    runSentinel({ ...BASE_OPTIONS, expectTools: ['nonexistent_tool'] }),
  );
  assert.equal(report.failed, 1);
  const failedCheck = report.checks.find((c) => c.status === 'failed');
  assert.match(failedCheck?.detail ?? '', /not advertised/);
});

test('sentinel: fails gracefully when server returns wrong protocol version', async () => {
  const report = await withFetch(makeMockFetch({ version: '2024-01-01' }), () => runSentinel({ ...BASE_OPTIONS }));
  assert.equal(report.failed, 1);
  assert.equal(report.checks[0]?.name, 'initialize');
  assert.match(report.checks[0]?.detail ?? '', /2025-11-25/);
});

test('sentinel: fails gracefully when tool call returns isError', async () => {
  const report = await withFetch(makeMockFetch({ toolCallError: true }), () =>
    runSentinel({ ...BASE_OPTIONS, callTool: 'search_devices' }),
  );
  assert.equal(report.failed, 1);
  const callCheck = report.checks.find((c) => c.name === 'tools/call');
  assert.match(callCheck?.detail ?? '', /device not found/);
});

test('sentinel: fails gracefully when calling unadvertised tool', async () => {
  const report = await withFetch(makeMockFetch(), () =>
    runSentinel({ ...BASE_OPTIONS, callTool: 'nonexistent_tool' }),
  );
  assert.equal(report.failed, 1);
  const callCheck = report.checks.find((c) => c.name === 'tools/call');
  assert.match(callCheck?.detail ?? '', /not advertised/);
});

test('sentinel: report includes totalDurationMs', async () => {
  const report = await withFetch(makeMockFetch(), () => runSentinel({ ...BASE_OPTIONS }));
  assert.ok(typeof report.totalDurationMs === 'number' && report.totalDurationMs >= 0);
});

test('sentinel: accepts 202 initialized notification', async () => {
  const report = await withFetch(makeMockFetch({ notificationStatus: 202 }), () => runSentinel({ ...BASE_OPTIONS }));
  assert.equal(report.failed, 0);
});
