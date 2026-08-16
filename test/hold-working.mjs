// Hold a working state for ~20s so the pet is visibly animating (typing),
// while a screenshot is taken from outside.
import { postStateToPort, computeCustomApplicationId } from '../lib/clawd-client.js'
const dshId = computeCustomApplicationId('D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe')
const sid = 'dsh-visual-check'
const keep = async (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await postStateToPort(23333, { state: 'working', event: 'PreToolUse', session_id: sid, tool_name: 'pwsh', agent_id: dshId, agent_pid: process.pid, platform: 'webui' })
    await new Promise((r) => setTimeout(r, 3000))
  }
}
keep(Number(process.argv[2] ?? 20000)).then(() => {
  return postStateToPort(23333, { state: 'sleeping', event: 'SessionEnd', session_id: sid, agent_id: dshId, agent_pid: process.pid })
}).then((r) => console.log('done, cleanup:', r.status))
