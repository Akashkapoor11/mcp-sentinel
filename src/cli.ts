#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isAcceptedNoContentNotification,
  parseEventStream,
  parseJsonRpcResponse,
  validateEndpointUrl,
  validateProtocolVersion,
  validateToolList,
  summarizeToolResult,
  type JsonRpcEnvelope,
} from './protocol.js';

export type CheckResult = { name: string; status: 'passed' | 'failed'; detail: string; durationMs?: number };

export type Options = {
  endpoint: string;
  callTool?: string;
  argumentsJson: string;
  expectTools?: string[];
  junitPath?: string;
  json: boolean;
  timeoutMs: number;
  verbose: boolean;
};

function parseArgs(argv: string[]): Options {
  const args = [...argv];
  const endpoint = args.shift();
  if (!endpoint || endpoint.startsWith('-')) {
    throw new Error(
      'Usage: mcp-sentinel <endpoint> [options]\n\n' +
      'Options:\n' +
      '  --call-tool NAME        Call a specific tool after discovery\n' +
      '  --arguments JSON        Arguments for --call-tool (default: {})\n' +
      '  --expect-tools a,b,c   Assert these tool names are advertised\n' +
      '  --timeout MS            Request timeout in milliseconds (default: 15000)\n' +
      '  --junit FILE            Write JUnit XML report to file\n' +
      '  --json                  Emit JSON report to stdout\n' +
      '  --verbose               Show extra detail for each check\n' +
      '  --help, -h              Show this help message',
    );
  }
  const options: Options = { endpoint, argumentsJson: '{}', json: false, timeoutMs: 15_000, verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--call-tool') {
      const value = args[++index];
      if (!value) throw new Error('--call-tool requires a tool name.');
      options.callTool = value;
    } else if (arg === '--arguments') {
      options.argumentsJson = args[++index] ?? '{}';
    } else if (arg === '--expect-tools') {
      const value = args[++index];
      if (!value) throw new Error('--expect-tools requires a comma-separated list of tool names.');
      options.expectTools = value.split(',').map((t) => t.trim()).filter(Boolean);
    } else if (arg === '--junit') {
      const value = args[++index];
      if (!value) throw new Error('--junit requires a file path.');
      options.junitPath = value;
    } else if (arg === '--timeout') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 100) throw new Error('--timeout must be an integer >= 100 ms.');
      options.timeoutMs = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('help');
    } else {
      throw new Error(`Unknown option: ${arg}. Run mcp-sentinel --help for usage.`);
    }
  }
  // Validate URL and arguments early so CLI errors are clear before any network call.
  validateEndpointUrl(options.endpoint);
  const parsedArguments: unknown = JSON.parse(options.argumentsJson);
  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    throw new Error('--arguments must be a JSON object, e.g. \'{"query":"example"}\'.');
  }
  return options;
}

async function postRpc(
  endpoint: string,
  message: unknown,
  id?: number,
  protocolVersion?: string,
  sessionId?: string,
  timeoutMs = 15_000,
): Promise<{ body: JsonRpcEnvelope | null; protocolVersion: string; sessionId?: string; status: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (protocolVersion) headers['Mcp-Protocol-Version'] = protocolVersion;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const noContentNotification = response.ok && isAcceptedNoContentNotification(message, response.status, response.headers.get('content-length'));
  let body: unknown = null;
  if (!response.ok) {
    const errorBody = mediaType === 'application/json'
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} from MCP endpoint: ${typeof errorBody === 'string' ? errorBody.slice(0, 500) : JSON.stringify(errorBody)}`);
  }
  if (noContentNotification) {
    body = null;
  } else if (mediaType === 'text/event-stream') {
    body = parseEventStream(await response.text(), id);
  } else if (mediaType === 'application/json') {
    body = await response.json();
  } else {
    throw new Error(`Unsupported MCP response content type: ${contentType || '(missing)'}. Expected application/json or text/event-stream.`);
  }
  const sessionHeader = response.headers.get('mcp-session-id') ?? sessionId;
  const versionHeader = response.headers.get('mcp-protocol-version') ?? protocolVersion ?? '2025-11-25';
  if (id !== undefined) body = parseJsonRpcResponse(body, id);
  return { body: body as JsonRpcEnvelope | null, protocolVersion: versionHeader, ...(sessionHeader ? { sessionId: sessionHeader } : {}), status: response.status };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function buildJunit(checks: CheckResult[]): string {
  const failures = checks.filter((c) => c.status === 'failed');
  const cases = checks.map((c) =>
    c.status === 'failed'
      ? `<testcase name="${escapeXml(c.name)}" time="${((c.durationMs ?? 0) / 1000).toFixed(3)}"><failure message="${escapeXml(c.detail)}"/></testcase>`
      : `<testcase name="${escapeXml(c.name)}" time="${((c.durationMs ?? 0) / 1000).toFixed(3)}"/>`,
  ).join('');
  const totalMs = checks.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="MCP Sentinel" tests="${checks.length}" failures="${failures.length}" time="${(totalMs / 1000).toFixed(3)}">${cases}</testsuite>`;
}

export type SentinelReport = {
  endpoint: string;
  protocolVersion: string;
  checks: CheckResult[];
  tools: ReturnType<typeof validateToolList>;
  passed: number;
  failed: number;
  totalDurationMs: number;
};

export async function runSentinel(options: Options): Promise<SentinelReport> {
  const checks: CheckResult[] = [];
  const startAll = Date.now();

  function pass(name: string, detail: string, durationMs?: number): void {
    checks.push({ name, status: 'passed', detail, ...(durationMs !== undefined ? { durationMs } : {}) });
  }
  function fail(name: string, error: unknown, durationMs?: number): void {
    checks.push({ name, status: 'failed', detail: error instanceof Error ? error.message : String(error), ...(durationMs !== undefined ? { durationMs } : {}) });
  }

  let protocolVersion = '2025-11-25';
  let sessionId: string | undefined;
  let tools: ReturnType<typeof validateToolList> = [];

  // ── 1. Initialize ──────────────────────────────────────────────────────────
  const t0 = Date.now();
  try {
    const response = await postRpc(
      options.endpoint,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-sentinel', version: '1.1.0' } } },
      1, undefined, undefined, options.timeoutMs,
    );
    if (response.body?.error) throw new Error(`Server returned error: ${response.body.error.message}`);
    const result = response.body?.result as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } | undefined;
    protocolVersion = result?.protocolVersion ?? response.protocolVersion;
    validateProtocolVersion(protocolVersion);
    sessionId = response.sessionId;
    const serverName = result?.serverInfo?.name ? ` (server: ${result.serverInfo.name} ${result.serverInfo?.version ?? ''})`.trimEnd() : '';
    pass('initialize', `Negotiated MCP protocol ${protocolVersion}${serverName}.`, Date.now() - t0);
  } catch (error) { fail('initialize', error, Date.now() - t0); }

  // ── 2. notifications/initialized ───────────────────────────────────────────
  if (checks[0]?.status === 'passed') {
    const t1 = Date.now();
    try {
      await postRpc(options.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, undefined, protocolVersion, sessionId, options.timeoutMs);
      pass('initialized notification', 'Server accepted the initialized notification (HTTP 200/202/204).', Date.now() - t1);
    } catch (error) { fail('initialized notification', error, Date.now() - t1); }

    // ── 3. tools/list ─────────────────────────────────────────────────────────
    const t2 = Date.now();
    try {
      const response = await postRpc(options.endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 2, protocolVersion, sessionId, options.timeoutMs);
      if (response.body?.error) throw new Error(`Server returned error: ${response.body.error.message}`);
      tools = validateToolList(response.body?.result);
      pass('tools/list', `Discovered ${tools.length} tool(s); validated names and input schemas.`, Date.now() - t2);
    } catch (error) { fail('tools/list', error, Date.now() - t2); }

    // ── 4. --expect-tools assertion ───────────────────────────────────────────
    if (options.expectTools && options.expectTools.length > 0) {
      const t3 = Date.now();
      try {
        const advertised = new Set(tools.map((tool) => tool.name));
        const missing = options.expectTools.filter((name) => !advertised.has(name));
        if (missing.length > 0) throw new Error(`Expected tool(s) not advertised by server: ${missing.join(', ')}.`);
        pass('expect-tools', `All expected tools present: ${options.expectTools.join(', ')}.`, Date.now() - t3);
      } catch (error) { fail('expect-tools', error, Date.now() - t3); }
    }

    // ── 5. --call-tool execution ──────────────────────────────────────────────
    if (options.callTool) {
      const t4 = Date.now();
      try {
        if (!tools.some((tool) => tool.name === options.callTool)) {
          throw new Error(`Tool "${options.callTool}" was not advertised by tools/list. Advertised: ${tools.map((t) => t.name).join(', ') || '(none)'}.`);
        }
        const args = JSON.parse(options.argumentsJson) as Record<string, unknown>;
        const response = await postRpc(
          options.endpoint,
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: options.callTool, arguments: args } },
          3, protocolVersion, sessionId, options.timeoutMs,
        );
        if (response.body?.error) throw new Error(`Server returned error: ${response.body.error.message}`);
        const result = response.body?.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (!result || result.isError) throw new Error(result?.content?.map((part) => part.text ?? '').join('\n') || 'Tool returned no successful result.');
        const summary = summarizeToolResult(result);
        pass('tools/call', `Executed ${options.callTool}; received ${result.content?.length ?? 0} content block(s). Preview: ${summary}`, Date.now() - t4);
      } catch (error) { fail('tools/call', error, Date.now() - t4); }
    }
  }

  const totalDurationMs = Date.now() - startAll;
  const report: SentinelReport = {
    endpoint: options.endpoint,
    protocolVersion,
    checks,
    tools,
    passed: checks.filter((c) => c.status === 'passed').length,
    failed: checks.filter((c) => c.status === 'failed').length,
    totalDurationMs,
  };

  // ── Output ─────────────────────────────────────────────────────────────────
  if (options.junitPath) {
    await writeFile(options.junitPath, buildJunit(checks), 'utf8');
    if (!options.json) process.stderr.write(`JUnit report written to ${options.junitPath}\n`);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const PASS = '\u2713';
    const FAIL = '\u2717';
    console.log(`\nMCP Sentinel \u2014 ${options.endpoint}`);
    console.log(`Protocol : ${protocolVersion}`);
    console.log(`Duration : ${totalDurationMs}ms total`);
    console.log('');
    for (const check of checks) {
      const icon = check.status === 'passed' ? PASS : FAIL;
      const timing = check.durationMs !== undefined ? ` (${check.durationMs}ms)` : '';
      if (check.status === 'failed' || options.verbose) {
        console.log(`  ${icon}  ${check.name}${timing}: ${check.detail}`);
      } else {
        console.log(`  ${icon}  ${check.name}${timing}`);
      }
    }
    console.log('');
    console.log(`  ${report.passed} passed \u00b7 ${report.failed} failed`);
    if (tools.length > 0) {
      console.log(`  Tools: ${tools.map((t) => t.name).join(', ')}`);
    }
    console.log('');
  }

  return report;
}

// Run as CLI entry point when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runSentinel(options);
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'help') {
      // Re-throw to trigger the usage message
      parseArgs([]);
    } else {
      console.error(message);
      process.exitCode = 2;
    }
  }
}
