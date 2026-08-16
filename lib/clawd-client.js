// Clawd on Desk local-server client for the dsh-clawd-pet plugin.
//
// Wire protocol (reverse-engineered from Clawd on Desk's unpacked sources:
// hooks/server-config.js, src/server-route-state.js, src/custom-applications.js):
//
//   - Clawd runs a 127.0.0.1 HTTP server on port 23333..23337 and publishes
//     the live port in ~/.clawd/runtime.json  ({app:"clawd-on-desk", port, ownerPid}).
//   - Agents report state via POST /state with a JSON body:
//       { state, event, session_id, agent_id, cwd, agent_pid, tool_name,
//         session_title, model, provider, context_usage, assistant_last_output, ... }
//   - Responses: 200 + `x-clawd-server: clawd-on-desk` = accepted;
//     204 = dropped (agent_id unknown/disabled); 400 = unknown `state`.
//   - `agent_id` must be either a built-in agent id or a REGISTERED custom
//     application id of the exact shape `custom-<slug>-<sha256(execPath)[0..12]>`
//     (sha over the lowercased executable path on Windows). Custom apps are
//     registered once in Clawd Settings → Agents → custom applications; the
//     resolved {id, executablePath} list is persisted in
//     %APPDATA%/clawd-on-desk/clawd-prefs.json under `customApplications`.
//   - Custom-app sessions are namespaced server-side (`custom-xxx:<sid>`),
//     so arbitrary session ids ("default", uuids, ...) are safe.
//
// Only Node built-ins are used: this plugin must load inside every DSH host
// (DSH Desktop Electron main, `dsh web` node server) without extra deps.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

export const CLAWD_SERVER_ID = 'clawd-on-desk'
export const CLAWD_SERVER_HEADER = 'x-clawd-server'
export const DEFAULT_SERVER_PORT = 23333
export const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337]
export const STATE_PATH = '/state'
export const CLAWD_RUNTIME_PATH = () => join(homedir(), '.clawd', 'runtime.json')

/** Clawd's custom-application id for an executable path (mirror of
 * src/custom-applications.js `applicationId`: sha256 over the win32-lowercased
 * path, first 12 hex chars, slug from the exe basename). */
export function computeCustomApplicationId(executablePath, platform = process.platform) {
  const key = platform === 'win32' ? String(executablePath).toLowerCase() : String(executablePath)
  const base = String(executablePath).replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
  const name = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Custom application'
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'app'
  return `custom-${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}

export function isCustomApplicationId(value) {
  return typeof value === 'string' && /^custom-[a-z0-9-]+-[a-f0-9]{12}$/.test(value)
}

/** Read Clawd's persisted prefs (best-effort) and return the registered
 * custom applications array. Electron userData dir for app "Clawd on Desk"
 * is %APPDATA%/clawd-on-desk (lowercased product name). */
export function readClawdPrefsCustomApplications(env = process.env) {
  const candidates = []
  if (env.APPDATA) {
    candidates.push(join(env.APPDATA, 'clawd-on-desk', 'clawd-prefs.json'))
    candidates.push(join(env.APPDATA, 'Clawd on Desk', 'clawd-prefs.json'))
  }
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'clawd-on-desk', 'clawd-prefs.json'))
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const apps = parsed?.customApplications
      if (Array.isArray(apps)) return apps.filter((entry) => entry && typeof entry.id === 'string')
    } catch { /* unreadable/corrupt prefs — fall through */ }
  }
  return []
}

/** Resolve the Clawd server port from ~/.clawd/runtime.json, else null. */
export function readClawdPort() {
  try {
    const parsed = JSON.parse(readFileSync(CLAWD_RUNTIME_PATH(), 'utf8'))
    const port = Number(parsed?.port)
    if (parsed?.app === CLAWD_SERVER_ID && SERVER_PORTS.includes(port)) return port
  } catch { /* not running or unreadable */ }
  return null
}

/** Candidate ports in probe order: runtime.json first, then the fixed range. */
export function portCandidates() {
  const ports = []
  const runtimePort = readClawdPort()
  if (runtimePort) ports.push(runtimePort)
  for (const port of SERVER_PORTS) if (!ports.includes(port)) ports.push(port)
  return ports
}

function readHeader(res, name) {
  const value = res.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/** POST one state body to a specific port. Resolves { ok, status, isClawd }.
 * `ok` means Clawd explicitly accepted the event (HTTP 200 with the
 * x-clawd-server header). */
export function postStateToPort(port, body, timeoutMs = 1200) {
  const payload = JSON.stringify(body)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: STATE_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        const isClawd = readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID
        finish({ ok: isClawd && res.statusCode === 200, status: res.statusCode || 0, isClawd })
      },
    )
    req.on('error', () => finish({ ok: false, status: 0, isClawd: false }))
    req.on('timeout', () => {
      req.destroy()
      finish({ ok: false, status: 0, isClawd: false })
    })
    req.end(payload)
  })
}

/** GET /state health probe against one port. */
export function probePort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: STATE_PATH,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        finish(readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID)
      },
    )
    req.on('error', () => finish(false))
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.end()
  })
}
