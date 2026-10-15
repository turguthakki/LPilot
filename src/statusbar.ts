import * as vscode from 'vscode';
import { isModelListed } from './types';
import type { ConfigStore } from './types';
import type { ModelRefresher } from './refresher';

/**
 * Status bar item showing how many LocalLLM models are available and whether
 * discovery failed. Clicking it refreshes every endpoint.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConfigStore,
    private readonly refresher: ModelRefresher,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'localllm.refreshModels';
    this.item.name = 'LPilot';
    this.item.show();
    this.update();

    this.disposables.push(
      store.onDidChange(() => this.update()),
      refresher.onDidChangeRefreshing(() => this.update()),
    );
  }

  private update(): void {
    const endpoints = this.store.listEndpoints();
    const models = this.store.listModels();
    const activeModels = models.filter((m) => {
      const endpoint = endpoints.find((e) => e.id === m.endpointId);
      return isModelListed(endpoint, m);
    }).length;

    const failures = endpoints.filter((e) => e.enabled && e.lastDiscovery && !e.lastDiscovery.ok).length;
    const icon = this.refresher.isRefreshing() ? '$(sync~spin)' : failures > 0 ? '$(warning)' : '$(robot)';
    this.item.text = failures > 0
      ? `${icon} LPilot: ${activeModels} model${activeModels === 1 ? '' : 's'} (${failures} error${failures === 1 ? '' : 's'})`
      : `${icon} LPilot: ${activeModels} model${activeModels === 1 ? '' : 's'}`;

    const lines = ['LPilot models', '', 'Click to refresh all endpoints', ''];
    for (const endpoint of endpoints) {
      if (!endpoint.enabled) {
        lines.push(`$(circle-slash) ${endpoint.name} (disabled)`);
        continue;
      }
      const status = endpoint.lastDiscovery;
      if (!status) {
        lines.push(`$(question) ${endpoint.name} (not discovered yet)`);
      } else if (status.ok) {
        lines.push(`$(check) ${endpoint.name} - ${status.count ?? 0} models - ${new Date(status.at).toLocaleTimeString()}`);
      } else {
        lines.push(`$(error) ${endpoint.name} - ${status.error ?? 'discovery failed'}`);
      }
    }
    this.item.tooltip = new vscode.MarkdownString(lines.join('\n  \n'));
    this.item.accessibilityInformation = { label: `LocalLLM: ${activeModels} models available. Activate to refresh.` };
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
