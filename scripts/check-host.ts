// Runs the mod's real commands on this machine, outside Claude Code: measure,
// convert to PNG, BMP and JPEG, decode base64, read the clipboard, delete a
// folder. CI runs it on Windows, macOS and Linux (.github/workflows/check.yml).
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/check-host.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  JPEG_MAX_BYTES,
  JPEG_STEPS,
  bmpCmd,
  clipboardCmd,
  copiesOf,
  decodeBase64Cmd,
  isOwnWork,
  jpgCmd,
  measureCmd,
  parseMeasure,
  pngCmd,
  removeCmd,
  trimDir,
} from '../hooks/host'
import type { Cmd, Os, Tool } from '../hooks/host'
import { decodeBmp } from '../hooks/pixels'

const os: Os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'

function which(name: string) {
  return spawnSync(os === 'windows' ? 'where' : 'which', [name]).status === 0
}

const tool: Tool = os === 'windows' ? 'gdi' : os === 'darwin' ? 'sips' : which('magick') ? 'magick' : which('convert') ? 'convert' : null

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

function run(cmd: Cmd | null) {
  if (!cmd) throw new Error('no command for this system')
  const [file, ...args] = cmd.argv
  const done = spawnSync(file ?? '', args, { env: { ...process.env, ...cmd.env }, encoding: 'utf8', timeout: 60_000 })

  return { code: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
}

// The mod builds its paths with `/` after the system's temp dir, as here.
const work = `${trimDir(tmpdir())}/claude-image-preview/ci-check`
mkdirSync(work, { recursive: true })
const input = new URL('../image-preview.png', import.meta.url)
const source = `${work}/source.png`
writeFileSync(source, readFileSync(input))

console.log(`system ${os}, converter ${tool}, work ${work}`)
check('a converter is found', tool !== null)

const measured = run(measureCmd(tool, source))
const size = parseMeasure(tool, measured.stdout)
check('measure', size?.width === 2000 && size?.height === 733, `${measured.stdout.trim()} ${measured.stderr.trim()}`)

const copies = copiesOf(`${work}/source`)
const w = size?.width ?? 2000
const h = size?.height ?? 733

const png = run(pngCmd(tool, source, copies.png, w, h))
const pngSize = parseMeasure(tool, run(measureCmd(tool, copies.png)).stdout)
check('PNG copy, 1024 px wide', png.code === 0 && pngSize?.width === 1024, png.stderr.trim())

const bmp = run(bmpCmd(tool, source, copies.bmp, w, h))
try {
  const px = decodeBmp(new Uint8Array(readFileSync(copies.bmp)))
  check('BMP copy decodes, 800 px wide', bmp.code === 0 && px.width === 800 && px.height === 293, `${px.width}×${px.height}`)
} catch (error) {
  check('BMP copy decodes', false, `${error} ${bmp.stderr.trim()}`)
}

let jpgBytes = 0
for (const [side, quality] of JPEG_STEPS) {
  run(jpgCmd(tool, source, copies.jpg, w, h, side, quality))
  jpgBytes = existsSync(copies.jpg) ? statSync(copies.jpg).size : 0
  if (jpgBytes > 0 && jpgBytes < JPEG_MAX_BYTES) break
}
check('JPEG copy fits the desktop', jpgBytes > 0 && jpgBytes < JPEG_MAX_BYTES, `${jpgBytes} bytes`)

const original = readFileSync(source)
const b64 = `${work}/sent.png.b64`
writeFileSync(b64, original.toString('base64'))
const decoded = run(decodeBase64Cmd(os, b64, `${work}/sent.png`))
const roundTrip = existsSync(`${work}/sent.png`) && readFileSync(`${work}/sent.png`).equals(original)
check('base64 decodes to the same bytes', decoded.code === 0 && roundTrip && !existsSync(b64), decoded.stderr.trim())

// CI has no picture on the clipboard (and Linux runners no clipboard tool): any
// non-zero exit is the mod's "no picture". Only a broken script fails here.
const clip = run(clipboardCmd(os, `${work}/clipboard.png`))
const isBroken = /ParserError|is not recognized|CommandNotFound|syntax error/i.test(clip.stderr)
check('clipboard read runs', !isBroken, `exit ${clip.code} ${clip.stderr.trim()}`)

check('the work folder is recognized as ours', isOwnWork(work))
const removed = run(removeCmd(os, work))
check('the work folder is removed', removed.code === 0 && !existsSync(work), removed.stderr.trim())

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
