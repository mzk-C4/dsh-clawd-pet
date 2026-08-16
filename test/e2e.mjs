// End-to-end wire test: POST as the registered DSH Desktop custom application.
import { postStateToPort, probePort, computeCustomApplicationId } from '../lib/clawd-client.js'

const port = 23333
console.log('health:', await probePort(port))
const dshId = computeCustomApplicationId('D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe')

// Simulate a mini turn: start → think → work → complete → end.
const posts = [
  { state: 'idle', event: 'SessionStart', session_id: 'dsh-e2e-test', cwd: 'D:\\AI（project）\\ds install', session_title: '接入验证' },
  { state: 'thinking', event: 'UserPromptSubmit', session_id: 'dsh-e2e-test' },
  { state: 'working', event: 'PreToolUse', session_id: 'dsh-e2e-test', tool_name: 'pwsh' },
  { state: 'attention', event: 'Stop', session_id: 'dsh-e2e-test', assistant_last_output: 'dsh-clawd-pet 端到端验证成功：宠物应该刚刚庆祝了一下！' },
  { state: 'sleeping', event: 'SessionEnd', session_id: 'dsh-e2e-test' },
]
for (const post of posts) {
  const r = await postStateToPort(port, { ...post, agent_id: dshId, agent_pid: process.pid, platform: 'webui' })
  console.log(`${post.state.padEnd(11)} ${post.event.padEnd(16)} -> ${r.status} ${r.ok ? 'ACCEPTED' : 'DROPPED'}`)
  await new Promise((resolve) => setTimeout(resolve, 700))
}
