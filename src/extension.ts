import * as vscode from 'vscode';
import { ConfigStore, isModelListed } from './types';
import { LocalLLMProvider } from './provider';
import { ModelRefresher } from './refresher';
import { ConfigViewProvider } from './webview';
import { StatusBarController } from './statusbar';
import { Logger } from './logging';

export const VENDOR_ID = 'localllm';

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('localllm');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  const store = new ConfigStore(context);
  await store.initialize();

  logger.info('Extension activating');
  logger.info(`Endpoints: ${store.listEndpoints().map((e) => `${e.name} -> ${e.baseUrl}${e.enabled ? '' : ' (disabled)'}`).join(', ') || '(none)'}`);

  const refresher = new ModelRefresher(store, () => getConfig().get<number>('discoveryTimeoutMs', 15000), logger);
  const provider = new LocalLLMProvider(store, () => getConfig().get<number>('requestTimeoutMs', 300000), logger);

  // Registers every enabled endpoint model with VS Code's chat model picker.
  context.subscriptions.push(
    provider,
    vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider),
  );

  const viewProvider = new ConfigViewProvider(context, store, refresher);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConfigViewProvider.viewType, viewProvider),
    viewProvider,
  );

  const statusBar = new StatusBarController(store, refresher);
  context.subscriptions.push(statusBar, logger);

  context.subscriptions.push(
    vscode.commands.registerCommand('localllm.showLogs', () => logger.show()),

    vscode.commands.registerCommand('localllm.openConfig', async () => {
      await vscode.commands.executeCommand(`${ConfigViewProvider.viewType}.focus`);
    }),

    vscode.commands.registerCommand('localllm.addEndpoint', async () => {
      await vscode.commands.executeCommand(`${ConfigViewProvider.viewType}.focus`);
      viewProvider.openAddEndpointForm();
    }),

    vscode.commands.registerCommand('localllm.refreshModels', async () => {
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'LPilot: discovering models...' },
        () => refresher.refreshAll(),
      );
      const failures = results.filter((r) => r.error);
      if (failures.length > 0) {
        const channel = vscode.window.createOutputChannel('LPilot');
        for (const failure of failures) {
          channel.appendLine(`[${new Date().toISOString()}] ${failure.endpointName}: ${failure.error ?? 'failed'}`);
        }
        const picked = await vscode.window.showErrorMessage(
          `LPilot: failed to discover models on ${failures.map((f) => f.endpointName).join(', ')}`,
          'Show Details',
          'Open Configuration',
        );
        if (picked === 'Show Details') {
          channel.show();
        } else if (picked === 'Open Configuration') {
          await vscode.commands.executeCommand('localllm.openConfig');
        }
      } else if (results.length > 0) {
        vscode.window.showInformationMessage(
          `LPilot: refreshed ${results.length} endpoint${results.length === 1 ? '' : 's'}.`,
        );
      } else {
        vscode.window.showWarningMessage('LPilot: no endpoints configured.');
      }
    }),

    vscode.commands.registerCommand('localllm.setTestModel', async () => {
      const models = store
        .listModels()
        .filter((m) => isModelListed(store.getEndpoint(m.endpointId), m))
        .sort((a, b) => a.modelId.localeCompare(b.modelId));
      if (models.length === 0) {
        vscode.window.showWarningMessage('LPilot: no models available. Run "Refresh Models" first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.modelId, description: m.key, model: m })),
        { title: 'Select the model used by integration tests' },
      );
      if (picked) {
        await getConfig().update('testModel', picked.model.key, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`LPilot: test model set to "${picked.model.modelId}".`);
      }
    }),

    vscode.commands.registerCommand('localllm.setLoadedOnly', async (value?: boolean) => {
      const loadedOnly = typeof value === 'boolean' ? value : !store.listEndpoints().some((e) => e.loadedOnly);
      for (const endpoint of store.listEndpoints()) {
        await store.updateEndpoint(endpoint.id, { loadedOnly });
      }
      await refresher.refreshAll();
      logger.info(`"Loaded only" filter set to ${loadedOnly} on all endpoints`);
    }),
  );

  // Auto-discover models on start (background, non-blocking).
  if (getConfig().get<boolean>('autoDiscoverOnStart', true)) {
    logger.info('Auto-discovering models on start');
    void refresher.refreshAutoDiscoverable().then(() => {
      const active = store.listModels().filter((m) => store.getEndpoint(m.endpointId)?.enabled && m.enabled).length;
      logger.info(`Startup discovery finished: ${active} model(s) available to VS Code`);
    });
  }
}

export function deactivate(): void {
  /* nothing to clean up, all disposables are registered on context.subscriptions */
}
