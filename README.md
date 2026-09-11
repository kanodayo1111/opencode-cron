# opencode-cron

An [OpenCode](https://opencode.ai/) plugin that runs prompts on a schedule. Each task fires on a 5-field cron expression and runs its prompt in a fresh session while OpenCode is running, with a restricted default permission set for unattended execution.

## Requirements

- OpenCode 1.18.2 or later
- A connected provider with at least one model (only if the task pins a model)

## Install From GitHub Release

Add the release tarball spec to your project or global `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cron@https://github.com/TTTPOB/opencode-cron-plugin/releases/download/v0.1.0/opencode-cron-0.1.0.tgz"
  ]
}
```

Quit and restart OpenCode after changing the configuration. OpenCode installs the plugin on startup.

## Install Locally

```bash
git clone https://github.com/TTTPOB/opencode-cron-plugin.git
cd opencode-cron-plugin
pnpm install
pnpm build
```

Reference the cloned directory with an absolute file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-cron-plugin"]
}
```

Restart OpenCode after building or changing the plugin.

## The `cron` tool

Manage scheduled tasks through one tool:

```ts
cron({ action: "list" })
cron({ action: "create", name: "nightly", schedule: "0 9 * * *", prompt: "Check the overnight failures" })
cron({ action: "update", name: "nightly", schedule: "30 9 * * *" })
cron({ action: "run", name: "nightly" })
cron({ action: "disable", name: "nightly" })
cron({ action: "remove", name: "nightly" })
```

Arguments:

- `action`: `list`, `create`, `update`, `remove`, `enable`, `disable`, or `run`
- `name`: unique task name (required for every action except `list`)
- `schedule`: 5-field cron expression, evaluated in the server's local time
- `prompt`: the prompt executed in a fresh session at each fire
- `agent`: optional agent name; defaults to the server's default primary agent
- `model`: optional `provider/model-id`; the plugin splits on the first `/`, so model IDs may contain `/`
- `variant`: optional model variant, or `default` to use the model's base configuration

`create` validates the schedule, agent, provider connection, model, and variant immediately, so mistakes surface before the first fire.

## Behavior

- **Storage**: task definitions persist in `<worktree>/.opencode/cron.json` and survive restarts. Consider adding that file to `.gitignore`.
- **Execution**: each fire creates a standalone session (no parent), runs the prompt, and records the run. Session history holds the full transcript.
- **Unattended permissions**: scheduled sessions deny `task`, `todowrite`, and any `experimental.primary_tools` tools, so an automated run cannot spawn subagents.
- **Scheduling**: OpenCode must be running at the trigger time. Missed runs (server stopped, or a previous run of the same task still in flight) are skipped, never queued or replayed.
- **Run records**: `list` shows each task's next run time and its `lastRun` (`completed`/`failed`, session id, and error text for failures).
- **`run` action**: starts a task immediately and returns; the result lands in `lastRun`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The test suite uses a mock of OpenCode's injected client with fake timers and verifies cron parsing, scheduling, permissions, model validation, run recording, persistence reload, and dispose behavior.
