// Verify that Clawd's own identifyCustomApplication (folder pick and exe pick)
// produces exactly the id our plugin computes for process.execPath.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { computeCustomApplicationId } from '../lib/clawd-client.js'

const require = createRequire(import.meta.url)
const clawd = require('../../research3/clawd-src/src/custom-applications.js')

const exe = 'D:\\Program Files\\DeepSeek Harness\\DSH Desktop\\DSH Desktop.exe'
const folder = 'D:\\Program Files\\DeepSeek Harness\\DSH Desktop'

const fromExe = clawd.identifyCustomApplication(exe)
const fromFolder = clawd.identifyCustomApplication(folder)
assert.ok(fromExe, 'exe pick must identify')
assert.ok(fromFolder, 'folder pick must identify')
console.log('Clawd exe pick   ->', fromExe.id, '|', fromExe.executablePath)
console.log('Clawd folder pick->', fromFolder.id, '|', fromFolder.executablePath)

const ours = computeCustomApplicationId(exe)
console.log('ours             ->', ours)
assert.equal(fromExe.id, ours, 'exe-pick id must equal ours')
assert.equal(fromFolder.id, ours, 'folder-pick id must equal ours (same resolved exe)')
assert.equal(fromFolder.executablePath.toLowerCase(), exe.toLowerCase())
console.log('ID ROUND-TRIP OK — registering either the DSH Desktop folder or the exe yields', ours)
