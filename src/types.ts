import * as vscode from 'vscode';
import type { DiscoveredModel } from './discovery';

/** Free-form parameters merged into chat completion request bodies. */
export type RequestParams = Record<string, unknown>;

export interface DiscoveryStatus {
  at: number;
  ok: boolean;
  count?: number;
  error?: string;
}

export interface EndpointConfig {
  id: string;
  name: string;
  /** Base URL of the server, e.g. `http://127.0.0.1:8080` or `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Header used to send the API key, e.g. `Authorization`. Empty means no auth header. */
  authHeader: string;
  /** Prefix used in front of the API key, e.g. `Bearer `. */
  authPrefix: string;
  /** Path used to list models, e.g. `/v1/models`. */
  modelsPath: string;
  /** Path used for chat completions, e.g. `/v1/chat/completions`. */
  chatPath: string;
  /** Additional headers sent with every request. */
  headers: Record<string, string>;
  /** Default parameters merged into every chat completion request body. */
  params: RequestParams;
  enabled: boolean;
  autoDiscover: boolean;
  /** When true, models the server reports as not loaded are not offered to VS Code. */
  loadedOnly: boolean;
  lastDiscovery?: DiscoveryStatus;
}

export interface ModelConfig {
  /** Stable key, `${endpointId}:${modelId}`, also used as the LanguageModelChatInformation id. */
  key: string;
  endpointId: string;
  /** Upstream model identifier, e.g. `llama-3.2-3b-instruct.q8_0.gguf`. */
  modelId: string;
  name: string;
  family: string;
  detail: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  enabled: boolean;
  /** Parameters merged on top of the endpoint defaults for this model. */
  params: RequestParams;
  /** Metadata detected from the server, refreshed on every discovery. */
  detected?: DetectedModelMeta;
  /** Fields the user edited in the config UI; discovery never overwrites these. */
  userSet?: string[];
  /** How the model entered the list: discovered from the server or added by the user. */
  origin?: 'discovered' | 'user';
  /** Number of consecutive discoveries that did not report this model (cleared when seen again). */
  missingCount?: number;
}

export interface LocalLLMState {
  endpoints: EndpointConfig[];
  /** Keyed by `ModelConfig.key`. */
  models: Record<string, ModelConfig>;
}

/** Metadata detected from the server during model discovery. */
export interface DetectedModelMeta {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  family?: string;
  detail?: string;
  isEmbedding?: boolean;
  /** Context length the model was loaded with, when the server reports one. */
  loadedContextLength?: number;
  /** Server-side load state, e.g. `loaded` / `not-loaded`. */
  state?: string;
  quantization?: string;
  publisher?: string;
  arch?: string;
  parameterSize?: string;
}

/** Fields that discovery auto-tracks until the user overrides them in the UI. */
const AUTO_TRACKED_FIELDS = ['name', 'family', 'detail', 'maxInputTokens', 'maxOutputTokens', 'toolCalling', 'imageInput'] as const;

/**
 * Applies freshly detected metadata to a model config. Fields the user has
 * explicitly customized are left untouched.
 */
export function applyDetection(model: ModelConfig, detected: DetectedModelMeta): ModelConfig {
  const updated: ModelConfig = { ...model, detected: { ...model.detected, ...detected } };
  const detectedMeta = detected as unknown as Record<string, unknown>;
  for (const field of AUTO_TRACKED_FIELDS) {
    if (detectedMeta[field] === undefined) {
      continue;
    }
    if (updated.userSet?.includes(field)) {
      continue;
    }
    (updated as unknown as Record<string, unknown>)[field] = detectedMeta[field];
  }
  return updated;
}

export interface WebviewEndpoint extends EndpointConfig {
  /** Never exposes the key value itself, only whether one is stored. */
  hasApiKey: boolean;
  models: ModelConfig[];
}

export interface WebviewState {
  endpoints: WebviewEndpoint[];
  refreshInProgress: boolean;
}

export const DEFAULT_MAX_INPUT_TOKENS = 8192;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function createDefaultEndpoint(partial?: Partial<EndpointConfig>): EndpointConfig {
  return {
    id: partial?.id ?? `ep-${Math.random().toString(36).slice(2, 10)}`,
    name: partial?.name ?? 'Local Server',
    baseUrl: partial?.baseUrl ?? 'http://127.0.0.1:8080',
    authHeader: partial?.authHeader ?? 'Authorization',
    authPrefix: partial?.authPrefix ?? 'Bearer ',
    modelsPath: partial?.modelsPath ?? '/v1/models',
    chatPath: partial?.chatPath ?? '/v1/chat/completions',
    headers: partial?.headers ?? {},
    params: partial?.params ?? { temperature: 0.7 },
    enabled: partial?.enabled ?? true,
    autoDiscover: partial?.autoDiscover ?? true,
    loadedOnly: partial?.loadedOnly ?? false,
    lastDiscovery: partial?.lastDiscovery,
  };
}

export function createDefaultModel(endpointId: string, modelId: string, partial?: Partial<ModelConfig>): ModelConfig {
  return {
    key: `${endpointId}:${modelId}`,
    endpointId,
    modelId,
    name: partial?.name ?? modelId,
    family: partial?.family ?? modelId,
    detail: partial?.detail ?? '',
    maxInputTokens: partial?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: partial?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    imageInput: partial?.imageInput ?? false,
    toolCalling: partial?.toolCalling ?? false,
    enabled: partial?.enabled ?? true,
    params: partial?.params ?? {},
    origin: partial?.origin ?? 'discovered',
  };
}

const STORAGE_KEY = 'localllm.state.v1';
const SECRET_PREFIX = 'localllm.endpointApiKey.';

/**
 * How many consecutive discoveries must pass without a server reporting a model
 * before it is pruned. 2 strikes means an unreported model survives exactly one
 * discovery (e.g. a temporarily unavailable server) before being removed.
 */
export const MODEL_MISS_THRESHOLD = 2;

/**
 * True when a model may be pruned after the server stopped reporting it.
 * User-added models and models the user explicitly customized are kept.
 */
export function isPrunableModel(model: ModelConfig): boolean {
  if (model.origin === 'user') {
    return false;
  }
  if (model.userSet && model.userSet.length > 0) {
    return false;
  }
  return true;
}

/**
 * Stores endpoints, model metadata and API key secrets.
 * API keys are kept in `context.secrets`, everything else in global state.
 */
export class ConfigStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private state: LocalLLMState = { endpoints: [], models: {} };

  constructor(private readonly context: vscode.ExtensionContext) { }

  async initialize(): Promise<void> {
    const stored = this.context.globalState.get<LocalLLMState | undefined>(STORAGE_KEY);
    if (stored && Array.isArray(stored.endpoints)) {
      this.state = {
        endpoints: stored.endpoints.map((e) => createDefaultEndpoint(e)),
        models: stored.models ?? {},
      };
    } else {
      const endpoint = createDefaultEndpoint({
        name: 'Local Server (127.0.0.1:8080)',
        baseUrl: 'http://127.0.0.1:8080',
      });
      this.state = { endpoints: [endpoint], models: {} };
    }
    await this.migrate();
    await this.save();
  }

  /**
   * One-time migrations over stored state.
   * v2: chats' agent mode only lists models with tool calling, so existing
   * discoveries are opted in (except obvious non-chat models).
   */
  private async migrate(): Promise<void> {
    const migrationKey = 'localllm.migrated.toolCalling.v2';
    if (this.context.globalState.get<boolean>(migrationKey)) {
      return;
    }
    let changed = false;
    for (const model of Object.values(this.state.models)) {
      if (!model.toolCalling && !looksLikeNonChatModel(model.modelId)) {
        model.toolCalling = true;
        changed = true;
      }
    }
    await this.context.globalState.update(migrationKey, true);
    if (changed) {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, {
      endpoints: this.state.endpoints,
      models: this.state.models,
    });
    this._onDidChange.fire();
  }

  getState(): LocalLLMState {
    return JSON.parse(JSON.stringify(this.state)) as LocalLLMState;
  }

  listEndpoints(): EndpointConfig[] {
    return this.state.endpoints;
  }

  getEndpoint(id: string): EndpointConfig | undefined {
    return this.state.endpoints.find((e) => e.id === id);
  }

  listModels(): ModelConfig[] {
    return Object.values(this.state.models);
  }

  listModelsForEndpoint(endpointId: string): ModelConfig[] {
    return Object.values(this.state.models).filter((m) => m.endpointId === endpointId);
  }

  getModel(key: string): ModelConfig | undefined {
    return this.state.models[key];
  }

  async addEndpoint(partial: Partial<EndpointConfig>, apiKey?: string): Promise<EndpointConfig> {
    const endpoint = createDefaultEndpoint(partial);
    this.state.endpoints.push(endpoint);
    if (apiKey) {
      await this.context.secrets.store(SECRET_PREFIX + endpoint.id, apiKey);
    }
    await this.save();
    return endpoint;
  }

  /** Updates an endpoint. Pass `apiKey: null` to remove the stored secret. */
  async updateEndpoint(id: string, patch: Partial<EndpointConfig> & { apiKey?: string | null }): Promise<void> {
    const endpoint = this.getEndpoint(id);
    if (!endpoint) {
      return;
    }
    const { apiKey, ...rest } = patch;
    Object.assign(endpoint, rest);
    if (apiKey !== undefined) {
      if (apiKey) {
        await this.context.secrets.store(SECRET_PREFIX + id, apiKey);
      } else {
        await this.context.secrets.delete(SECRET_PREFIX + id);
      }
    }
    await this.save();
  }

  async removeEndpoint(id: string): Promise<void> {
    this.state.endpoints = this.state.endpoints.filter((e) => e.id !== id);
    for (const key of Object.keys(this.state.models)) {
      if (this.state.models[key].endpointId === id) {
        delete this.state.models[key];
      }
    }
    await this.context.secrets.delete(SECRET_PREFIX + id);
    await this.save();
  }

  async getApiKey(endpoint: EndpointConfig): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + endpoint.id);
  }

  /**
   * Reconciles the cached models of an endpoint with the freshly discovered ids.
   *
   * - Models the server still reports are updated in place (user overrides kept).
   * - Models the server no longer reports are pruned, *except* user-added models
   *   and models the user customized (`origin: 'user'` / `userSet`). Those are
   *   only removed by hand from the configuration UI.
   */
  async syncModels(endpointId: string, discovered: DiscoveredModel[]): Promise<ModelConfig[]> {
    const existing = this.state.models;
    const seen = new Set<string>();

    for (const discoveredModel of discovered) {
      const modelId = discoveredModel.id;
      const key = `${endpointId}:${modelId}`;
      seen.add(key);
      const meta = discoveredModel.meta;
      if (existing[key]) {
        // Keep the user's overrides but make sure it points at the right endpoint.
        existing[key].endpointId = endpointId;
        existing[key].missingCount = 0;
        if (meta) {
          existing[key] = applyDetection(existing[key], meta);
        } else {
          // The server did not report a state; drop any stale load state so a
          // model that disappeared from memory is not left marked "loaded".
          existing[key].detected = withoutLoadState(existing[key].detected);
        }
      } else {
        const model = createDefaultModel(endpointId, modelId, {
          family: guessFamily(modelId),
          toolCalling: !looksLikeNonChatModel(modelId),
        });
        existing[key] = meta ? applyDetection(model, meta) : model;
      }
    }

    for (const key of Object.keys(existing)) {
      const model = existing[key];
      if (model.endpointId !== endpointId || seen.has(key)) {
        continue;
      }
      if (!isPrunableModel(model)) {
        continue;
      }
      model.missingCount = (model.missingCount ?? 0) + 1;
      if (model.missingCount >= MODEL_MISS_THRESHOLD) {
        delete existing[key];
      }
    }

    await this.save();
    return this.listModelsForEndpoint(endpointId);
  }

  /** Removes a single cached model (used by the configuration UI). */
  async removeModel(key: string): Promise<void> {
    if (this.state.models[key]) {
      delete this.state.models[key];
      await this.save();
    }
  }

  /** Removes every cached model of an endpoint (e.g. after disabling it). */
  async clearModels(endpointId: string): Promise<void> {
    for (const key of Object.keys(this.state.models)) {
      if (this.state.models[key].endpointId === endpointId) {
        delete this.state.models[key];
      }
    }
    await this.save();
  }

  async upsertModel(key: string, patch: Partial<ModelConfig>): Promise<void> {
    const model = this.state.models[key];
    if (!model) {
      return;
    }
    Object.assign(model, patch);
    await this.save();
  }

  async setDiscoveryStatus(endpointId: string, status: DiscoveryStatus): Promise<void> {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) {
      return;
    }
    endpoint.lastDiscovery = status;
    await this.save();
  }
}

/** Heuristic family guess from a model id, e.g. `gemma-3-4b@q4_k_m` -> `gemma-3-4b`. */
function guessFamily(modelId: string): string {
  return modelId.split('@')[0].split(':')[0].trim() || modelId;
}

/**
 * Drops the load-state fields from detected metadata. Used when a discovery
 * pass reports a model without any load state (e.g. llama.cpp), so a model that
 * is no longer in memory does not stay marked as loaded.
 */
function withoutLoadState(detected: DetectedModelMeta | undefined): DetectedModelMeta | undefined {
  if (!detected) {
    return detected;
  }
  const next = { ...detected };
  delete next.state;
  delete next.loadedContextLength;
  return next;
}

/** Embedding/reranking models are not chat models and don't support tool calling. */
function looksLikeNonChatModel(modelId: string): boolean {
  return /\b(embed|embedding|bge|gte-|e5-|rerank)\b/i.test(modelId);
}

/**
 * True when an endpoint's "loaded only" filter lets a model through.
 * Servers that don't report a load state always pass.
 */
export function isModelEnabledByFilter(endpoint: EndpointConfig, model: ModelConfig): boolean {
  if (!endpoint.loadedOnly) {
    return true;
  }
  const state = model.detected?.state;
  // Only hide models the server *explicitly* reports as not loaded. Servers that
  // don't expose a load state (many OpenAI-compatible ones) keep every model.
  return state === undefined || !isExplicitlyNotLoaded(state);
}

/** True when a server-reported state string means "not currently in memory". */
export function isExplicitlyNotLoaded(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized.startsWith('not') || normalized === 'unloaded' || normalized === 'idle';
}

/** Parses a stored string-array field, tolerating legacy/corrupt values. */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** True when a model is offered to VS Code (enabled model, enabled endpoint, passes loaded-only filter). */
export function isModelListed(endpoint: EndpointConfig | undefined, model: ModelConfig): boolean {
  if (!endpoint || !endpoint.enabled || !model.enabled) {
    return false;
  }
  return isModelEnabledByFilter(endpoint, model);
}
