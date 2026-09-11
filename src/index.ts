import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { nextRun, parseCron } from "./cron.js"

const MetadataKey = "opencode-cron"
const MAX_TIMEOUT_MS = 2 ** 31 - 1

const PermissionRuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
})
const TaskSelectionSchema = z.object({
  model: z.object({ providerID: z.string(), modelID: z.string() }),
  variant: z.string().optional(),
})
const LastRunSchema = z.object({
  at: z.string(),
  sessionID: z.string().optional(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
})
export const JobSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  agent: z.string().optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastRun: LastRunSchema.optional(),
})
export const StoreSchema = z.object({
  version: z.literal(1),
  jobs: z.array(JobSchema),
})
const SessionSchema = z
  .object({
    id: z.string(),
    parentID: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
const AgentSchema = z
  .object({
    name: z.string(),
    mode: z.enum(["subagent", "primary", "all"]),
  })
  .passthrough()
const ConfigSchema = z
  .object({
    experimental: z
      .object({
        primary_tools: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough()
const ModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    variants: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
const ProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    models: z.record(z.string(), ModelSchema),
  })
  .passthrough()
const ProviderListSchema = z.object({
  all: z.array(ProviderSchema),
  default: z.record(z.string(), z.string()),
  connected: z.array(z.string()),
})
const PromptResultSchema = z.object({
  parts: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
      })
      .passthrough(),
  ),
})

type Client = PluginInput["client"]
type ApiResult = { data?: unknown; error?: unknown; response?: Response }
type Store = z.infer<typeof StoreSchema>
export type Job = z.infer<typeof JobSchema>
type TaskSelection = z.infer<typeof TaskSelectionSchema>
type ProviderList = z.infer<typeof ProviderListSchema>

export type StoreIO = {
  load(): Promise<Store | undefined>
  save(store: Store): Promise<void>
  now(): Date
}

function parseResult<T>(result: unknown, schema: z.ZodType<T>, operation: string): T {
  const response = result as ApiResult
  if (response.data === undefined) {
    const detail = response.error === undefined ? `HTTP ${response.response?.status ?? "error"}` : JSON.stringify(response.error)
    throw new Error(`${operation} failed: ${detail}`)
  }
  return schema.parse(response.data)
}

function parseModel(value: string) {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid model "${value}"; expected provider/model-id`)
  }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

function normalizeVariant(variant?: string) {
  return variant === "default" ? undefined : variant
}

function validateModel(catalog: ProviderList, model: { providerID: string; modelID: string }, variant?: string) {
  const provider = catalog.all.find((item) => item.id === model.providerID)
  if (!provider) throw new Error(`Unknown provider: ${model.providerID}`)
  if (!catalog.connected.includes(model.providerID)) throw new Error(`Provider is not connected: ${model.providerID}`)
  const selected = provider.models[model.modelID]
  if (!selected) throw new Error(`Unknown model: ${model.providerID}/${model.modelID}`)
  if (variant !== undefined && !(variant in (selected.variants ?? {}))) {
    throw new Error(`Unknown variant for ${model.providerID}/${model.modelID}: ${variant}`)
  }
}

/**
 * File-backed store at <worktree>/.opencode/cron.json, written atomically.
 * A corrupt store is reported and treated as empty rather than failing plugin load.
 */
export function fileStoreIO(worktree: string): StoreIO {
  const file = path.join(worktree, ".opencode", "cron.json")
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(file, "utf8")
      } catch {
        return undefined
      }
      try {
        return StoreSchema.parse(JSON.parse(raw))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[opencode-cron] ignoring corrupt store ${file}: ${message}`)
        return undefined
      }
    },
    async save(store: Store) {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(store, null, 2))
      await rename(tmp, file)
    },
    now() {
      return new Date()
    },
  }
}

type CronTool = ReturnType<typeof tool>

export async function createCron(
  client: Client,
  io: StoreIO,
): Promise<{ tool: { cron: CronTool }; dispose: () => Promise<void> }> {
  const jobs = new Map<string, Job>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()
  let disposed = false

  function clearTimer(name: string) {
    const existing = timers.get(name)
    if (existing) {
      clearTimeout(existing)
      timers.delete(name)
    }
  }

  function scheduleJob(job: Job) {
    clearTimer(job.name)
    if (!job.enabled || disposed) return
    const target = nextRun(job.schedule, io.now())
    const delay = Math.max(0, target.getTime() - io.now().getTime())
    if (delay > MAX_TIMEOUT_MS) {
      // setTimeout cannot hold delays past ~24.8 days (monthly schedules); re-arm later.
      timers.set(job.name, setTimeout(() => scheduleJob(job), MAX_TIMEOUT_MS))
    } else {
      timers.set(job.name, setTimeout(() => void fireJob(job), delay))
    }
  }

  async function persist() {
    await io.save({ version: 1, jobs: [...jobs.values()].map((job) => ({ ...job })) })
  }

  async function updateJob(name: string, patch: Partial<Job>) {
    const job = jobs.get(name)
    if (!job) return
    Object.assign(job, patch)
    await persist()
  }

  async function resolveSelection(input: { model?: string; variant?: string }): Promise<TaskSelection | undefined> {
    if (!input.model) return undefined
    const catalog = parseResult(await client.provider.list(), ProviderListSchema, "List providers")
    const model = parseModel(input.model)
    const variant = normalizeVariant(input.variant)
    validateModel(catalog, model, variant)
    return { model, variant }
  }

  async function deniedPermissions() {
    const config = parseResult(await client.config.get(), ConfigSchema, "Get config")
    const denied = ["task", "todowrite", ...(config.experimental?.primary_tools ?? [])]
    return denied.map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    }))
  }

  async function validateJobFields(input: { schedule?: string; prompt?: string; agent?: string; model?: string; variant?: string }) {
    if (input.schedule !== undefined) parseCron(input.schedule)
    if (input.prompt !== undefined && input.prompt.trim().length === 0) {
      throw new Error("prompt must not be empty")
    }
    if (input.agent !== undefined) {
      const agents = parseResult(await client.app.agents(), z.array(AgentSchema), "List agents")
      if (!agents.some((agent) => agent.name === input.agent)) {
        throw new Error(`Unknown agent: ${input.agent}`)
      }
    }
    if (input.model !== undefined) {
      await resolveSelection(input)
    }
  }

  async function executeJob(job: Job) {
    const startedAt = io.now()
    let sessionID: string | undefined
    try {
      const selection = await resolveSelection(job)
      const agent = job.agent ? { agent: job.agent } : {}
      const model = selection
        ? {
            model: {
              id: selection.model.modelID,
              providerID: selection.model.providerID,
              variant: selection.variant,
            },
          }
        : {}
      const createBody = {
        title: `cron: ${job.name}`,
        metadata: { [MetadataKey]: { name: job.name, schedule: job.schedule } },
        permission: await deniedPermissions(),
        ...model,
        ...agent,
      }
      // Generated SDK types lag behind the server HttpApi, which accepts these session fields here.
      const created = parseResult(
        await client.session.create({ body: createBody } as never),
        SessionSchema,
        "Create scheduled session",
      )
      sessionID = created.id
      const promptBody = {
        parts: [{ type: "text" as const, text: job.prompt }],
        ...(selection ? { model: selection.model, variant: selection.variant } : {}),
        ...agent,
      }
      // Generated SDK types lag behind the server HttpApi, which accepts variant here.
      const result = parseResult(
        await client.session.prompt({ path: { id: created.id }, body: promptBody } as never),
        PromptResultSchema,
        "Run scheduled prompt",
      )
      await updateJob(job.name, {
        lastRun: { at: startedAt.toISOString(), sessionID: created.id, status: "completed" },
      })
      return result.parts.findLast((part) => part.type === "text")?.text ?? ""
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateJob(job.name, {
        lastRun: {
          at: startedAt.toISOString(),
          ...(sessionID ? { sessionID } : {}),
          status: "failed",
          error: message,
        },
      })
      return undefined
    }
  }

  async function runIfIdle(job: Job): Promise<boolean> {
    if (inFlight.has(job.name)) return false
    inFlight.add(job.name)
    try {
      await executeJob(job)
    } finally {
      inFlight.delete(job.name)
    }
    return true
  }

  async function fireJob(job: Job) {
    if (disposed) return
    await runIfIdle(job)
    const current = jobs.get(job.name)
    if (current?.enabled && !disposed) scheduleJob(current)
  }

  function jobSummary(job: Job) {
    let next: string | undefined
    if (job.enabled) {
      try {
        next = nextRun(job.schedule, io.now()).toISOString()
      } catch {
        next = undefined
      }
    }
    return { ...job, nextRun: next }
  }

  const cronTool = tool({
    description:
      "Manage scheduled tasks. Each task runs a prompt in a fresh session on a 5-field cron schedule (server local time) while OpenCode is running. Use the list action to see existing tasks, their next run time, and last run status.",
    args: {
      action: tool.schema.enum(["list", "create", "update", "remove", "enable", "disable", "run"]),
      name: tool.schema.string().min(1).optional(),
      schedule: tool.schema.string().min(1).optional(),
      prompt: tool.schema.string().min(1).optional(),
      agent: tool.schema.string().min(1).optional(),
      model: tool.schema.string().min(1).optional(),
      variant: tool.schema.string().min(1).optional(),
    },
    async execute(input) {
      switch (input.action) {
        case "list": {
          const list = [...jobs.values()].map((job) => jobSummary(job))
          return JSON.stringify({ jobs: list }, null, 2)
        }
        case "create": {
          if (!input.name) throw new Error("name is required to create a task")
          if (!input.schedule) throw new Error("schedule is required to create a task")
          if (!input.prompt) throw new Error("prompt is required to create a task")
          if (jobs.has(input.name)) throw new Error(`A task named "${input.name}" already exists`)
          await validateJobFields(input)
          const job: Job = {
            name: input.name,
            schedule: input.schedule,
            prompt: input.prompt,
            agent: input.agent,
            model: input.model,
            variant: normalizeVariant(input.variant),
            enabled: true,
            createdAt: io.now().toISOString(),
          }
          jobs.set(job.name, job)
          await persist()
          scheduleJob(job)
          return JSON.stringify({ created: jobSummary(job) }, null, 2)
        }
        case "update": {
          if (!input.name) throw new Error("name is required to update a task")
          const job = jobs.get(input.name)
          if (!job) throw new Error(`Unknown task: ${input.name}`)
          await validateJobFields(input)
          if (input.schedule !== undefined) job.schedule = input.schedule
          if (input.prompt !== undefined) job.prompt = input.prompt
          if (input.agent !== undefined) job.agent = input.agent
          if (input.model !== undefined) job.model = input.model
          if (input.variant !== undefined) job.variant = normalizeVariant(input.variant)
          await persist()
          scheduleJob(job)
          return JSON.stringify({ updated: jobSummary(job) }, null, 2)
        }
        case "remove": {
          if (!input.name) throw new Error("name is required to remove a task")
          if (!jobs.delete(input.name)) throw new Error(`Unknown task: ${input.name}`)
          clearTimer(input.name)
          await persist()
          return JSON.stringify({ removed: input.name }, null, 2)
        }
        case "enable": {
          if (!input.name) throw new Error("name is required to enable a task")
          const job = jobs.get(input.name)
          if (!job) throw new Error(`Unknown task: ${input.name}`)
          job.enabled = true
          await persist()
          scheduleJob(job)
          return JSON.stringify({ enabled: jobSummary(job) }, null, 2)
        }
        case "disable": {
          if (!input.name) throw new Error("name is required to disable a task")
          const job = jobs.get(input.name)
          if (!job) throw new Error(`Unknown task: ${input.name}`)
          job.enabled = false
          clearTimer(input.name)
          await persist()
          return JSON.stringify({ disabled: jobSummary(job) }, null, 2)
        }
        case "run": {
          if (!input.name) throw new Error("name is required to run a task")
          const job = jobs.get(input.name)
          if (!job) throw new Error(`Unknown task: ${input.name}`)
          if (inFlight.has(job.name)) {
            return JSON.stringify({ status: "skipped", reason: `task "${job.name}" is already running` }, null, 2)
          }
          // executeJob records the run in lastRun; the tool returns immediately.
          void runIfIdle(job)
          return JSON.stringify({ status: "started", name: job.name }, null, 2)
        }
      }
    },
  })

  const store = await io.load()
  for (const job of store?.jobs ?? []) {
    jobs.set(job.name, job)
    scheduleJob(job)
  }

  return {
    tool: { cron: cronTool },
    async dispose() {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

const plugin: Plugin = async ({ client, worktree }) => {
  const { tool, dispose } = await createCron(client, fileStoreIO(worktree))
  return { tool, dispose }
}

export default plugin
