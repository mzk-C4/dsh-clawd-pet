// dsh-clawd-pet — make the Clawd on Desk desktop pet animate along with
// DeepSeek Harness (DSH) agent state.
//
// Listens to the DSH session firehose (session/created, session/disposed,
// session/event) plus agent/error, maps events to Clawd pet states, and
// POSTs them to Clawd's local server (127.0.0.1:23333+/state) under a
// REGISTERED custom-application agent id (see lib/clawd-client.js).
//
// State mapping (DSH event → Clawd state → pet animation):
//   user prompt / turn start / model streaming   → thinking   (pet thinking)
//   tool/call, tool/result                       → working    (pet typing)
//   subagent / workflow agents active            → juggling   (pet juggling)
//   approval/asked                               → notification (pet alerts you)
//   turn/end completed                           → attention  (pet celebrates)
//   turn/end error, agent/error                  → error      (pet error)
//   compaction/start                             → sweeping   (pet sweeps context)
//   session/disposed                             → sleeping   (card removed)
//
// Subagent sessions (delegationDepth > 0) report INTO their parent session
// as SubagentStart/SubagentStop so the HUD stays clean and the pet juggles.

import z from '@deepseek-ai/schemastery'
import {
  computeCustomApplicationId,
  isCustomApplicationId,
  portCandidates,
  postStateToPort,
  probePort,
  readClawdPrefsCustomApplications,
} from './lib/clawd-client.js'

/** Stable Cordis plugin name. */
export const name = 'clawd-pet'

/** No hard service deps: the session firehose is plain ctx events. The
 * session store is injected opportunistically inside apply() so the plugin
 * still loads on hosts without one. */
export const inject = []

/** Plugin configuration (Web 设置 → 插件 → clawd-pet). */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Force a Clawd agent id (e.g. `custom-dsh-desktop-abc123def456`). Empty = auto-resolve. */
  agentId: z.string().default(''),
  /** Force the Clawd server port. 0 = discover from ~/.clawd/runtime.json + 23333..23337. */
  port: z.number().step(1).min(0).max(65535).default(0),
  /** Report subagent sessions as juggling on the parent session. */
  subagents: z.boolean().default(true),
  /** Send context-usage estimates (token ring on the session HUD). */
  contextUsage: z.boolean().default(true),
  /** Report single-tool failures as one-shot error animations. */
  toolFailures: z.boolean().default(true),
  /** Send the final assistant message text with turn completions. */
  completionText: z.boolean().default(true),
  /** Minimum ms between throttled posts for one session (burst coalescing
   * for stream/context noise; state transitions always go through). */
  minIntervalMs: z.number().step(1).min(0).max(60_000).default(200),
  /** Post timeout per request. */
  timeoutMs: z.number().step(1).min(100).max(10_000).default(1200),
})

/** Clamp helper for assistant_last_output (Clawd caps at 2400 chars). */
function clampText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Extract plain text blocks from a message content array. */
function textBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger.info('clawd-pet: disabled by config')
    return
  }

  // ── Runtime state ─────────────────────────────────────────────────────────
  const agentPid = process.pid
  const execPath = process.execPath
  let resolvedAgentId = isCustomApplicationId(config.agentId) ? config.agentId : ''
  let activePort = config.port > 0 ? config.port : null
  let connected = false
  let lastSetupWarn = 0

  /** Per-session tracked info. */
  const tracked = new Map()
  const pendingPosts = [] // FIFO, one in flight
  let posting = false

  function track(sessionId) {
    let entry = tracked.get(sessionId)
    if (!entry) {
      entry = {
        lastPostAt: 0,
        model: null,
        provider: null,
        title: null,
        contextWindow: null,
        lastInputTokens: null,
        streamedSteps: new Set(),
        liveToolCalls: new Set(),
        subagents: new Set(),
        workflows: new Set(),
        lastAssistantText: '',
      }
      tracked.set(sessionId, entry)
    }
    return entry
  }

  // ── Agent-id resolution ───────────────────────────────────────────────────
  function resolveAgentId() {
    if (resolvedAgentId) return resolvedAgentId
    // 1) A custom application registered in Clawd whose executablePath
    //    matches this host executable — Clawd's own persisted id, so the
    //    user may register either the exe or its containing folder.
    const apps = readClawdPrefsCustomApplications()
    const normalize = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p))
    const execLower = normalize(execPath)
    const match = apps.find((app) => (
      isCustomApplicationId(app.id)
      && typeof app.executablePath === 'string'
      && normalize(app.executablePath) === execLower
    ))
    if (match) {
      resolvedAgentId = match.id
      ctx.logger.info(`clawd-pet: agent id resolved from Clawd prefs: ${resolvedAgentId}`)
      return resolvedAgentId
    }
    // 2) Deterministic id from our own executable path (mirrors Clawd's
    //    custom-applications.js hashing, so it matches what Clawd will
    //    register for this exe).
    resolvedAgentId = computeCustomApplicationId(execPath)
    return resolvedAgentId
  }

  // ── Posting pipeline ──────────────────────────────────────────────────────
  async function flush() {
    if (posting) return
    posting = true
    try {
      while (pendingPosts.length > 0) {
        const post = pendingPosts.shift()
        try {
          await deliver(post)
        } catch (error) {
          ctx.logger.warn(`clawd-pet: post failed: ${String(error)}`)
        }
      }
    } finally {
      posting = false
    }
  }

  function warnSetup(message) {
    const now = Date.now()
    if (now - lastSetupWarn < 10 * 60_000) return
    lastSetupWarn = now
    ctx.logger.warn(message)
  }

  async function deliver(post) {
    if (!activePort) {
      for (const port of portCandidates()) {
        if (await probePort(port)) {
          activePort = port
          break
        }
      }
      if (!activePort) {
        warnSetup('clawd-pet: Clawd on Desk is not running (no 127.0.0.1:23333+ /state server found); posts skipped, will keep probing')
        return
      }
    }
    const body = { ...post, agent_id: resolveAgentId(), agent_pid: agentPid, platform: 'webui' }
    const result = await postStateToPort(activePort, body, config.timeoutMs)
    if (!result.isClawd) {
      activePort = null // Clawd quit or its port moved — rediscover next post
      return
    }
    if (result.status === 200) {
      if (!connected) {
        connected = true
        ctx.logger.info(`clawd-pet: connected to Clawd on port ${activePort} as ${resolveAgentId()}`)
      }
      return
    }
    if (result.status === 204) {
      // Clawd is running but dropped the event: our agent id is not
      // registered as a custom application, or the agent is toggled off in
      // Clawd's settings.
      warnSetup(
        `clawd-pet: Clawd on Desk is dropping our events (agent id ${resolveAgentId()} is not registered/enabled there). ` +
        `Open Clawd → Settings → Agents → add a custom application pointing at "${execPath}" ` +
        `(and make sure it is enabled), or set the clawd-pet plugin config agentId.`,
      )
    }
    // 400 = unknown state — a mapping bug on our side; surfaced once per
    // deliver by the surrounding catch, so just swallow here.
  }

  function enqueue(sessionId, state, event, extra = {}, options = {}) {
    if (config.enabled === false) return
    const entry = track(sessionId)
    const now = Date.now()
    if (options.force !== true && now - entry.lastPostAt < config.minIntervalMs) return
    entry.lastPostAt = now
    pendingPosts.push({
      state,
      event,
      session_id: sessionId,
      ...(entry.title ? { session_title: entry.title } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...extra,
    })
    void flush()
  }

  // ── DSH event handling ────────────────────────────────────────────────────
  function isSubagentSession(session) {
    const depth = session?.header?.delegationDepth
    return typeof depth === 'number' && depth > 0
  }

  function parentOf(session) {
    return typeof session?.header?.parentSession === 'string' ? session.header.parentSession : null
  }

  function cwdOf(session) {
    return typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  }

  /** A subagent became (in)active — reflect on the parent as juggling. */
  function subagentCountChanged(parentId) {
    const entry = tracked.get(parentId)
    if (!entry) return
    if (entry.subagents.size > 0) {
      enqueue(parentId, 'juggling', 'SubagentStart', {}, { force: true })
    } else {
      enqueue(parentId, 'working', 'SubagentStop', {}, { force: true })
    }
  }

  function handleSessionEvent(session, event) {
    if (config.enabled === false) return
    const sessionId = session?.id
    if (!sessionId) return
    const type = event?.type
    const data = event?.data ?? {}

    // Subagent sessions report into their parent (HUD stays clean).
    if (isSubagentSession(session)) {
      if (!config.subagents) return
      const parent = parentOf(session) || sessionId
      const entry = track(parent)
      if (type === 'turn/end') {
        if (entry.subagents.delete(sessionId)) subagentCountChanged(parent)
      }
      return
    }

    switch (type) {
      case 'session/title': {
        const entry = track(sessionId)
        const title = clampText(data.title, 80)
        if (title && title !== entry.title) {
          entry.title = title
          pendingPosts.push({
            state: 'idle',
            event: 'SessionStart',
            session_id: sessionId,
            metadata_only: true,
            session_title: title,
          })
          void flush()
        }
        return
      }
      case 'request/context': {
        const entry = track(sessionId)
        if (typeof data.model === 'string') entry.model = data.model
        if (typeof data.provider === 'string') entry.provider = data.provider
        if (Number.isFinite(data.contextWindow) && data.contextWindow > 0) entry.contextWindow = data.contextWindow
        return
      }
      case 'assistant/message': {
        const entry = track(sessionId)
        const source = data.message?.source
        if (source && typeof source.model === 'string') {
          entry.model = source.model
          if (typeof source.provider === 'string') entry.provider = source.provider
        }
        const usage = data.usage ?? {}
        const inputTokens = usage.inputTokens ?? usage.input_tokens
        if (Number.isFinite(inputTokens)) entry.lastInputTokens = inputTokens
        if (config.completionText) {
          const text = clampText(textBlocks(data.message?.content), 2400)
          if (text) entry.lastAssistantText = text
        }
        return
      }
      case 'assistant/chunk': {
        // First chunk of a step: the model started producing output.
        const entry = track(sessionId)
        const key = `${data.turn}:${data.step}`
        if (!entry.streamedSteps.has(key)) {
          entry.streamedSteps.add(key)
          if (entry.liveToolCalls.size === 0) {
            enqueue(sessionId, 'thinking', 'UserPromptSubmit')
          }
        }
        return
      }
      case 'user/message': {
        // Includes injected context between steps; only meaningful when no
        // tool is mid-flight (otherwise "working" is the honest state).
        const entry = track(sessionId)
        if (entry.liveToolCalls.size === 0) {
          enqueue(sessionId, 'thinking', 'UserPromptSubmit')
        }
        return
      }
      case 'turn/start': {
        enqueue(sessionId, 'thinking', 'UserPromptSubmit', {}, { force: true })
        return
      }
      case 'tool/call': {
        const entry = track(sessionId)
        if (typeof data.callId === 'string') entry.liveToolCalls.add(data.callId)
        enqueue(sessionId, 'working', 'PreToolUse', typeof data.name === 'string' ? { tool_name: data.name } : {}, { force: true })
        return
      }
      case 'tool/result': {
        const entry = track(sessionId)
        if (typeof data.message?.source?.callId === 'string') entry.liveToolCalls.delete(data.message.source.callId)
        const isError = data.message?.isError === true || data.error !== undefined
        if (isError && config.toolFailures) {
          enqueue(sessionId, 'error', 'PostToolUseFailure', {}, { force: true })
        } else {
          enqueue(sessionId, 'working', 'PostToolUse')
        }
        return
      }
      case 'approval/asked': {
        enqueue(
          sessionId,
          'notification',
          'Notification',
          typeof data.toolName === 'string' ? { tool_name: data.toolName } : {},
          { force: true },
        )
        return
      }
      case 'approval/decided': {
        enqueue(sessionId, 'working', 'PreToolUse', {}, { force: true })
        return
      }
      case 'tool-workflow/run-start': {
        // {runId, name} — a workflow run (fan-out of subagents) started.
        const entry = track(sessionId)
        if (typeof data.runId === 'string') entry.workflows.add(data.runId)
        if (entry.workflows.size === 1) enqueue(sessionId, 'juggling', 'SubagentStart', {}, { force: true })
        return
      }
      case 'tool-workflow/run-end': {
        // {runId, stopReason} — the whole run finished.
        const entry = track(sessionId)
        if (typeof data.runId === 'string') entry.workflows.delete(data.runId)
        if (entry.workflows.size === 0) enqueue(sessionId, 'working', 'SubagentStop', {}, { force: true })
        return
      }
      case 'compaction/start': {
        enqueue(sessionId, 'sweeping', 'PreCompact', {}, { force: true })
        return
      }
      case 'compaction/end': {
        enqueue(sessionId, 'thinking', 'PostCompact', {}, { force: true })
        return
      }
      case 'turn/end': {
        const reason = data.reason ?? {}
        const entry = track(sessionId)
        const extra = {}
        if (config.completionText && entry.lastAssistantText) {
          extra.assistant_last_output = entry.lastAssistantText
        }
        if (config.contextUsage && entry.contextWindow && entry.lastInputTokens) {
          const used = entry.lastInputTokens
          const limit = entry.contextWindow
          extra.context_usage = {
            used,
            limit,
            percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
          }
        }
        if (reason.kind === 'error') {
          enqueue(sessionId, 'error', 'ApiError', extra, { force: true })
          return
        }
        if (reason.kind === 'completed' || reason.kind === 'max-tokens') {
          enqueue(sessionId, 'attention', 'Stop', extra, { force: true })
          return
        }
        // aborted / blocked — settle without celebrating.
        enqueue(sessionId, 'idle', 'Stop', {}, { force: true })
        return
      }
      default:
        return
    }
  }

  function handleSessionCreated(session) {
    if (config.enabled === false || !session?.id) return
    if (isSubagentSession(session)) {
      if (!config.subagents) return
      const parent = parentOf(session) || session.id
      const entry = track(parent)
      entry.subagents.add(session.id)
      subagentCountChanged(parent)
      return
    }
    const entry = track(session.id)
    const cwd = cwdOf(session)
    if (cwd && !entry.title) {
      const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      const title = clampText(base, 80)
      if (title) entry.title = title
    }
    enqueue(session.id, 'idle', 'SessionStart', cwd ? { cwd } : {}, { force: true })
  }

  function handleSessionDisposed(session) {
    if (config.enabled === false || !session?.id) return
    if (isSubagentSession(session)) {
      if (!config.subagents) return
      const parent = parentOf(session) || session.id
      const entry = tracked.get(parent)
      if (entry?.subagents.delete(session.id)) subagentCountChanged(parent)
      tracked.delete(session.id)
      return
    }
    enqueue(session.id, 'sleeping', 'SessionEnd', {}, { force: true })
    tracked.delete(session.id)
  }

  // ── Wire up ───────────────────────────────────────────────────────────────
  ctx.on('session/created', handleSessionCreated)
  ctx.on('session/disposed', handleSessionDisposed)
  ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(session, event)
    } catch (error) {
      ctx.logger.warn(`clawd-pet: session/event handler failed: ${String(error)}`)
    }
  })
  ctx.on('agent/error', ({ agent } = {}) => {
    try {
      const session = agent?.session
      if (!session?.id || isSubagentSession(session)) return
      enqueue(session.id, 'error', 'ApiError', {}, { force: true })
    } catch { /* never disturb the host */ }
  })

  // Adopt sessions that already exist when the plugin loads (host restart
  // with live sessions, or plugin installed while sessions are open).
  ctx.inject(['sessions'], (sessionsCtx) => {
    try {
      for (const session of sessionsCtx.sessions.list()) handleSessionCreated(session)
    } catch (error) {
      ctx.logger.warn(`clawd-pet: session adoption failed: ${String(error)}`)
    }
  })

  ctx.on('dispose', () => {
    // Best-effort teardown: Clawd's agent_pid liveness check cleans up any
    // posts that do not make it out in time.
    const fallbackPort = activePort ?? portCandidates()[0]
    if (!fallbackPort) return
    for (const sessionId of tracked.keys()) {
      postStateToPort(fallbackPort, {
        state: 'sleeping',
        event: 'SessionEnd',
        session_id: sessionId,
        agent_id: resolveAgentId(),
        agent_pid: agentPid,
      }, 300).catch(() => {})
    }
    tracked.clear()
  })

  ctx.logger.info(`clawd-pet: loaded (host exe ${execPath}; computed agent id ${resolvedAgentId || computeCustomApplicationId(execPath)})`)
}
