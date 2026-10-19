export interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SentinelTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

/** Parse and validate a JSON-RPC 2.0 response envelope, asserting the ID matches. */
export function parseJsonRpcResponse(value: unknown, expectedId: string | number): JsonRpcEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Response is not a JSON object.');
  const response = value as JsonRpcEnvelope;
  if (response.jsonrpc !== '2.0') throw new Error('Response jsonrpc version must be 2.0.');
  if (response.id !== expectedId) throw new Error(`Response id mismatch: expected ${expectedId}, received ${String(response.id)}.`);
  if (!('result' in response) && !('error' in response)) throw new Error('Response must contain result or error.');
  return response;
}

/**
 * Validate the tools/list result array.
 * Checks: name format, no duplicates, inputSchema type and property consistency,
 * required array entries all declared in properties.
 */
export function validateToolList(value: unknown): SentinelTool[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tools?: unknown }).tools)) {
    throw new Error('tools/list result must contain a tools array.');
  }
  const tools = (value as { tools: unknown[] }).tools;
  const names = new Set<string>();
  return tools.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Tool at index ${index} is not an object.`);
    const tool = raw as SentinelTool;
    if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) throw new Error(`Tool at index ${index} has an invalid name.`);
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}.`);
    names.add(tool.name);
    if (tool.inputSchema && tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object') {
      throw new Error(`Tool ${tool.name} inputSchema.type should be object.`);
    }
    if (tool.inputSchema?.properties !== undefined && (!tool.inputSchema.properties || typeof tool.inputSchema.properties !== 'object' || Array.isArray(tool.inputSchema.properties))) {
      throw new Error(`Tool ${tool.name} inputSchema.properties should be an object.`);
    }
    if (tool.inputSchema?.required !== undefined) {
      if (!Array.isArray(tool.inputSchema.required) || tool.inputSchema.required.some((name) => typeof name !== 'string')) {
        throw new Error(`Tool ${tool.name} inputSchema.required should be a string array.`);
      }
      if (new Set(tool.inputSchema.required).size !== tool.inputSchema.required.length) {
        throw new Error(`Tool ${tool.name} inputSchema.required contains duplicates.`);
      }
      const properties = tool.inputSchema.properties ?? {};
      for (const name of tool.inputSchema.required) if (!Object.hasOwn(properties, name)) {
        throw new Error(`Tool ${tool.name} requires undeclared input property: ${name}.`);
      }
    }
    return tool;
  });
}

/**
 * Parse a Streamable HTTP SSE event stream, selecting the JSON-RPC response
 * that matches expectedId. Supports multi-line data: continuation and ignores
 * progress notifications, heartbeats, and [DONE] frames.
 */
export function parseEventStream(text: string, expectedId?: string | number): unknown {
  const candidates: unknown[] = [];
  const events = text.split(/\r?\n\r?\n/).map((chunk) => chunk.trim()).filter(Boolean);
  for (const event of events) {
    const dataLines = event.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (!dataLines.length) continue;
    const payloadText = dataLines.map((line) => line.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') continue;
    let payload: unknown;
    try { payload = JSON.parse(payloadText) as unknown; } catch { continue; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const envelope = payload as JsonRpcEnvelope;
    // Progress notifications and server requests can appear before the RPC response.
    // Select the frame that matches this request ID rather than returning the first event.
    if (expectedId !== undefined) {
      if (envelope.id === expectedId && ('result' in envelope || 'error' in envelope)) return payload;
    } else if ('id' in envelope && ('result' in envelope || 'error' in envelope)) {
      candidates.push(payload);
    }
  }
  if (expectedId !== undefined) throw new Error(`Event stream did not contain a JSON-RPC response for id ${String(expectedId)}.`);
  if (candidates.length) return candidates[candidates.length - 1];
  throw new Error('Event stream did not contain a JSON-RPC result or error.');
}

/** Accept a no-body HTTP acknowledgement only for JSON-RPC notifications (no id field). */
export function isAcceptedNoContentNotification(message: unknown, status: number, contentLength?: string | null): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const envelope = message as Record<string, unknown>;
  const isNotification = envelope['jsonrpc'] === '2.0' && typeof envelope['method'] === 'string'
    && String(envelope['method']).startsWith('notifications/') && !('id' in envelope);
  return isNotification && (status === 202 || status === 204 || contentLength === '0');
}

/**
 * Validate that the server negotiated a version in the MCP 2025-11-25 protocol family.
 * Later patch versions (2025-11-25-rc1, etc.) are accepted; a completely different family is not.
 */
export function validateProtocolVersion(version: string): void {
  if (!version.startsWith('2025-11-25')) {
    throw new Error(
      `Expected MCP protocol family 2025-11-25, server negotiated "${version || '(missing)'}". ` +
      'Confirm the server supports the required protocol version before proceeding.',
    );
  }
}

/** Validate that the endpoint URL is safe to probe (HTTP/HTTPS, no embedded credentials). */
export function validateEndpointUrl(raw: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`"${raw}" is not a valid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Endpoint must use HTTP or HTTPS.');
  if (parsed.username || parsed.password) throw new Error('Do not embed credentials in the endpoint URL. Use environment variables or a proxy.');
  return parsed;
}

/**
 * Extract a concise, human-readable summary from a tool-call result.
 * Returns the text of the first text content block, or a fallback.
 */
export function summarizeToolResult(result: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (!result) return '(no result)';
  if (result.isError) return `Tool error: ${result.content?.map((c) => c.text ?? '').join(' ').slice(0, 200) || '(no detail)'}`;
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  return text.slice(0, 200) || '(empty response)';
}
