# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-15

### Added

- Initial release.
- Exposes local and remote LLM servers as chat models in VS Code via the
  Language Model Chat Provider API (`localllm` vendor).
- OpenAI-compatible chat completions with streaming (SSE) responses.
- Model auto-discovery across mixed server families:
  - OpenAI-compatible `GET /v1/models` (LM Studio, llama.cpp, vLLM, OpenAI…)
  - Ollama native `GET /api/tags`
- Rich metadata detection (best effort, failures ignored):
  - LM Studio `/api/v0/models` (`state`, flat capabilities) and
    `/api/v1/models` (`loaded_instances`, nested capabilities/quantization)
  - llama.cpp `/props` (loaded model + context) and `/v1/models` (`meta`)
  - Ollama `POST /api/show`
  - Generic OpenAI `GET /v1/models/{id}`
- **Currently-loaded model detection** for both LM Studio and llama.cpp:
  the loaded model is badged as `loaded`; the `Loaded only` filter hides
  models a server *explicitly* reports as not loaded.
- **Model pruning**: models a server stops reporting are removed after two
  consecutive missed discoveries. User-added and user-customized models are
  never auto-pruned and can only be removed by hand.
- Sidebar configuration UI: endpoints, API keys, extra headers, default
  request parameters, per-model overrides, manual add/remove.
- Status bar item with per-endpoint discovery status.
- Tool calling (agent mode) and image input support, with capability badges.
- API keys stored in `context.secrets`; never written to global state.
- Commands: Open Configuration, Refresh Models, Add Endpoint, Show Logs,
  Set Test Model, Set "Loaded only" filter.
