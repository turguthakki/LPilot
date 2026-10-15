import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigStore, WebviewState } from './types';
import type { ModelRefresher } from './refresher';

/** Sidebar webview that manages endpoints, API keys, parameters and discovered models. */
export class ConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localllm.configView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConfigStore,
    private readonly refresher: ModelRefresher,
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const messageSub = webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message));
    const stateSub = this.store.onDidChange(() => this.postState());
    const refreshSub = this.refresher.onDidChangeRefreshing(() => this.postState());

    webviewView.onDidDispose(() => {
      this.view = undefined;
      messageSub.dispose();
      stateSub.dispose();
      refreshSub.dispose();
    });
    this.disposables.push(messageSub, stateSub, refreshSub);

    this.postState();
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const nonce = getNonce();
    const template = fs.readFileSync(path.join(mediaDir.fsPath, 'index.html'), 'utf8');
    return template
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{scriptUri\}/g, webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js')).toString())
      .replace(/\$\{codiconUri\}/g, webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'codicon.css')).toString())
      .replace(/\$\{styleUri\}/g, webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'style.css')).toString());
  }

  private async buildState(): Promise<WebviewState> {
    const endpoints = this.store.listEndpoints();
    const webviewEndpoints: WebviewState['endpoints'] = [];
    for (const endpoint of endpoints) {
      webviewEndpoints.push({
        ...endpoint,
        hasApiKey: Boolean(await this.store.getApiKey(endpoint)),
        models: this.store
          .listModelsForEndpoint(endpoint.id)
          .map((m) => ({ ...m }))
          .sort((a, b) => a.modelId.localeCompare(b.modelId)),
      });
    }
    return { endpoints: webviewEndpoints, refreshInProgress: this.refresher.isRefreshing() };
  }

  postState(): void {
    void this.buildState().then((state) => {
      void this.view?.webview.postMessage({ type: 'state', state });
    });
  }

  /** Asks the webview to reveal the "add endpoint" form. */
  openAddEndpointForm(): void {
    void this.view?.webview.postMessage({ type: 'openAdd' });
  }

  private postToast(level: 'info' | 'error', text: string): void {
    void this.view?.webview.postMessage({ type: 'toast', level, text });
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.postState();
        break;
      case 'saveEndpoint': {
        const endpoint = message.endpoint ?? {};
        const apiKey = message.apiKey;
        let savedId: string | undefined;
        if (typeof endpoint.id === 'string' && this.store.getEndpoint(endpoint.id)) {
          await this.store.updateEndpoint(endpoint.id, { ...endpoint, apiKey });
          savedId = endpoint.id;
        } else {
          const added = await this.store.addEndpoint(endpoint, typeof apiKey === 'string' && apiKey ? apiKey : undefined);
          savedId = added.id;
        }
        // Saving an endpoint discovers its models so the new settings take effect.
        if (savedId) {
          await this.refresher.refreshEndpoint(savedId);
        }
        this.postState();
        break;
      }
      case 'removeEndpoint':
        if (typeof message.id === 'string') {
          await this.store.removeEndpoint(message.id);
        }
        break;
      case 'refreshEndpoint':
        if (typeof message.id === 'string') {
          await this.refresher.refreshEndpoint(message.id);
        }
        break;
      case 'refreshAll': {
        const results = await this.refresher.refreshAll();
        const failures = results.filter((r) => r.error);
        if (failures.length > 0) {
          this.postToast('error', `Failed: ${failures.map((f) => f.endpointName).join(', ')}`);
        } else if (results.length > 0) {
          this.postToast('info', `Refreshed ${results.length} endpoint${results.length === 1 ? '' : 's'}`);
        }
        this.postState();
        break;
      }
      case 'updateModel': {
        const key = String(message.key ?? '');
        const patch = message.patch ?? {};
        await this.store.upsertModel(key, patch);
        break;
      }
      case 'removeModel': {
        const key = String(message.key ?? '');
        await this.store.removeModel(key);
        break;
      }
      case 'addModel': {
        const endpointId = String(message.endpointId ?? '');
        const modelId = String(message.modelId ?? '').trim();
        if (endpointId && modelId && !this.store.getModel(`${endpointId}:${modelId}`)) {
          const existing = this.store.listModelsForEndpoint(endpointId).map((m) => ({ id: m.modelId }));
          await this.store.syncModels(endpointId, [...existing, { id: modelId }]);
          // Models added by hand are kept even when the server stops reporting them.
          await this.store.upsertModel(`${endpointId}:${modelId}`, { origin: 'user' });
        }
        break;
      }
      default:
        break;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
