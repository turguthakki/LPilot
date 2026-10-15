(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{ endpoints: any[], refreshInProgress: boolean }} */
  let state = { endpoints: [], refreshInProgress: false };
  const drafts = {};
  const expanded = new Set();
  let addFormOpen = false;
  let initialExpandDone = false;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    if (msg.type === 'state') {
      const previousSelected = new Set(expanded);
      state = msg.state;
      if (!initialExpandDone && state.endpoints.length > 0) {
        expanded.add(state.endpoints[0].id);
        initialExpandDone = true;
      } else {
        expanded.clear();
        for (const endpoint of state.endpoints) {
          if (previousSelected.has(endpoint.id)) {
            expanded.add(endpoint.id);
          }
        }
      }
      render();
    } else if (msg.type === 'toast') {
      showToast(msg.level, msg.text);
    } else if (msg.type === 'openAdd') {
      addFormOpen = true;
      render();
    }
  });

  function post(message) {
    vscode.postMessage(message);
  }

  /**
   * In-webview confirmation dialog. `window.confirm()` is a no-op inside VS Code
   * webviews (it always returns undefined), so it can never gate an action.
   * Returns a promise resolving to true (confirmed) or false (cancelled).
   */
  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const overlay = h('div', { class: 'modal-overlay' });
      const close = (result) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          close(false);
        }
      };
      const confirmBtn = h('button', {
        class: `btn ${danger ? 'danger' : 'primary'}`,
        text: confirmLabel,
        onclick: () => close(true),
      });
      const cancelBtn = h('button', { class: 'btn', text: 'Cancel', onclick: () => close(false) });
      const dialog = h('div', { class: 'modal' },
        h('div', { class: 'modal-title', text: title }),
        message ? h('div', { class: 'modal-body', text: message }) : null,
        h('div', { class: 'modal-actions' }, cancelBtn, confirmBtn),
      );
      overlay.append(dialog);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          close(false);
        }
      });
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      confirmBtn.focus();
    });
  }

  function showToast(level, text) {
    const toast = document.getElementById('toast');
    toast.textContent = text;
    toast.className = `toast ${level === 'error' ? 'error' : ''}`;
    setTimeout(() => toast.classList.add('hidden'), 6000);
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) {
          continue;
        }
        if (key === 'class') {
          el.className = value;
        } else if (key === 'text') {
          el.textContent = value;
        } else if (key === 'value') {
          el.value = value;
        } else if (key === 'title') {
          el.title = value;
        } else if (key === 'checked' || key === 'disabled') {
          el[key] = Boolean(value);
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          el.setAttribute(key, String(value));
        }
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function displayValue(value) {
    if (value === undefined || value === null) {
      return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  function parseValue(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') {
      return '';
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Mirrors isExplicitlyNotLoaded() in src/types.ts. */
  function isExplicitlyNotLoaded(state) {
    if (typeof state !== 'string') {
      return false;
    }
    const normalized = state.trim().toLowerCase();
    return normalized.startsWith('not') || normalized === 'unloaded' || normalized === 'idle';
  }

  function getDraft(endpoint) {
    if (!drafts[endpoint.id]) {
      drafts[endpoint.id] = {
        name: endpoint.name ?? '',
        baseUrl: endpoint.baseUrl ?? '',
        authHeader: endpoint.authHeader ?? '',
        authPrefix: endpoint.authPrefix ?? '',
        modelsPath: endpoint.modelsPath ?? '',
        chatPath: endpoint.chatPath ?? '',
        enabled: endpoint.enabled,
        autoDiscover: endpoint.autoDiscover,
        loadedOnly: Boolean(endpoint.loadedOnly),
        headers: Object.entries(endpoint.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        params: Object.entries(endpoint.params ?? {}).map(([key, value]) => ({ key, value: displayValue(value) })),
        apiKey: '',
      };
    }
    return drafts[endpoint.id];
  }

  function mapToObject(rows) {
    const result = {};
    for (const row of rows) {
      const key = String(row.key ?? '').trim();
      if (key) {
        result[key] = row.value;
      }
    }
    return result;
  }

  function saveDraft(endpoint, overrides) {
    const draft = getDraft(endpoint);
    const merged = { ...draft, ...(overrides ?? {}) };
    Object.assign(draft, merged);
    const message = {
      type: 'saveEndpoint',
      endpoint: {
        id: endpoint.id,
        name: merged.name,
        baseUrl: merged.baseUrl,
        authHeader: merged.authHeader,
        authPrefix: merged.authPrefix,
        modelsPath: merged.modelsPath,
        chatPath: merged.chatPath,
        enabled: merged.enabled,
        autoDiscover: merged.autoDiscover,
        loadedOnly: Boolean(merged.loadedOnly),
        headers: mapToObject(merged.headers),
        params: mapToObject(merged.params),
      },
    };
    const apiKey = overrides && 'apiKey' in overrides ? overrides.apiKey : merged.apiKey;
    // Only send the key when it changed (typed) or was explicitly removed (null).
    if (apiKey === null || (typeof apiKey === 'string' && apiKey.length > 0)) {
      message.apiKey = apiKey;
    }
    post(message);
  }

  function removeKey(endpoint) {
    saveDraft(endpoint, { apiKey: null });
    showToast('info', 'API key removed');
  }

  const expandedModels = new Set();

  const addUserField = (userSet, field) => (userSet && userSet.includes(field) ? userSet : [...(userSet ?? []), field]);

  // ---------------------------------------------------------------- rendering

  function render() {
    const root = document.getElementById('endpoints');
    root.textContent = '';

    const summary = summarize();
    document.getElementById('subtitle').textContent = summary;

    const refreshAll = document.getElementById('refresh-all');
    refreshAll.disabled = state.refreshInProgress;
    refreshAll.replaceChildren(
      h('span', { class: `codicon codicon-refresh${state.refreshInProgress ? ' spin' : ''}` }),
      document.createTextNode(state.refreshInProgress ? ' Refreshing…' : ' Refresh all'),
    );

    if (state.endpoints.length === 0) {
      root.append(h('div', { class: 'empty', text: 'No endpoints configured. Click "Add endpoint" to get started.' }));
    }

    for (const endpoint of state.endpoints) {
      root.append(renderEndpoint(endpoint));
    }

    if (addFormOpen) {
      root.append(renderAddForm());
    }
  }

  function summarize() {
    const enabledEndpoints = state.endpoints.filter((e) => e.enabled);
    const enabledModels = enabledEndpoints.reduce(
      (count, e) => count + e.models.filter((m) => m.enabled).length,
      0,
    );
    const errors = enabledEndpoints.filter((e) => e.lastDiscovery && !e.lastDiscovery.ok).length;
    const parts = [
      `${enabledEndpoints.length} endpoint${enabledEndpoints.length === 1 ? '' : 's'}, ${enabledModels} model${enabledModels === 1 ? '' : 's'} enabled`,
    ];
    if (errors > 0) {
      parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  }

  function renderEndpoint(endpoint) {
    const draft = getDraft(endpoint);
    const isOpen = expanded.has(endpoint.id);
    const card = h('section', { class: 'card' });

    const statusBadge = renderStatusBadge(endpoint);
    const head = h(
      'div',
      {
        class: 'card-head',
        onclick: () => {
          if (isOpen) {
            expanded.delete(endpoint.id);
          } else {
            expanded.add(endpoint.id);
          }
          render();
        },
      },
      h('span', { class: `codicon codicon-chevron-${isOpen ? 'down' : 'right'}` }),
      h('input', {
        type: 'checkbox',
        checked: endpoint.enabled,
        title: endpoint.enabled ? 'Endpoint enabled' : 'Endpoint disabled',
        onclick: (event) => {
          event.stopPropagation();
          saveDraft(endpoint, { enabled: !endpoint.enabled });
        },
      }),
      h('div', { class: 'grow' },
        h('div', { class: 'endpoint-name', text: endpoint.name || '(unnamed)' }),
        h('div', { class: 'endpoint-url', text: endpoint.baseUrl || '(no URL)' }),
      ),
      statusBadge,
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn small',
          title: 'Discover models now',
          onclick: (event) => {
            event.stopPropagation();
            post({ type: 'refreshEndpoint', id: endpoint.id });
          },
        }, h('span', { class: 'codicon codicon-refresh' }), h('span', { class: 'btn-label', text: 'Refresh' })),
        h('button', {
          class: 'btn small danger',
          title: 'Delete endpoint',
          onclick: async (event) => {
            event.stopPropagation();
            const ok = await confirmDialog({
              title: 'Delete endpoint',
              message: `Delete endpoint "${endpoint.name}" and its cached models?`,
              confirmLabel: 'Delete',
              danger: true,
            });
            if (ok) {
              delete drafts[endpoint.id];
              post({ type: 'removeEndpoint', id: endpoint.id });
            }
          },
        }, h('span', { class: 'codicon codicon-trash' }), h('span', { class: 'btn-label', text: 'Delete' })),
      ),
    );
    card.append(head);

    if (isOpen) {
      card.append(renderBody(endpoint, draft));
    }
    return card;
  }

  function renderStatusBadge(endpoint) {
    const status = endpoint.lastDiscovery;
    if (state.refreshInProgress) {
      return h('span', { class: 'badge unknown' }, h('span', { class: 'codicon codicon-sync spin' }), ' discovering…');
    }
    if (!status) {
      return h('span', { class: 'badge unknown' }, h('span', { class: 'codicon codicon-question' }), ' not discovered');
    }
    if (!status.ok) {
      return h('span', { class: 'badge error', title: status.error ?? 'Discovery failed' },
        h('span', { class: 'codicon codicon-error' }), ' discovery failed');
    }
    return h('span', { class: 'badge ok', title: `Last discovered ${new Date(status.at).toLocaleString()}` },
      h('span', { class: 'codicon codicon-check' }), `${status.count ?? 0} models`);
  }

  function renderBody(endpoint, draft) {
    const models = endpoint.models ?? [];
    const enabledCount = models.filter((m) => m.enabled).length;
    // Only hide models the server explicitly reports as not loaded; servers
    // without a load state keep every model visible.
    const visibleModels = endpoint.loadedOnly
      ? models.filter((m) => !isExplicitlyNotLoaded(m.detected?.state))
      : models;

    return h('div', { class: 'card-body' },
      field('Endpoint name', h('input', {
        type: 'text',
        value: draft.name,
        oninput: (event) => { draft.name = event.target.value; },
        onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
      })),

      field('Base URL', h('input', {
        type: 'text',
        value: draft.baseUrl,
        placeholder: 'http://127.0.0.1:8080',
        oninput: (event) => { draft.baseUrl = event.target.value; },
        onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
      })),

      h('div', { class: 'field' },
        h('label', { text: 'API key (optional)' }),
        h('div', { class: 'api-key-row' },
          h('input', {
            type: 'password',
            value: draft.apiKey,
            placeholder: endpoint.hasApiKey ? 'Key stored - type to replace' : 'No API key required',
            oninput: (event) => { draft.apiKey = event.target.value; },
            onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
          }),
          endpoint.hasApiKey
            ? h('button', { class: 'btn small danger', onclick: () => removeKey(endpoint) }, 'Remove key')
            : null,
        ),
      ),

      h('details', {},
        h('summary', { text: 'Advanced: auth, paths & extra headers' }),
        h('div', { class: 'card-body' },
          field('Auth header', h('div', { class: 'row' },
            h('input', {
              type: 'text',
              value: draft.authHeader,
              oninput: (event) => { draft.authHeader = event.target.value; },
              onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
            }),
            h('input', {
              type: 'text',
              value: draft.authPrefix,
              placeholder: 'Bearer ',
              title: 'Prefix in front of the key',
              oninput: (event) => { draft.authPrefix = event.target.value; },
              onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
            }),
          )),
          field('Models path', h('input', {
            type: 'text',
            value: draft.modelsPath,
            oninput: (event) => { draft.modelsPath = event.target.value; },
            onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
          })),
          field('Chat completions path', h('input', {
            type: 'text',
            value: draft.chatPath,
            oninput: (event) => { draft.chatPath = event.target.value; },
            onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
          })),
          kvEditor(draft.headers, (rows) => { draft.headers = rows; }, 'header', endpoint),
        ),
      ),

      h('div', { class: 'field' },
        h('label', { text: 'Default request parameters (sent with every chat request)' }),
        kvEditor(draft.params, (rows) => { draft.params = rows; }, 'parameter', endpoint),
      ),

      h('div', { class: 'row', style: 'flex-wrap: wrap; gap: 12px;' },
        h('label', { class: 'checkbox-field' },
          h('input', {
            type: 'checkbox',
            checked: draft.autoDiscover,
            onchange: (event) => saveDraft(endpoint, { autoDiscover: event.target.checked }),
          }),
          'Auto-discover on start'),
        h('label', { class: 'checkbox-field' },
          h('input', {
            type: 'checkbox',
            checked: draft.enabled,
            onchange: (event) => saveDraft(endpoint, { enabled: event.target.checked }),
          }),
          'Enabled'),
      ),

      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => saveDraft(endpoint) }, 'Save endpoint (discovers models)'),
      ),

      h('div', { class: 'models' },
        h('div', { class: 'models-head' },
          h('h3', { text: `Models (${enabledCount}/${models.length} enabled)` }),
          h('label', { class: 'checkbox-field', title: 'Hide models that are not currently loaded in server memory' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(endpoint.loadedOnly),
              onchange: (event) => saveDraft(endpoint, { loadedOnly: event.target.checked }),
            }),
            'Loaded only'),
        ),
        visibleModels.length === 0
          ? h('div', { class: 'empty', text: models.length === 0 ? 'No models discovered yet. Use "Discover now".' : 'No model matches the "Loaded only" filter.' })
          : visibleModels.map((model) => renderModelRow(endpoint, model)),
        renderAddModel(endpoint),
      ),
    );
  }

  function field(label, ...controls) {
    return h('div', { class: 'field' }, h('label', { text: label }), ...controls);
  }

  function kvEditor(rows, onChange, kind, endpoint) {
    const container = h('div', { class: 'kv-rows' });

    const addRow = () => {
      onChange([...rows, { key: '', value: '' }]);
      render();
    };
    const setRow = (index, patch) => {
      const copy = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      onChange(copy);
    };
    const removeRow = (index) => {
      onChange(rows.filter((_, i) => i !== index));
      render();
    };

    rows.forEach((row, index) => {
      container.append(
        h('div', { class: 'kv-row' },
          h('input', {
            type: 'text',
            value: row.key,
            placeholder: kind,
            oninput: (event) => setRow(index, { key: event.target.value }),
            onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
          }),
          h('input', {
            type: 'text',
            value: row.value,
            placeholder: 'value (JSON or string)',
            oninput: (event) => setRow(index, { value: event.target.value }),
            onkeydown: (event) => { if (event.key === 'Enter') { saveDraft(endpoint); } },
          }),
          h('button', {
            class: 'btn small danger',
            title: `Remove ${kind}`,
            onclick: () => removeRow(index),
          }, h('span', { class: 'codicon codicon-close' })),
        ),
      );
    });

    container.append(
      h('button', { class: 'btn small', onclick: addRow },
        h('span', { class: 'codicon codicon-add' }), ` Add ${kind}`),
    );
    return container;
  }

  function renderModelRow(endpoint, model) {
    const patch = (changes) => post({ type: 'updateModel', key: model.key, patch: changes });
    const isOpen = expandedModels.has(model.key);
    const detected = model.detected ?? {};

    const badges = [];
    if (detected.state) {
      const loaded = !isExplicitlyNotLoaded(detected.state);
      badges.push(h('span', {
        class: `model-badge ${loaded ? 'ok' : 'muted'}`,
        title: `Server state: ${detected.state}`,
      },
        h('span', { class: `codicon codicon-${loaded ? 'check' : 'circle-slash'}` }),
        ` ${detected.state}`));
    }
    if (model.origin === 'user') {
      badges.push(h('span', { class: 'model-badge muted', title: 'Added by hand - kept even when the server stops reporting it' }, 'manual'));
    }
    if (model.toolCalling) {
      badges.push(h('span', { class: 'model-badge ok', title: 'Tool calling enabled - required for agent mode' }, 'tools'));
    }
    if (model.imageInput) {
      badges.push(h('span', { class: 'model-badge ok', title: 'Image input supported' }, 'vision'));
    }

    return h('div', { class: 'model-card' },
      h('div', {
        class: 'model-head',
        onclick: () => {
          if (isOpen) {
            expandedModels.delete(model.key);
          } else {
            expandedModels.add(model.key);
          }
          render();
        },
      },
        h('span', { class: `codicon codicon-chevron-${isOpen ? 'down' : 'right'}` }),
        h('input', {
          type: 'checkbox',
          checked: model.enabled,
          title: model.enabled ? 'Model enabled' : 'Model disabled',
          onclick: (event) => {
            event.stopPropagation();
            patch({ enabled: event.target.checked });
          },
        }),
        h('input', {
          type: 'text',
          class: 'model-name-input',
          value: model.name,
          title: 'Display name in the model picker (click row to expand)',
          onclick: (event) => event.stopPropagation(),
          onchange: (event) => patch({ name: event.target.value, userSet: addUserField(model.userSet, 'name') }),
        }),
        ...badges,
        h('button', {
          class: 'btn small danger',
          title: 'Remove this model from the configuration',
          onclick: async (event) => {
            event.stopPropagation();
            const ok = await confirmDialog({
              title: 'Remove model',
              message: `Remove model "${model.modelId}" from the configuration?`,
              confirmLabel: 'Remove',
              danger: true,
            });
            if (ok) {
              if (model.origin !== 'user' && (!model.userSet || model.userSet.length === 0)) {
                showToast('info', 'Will be re-added on the next discovery if the server still reports it');
              }
              post({ type: 'removeModel', key: model.key });
            }
          },
        }, h('span', { class: 'codicon codicon-trash' }), h('span', { class: 'btn-label', text: 'Remove' })),
      ),
      isOpen
        ? h('div', { class: 'model-details' },
            infoRow('Model ID', model.modelId),
            infoRow('Family', h('input', {
              type: 'text',
              value: model.family,
              onchange: (event) => patch({ family: event.target.value, userSet: addUserField(model.userSet, 'family') }),
            })),
            infoRow('Publisher', detected.publisher),
            infoRow('Architecture', detected.arch),
            infoRow('Quantization', detected.quantization),
            infoRow('State', detected.state),
            infoRow('Max context', formatTokens(model.maxInputTokens), h('input', {
              type: 'number',
              value: String(model.maxInputTokens),
              min: '256',
              step: '1024',
              title: 'Max input tokens reported to VS Code',
              onchange: (event) => patch({
                maxInputTokens: Number(event.target.value) || model.maxInputTokens,
                userSet: addUserField(model.userSet, 'maxInputTokens'),
              }),
            })),
            infoRow('Loaded context', detected.loadedContextLength !== undefined ? formatTokens(detected.loadedContextLength) : undefined),
            infoRow('Max output tokens', undefined, h('input', {
              type: 'number',
              value: String(model.maxOutputTokens),
              min: '64',
              step: '256',
              onchange: (event) => patch({
                maxOutputTokens: Number(event.target.value) || model.maxOutputTokens,
                userSet: addUserField(model.userSet, 'maxOutputTokens'),
              }),
            })),
            h('div', { class: 'model-detail-row' },
              h('span', { class: 'model-detail-label', text: 'Capabilities' }),
              h('span', { class: 'model-detail-value capabilities' },
                h('label', { class: 'checkbox-field', title: 'Tool calling - required for models to appear in agent mode' },
                  h('input', {
                    type: 'checkbox',
                    checked: model.toolCalling,
                    onchange: (event) => patch({
                      toolCalling: event.target.checked,
                      userSet: addUserField(model.userSet, 'toolCalling'),
                    }),
                  }),
                  'tools'),
                h('label', { class: 'checkbox-field', title: 'Image input' },
                  h('input', {
                    type: 'checkbox',
                    checked: model.imageInput,
                    onchange: (event) => patch({
                      imageInput: event.target.checked,
                      userSet: addUserField(model.userSet, 'imageInput'),
                    }),
                  }),
                  'vision'),
                detected.isEmbedding ? h('span', { class: 'model-badge muted', text: 'embedding model' }) : null,
              ),
            ),
          )
        : null,
    );
  }

  function infoRow(label, value, control) {
    if (value === undefined && control === undefined) {
      return null;
    }
    return h('div', { class: 'model-detail-row' },
      h('span', { class: 'model-detail-label', text: label }),
      h('span', { class: 'model-detail-value' }, control ? control : String(value)),
    );
  }

  function formatTokens(value) {
    if (typeof value !== 'number') {
      return undefined;
    }
    return value >= 1024 ? `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)}k tokens` : `${value} tokens`;
  }

  function renderAddModel(endpoint) {
    const input = h('input', { type: 'text', placeholder: 'Add model id manually (e.g. mistral:7b)' });
    const submit = () => {
      const modelId = input.value.trim();
      if (modelId) {
        post({ type: 'addModel', endpointId: endpoint.id, modelId });
      }
    };
    return h('div', { class: 'add-model' },
      input,
      h('button', {
        class: 'btn small',
        onclick: submit,
      }, 'Add model'),
    );
  }

  function renderAddForm() {
    const local = { name: '', baseUrl: 'http://127.0.0.1:8080', apiKey: '' };
    const close = () => { addFormOpen = false; render(); };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head', onclick: close },
        h('span', { class: 'codicon codicon-add' }),
        h('div', { class: 'grow' }, h('div', { class: 'endpoint-name', text: 'New endpoint' })),
      ),
      h('div', { class: 'card-body' },
        field('Endpoint name', h('input', {
          type: 'text',
          value: local.name,
          placeholder: 'My LLM server',
          oninput: (event) => { local.name = event.target.value; },
        })),
        field('Base URL', h('input', {
          type: 'text',
          value: local.baseUrl,
          oninput: (event) => { local.baseUrl = event.target.value; },
        })),
        field('API key (optional)', h('input', {
          type: 'password',
          value: local.apiKey,
          oninput: (event) => { local.apiKey = event.target.value; },
        })),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary',
            onclick: () => {
              const message = {
                type: 'saveEndpoint',
                endpoint: {
                  name: local.name || 'New endpoint',
                  baseUrl: local.baseUrl,
                  modelsPath: '/v1/models',
                  chatPath: '/v1/chat/completions',
                  authHeader: 'Authorization',
                  authPrefix: 'Bearer ',
                enabled: true,
                autoDiscover: true,
                loadedOnly: false,
              },
            };
              if (local.apiKey) {
                message.apiKey = local.apiKey;
              }
              post(message);
              addFormOpen = false;
              render();
            },
          }, 'Add & discover models'),
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
        ),
      ),
    );
  }

  document.getElementById('refresh-all').addEventListener('click', () => {
    post({ type: 'refreshAll' });
  });
  document.getElementById('toggle-add').addEventListener('click', () => {
    addFormOpen = !addFormOpen;
    render();
  });

  post({ type: 'ready' });
})();
