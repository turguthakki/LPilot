import * as vscode from 'vscode';

export class ChatRequestError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

export interface OpenAIStreamDelta {
  content?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
  finishReason?: string;
}

export function resolveUrl(baseUrl: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const suffix = (path || '').trim();
  if (!suffix) {
    return base;
  }
  if (/^https?:\/\//i.test(suffix)) {
    return suffix;
  }
  return `${base}/${suffix.replace(/^\/+/, '')}`;
}

export function buildHeaders(endpoint: {
  authHeader: string;
  authPrefix: string;
  headers: Record<string, string>;
}, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(endpoint.headers ?? {}),
  };
  if (apiKey && endpoint.authHeader) {
    headers[endpoint.authHeader] = `${endpoint.authPrefix ?? ''}${apiKey}`;
  }
  return headers;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Streams an OpenAI-compatible chat completion request.
 * Yields incremental deltas; throws `ChatRequestError` on HTTP/network failures.
 */
export async function* streamChatCompletion(options: {
  endpoint: Parameters<typeof buildHeaders>[0] & { baseUrl: string; chatPath: string };
  apiKey: string | undefined;
  body: Record<string, unknown>;
  timeoutMs: number;
  token?: vscode.CancellationToken;
}): AsyncGenerator<OpenAIStreamDelta> {
  const { endpoint, apiKey, body, timeoutMs, token } = options;
  const controller = new AbortController();
  const cancellationListener = token?.onCancellationRequested(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveUrl(endpoint.baseUrl, endpoint.chatPath), {
      method: 'POST',
      headers: buildHeaders(endpoint, apiKey),
      body: JSON.stringify({ stream: true, ...body }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new ChatRequestError(
        `${endpoint.baseUrl}${endpoint.chatPath} responded with ${response.status}. ${detail}`,
        response.status,
      );
    }
    if (!response.body) {
      throw new ChatRequestError('Response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        const delta = parseSseLine(line);
        if (delta) {
          yield delta;
          if (token?.isCancellationRequested) {
            controller.abort();
            return;
          }
        }
      }
    }

    buffer += decoder.decode();
    for (const rawLine of buffer.split('\n')) {
      const delta = parseSseLine(rawLine.trim());
      if (delta) {
        yield delta;
      }
    }
  } catch (err) {
    if (token?.isCancellationRequested) {
      return;
    }
    if (err instanceof ChatRequestError) {
      throw err;
    }
    const aborted = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
    if (aborted && token?.isCancellationRequested) {
      return;
    }
    if (aborted) {
      throw new ChatRequestError(`Request to ${endpoint.baseUrl} timed out after ${timeoutMs}ms`);
    }
    throw new ChatRequestError(`Failed to reach ${endpoint.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    cancellationListener?.dispose();
  }
}

function parseSseLine(line: string): OpenAIStreamDelta | undefined {
  if (!line.startsWith('data:')) {
    return undefined;
  }
  const data = line.slice('data:'.length).trim();
  if (!data || data === '[DONE]') {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  // Some servers (non-chat or plain completions) return a single string chunk.
  if (typeof parsed === 'string') {
    return { content: parsed };
  }

  const delta = parsed.choices?.[0]?.delta ?? parsed.choices?.[0]?.message;
  if (!delta) {
    if (typeof parsed.content === 'string') {
      return { content: parsed.content };
    }
    return undefined;
  }

  const result: OpenAIStreamDelta = {};
  if (typeof delta.content === 'string') {
    result.content = delta.content;
  }
  // Some reasoning models emit `reasoning_content`.
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    result.content = (result.content ?? '') + delta.reasoning_content;
  }
  if (Array.isArray(delta.tool_calls)) {
    result.toolCalls = delta.tool_calls.map((tc: any, index: number) => ({
      index: typeof tc.index === 'number' ? tc.index : index,
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }));
  }
  const finishReason = parsed.choices?.[0]?.finish_reason;
  if (typeof finishReason === 'string') {
    result.finishReason = finishReason;
  }
  return result;
}
