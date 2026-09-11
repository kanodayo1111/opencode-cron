# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An OpenCode plugin (`opencode-cron`) that adds scheduled tasks: each task runs a prompt in a fresh session on a 5-field cron schedule while the OpenCode server is running. The implementation is `src/index.ts` (plugin entry, cron tool, scheduling engine) and `src/cron.ts` (dependency-free cron parser). Tests live in `test/cron.test.ts` and `test/plugin.test.ts` against a mock of OpenCode's injected client.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # tsc --noEmit over src + test
pnpm test               # vitest run (single file: pnpm vitest run test/cron.test.ts)
pnpm build              # tsc -p tsconfig.build.json → dist/
```

Package manager is pnpm 10 (`packageManager` pin); Node >= 22 required.

## Architecture

`src/index.ts` exports `createCron(client, io)` (tools + dispose, `io` is an injectable `StoreIO` for tests) and a default `Plugin` that wires `fileStoreIO(worktree)`. Zod schemas at the top of the file parse OpenCode server responses at adaptation boundaries.

- **Scheduling**: per-job `setTimeout` armed to the next matching minute (`nextRun` from `src/cron.ts`). Delays longer than the `setTimeout` cap (~24.8 days) re-arm in a chain. `dispose` clears all timers.
- **Execution**: each fire creates a standalone session (`client.session.create`) and prompts it (`client.session.prompt`), then records `lastRun` and re-arms. A run in flight suppresses further fires; occurrences during a run are skipped, not queued. Missed runs across restarts are skipped too.
- **Storage**: `<worktree>/.opencode/cron.json`, written atomically (tmp + rename). A corrupt store is logged and treated as empty. `StoreIO` abstracts load/save/now for tests.
- **Validation**: schedule parses at `create`/`update`; agent checked against `client.app.agents()`; model/variant checked against the provider catalog and connected list (model split on the first `/`).

## SDK-type lag convention

The generated `@opencode-ai/plugin` client types lag behind the server's HttpApi. Places where the code sends fields the SDK types don't declare (`session.create` with `metadata`/`permission`, `session.prompt` with `variant`) carry an English comment noting this and pass the body as `as never`. Keep this convention: narrow Zod schemas parse responses; don't create a custom client (it would lose the host's auth headers and in-process fetch).

## Test conventions

Tests use `vi.useFakeTimers()` (which also mocks `new Date()`, so `io.now()` follows the fake clock) plus an in-memory `StoreIO`. `advanceTo(date)` computes the real delta and calls `vi.advanceTimersByTimeAsync`. While a run is in flight there is no armed timer, so in-flight tests assert on skipped occurrences accordingly.
