// Standalone load test: import the plugin and run apply() with a mock ctx.
const ctx = {
  logger: { info: console.log, warn: console.warn },
  on: (event) => console.log('ctx.on registered:', event),
  inject: (deps, fn) => {
    console.log('ctx.inject registered:', JSON.stringify(deps))
    // simulate available sessions service
    fn({ sessions: { list: () => [] } })
  },
}
const mod = await import('../index.js')
console.log('plugin name:', mod.name, '| inject:', JSON.stringify(mod.inject))
mod.apply(ctx, {
  enabled: true,
  agentId: '',
  port: 0,
  subagents: true,
  contextUsage: true,
  toolFailures: true,
  completionText: true,
  minIntervalMs: 200,
  timeoutMs: 1200,
})
console.log('LOAD OK')
