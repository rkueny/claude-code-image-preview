import { expect, mock, test } from 'claude-code/testing'

import { boxFor, decodeBmp, fitCells, fitRow } from '../hooks/pixels'

/** A 24-bit top-down BMP, `w × h`, a gold square on a dark ground. */
function bmp(w: number, h: number): Uint8Array {
  const stride = Math.ceil((w * 3) / 4) * 4
  const bytes = new Uint8Array(54 + stride * h)
  const dv = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  dv.setUint32(2, bytes.length, true)
  dv.setUint32(10, 54, true)
  dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true)
  dv.setInt32(22, -h, true)
  dv.setUint16(26, 1, true)
  dv.setUint16(28, 24, true)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isGold = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4
      const p = 54 + y * stride + x * 3
      bytes[p] = isGold ? 0x30 : 0x18 // B
      bytes[p + 1] = isGold ? 0xb0 : 0x10 // G
      bytes[p + 2] = isGold ? 0xd0 : 0x20 // R
    }
  }

  return bytes
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

test('a BMP decodes to its pixels', () => {
  const px = decodeBmp(bmp(8, 8))
  expect(px.width).toBe(8)
  expect([...px.rgb.slice(0, 3)]).toEqual([0x20, 0x10, 0x18])
  const middle = (4 * 8 + 4) * 3
  expect([...px.rgb.slice(middle, middle + 3)]).toEqual([0xd0, 0xb0, 0x30])
})

test('cells use block glyphs where the picture has an edge, flat cells elsewhere', () => {
  const px = decodeBmp(bmp(64, 64))
  const { words } = fitCells(px, 16, 8)
  const glyphs = new Set<number>()
  for (let i = 0; i < words.length; i += 3) glyphs.add(words[i] ?? 0)
  expect(glyphs.has(0x20)).toBe(true)
  // Terminal.app's set: lower half blocks only.
  const half = fitCells(px, 16, 8, 'half').words
  for (let i = 0; i < half.length; i += 3) expect([0x20, 0x2584]).toContain(half[i])
})

test('a row of tiles keeps aspect ratios and fits the band', () => {
  expect(boxFor(500, 500, 10, 48)).toEqual({ columns: 20, rows: 10 })
  const square = { width: 500, height: 500 }
  expect(fitRow([square], 30, 120, 10)).toEqual([{ columns: 20, rows: 10 }])
  expect(fitRow([square, square, square], 30, 40, 10)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
})

const BAND = {
  plugin: 'image-preview',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('a pasted image shows framed above the prompt, and goes when the prompt is sent', async ($, on) => {
  const clock = mock.clock(on)
  const pasteDir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'look [Image #1]'
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  const env: Record<string, string> = { TERM_PROGRAM: 'iTerm.app', TMPDIR: '/tmp' }

  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.exists', ($, e) => ({ value: e.path.startsWith('/tmp/claude-501/-work/sess-1') }))
  on('fs.list', ($, e) => ({ value: e.path === pasteDir ? [{ name: '1.png', kind: 'file', ...entry }] : [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 65_000, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: toB64(bmp(64, 64)) } }))
  on('process.run', ($, e) => {
    const stdout = e.argv[0] === 'uname' ? 'Darwin\n' : e.argv[0] === 'id' ? '501\n' : e.argv.includes('pixelWidth') ? 'pixelWidth: 232\npixelHeight: 232\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props).toMatchObject({ columns: 20, rows: 10 })
  expect(await ui.find({ type: 'Text', text: '#1 · 232×232' })).toBeDefined()
  // The engine's own band still draws beneath the tiles.
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()

  // Sending the prompt empties the box, and the tiles go.
  draft = ''
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Raster' })).toBeUndefined()
})
