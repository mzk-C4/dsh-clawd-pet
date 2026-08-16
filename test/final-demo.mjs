// One-shot demo: play the celebration + a complete mini lifecycle on the pet.
import { postStateToPort, computeCustomApplicationId } from '../lib/clawd-client.js'
const dshId = computeCustomApplicationId('D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe')
const sid = 'dsh-final-demo'
const post = (state, event, extra = {}) => postStateToPort(23333, { state, event, session_id: sid, agent_id: dshId, agent_pid: process.pid, platform: 'webui', ...extra })

console.log('notify   ->', (await post('notification', 'Notification', { session_title: 'DSH 接入完成' })).status)
await new Promise((r) => setTimeout(r, 1200))
console.log('thinking ->', (await post('thinking', 'UserPromptSubmit')).status)
await new Promise((r) => setTimeout(r, 1200))
console.log('working  ->', (await post('working', 'PreToolUse', { tool_name: 'pwsh' })).status)
await new Promise((r) => setTimeout(r, 1500))
console.log('celebrate->', (await post('attention', 'Stop', { assistant_last_output: 'dsh-clawd-pet 接入完成！重启 DSH Desktop 后即全自动生效。' })).status)
await new Promise((r) => setTimeout(r, 2500))
console.log('sleep    ->', (await post('sleeping', 'SessionEnd')).status)
