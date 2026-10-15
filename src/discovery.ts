import { buildHeaders, resolveUrl } from './client';
import type { DetectedModelMeta } from './types';
import type { EndpointConfig } from './types';

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
  /** Metadata detected from the server, if the server exposes it. */
  meta?: DetectedModelMeta;
}

interface FetchResult {
  ok: boolean;
  status: number;
  json: any;
}

async function fetchJson(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  url: string,
  timeoutMs: number,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: buildHeaders(endpoint, apiKey),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, json: undefined };
    }
    const text = await response.text();
    try {
      return { ok: true, status: response.status, json: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, json: undefined };
    }
  } catch {
    return { ok: false, status: 0, json: undefined };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the list of models from an endpoint together with any metadata the
 * server exposes (context length, tool calling, vision).
 *
 * Supported model sources:
 * - OpenAI-compatible `GET {modelsPath}` (`data[].id`), e.g. LM Studio, llama.cpp, vLLM
 * - Ollama native `GET /api/tags` (`models[].name`)
 *
 * Metadata sources (best effort, all failures ignored):
 * - LM Studio `GET /api/v0/models` (also `/api/v1/models`)
 * - Ollama native `POST /api/show` per model
 * - llama.cpp `GET /props` (`default_generation_settings.n_ctx`)
 * - OpenAI `GET /v1/models/{id}`
 */
export async function discoverModels(endpoint: EndpointConfig, apiKey: string | undefined, timeoutMs: number): Promise<DiscoveredModel[]> {
  const paths = [endpoint.modelsPath, '/v1/models', '/api/tags']
    .map((p) => (p ?? '').trim())
    .filter((p, i, all) => p.length > 0 && all.indexOf(p) === i);

  const errors: string[] = [];
  for (const path of paths) {
    const result = await fetchJson(endpoint, apiKey, resolveUrl(endpoint.baseUrl, path), timeoutMs);
    if (result.ok) {
      const models = parseModelList(result.json);
      if (models.length > 0) {
        await enrichMetadata(endpoint, apiKey, timeoutMs, models, path);
        return models;
      }
    }
    errors.push(`${path}: ${result.status === 0 ? 'unreachable' : `HTTP ${result.status}`}`);
  }
  throw new Error(`No models discovered. Tried:\n${errors.join('\n')}`);
}

function parseModelList(json: any): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  const push = (id: unknown, ownedBy?: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
      return;
    }
    seen.add(id);
    models.push({ id, ownedBy: typeof ownedBy === 'string' ? ownedBy : undefined });
  };

  // OpenAI-compatible: { data: [{ id }] }
  if (Array.isArray(json?.data)) {
    for (const m of json.data) {
      push(m?.id, m?.owned_by);
    }
  }
  // Ollama native: { models: [{ name }] }
  if (Array.isArray(json?.models)) {
    for (const m of json.models) {
      push(m?.name ?? m?.model ?? m?.id, m?.owned_by);
    }
  }
  // Some servers return a bare array of ids or objects.
  if (Array.isArray(json)) {
    for (const m of json) {
      push(typeof m === 'string' ? m : m?.id, typeof m === 'object' ? m?.owned_by : undefined);
    }
  }

  return models;
}

/** Runs every metadata probe concurrently; each one is allowed to fail silently. */
async function enrichMetadata(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
  listPath: string,
): Promise<void> {
  const isOllamaStyle = listPath.includes('/api/');
  await Promise.all([
    enrichFromLMStudio(endpoint, apiKey, timeoutMs, models),
    enrichFromOllamaShow(endpoint, apiKey, timeoutMs, models, isOllamaStyle),
    enrichFromProps(endpoint, apiKey, timeoutMs, models),
    enrichFromLlamaV1Models(endpoint, apiKey, timeoutMs, models),
    enrichFromOpenAIModelDetail(endpoint, apiKey, timeoutMs, models),
  ]);
}

/**
 * LM Studio native API: `/api/v0/models` (`data[]` with a `state` field) and the
 * newer `/api/v1/models` (`models[]` with `loaded_instances` and nested
 * `capabilities` / `quantization` objects). Both are probed and merged.
 */
async function enrichFromLMStudio(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  await enrichFromLMStudioV0(endpoint, apiKey, timeoutMs, models);
  await enrichFromLMStudioV1(endpoint, apiKey, timeoutMs, models);
}

/** LM Studio `/api/v0/models`: flat entries with a `state` string. */
async function enrichFromLMStudioV0(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  const result = await fetchJson(endpoint, apiKey, resolveUrl(endpoint.baseUrl, '/api/v0/models'), timeoutMs);
  if (!result.ok || !Array.isArray(result.json?.data)) {
    return;
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const entry of result.json.data) {
    const model = byId.get(entry?.id);
    if (!model) {
      continue;
    }
    const capabilities: string[] = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    const type = typeof entry.type === 'string' ? entry.type : 'llm';
    const contextLength = pickNumber(entry.loaded_context_length, entry.max_context_length);
    const detailParts = [entry.publisher, entry.arch, entry.quantization].filter((part) => typeof part === 'string' && part.length > 0);
    model.meta = {
      ...model.meta,
      maxInputTokens: contextLength,
      toolCalling: capabilities.includes('tool_use'),
      imageInput: type === 'vlm' || capabilities.includes('vision'),
      detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
      isEmbedding: type === 'embeddings',
      loadedContextLength: pickNumber(entry.loaded_context_length),
      state: typeof entry.state === 'string' ? entry.state : undefined,
      quantization: typeof entry.quantization === 'string' ? entry.quantization : undefined,
      publisher: typeof entry.publisher === 'string' ? entry.publisher : undefined,
      arch: typeof entry.arch === 'string' ? entry.arch : undefined,
    };
  }
}

/** LM Studio `/api/v1/models`: nested `capabilities`, `quantization` and `loaded_instances`. */
async function enrichFromLMStudioV1(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  const result = await fetchJson(endpoint, apiKey, resolveUrl(endpoint.baseUrl, '/api/v1/models'), timeoutMs);
  if (!result.ok || !Array.isArray(result.json?.models)) {
    return;
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const entry of result.json.models) {
    const id = typeof entry?.key === 'string' ? entry.key : undefined;
    const model = id ? byId.get(id) : undefined;
    if (!model) {
      continue;
    }
    const capabilities = entry.capabilities ?? {};
    const type = typeof entry.type === 'string' ? entry.type : 'llm';
    const loadedInstances: unknown[] = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
    const detailParts = [entry.publisher, entry.architecture, entry.quantization?.name].filter(
      (part) => typeof part === 'string' && part.length > 0,
    );
    model.meta = {
      ...model.meta,
      // v0 (probed first) reports the loaded context, which is the safer limit;
      // only fall back to the model's max context when v0 had nothing.
      maxInputTokens: model.meta?.maxInputTokens ?? pickNumber(entry.max_context_length),
      toolCalling: typeof capabilities.trained_for_tool_use === 'boolean' ? capabilities.trained_for_tool_use : model.meta?.toolCalling,
      imageInput: typeof capabilities.vision === 'boolean' ? capabilities.vision : model.meta?.imageInput,
      detail: detailParts.length > 0 ? detailParts.join(' · ') : model.meta?.detail,
      isEmbedding: type === 'embeddings',
      // v1 reports loaded instances rather than a state string; prefer the v0 state.
      state: model.meta?.state ?? (loadedInstances.length > 0 ? 'loaded' : 'not-loaded'),
      quantization: typeof entry.quantization?.name === 'string' ? entry.quantization.name : model.meta?.quantization,
      publisher: typeof entry.publisher === 'string' ? entry.publisher : model.meta?.publisher,
      arch: typeof entry.architecture === 'string' ? entry.architecture : model.meta?.arch,
      parameterSize: typeof entry.params_string === 'string' ? entry.params_string : model.meta?.parameterSize,
    };
  }
}

/** Ollama native API: POST /api/show returns capabilities and context length. */
async function enrichFromOllamaShow(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
  isOllamaStyle: boolean,
): Promise<void> {
  if (!isOllamaStyle) {
    // Ollama also serves the OpenAI surface; only probe when the list came from /api/.
    return;
  }
  const showUrl = resolveUrl(endpoint.baseUrl, '/api/show');
  const batchSize = 4;
  for (let i = 0; i < models.length; i += batchSize) {
    const batch = models.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (model) => {
        const result = await fetchJson(endpoint, apiKey, showUrl, timeoutMs, 'POST', { model: model.id });
        if (!result.ok) {
          return;
        }
        const json = result.json ?? {};
        const capabilities: string[] = Array.isArray(json.capabilities) ? json.capabilities : [];
        const contextLength = findContextLength(json.model_info);
        const details = json.details ?? {};
        const detailParts = [details.family, details.parameter_size, details.quantization_level].filter(
          (part) => typeof part === 'string' && part.length > 0,
        );
        model.meta = {
          ...model.meta,
          maxInputTokens: contextLength ?? model.meta?.maxInputTokens,
          toolCalling: capabilities.includes('tools'),
          imageInput: capabilities.includes('vision'),
          detail: detailParts.length > 0 ? detailParts.join(' · ') : model.meta?.detail,
          isEmbedding: capabilities.includes('embedding'),
          parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
          quantization: typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
          publisher: typeof details.family === 'string' ? details.family : undefined,
          arch: typeof details.family === 'string' ? details.family : undefined,
        };
      }),
    );
  }
}

/** llama.cpp: GET /props exposes the context size and the currently loaded model. */
async function enrichFromProps(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  const result = await fetchJson(endpoint, apiKey, resolveUrl(endpoint.baseUrl, '/props'), timeoutMs);
  if (!result.ok) {
    return;
  }
  const json = result.json ?? {};
  const contextLength = pickNumber(
    json?.default_generation_settings?.n_ctx,
    json?.n_ctx,
    json?.default_generation_settings?.n_ctx,
  );
  if (contextLength !== undefined) {
    for (const model of models) {
      model.meta = { ...model.meta, maxInputTokens: model.meta?.maxInputTokens ?? contextLength };
    }
  }

  // llama.cpp only serves /props when a model is loaded; the loaded model is
  // named by `model_alias` (falling back to `model_path`).
  const loadedIds = collectLlamaLoadedIds(json);
  if (loadedIds.length === 0) {
    return;
  }
  for (const model of models) {
    const loaded = loadedIds.some((id) => matchesModelId(id, model.id));
    model.meta = {
      ...model.meta,
      state: loaded ? 'loaded' : 'not-loaded',
      loadedContextLength: loaded ? contextLength ?? model.meta?.loadedContextLength : model.meta?.loadedContextLength,
    };
  }
}

/** llama.cpp OpenAI surface: `data[].meta` carries GGUF metadata (no load state). */
async function enrichFromLlamaV1Models(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  const result = await fetchJson(endpoint, apiKey, resolveUrl(endpoint.baseUrl, '/v1/models'), timeoutMs);
  if (!result.ok || !Array.isArray(result.json?.data)) {
    return;
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const entry of result.json.data) {
    const model = byId.get(entry?.id);
    const meta = entry?.meta;
    if (!model || !meta || typeof meta !== 'object') {
      continue;
    }
    const contextLength = pickNumber(meta.n_ctx, meta.n_ctx_train);
    model.meta = {
      ...model.meta,
      maxInputTokens: contextLength ?? model.meta?.maxInputTokens,
      quantization: typeof meta.ftype === 'string' ? meta.ftype : model.meta?.quantization,
      parameterSize: typeof meta.n_params === 'number' ? `${Math.round(meta.n_params / 1e9)}B` : model.meta?.parameterSize,
    };
  }
}

/** Extracts the ids of the model(s) llama.cpp reports as loaded via /props. */
function collectLlamaLoadedIds(json: any): string[] {
  const ids: string[] = [];
  for (const value of [json?.model_alias, json?.model_path, json?.model]) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    const segments = value.split(/[\\/]/);
    ids.push(value, segments[segments.length - 1]);
  }
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

/** True when a server-reported loaded id matches a discovered model id. */
function matchesModelId(loadedId: string, modelId: string): boolean {
  if (loadedId === modelId) {
    return true;
  }
  const base = (value: string) => value.split(/[\\/]/).pop() ?? value;
  return base(loadedId) === base(modelId);
}

/** OpenAI-compatible GET /v1/models/{id}: parse anything richer the server returns. */
async function enrichFromOpenAIModelDetail(
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  timeoutMs: number,
  models: DiscoveredModel[],
): Promise<void> {
  const batchSize = 4;
  for (let i = 0; i < models.length; i += batchSize) {
    const batch = models.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (model) => {
        if (model.meta?.maxInputTokens !== undefined && model.meta?.toolCalling !== undefined) {
          return;
        }
        const url = `${resolveUrl(endpoint.baseUrl, '/v1/models')}/${encodeURIComponent(model.id)}`;
        const result = await fetchJson(endpoint, apiKey, url, timeoutMs);
        if (!result.ok) {
          return;
        }
        const json = result.json ?? {};
        const contextLength = pickNumber(
          json.context_length,
          json.max_context_length,
          json.context_window,
          json.metadata?.context_length,
        );
        const toolCalling = typeof json.capabilities?.tool_calling === 'boolean'
          ? json.capabilities.tool_calling
          : undefined;
        if (contextLength !== undefined || toolCalling !== undefined) {
          model.meta = { ...model.meta, maxInputTokens: contextLength ?? model.meta?.maxInputTokens, toolCalling };
        }
      }),
    );
  }
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

/** Finds a `<arch>.context_length` entry in Ollama's model_info object. */
function findContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return undefined;
  }
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('context_length') && typeof value === 'number' && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}
