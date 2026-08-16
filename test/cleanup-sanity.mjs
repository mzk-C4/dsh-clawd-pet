// Clean up the live-protocol sanity session from Clawd.
import { postStateToPort } from '../lib/clawd-client.js'
const r = await postStateToPort(23333, {
  state: 'sleeping',
  event: 'SessionEnd',
  session_id: 'smoke-claude-sanity',
  agent_id: 'claude-code',
  agent_pid: process.pid,
})
console.log('cleanup:', JSON.stringify(r))
