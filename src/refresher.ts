import * as vscode from 'vscode';
import { discoverModels } from './discovery';
import type { ConfigStore } from './types';
import type { Logger } from './logging';

/**
 * Orchestrates model discovery for endpoints and updates the config store.
 * Shared by the status bar item, commands and the config webview.
 */
export class ModelRefresher {
  private readonly running = new Set<string>();
  private readonly _onDidChangeRefreshing = new vscode.EventEmitter<void>();
  readonly onDidChangeRefreshing = this._onDidChangeRefreshing.event;

  constructor(
    private readonly store: ConfigStore,
    private readonly getDiscoveryTimeoutMs: () => number,
    private readonly logger?: Logger,
  ) { }

  isRefreshing(endpointId?: string): boolean {
    return endpointId ? this.running.has(endpointId) : this.running.size > 0;
  }

  /** Discovers models for one endpoint. Returns an error message or undefined on success. */
  async refreshEndpoint(endpointId: string): Promise<string | undefined> {
    if (this.running.has(endpointId)) {
      return undefined;
    }
    const endpoint = this.store.getEndpoint(endpointId);
    if (!endpoint) {
      return 'Endpoint no longer exists';
    }
    if (!endpoint.enabled) {
      await this.store.clearModels(endpointId);
      await this.store.setDiscoveryStatus(endpointId, { at: Date.now(), ok: true, count: 0 });
      this.logger?.info(`Endpoint "${endpoint.name}" is disabled, cached models cleared`);
      return undefined;
    }

    this.running.add(endpointId);
    this._onDidChangeRefreshing.fire();
    const started = Date.now();
    this.logger?.info(`Discovering models on "${endpoint.name}" (${endpoint.baseUrl}${endpoint.modelsPath})`);
    try {
      const apiKey = await this.store.getApiKey(endpoint);
      const models = await discoverModels(endpoint, apiKey, this.getDiscoveryTimeoutMs());
      await this.store.syncModels(endpointId, models);
      await this.store.setDiscoveryStatus(endpointId, { at: Date.now(), ok: true, count: models.length });
      this.logger?.info(
        `Discovered ${models.length} model(s) on "${endpoint.name}" in ${Date.now() - started}ms: ${models.map((m) => m.id).join(', ')}`,
      );
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.setDiscoveryStatus(endpointId, { at: Date.now(), ok: false, error: message });
      this.logger?.error(`Discovery failed on "${endpoint.name}" (${endpoint.baseUrl}): ${message}`);
      return message;
    } finally {
      this.running.delete(endpointId);
      this._onDidChangeRefreshing.fire();
    }
  }

  async refreshAll(): Promise<Array<{ endpointName: string; error?: string }>> {
    const endpoints = this.store.listEndpoints();
    const results = await Promise.all(
      endpoints.map(async (endpoint) => ({
        endpointName: endpoint.name,
        error: await this.refreshEndpoint(endpoint.id),
      })),
    );
    return results;
  }

  /** Discovery for endpoints flagged for auto-discovery; runs in the background. */
  async refreshAutoDiscoverable(): Promise<void> {
    const endpoints = this.store.listEndpoints().filter((e) => e.enabled && e.autoDiscover);
    await Promise.all(endpoints.map((e) => this.refreshEndpoint(e.id)));
  }
}
