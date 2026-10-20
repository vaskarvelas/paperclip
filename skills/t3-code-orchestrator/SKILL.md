---
name: t3-code-orchestrator
description: Start and orchestrate software engineering jobs in T3 Code Nightly using OMP agents with codex and antigravity models.
---

# T3 Code Nightly Orchestrator

Connects Paperclip agents to T3 Code Nightly (`http://127.0.0.1:3773`) to launch, monitor, and manipulate software engineering tasks.

## Mandatory Policy Constraint

- **Harness Constraint**: Every software engineering job launched in T3 Code Nightly MUST be assigned to an **OMP agent** (`providerInstanceId: "omp"`).
- **Model Constraint**: ONLY **codex** models (`openai-codex/*`, e.g. `openai-codex/gpt-6.1-sol`) or **antigravity** models (`google-antigravity/*`, e.g. `google-antigravity/gemini-3.8-flash`, `google-antigravity/claude-sonnet-5-5`) are permitted.
- **Strict Exclusion**: Under no circumstances should `claudeAgent`, `opencode`, `cursor`, `grok`, or other providers be assigned.

## Available Interfaces

### 1. Direct MCP Tools (Injected into agent runtime via `t3_code`)
The MCP client authenticates with a `full-access` MCP client token (`rtc: "full-access"`), so `t3_project_create` and `t3_thread_launch` with `runtimeMode: "full-access"` work directly without human approval hangs.

- `t3_project_list` / `t3_project_create`: Discover or register project workspace directories.
- `t3_thread_launch`: Launch an engineering job thread with explicit workspace, prompt, and model configuration.
  ```json
  {
    "projectId": "<projectId>",
    "title": "Implement feature X",
    "message": "Task instructions...",
    "runtimeMode": "full-access",
    "modelSelection": {
      "instanceId": "omp",
      "model": "openai-codex/gpt-6.1-sol"
    }
  }
  ```
- `t3_thread_configure`: Set or switch model on a thread (must stay within permitted OMP codex/antigravity models).
- `t3_thread_send`: Send follow-up instructions or steering to a thread.
- `t3_thread_wait`: Wait until the thread settles or completes its turn.
- `t3_thread_read`: Read durable state, progress, and messages from the thread.

### 2. Fast CLI Helper (`t3-job`)
`t3-job` also authenticates with a `full-access` MCP client token (`rtc: "full-access"`).
`t3-job launch` defaults to `--mode full-access` and automatically registers any local directory via `t3_project_create` if not already registered.

- Preflight token check: `t3-job token-check` (verifies full-access token validity against T3 Code)
- Issue browser pairing code: `t3-job pair` (issues a pairing code via `t3 auth pairing create --json` if a browser session ever needs to pair with `http://127.0.0.1:3773`)
- Check projects: `t3-job projects`
- Check allowed models: `t3-job models`
- Launch job: `t3-job launch --project /path/to/project --title "Title" --model codex --prompt "Instructions..."` (defaults to `--mode full-access`, auto-registers directory)
- Check status: `t3-job status <threadId>`
- Wait for completion: `t3-job wait <threadId>`
- Send follow-up: `t3-job send <threadId> "Additional guidance"`
