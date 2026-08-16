// Full mapping test: drive the plugin with a mock Cordis ctx and a realistic
// DSH session event sequence; intercept posts to Clawd and verify states.
import assert from 'node:assert/strict'

// Mock @deepseek-ai/schemastery (the profile provides the real one at
// runtime; here we only need z.object/z.boolean/z.string/z.number).
const schemasteryUrl = new URL('node_modules/@deepseek-ai/schemastery', import.meta.url).href
let z
try {
  z = await import(schemasteryUrl)
} catch {
  z = {
    object: (shape) => ({ shape, parse: (v) => v }),
    boolean: () => ({}),
    string: () => ({}),
    number: () => ({}),
  }
}

// Intercept the HTTP layer by monkey-patching postStateToPort/probePort would
// require DI; instead run the plugin and let it talk to the real local
// Clawd... no — for a hermetic unit test, intercept via a fake clawd-client by
// shimming node:http. Simpler: capture bodies by pointing the client at a
// local recorder server.
import http from 'node:http'

const recorded = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    recorded.push({ path: req.url, body: JSON.parse(body) })
    res.writeHead(200, { 'x-clawd-server': 'clawd-on-desk' })
    res.end('ok')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// Point runtime config at the recorder.
const config = {
  enabled: true,
  agentId: '',
  port,
  subagents: true,
  contextUsage: true,
  toolFailures: true,
  completionText: true,
  minIntervalMs: 0,
  timeoutMs: 800,
}

// Force the agent id so prefs lookup is skipped (DSH Desktop exe path).
process.execPath = 'D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe'

const logs = []
const mockCtx = {
  logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
  listeners: new Map(),
  on(event, handler) { this.listeners.set(event, handler) },
  inject(deps, fn) { this.injectFn = fn; this.injectDeps = deps },
}
const sessionsList = []
mockCtx.inject = (deps, fn) => fn({ sessions: { list: () => sessionsList } })

const plugin = await import('../index.js')
plugin.apply(mockCtx, config)

const emit = (event, ...args) => mockCtx.listeners.get(event)?.(...args)

// ── Drive a realistic session lifecycle ────────────────────────────────────
const header = { id: 'session-test-1', cwd: 'D:\\AI（project）\\ds install', delegationDepth: undefined }
const session = { id: 'session-test-1', header }

emit('session/created', session)                                    // idle / SessionStart
emit('session/event', session, { type: 'session/title', data: { title: 'Clawd 接入测试' } })
emit('session/event', session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } })
emit('session/event', session, { type: 'request/context', data: { provider: 'zai-coding-cn', model: 'glm-5.3', contextWindow: 1000000 } })
emit('session/event', session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '好' } } })
emit('session/event', session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来处理' }], source: { kind: 'model', provider: 'zai-coding-cn', model: 'glm-5.3' } }, usage: { inputTokens: 12345, outputTokens: 67 } } })
emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: {} } })
emit('session/event', session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '<context>command output</context>' }] } }) // injected ctx mid-tools: must NOT downgrade to thinking
emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', content: [] }], source: { kind: 'tool', callId: 'call-1' } } } })
emit('session/event', session, { type: 'approval/asked', data: { id: 'appr-1', toolName: 'pwsh' } })
emit('session/event', session, { type: 'approval/decided', data: { id: 'appr-1', outcome: 'allowed-once' } })
emit('session/event', session, { type: 'compaction/start', data: {} })
emit('session/event', session, { type: 'compaction/end', data: {} })

// subagent round: a child session is created (delegationDepth 1, parent set)
const childHeader = { id: 'session-child-1', cwd: 'D:\\AI（project）\\ds install', delegationDepth: 1, parentSession: 'session-test-1' }
const child = { id: 'session-child-1', header: childHeader }
emit('session/created', child)                                      // juggling / SubagentStart on parent
emit('session/event', child, { type: 'turn/start', data: { turn: 1 } })
emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
emit('session/disposed', child)                                     // SubagentStop -> working on parent

// workflow run
emit('session/event', session, { type: 'tool-workflow/run-start', data: { runId: 'run-1', name: 'audit' } })
emit('session/event', session, { type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' } })

// failed tool
emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-2', name: 'web_search', arguments: {} } })
emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'tool', isError: true, content: [{ type: 'tool-result', content: [] }], source: { kind: 'tool', callId: 'call-2' } }, error: { code: 'TIMEOUT' } } })

// turn completes
emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }) // attention / Stop

// agent error (no open turn)
emit('agent/error', { agent: { session } })

// dispose
emit('session/disposed', session)                                   // sleeping / SessionEnd

// Let the post queue drain.
await new Promise((resolve) => setTimeout(resolve, 300))
server.close()

// ── Assertions ─────────────────────────────────────────────────────────────
const states = recorded.map((r) => `${r.body.state}/${r.body.event}`)
console.log('posted states:', states.join('  '))

const expectedContains = [
  'idle/SessionStart',
  'thinking/UserPromptSubmit',
  'working/PreToolUse',
  'notification/Notification',
  'working/PreToolUse',
  'sweeping/PreCompact',
  'thinking/PostCompact',
  'juggling/SubagentStart',
  'working/SubagentStop',
  'juggling/SubagentStart',
  'working/SubagentStop',
  'error/PostToolUseFailure',
  'attention/Stop',
  'sleeping/SessionEnd',
]
for (const expect of expectedContains) {
  assert.ok(states.includes(expect), `missing ${expect} in ${JSON.stringify(states)}`)
}

// The completion post should carry assistant text + context usage + model.
const stop = recorded.find((r) => r.body.state === 'attention').body
assert.equal(stop.assistant_last_output, '好的，我来处理')
assert.equal(stop.context_usage.percent, 1) // 12345/1000000
assert.equal(stop.model, 'glm-5.3')
assert.equal(stop.agent_id, 'custom-dsh-desktop-271e1a77cf0b')
assert.ok(Number.isInteger(stop.agent_pid))

// Title posts.
const titlePost = recorded.find((r) => r.body.metadata_only === true)
assert.ok(titlePost, 'title metadata post missing')
assert.equal(titlePost.body.session_title, 'Clawd 接入测试')

// No posts for the child session itself (all folded into the parent).
assert.ok(recorded.every((r) => r.body.session_id !== 'session-child-1'), 'child session leaked its own card')

// The ApiError from agent/error should appear after the failed tool's error.
assert.ok(states.includes('error/ApiError'), 'agent/error not mapped')

console.log('MAPPING TEST PASSED —', recorded.length, 'posts')
