// Live protocol test against the running Clawd on Desk server.
// 1) unregistered custom id -> expect 204 (dropped)
// 2) known-state check with bad state -> expect 400 (unknown state)
// 3) claude-code (registered agent) sanity post -> expect 200 (accepted)
import { postStateToPort, probePort, computeCustomApplicationId } from '../lib/clawd-client.js'

const port = 23333
console.log('health:', await probePort(port))

const dshId = computeCustomApplicationId('D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe')

const r1 = await postStateToPort(port, {
  state: 'idle',
  event: 'SessionStart',
  session_id: 'smoke-test-1',
  agent_id: dshId,
  agent_pid: process.pid,
})
console.log(`unregistered custom id (${dshId}) ->`, JSON.stringify(r1), '(expect 204)')

const r2 = await postStateToPort(port, {
  state: 'not-a-state',
  event: 'SessionStart',
  session_id: 'smoke-test-2',
  agent_id: dshId,
  agent_pid: process.pid,
})
console.log('bad state ->', JSON.stringify(r2), '(expect 400 if agent accepted, or 204 if dropped first)')

const r3 = await postStateToPort(port, {
  state: 'idle',
  event: 'SessionStart',
  session_id: 'smoke-claude-sanity',
  agent_id: 'claude-code',
  agent_pid: process.pid,
})
console.log('claude-code sanity ->', JSON.stringify(r3), '(expect 200 — proves the wire format)')
