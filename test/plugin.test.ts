import type { PluginInput } from "@opencode-ai/plugin"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCron, StoreSchema, type StoreIO } from "../src/index.js"

type Client = PluginInput["client"]
type Stored = ReturnType<typeof StoreSchema.parse>

const BASE = new Date(2026, 8, 11, 10, 0, 0) // Friday 2026-09-11 10:00 local

function response(data: unknown, status = 200) {
  return { data, response: new Response(null, { status }) }
}

function memoryIO(): StoreIO & { store: () => Stored | undefined } {
  let saved: Stored | undefined
  return {
    async load() {
      return saved
    },
    async save(store) {
      saved = store
    },
    now() {
      return new Date()
    },
    store() {
      return saved
    },
  }
}

function setup(options?: { prompt?: () => Promise<unknown> }) {
  const client = {
    session: {
      create: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        return response({ id: `child-${client.session.create.mock.calls.length}`, parentID: undefined })
      }),
      prompt: vi.fn(options?.prompt ?? (async () => response({ parts: [{ type: "text", text: "done" }] }))),
    },
    app: {
      agents: vi.fn(async () =>
        response([
          { name: "build", mode: "primary" },
          { name: "general", mode: "subagent" },
        ]),
      ),
    },
    config: {
      get: vi.fn(async () => response({ experimental: { primary_tools: ["apply_patch"] } })),
    },
    provider: {
      list: vi.fn(async () =>
        response({
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: { main: { id: "main", name: "Main", variants: { high: {} } } },
            },
            {
              id: "offline",
              name: "Offline",
              models: { model: { id: "model", name: "Model", variants: {} } },
            },
          ],
          default: { openai: "main" },
          connected: ["openai"],
        }),
      ),
    },
  }
  const io = memoryIO()
  return { client: client as unknown as Client, io }
}

type Tool = NonNullable<Awaited<ReturnType<typeof createCron>>["tool"]["cron"]>

async function call(tool: Tool, input: Record<string, unknown>) {
  const result = await tool.execute(input as never, {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  } as never)
  return JSON.parse(typeof result === "string" ? result : JSON.stringify(result))
}

async function advanceTo(date: Date) {
  await vi.advanceTimersByTimeAsync(date.getTime() - Date.now())
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("cron tool", () => {
  it("creates a task, persists it, and lists it with the next run time", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    const result = await call(tool.cron, {
      action: "create",
      name: "nightly",
      schedule: "0 9 * * *",
      prompt: "Check the overnight failures",
    })
    expect(result.created.enabled).toBe(true)
    expect(result.created.nextRun).toBe(new Date(2026, 8, 12, 9, 0).toISOString())
    expect(io.store()?.jobs).toHaveLength(1)

    const list = await call(tool.cron, { action: "list" })
    expect(list.jobs).toHaveLength(1)
    expect(list.jobs[0].name).toBe("nightly")
    await dispose()
  })

  it("rejects duplicate names, empty prompts, invalid schedules, unknown agents, and bad models", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    const base = { action: "create", name: "job", schedule: "* * * * *", prompt: "hi" }
    await call(tool.cron, base)
    await expect(call(tool.cron, base)).rejects.toThrow("already exists")
    await expect(call(tool.cron, { ...base, name: "bad-schedule", schedule: "* * * *" })).rejects.toThrow("5 fields")
    await expect(
      call(tool.cron, { action: "create", name: "agent", schedule: "* * * * *", prompt: "hi", agent: "nope" }),
    ).rejects.toThrow("Unknown agent")
    await expect(
      call(tool.cron, { action: "create", name: "model", schedule: "* * * * *", prompt: "hi", model: "openai/missing" }),
    ).rejects.toThrow("Unknown model")
    await expect(
      call(tool.cron, { action: "create", name: "provider", schedule: "* * * * *", prompt: "hi", model: "missing/main" }),
    ).rejects.toThrow("Unknown provider")
    await expect(
      call(tool.cron, { action: "create", name: "conn", schedule: "* * * * *", prompt: "hi", model: "offline/model" }),
    ).rejects.toThrow("not connected")
    await expect(
      call(tool.cron, { action: "create", name: "variant", schedule: "* * * * *", prompt: "hi", model: "openai/main", variant: "no" }),
    ).rejects.toThrow("Unknown variant")
    expect(io.store()?.jobs).toHaveLength(1)
    await dispose()
  })

  it("fires on schedule with denied permissions and records a completed run", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, {
      action: "create",
      name: "nightly",
      schedule: "0 9 * * *",
      prompt: "Check the overnight failures",
    })
    await advanceTo(new Date(2026, 8, 12, 9, 0))
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.session.create).toHaveBeenCalledWith({
      body: {
        title: "cron: nightly",
        metadata: { "opencode-cron": { name: "nightly", schedule: "0 9 * * *" } },
        permission: [
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "todowrite", pattern: "*", action: "deny" },
          { permission: "apply_patch", pattern: "*", action: "deny" },
        ],
      },
    })
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "child-1" },
      body: { parts: [{ type: "text", text: "Check the overnight failures" }] },
    })
    const store = StoreSchema.parse(io.store())
    expect(store.jobs[0]?.lastRun).toMatchObject({ status: "completed", sessionID: "child-1" })
    await dispose()
  })

  it("passes model, variant, and agent fields to the server", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, {
      action: "create",
      name: "job",
      schedule: "0 9 * * *",
      prompt: "Work",
      agent: "general",
      model: "openai/main",
      variant: "high",
    })
    await advanceTo(new Date(2026, 8, 12, 9, 0))
    expect(client.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({
        agent: "general",
        model: { id: "main", providerID: "openai", variant: "high" },
      }),
    })
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "child-1" },
      body: {
        parts: [{ type: "text", text: "Work" }],
        model: { providerID: "openai", modelID: "main" },
        variant: "high",
        agent: "general",
      },
    })
    await dispose()
  })

  it("maps variant default to the base configuration", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, {
      action: "create",
      name: "job",
      schedule: "0 9 * * *",
      prompt: "Work",
      model: "openai/main",
      variant: "default",
    })
    const list = await call(tool.cron, { action: "list" })
    expect(list.jobs[0].variant).toBeUndefined()
    await advanceTo(new Date(2026, 8, 12, 9, 0))
    expect(client.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({ model: { id: "main", providerID: "openai", variant: undefined } }),
    })
    await dispose()
  })

  it("records a failed run when the prompt fails", async () => {
    const { client, io } = setup({
      prompt: async () => {
        throw new Error("provider exploded")
      },
    })
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "job", schedule: "0 9 * * *", prompt: "Work" })
    await advanceTo(new Date(2026, 8, 12, 9, 0))
    const list = await call(tool.cron, { action: "list" })
    expect(list.jobs[0].lastRun).toMatchObject({
      status: "failed",
      sessionID: "child-1",
      error: expect.stringContaining("provider exploded"),
    })
    await dispose()
  })

  it("misses occurrences while a run is in flight and resumes scheduling after", async () => {
    let release: (value: unknown) => void = () => undefined
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { client, io } = setup({
      prompt: () => gate.then(() => response({ parts: [{ type: "text", text: "done" }] })),
    })
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "every", schedule: "* * * * *", prompt: "Work" })
    await advanceTo(new Date(2026, 8, 11, 10, 1))
    expect(client.session.create).toHaveBeenCalledTimes(1)
    // While the first run is pending there is no armed timer, so later
    // minutes are skipped rather than queued.
    await advanceTo(new Date(2026, 8, 11, 10, 3))
    expect(client.session.create).toHaveBeenCalledTimes(1)
    release(undefined)
    await vi.advanceTimersByTimeAsync(0)
    const list = await call(tool.cron, { action: "list" })
    expect(list.jobs[0].lastRun).toMatchObject({ status: "completed", sessionID: "child-1" })
    // Scheduling resumes from completion time.
    await advanceTo(new Date(2026, 8, 11, 10, 4))
    expect(client.session.create).toHaveBeenCalledTimes(2)
    await dispose()
  })

  it("runs a task immediately with the run action", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "job", schedule: "0 9 * * *", prompt: "Work" })
    const result = await call(tool.cron, { action: "run", name: "job" })
    expect(result.status).toBe("started")
    await vi.advanceTimersByTimeAsync(0)
    expect(client.session.create).toHaveBeenCalledTimes(1)
    const list = await call(tool.cron, { action: "list" })
    expect(list.jobs[0].lastRun).toMatchObject({ status: "completed" })
    await dispose()
  })

  it("does not fire disabled or removed tasks", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "a", schedule: "* * * * *", prompt: "Work" })
    await call(tool.cron, { action: "create", name: "b", schedule: "* * * * *", prompt: "Work" })
    await call(tool.cron, { action: "disable", name: "a" })
    await call(tool.cron, { action: "remove", name: "b" })
    await advanceTo(new Date(2026, 8, 11, 10, 5))
    expect(client.session.create).not.toHaveBeenCalled()
    expect(io.store()?.jobs).toHaveLength(1)
    await dispose()
  })

  it("updates a task and reschedules it", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "job", schedule: "0 9 * * *", prompt: "Work" })
    const result = await call(tool.cron, { action: "update", name: "job", schedule: "30 11 * * *", prompt: "Updated" })
    expect(result.updated.nextRun).toBe(new Date(2026, 8, 11, 11, 30).toISOString())
    await advanceTo(new Date(2026, 8, 11, 11, 31))
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "child-1" },
      body: { parts: [{ type: "text", text: "Updated" }] },
    })
    expect(io.store()?.jobs[0]?.schedule).toBe("30 11 * * *")
    await dispose()
  })

  it("reloads tasks from the store on startup and skips missed runs", async () => {
    const { client, io } = setup()
    const first = await createCron(client, io)
    await call(first.tool.cron, { action: "create", name: "job", schedule: "0 9 * * *", prompt: "Work" })
    await first.dispose()

    // Restart two days later: the missed runs are skipped, the next occurrence is scheduled.
    vi.setSystemTime(new Date(2026, 8, 13, 10, 0, 0))
    const second = await createCron(client, io)
    const list = await call(second.tool.cron, { action: "list" })
    expect(list.jobs[0].nextRun).toBe(new Date(2026, 8, 14, 9, 0).toISOString())
    await advanceTo(new Date(2026, 8, 14, 9, 0))
    expect(client.session.create).toHaveBeenCalledTimes(1)
    await second.dispose()
  })

  it("stops scheduling after dispose", async () => {
    const { client, io } = setup()
    const { tool, dispose } = await createCron(client, io)
    await call(tool.cron, { action: "create", name: "job", schedule: "* * * * *", prompt: "Work" })
    await dispose()
    await advanceTo(new Date(2026, 8, 11, 11, 0, 0))
    expect(client.session.create).not.toHaveBeenCalled()
  })
})
