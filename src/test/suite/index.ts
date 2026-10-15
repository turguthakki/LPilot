import * as assert from 'assert';
import * as vscode from 'vscode';
import { setup, suite, test, testWithTimeout } from './registry';

const EXTENSION_ID = 'turguthakki.lpilot';
const DISCOVERY_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 300_000;

suite('LPilot Extension', () => {
  setup(async function () {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not installed`);
    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, 'Extension did not activate');
  });

  test('extension registers the LPilot chat provider', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: 'localllm' });
    assert.ok(Array.isArray(models), 'selectChatModels should return an array');
  });

  test('auto-discovers models from configured endpoints on start', async () => {
    const models = await waitForLPilotModels();
    assert.ok(
      models.length > 0,
      'Expected at least one LPilot model to be discovered. ' +
      'Make sure an OpenAI-compatible server (e.g. http://127.0.0.1:8080) is running.',
    );
    for (const model of models) {
      assert.strictEqual(model.vendor, 'localllm');
      assert.ok(model.maxInputTokens > 0, `maxInputTokens should be positive for ${model.id}`);
      assert.ok(typeof model.name === 'string' && model.name.length > 0, `model name should be set for ${model.id}`);
    }
  });

  test('reports server-detected context length (not just defaults)', async () => {
    const models = await waitForLPilotModels();
    assert.ok(models.length > 0, 'No LPilot models available');

    // LM Studio exposes rich metadata (v0: `data[]`, v1: `models[]`); compare when present.
    const expected = await fetchServerContextLengths();
    if (expected.size > 0) {
      let compared = 0;
      for (const model of models) {
        const upstreamId = model.id.slice(model.id.indexOf(':') + 1);
        const context = expected.get(upstreamId);
        if (context) {
          assert.strictEqual(
            model.maxInputTokens,
            context,
            `Expected detected context ${context} for ${upstreamId}, got ${model.maxInputTokens}`,
          );
          compared += 1;
        }
      }
      assert.ok(compared > 0, 'Expected at least one model with a server-reported context length');
      console.log(`LPilot test: verified detected context length for ${compared} model(s)`);
    } else {
      console.log('LPilot test: server does not expose model metadata, skipping context comparison');
    }
  });

  test('refresh command re-discovers models without errors', async () => {
    await vscode.commands.executeCommand('localllm.refreshModels');
    const models = await waitForLPilotModels();
    assert.ok(models.length > 0, 'Models should still be present after a manual refresh');
  });

  testWithTimeout('"Loaded only" filter hides not-loaded models from VS Code', DISCOVERY_TIMEOUT_MS + 60_000, async () => {
    const serverModels = await fetchServerModels();
    if (serverModels.length === 0) {
      console.log('LPilot test: server does not expose a load state, skipping loaded-only test');
      return;
    }

    const totalModels = serverModels.length;
    const loadedCount = serverModels.filter((m) => !isNotLoaded(m.state)).length;

    // Turn the filter on, refresh, and check VS Code only sees loaded models.
    await vscode.commands.executeCommand('localllm.setLoadedOnly', true);
    const filtered = await waitForModels((models) => models.length === loadedCount);
    assert.strictEqual(
      filtered.length,
      loadedCount,
      `Expected exactly ${loadedCount} loaded models with "Loaded only" on, got ${filtered.length} (of ${totalModels})`,
    );

    // Turn it back off and expect everything again.
    await vscode.commands.executeCommand('localllm.setLoadedOnly', false);
    const unfiltered = await waitForModels((models) => models.length >= totalModels);
    assert.strictEqual(unfiltered.length, totalModels, `Expected all ${totalModels} models with the filter off, got ${unfiltered.length}`);
  });

  test('marks the currently loaded model (LM Studio and llama.cpp style)', async () => {
    const models = await waitForLPilotModels();
    assert.ok(models.length > 0, 'No LPilot models available');

    // LM Studio reports loaded models directly; llama.cpp serves a single loaded
    // model via /props and returns every other model as "not-loaded".
    let expectedLoaded: string[] | undefined;
    try {
      const props = await fetch('http://127.0.0.1:8080/props');
      if (props.ok) {
        const json = (await props.json()) as { model_alias?: string; model_path?: string };
        const id = json.model_alias ?? json.model_path;
        if (id) {
          expectedLoaded = [id.split(/[\\/]/).pop() ?? id];
        }
      }
    } catch {
      expectedLoaded = undefined;
    }
    if (expectedLoaded === undefined) {
      const serverModels = await fetchServerModels();
      expectedLoaded = serverModels
        .filter((m) => !isNotLoaded(m.state))
        .map((m) => m.id.split(/[\\/]/).pop() ?? m.id);
    }
    if (expectedLoaded.length === 0) {
      console.log('LPilot test: server reports no loaded model, skipping');
      return;
    }

    const loaded = models.filter((m) => {
      const upstream = m.id.slice(m.id.indexOf(':') + 1);
      const base = upstream.split(/[\\/]/).pop() ?? upstream;
      return expectedLoaded!.includes(base);
    });
    assert.ok(
      loaded.length > 0,
      `Expected at least one model to be reported as loaded (${expectedLoaded.join(', ')}), got none`,
    );
    console.log(`LPilot test: loaded model(s) detected: ${loaded.map((m) => m.id).join(', ')}`);
  });

  testWithTimeout('prunes models the server no longer reports, keeping manual ones', DISCOVERY_TIMEOUT_MS, async () => {
    const serverModels = await fetchServerModels();
    const serverIds = new Set(serverModels.map((m) => m.id));
    const models = await waitForLPilotModels();
    if (models.length === 0) {
      console.log('LPilot test: no models available, skipping prune test');
      return;
    }

    // Every model VS Code sees must still be reported by the server (or be a
    // manually added one). Stale models are pruned after two discoveries.
    const unknown = models
      .map((m) => m.id.slice(m.id.indexOf(':') + 1))
      .filter((id) => !serverIds.has(id));
    assert.ok(
      unknown.length === 0 || serverModels.length === 0,
      `VS Code still offers models the server does not report: ${unknown.join(', ')}`,
    );

    // Refresh twice to guarantee any stale entry would have been pruned.
    await vscode.commands.executeCommand('localllm.refreshModels');
    await vscode.commands.executeCommand('localllm.refreshModels');
    const after = await waitForLPilotModels();
    const staleAfter = after
      .map((m) => m.id.slice(m.id.indexOf(':') + 1))
      .filter((id) => !serverIds.has(id));
    assert.strictEqual(staleAfter.length, 0, `Stale models survived pruning: ${staleAfter.join(', ')}`);
  });

  test('configuration sidebar view resolves without errors', async () => {
    await vscode.commands.executeCommand('localllm.openConfig');
    // Give the webview time to load its html/scripts.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(true);
  });

  testWithTimeout('sends a chat request through the provider and streams text back', CHAT_TIMEOUT_MS, async () => {
    const models = await waitForLPilotModels();
    assert.ok(models.length > 0, 'No LPilot models available for the chat test');

    const configured = vscode.workspace.getConfiguration('localllm').get<string>('testModel');
    const model = pickTestModel(models, configured);
    console.log(`LPilot test: using model "${model.id}"`);

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('Reply with exactly one word: OK')],
      { justification: 'LPilot integration smoke test' },
    );

    let text = '';
    let chunks = 0;
    try {
      for await (const part of response.text) {
        text += part;
        chunks += 1;
      }
    } catch (err) {
      assert.fail(`Chat request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`LPilot test: received ${chunks} chunk(s), ${text.length} chars: ${JSON.stringify(text.slice(0, 200))}`);
    assert.ok(chunks > 0, 'Expected at least one streamed chunk');
    assert.ok(text.trim().length > 0, 'Expected a non-empty response');
  });

  testWithTimeout('token counting returns a positive estimate', CHAT_TIMEOUT_MS, async () => {
    const models = await waitForLPilotModels();
    const model = pickTestModel(models, vscode.workspace.getConfiguration('localllm').get<string>('testModel'));
    const tokens = await model.countTokens('Hello world, this is a token counting test');
    assert.ok(tokens > 0, `Expected a positive token count, got ${tokens}`);
  });

  async function waitForLPilotModels(): Promise<vscode.LanguageModelChat[]> {
    return waitForModels((models) => models.length > 0);
  }

  /**
   * Reads the server's model list plus load state, supporting LM Studio
   * (`/api/v0/models` `data[].state`, `/api/v1/models` `models[].loaded_instances`)
   * and llama.cpp (`/props` for the single loaded model).
   */
  async function fetchServerModels(): Promise<Array<{ id: string; state?: string }>> {
    const v0 = await fetchJson('/api/v0/models');
    if (v0 && Array.isArray((v0 as any).data)) {
      return (v0 as any).data.map((m: any) => ({ id: String(m.id), state: typeof m.state === 'string' ? m.state : undefined }));
    }
    const v1 = await fetchJson('/api/v1/models');
    if (v1 && Array.isArray((v1 as any).models)) {
      return (v1 as any).models.map((m: any) => ({
        id: String(m.key ?? m.id),
        state: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0 ? 'loaded' : 'not-loaded',
      }));
    }
    const props = await fetchJson('/props');
    if (props && typeof (props as any).model_alias === 'string') {
      const alias = String((props as any).model_alias ?? (props as any).model_path ?? '');
      const base = alias.split(/[\\/]/).pop() ?? alias;
      return [{ id: base, state: 'loaded' }];
    }
    return [];
  }

  async function fetchJson(path: string): Promise<unknown | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:8080${path}`);
      if (!response.ok) {
        return undefined;
      }
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /** Server-reported context lengths, supporting LM Studio v0/v1 and llama.cpp. */
  async function fetchServerContextLengths(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const v0 = await fetchJson('/api/v0/models');
    if (v0 && Array.isArray((v0 as any).data)) {
      for (const m of (v0 as any).data) {
        const context = m.loaded_context_length ?? m.max_context_length;
        if (typeof context === 'number') {
          result.set(String(m.id), context);
        }
      }
      return result;
    }
    const v1 = await fetchJson('/api/v1/models');
    if (v1 && Array.isArray((v1 as any).models)) {
      for (const m of (v1 as any).models) {
        const context = m.max_context_length;
        if (typeof context === 'number') {
          result.set(String(m.key ?? m.id), context);
        }
      }
      return result;
    }
    const props = await fetchJson('/props');
    const alias = typeof (props as any)?.model_alias === 'string' ? String((props as any).model_alias) : undefined;
    const context = (props as any)?.default_generation_settings?.n_ctx ?? (props as any)?.n_ctx;
    if (alias && typeof context === 'number') {
      result.set(alias.split(/[\\/]/).pop() ?? alias, context);
    }
    return result;
  }

  function isNotLoaded(state: string | undefined): boolean {
    if (typeof state !== 'string') {
      return false;
    }
    const normalized = state.trim().toLowerCase();
    return normalized.startsWith('not') || normalized === 'unloaded' || normalized === 'idle';
  }

  /** Polls the LM service until the predicate matches or the timeout hits. */
  async function waitForModels(
    predicate: (models: vscode.LanguageModelChat[]) => boolean,
    timeoutMs = DISCOVERY_TIMEOUT_MS,
  ): Promise<vscode.LanguageModelChat[]> {
    const deadline = Date.now() + timeoutMs;
    let models: vscode.LanguageModelChat[] = [];
    while (Date.now() < deadline) {
      models = await vscode.lm.selectChatModels({ vendor: 'localllm' });
      if (predicate(models)) {
        return models;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return models;
  }

  /** Prefers a tiny model so the smoke test stays fast, else the first available one. */
  function pickTestModel(models: vscode.LanguageModelChat[], configured: string | undefined): vscode.LanguageModelChat {
    if (configured) {
      const match = models.find((m) => m.id === configured);
      if (match) {
        return match;
      }
      console.warn(`Configured test model "${configured}" not found, falling back to auto-selection.`);
    }
    const preferred = ['350m', '1b', '0.5b', '3b', '4b'];
    for (const hint of preferred) {
      const match = models.find((m) => m.id.toLowerCase().includes(hint));
      if (match) {
        return match;
      }
    }
    return models[0];
  }
});
