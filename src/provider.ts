import * as vscode from 'vscode';
import type { ConfigStore, LocalLLMState, ModelConfig } from './types';
import { isModelEnabledByFilter } from './types';
import type { Logger } from './logging';
import { streamChatCompletion } from './client';

interface OpenAITextContent {
  type: 'text';
  text: string;
}

interface OpenAIImageContent {
  type: 'image_url';
  image_url: { url: string };
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | Array<OpenAITextContent | OpenAIImageContent>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: object;
  };
}

/**
 * Registers every enabled model from every enabled endpoint with VS Code's
 * Language Model API, so the models show up in the chat model picker.
 */
export class LocalLLMProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private readonly modelsByKey = new Map<string, ModelConfig>();
  private cachedState: LocalLLMState = { endpoints: [], models: {} };

  constructor(
    private readonly store: ConfigStore,
    private readonly getTimeoutMs: () => number,
    private readonly logger?: Logger,
  ) {
    this.reload();
    store.onDidChange(() => {
      this.reload();
      this._onDidChange.fire();
    });
  }

  private reload(): void {
    this.cachedState = this.store.getState();
    this.modelsByKey.clear();
    for (const model of Object.values(this.cachedState.models)) {
      this.modelsByKey.set(model.key, model);
    }
  }

  /** Notifies VS Code that the list of available models changed. */
  refreshModelInformation(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const infos: vscode.LanguageModelChatInformation[] = [];
    const endpointById = new Map(this.cachedState.endpoints.map((e) => [e.id, e]));

    for (const model of this.modelsByKey.values()) {
      const endpoint = endpointById.get(model.endpointId);
      if (!endpoint || !endpoint.enabled || !model.enabled) {
        continue;
      }
      if (!isModelEnabledByFilter(endpoint, model)) {
        continue;
      }
      infos.push({
        id: model.key,
        // Prefix with the endpoint name so models are grouped/labelled by their
        // source in the picker, e.g. "Siyah/ornith", "NVIDIA/Deepseek".
        name: endpointLabel(endpoint.name, model.name),
        family: model.family,
        version: model.modelId,
        tooltip: `${model.modelId}${model.detected?.detail ? ` · ${model.detected.detail}` : ''} — ${endpoint.name} (${endpoint.baseUrl})`,
        detail: `${endpoint.name} · ${model.detected?.detail ?? ''}`.trim() + ` · ${model.maxInputTokens} max input tokens`,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          imageInput: model.imageInput,
          toolCalling: model.toolCalling,
        },
      });
    }

    // Discovery is orchestrated centrally by the extension (on start, via the
    // status bar and the config webview). Here we only report known models.
    this.logger?.info(`VS Code queried model information (silent=${String(options.silent)}): reporting ${infos.length} model(s)`);
    return infos;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const modelConfig = this.modelsByKey.get(model.id);
    if (!modelConfig) {
      throw new Error(`Model "${model.id}" is no longer configured. Refresh the models and try again.`);
    }
    const endpoint = this.cachedState.endpoints.find((e) => e.id === modelConfig.endpointId);
    if (!endpoint) {
      throw new Error(`Endpoint for model "${modelConfig.modelId}" no longer exists.`);
    }

    const apiKey = await this.store.getApiKey(endpoint);
    const requestBody: Record<string, unknown> = {
      model: modelConfig.modelId,
      messages: convertMessages(messages),
      ...endpoint.params,
      ...modelConfig.params,
      ...(options.modelOptions ?? {}),
    };

    const tools = convertTools(options.tools);
    this.logger?.info(
      `Chat request: model "${modelConfig.modelId}" on "${endpoint.name}" (${endpoint.baseUrl}${endpoint.chatPath}), ` +
      `${messages.length} message(s)${tools.length > 0 ? `, ${tools.length} tool(s)` : ''}`,
    );
    if (tools.length > 0) {
      requestBody.tools = tools;
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        requestBody.tool_choice = 'required';
      }
    }

    // Accumulate streamed tool calls until they are complete.
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    const started = Date.now();
    let streamedText = 0;

    for await (const delta of streamChatCompletion({
      endpoint,
      apiKey,
      body: requestBody,
      timeoutMs: this.getTimeoutMs(),
      token,
    })) {
      if (token.isCancellationRequested) {
        break;
      }
      if (delta.content) {
        streamedText += delta.content.length;
        progress.report(new vscode.LanguageModelTextPart(delta.content));
      }
      if (delta.toolCalls) {
        for (const tc of delta.toolCalls) {
          const buffered = toolCallBuffers.get(tc.index) ?? { id: tc.id ?? '', name: '', args: '' };
          if (tc.id) {
            buffered.id = tc.id;
          }
          if (tc.name) {
            buffered.name += tc.name;
          }
          if (tc.arguments) {
            buffered.args += tc.arguments;
          }
          toolCallBuffers.set(tc.index, buffered);
        }
      }
    }

    for (const buffered of toolCallBuffers.values()) {
      if (!buffered.name) {
        continue;
      }
      this.logger?.info(`Tool call requested: ${buffered.name}`);
      progress.report(
        new vscode.LanguageModelToolCallPart(buffered.id || `call-${Date.now()}`, buffered.name, safeJsonParse(buffered.args)),
      );
    }

    this.logger?.info(
      `Chat response finished for "${modelConfig.modelId}" in ${Date.now() - started}ms ` +
      `(${streamedText} chars streamed, ${toolCallBuffers.size} tool call(s))`,
    );
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return Math.ceil(textContent(text).length / 4);
  }
}

/**
 * Builds the model label shown in the chat model picker. The endpoint name is
 * prefixed so models from different servers are easy to tell apart, e.g.
 * "Siyah/ornith" or "NVIDIA/Deepseek".
 *
 * If the model name already begins with the endpoint name (case-insensitive,
 * e.g. endpoint "NVIDIA" + model "nvidia/etc"), the duplicate is stripped and
 * the endpoint's own casing is used as the group prefix, so the grouping stays
 * consistent ("NVIDIA/etc", not "nvidia/etc").
 */
function endpointLabel(endpointName: string, modelName: string): string {
  const prefix = (endpointName ?? '').trim();
  const name = (modelName ?? '').trim();
  if (!prefix) {
    return name;
  }
  const prefixWithSlash = `${prefix}/`;
  if (name.toLowerCase().startsWith(prefixWithSlash.toLowerCase())) {
    return `${prefix}/${name.slice(prefixWithSlash.length)}`;
  }
  return `${prefix}/${name}`;
}

function textContent(text: string | vscode.LanguageModelChatRequestMessage): string {
  if (typeof text === 'string') {
    return text;
  }
  const parts: string[] = [];
  for (const part of text.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    }
  }
  return parts.join('\n');
}

function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAITool[] {
  if (!tools) {
    return [];
  }
  const converted: OpenAITool[] = [];
  for (const tool of tools) {
    converted.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    });
  }
  return converted;
}

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      result.push(convertAssistantMessage(message));
      continue;
    }
    result.push(...convertUserMessage(message));
  }

  return result;
}

function convertAssistantMessage(message: vscode.LanguageModelChatRequestMessage): OpenAIMessage {
  const texts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      texts.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }

  const converted: OpenAIMessage = { role: 'assistant', content: texts.join('\n') };
  if (toolCalls.length > 0) {
    converted.tool_calls = toolCalls;
  }
  return converted;
}

function convertUserMessage(message: vscode.LanguageModelChatRequestMessage): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  let texts: string[] = [];
  const images: OpenAIImageContent[] = [];

  const flush = () => {
    if (texts.length === 0 && images.length === 0) {
      return;
    }
    if (images.length > 0) {
      const content: Array<OpenAITextContent | OpenAIImageContent> = texts.map((text) => ({ type: 'text', text }));
      content.push(...images);
      result.push({ role: 'user', content });
    } else {
      result.push({ role: 'user', content: texts.join('\n') });
    }
    texts = [];
    images.length = 0;
  };

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      texts.push(part.value);
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (part.mimeType?.startsWith('image/')) {
        texts.push('[image]');
        images.push({ type: 'image_url', image_url: { url: dataPartToUrl(part) } });
      } else {
        texts.push(`[data: ${part.mimeType}]`);
      }
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      flush();
      result.push({ role: 'tool', tool_call_id: part.callId, content: stringifyToolResult(part) });
    } else if (typeof part === 'string') {
      texts.push(part);
    }
  }
  flush();

  return result;
}

function dataPartToUrl(part: vscode.LanguageModelDataPart): string {
  let binary = '';
  const bytes = part.data;
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = Buffer.from(binary, 'binary').toString('base64');
  return `data:${part.mimeType};base64,${base64}`;
}

function stringifyToolResult(part: vscode.LanguageModelToolResultPart): string {
  const lines: string[] = [];
  for (const item of part.content) {
    if (item instanceof vscode.LanguageModelTextPart) {
      lines.push(item.value);
    } else if (typeof item === 'string') {
      lines.push(item);
    } else {
      try {
        lines.push(JSON.stringify(item));
      } catch {
        lines.push(String(item));
      }
    }
  }
  return lines.join('\n') || '(no content)';
}

function safeJsonParse(input: string): Record<string, unknown> {
  if (!input) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw: input };
  }
}
