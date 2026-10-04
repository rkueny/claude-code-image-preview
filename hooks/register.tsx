import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { PastedImage } from '../types'
import {
  EXT,
  JPEG_MAX_BYTES,
  JPEG_STEPS,
  bmpArgv,
  clipboardArgv,
  copiesOf,
  isOwnWork,
  isPastedName,
  isPicture,
  jpgArgv,
  measureArgv,
  mediaTypeOf,
  parseMeasure,
  pngArgv,
  projectFolder,
  tempRoot,
  writeBase64Argv,
} from './host'
import type { Host } from './host'
import { boxFor, cellsToBase64, decodeBmp, fitCells, fitRow, formatSize, fromBase64 } from './pixels'
import type { GlyphSet, Pixels } from './pixels'

type $ = EngineInterface
type Drawn = RenderInput<'AbovePrompt' | 'Pane'>
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type Sent = { index: number; block: ImageBlock; n?: number }

const GALLERY = 'image-preview'
const KEPT = 40
const SHOWN = 12
const TOKEN = /\[Image #(\d+)\]/g
// Pasting an image raises no prompt.edit (the tag shows on the next key), so the prompt is polled.
const POLL_MS = 200

const images = atom({ plugin: 'image-preview', key: 'images' } as const, [] as PastedImage[])

// The module's own memory: rebuilt after a reload, while `images` stays.
let renderer = 'auto'
let bandRows = 10
let host: Host | null = null
let hostPending: Promise<Host> | null = null
let isKitty = false
let glyphSet: GlyphSet = 'full'
let hasWarned = false
/** The `[Image #n]` of the prompt being submitted, in order, for its row. */
let submittedNs: number[] = []
const capturing = new Set<number>()
/** The `[Image #n]` the last poll saw, so an unchanged prompt costs one read. */
let lastTokens = ''
let isPolling = false
const pixelCache = new Map<string, Pixels>()
const cellCache = new Map<string, string>()
const svgCache = new Map<string, string>()

function tokensOf(text: string) {
  return [...text.matchAll(TOKEN)].map(m => Number(m[1]))
}

function isImageBlock(block: { type: string; [k: string]: unknown }): block is ImageBlock {
  const source = block.source as { type?: unknown; data?: unknown } | undefined

  return block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string'
}

function run($: $, argv: string[] | null, stdin?: string) {
  if (!argv) return Promise.resolve(null)

  return $.process.run(argv, { stdin, timeoutMs: 20_000 }).catch(() => null)
}

// ---- the machine -------------------------------------------------------------

function ensureHost($: $): Promise<Host> {
  if (host) return Promise.resolve(host)
  hostPending ??= detectHost($).then(found => {
    host = found
    hostPending = null
    if (!found.tool && !hasWarned) {
      hasWarned = true
      $.ui.toast('image-preview: no image converter found (needs sips on macOS, ImageMagick on Linux)')
    }

    return found
  })

  return hostPending
}

async function detectHost($: $): Promise<Host> {
  const uname = await run($, ['uname', '-s'])
  const name = uname?.stdout.trim() ?? ''
  const os = name === 'Darwin' ? 'darwin' : name === 'Linux' ? 'linux' : 'other'

  let tool: Host['tool'] = null
  if (os === 'darwin') {
    tool = 'sips'
  } else if (os === 'linux') {
    const found = await run($, ['sh', '-c', 'command -v magick || command -v convert'])
    const path = found?.stdout.trim() ?? ''
    tool = path.endsWith('magick') ? 'magick' : path.endsWith('convert') ? 'convert' : null
  }

  const sessionId = await $.session.id()
  const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  const work = `${tmp}/claude-image-preview/${sessionId.replace(/[^\w-]/g, '_')}`
  await run($, ['mkdir', '-p', work])

  return { os, tool, work, pasteDir: await findPasteDir($, sessionId) }
}

/**
 * Claude Code writes each pasted image to
 * `<tmp>/claude-<uid>/<project>/<session>/images/<n>.<ext>` as it is pasted,
 * the project folder being the cwd with every non-alphanumeric turned into
 * `-`. When that folder is not there yet, the temp root is scanned for the
 * session; failing that, the guess is where it will land.
 */
async function findPasteDir($: $, sessionId: string): Promise<string> {
  const uid = (await run($, ['id', '-u']))?.stdout.trim() || '0'
  const root = tempRoot(await $.env.get('CLAUDE_CODE_TMPDIR'), uid)
  const guess = `${root}/${projectFolder(await $.session.cwd())}/${sessionId}`
  if (await $.fs.exists(guess).catch(() => false)) return `${guess}/images`

  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const dir = `${root}/${entry.name}/${sessionId}`
    if (await $.fs.exists(dir).catch(() => false)) return `${dir}/images`
  }

  return `${guess}/images`
}

async function looksLikeKitty($: $) {
  if (await $.env.get('TMUX')) return false
  const term = (await $.env.get('TERM')) ?? ''
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''

  return (
    /kitty|ghostty/i.test(term) ||
    /kitty|ghostty/i.test(program) ||
    !!(await $.env.get('KITTY_WINDOW_ID')) ||
    !!(await $.env.get('GHOSTTY_RESOURCES_DIR'))
  )
}

async function copyPath($: $, file: string, surface: Drawn['surface']) {
  const copied = await $.ui.copy({ text: file, surface })
  $.ui.toast(copied.isCopied ? 'Path copied' : 'Could not copy the path')
}

// ---- capture -----------------------------------------------------------------

type Found = Pick<PastedImage, 'id' | 'n' | 'status' | 'file' | 'mediaType' | 'rowId'>

/** Measures the picture, makes the renderers' copies and adds it to `images`. */
async function ingest($: $, found: Found) {
  const h = await ensureHost($)
  const measured = await run($, measureArgv(h.tool, found.file))
  const size = measured && parseMeasure(h.tool, measured.stdout)
  if (!size) return

  const at = await $.clock.now()
  const copies = copiesOf(`${h.work}/${found.id}-${at}`)
  await run($, pngArgv(h.tool, found.file, copies.png, size.width, size.height))
  await run($, bmpArgv(h.tool, found.file, copies.bmp, size.width, size.height))
  for (const [side, quality] of JPEG_STEPS) {
    await run($, jpgArgv(h.tool, found.file, copies.jpg, size.width, size.height, side, quality))
    const stat = await $.fs.stat(copies.jpg).catch(() => null)
    if (stat && stat.size > 0 && stat.size < JPEG_MAX_BYTES) break
  }

  const stat = await $.fs.stat(found.file).catch(() => null)
  const image: PastedImage = { ...found, ...size, ...copies, size: stat?.size ?? 0, at }
  await update($, images, list => [...list.filter(i => i.id !== image.id), image].slice(-KEPT))
}

/** Whether `[Image #n]` is still in the prompt. */
async function isInPrompt($: $, n: number) {
  const box = await $.prompt.read().catch(() => null)

  return !!box && tokensOf(box.text).includes(n)
}

/** `[Image #n]` just appeared in the prompt: find its picture and show it. */
async function captureDraft($: $, n: number, attempt = 0): Promise<void> {
  let isDone = true
  try {
    const h = await ensureHost($)
    const entries = h.pasteDir ? await $.fs.list(h.pasteDir).catch(() => []) : []
    const hit = entries.find(e => e.kind === 'file' && isPastedName(e.name, n))
    if (hit && h.pasteDir) {
      const file = `${h.pasteDir}/${hit.name}`
      if (await isInPrompt($, n)) {
        await ingest($, { id: `draft-${n}`, n, status: 'draft', file, mediaType: mediaTypeOf(file) })
      }

      return
    }
    // Claude Code writes the file a moment after the paste: wait a little,
    // looking again for the session's folder in case it moved.
    if (attempt < 4) {
      if (attempt === 1) h.pasteDir = await findPasteDir($, await $.session.id())
      isDone = false
      $.clock.after(250, () => void captureDraft($, n, attempt + 1))

      return
    }
    // Never written (the store is off for this session): read the clipboard.
    const out = `${h.work}/clipboard-${n}-${await $.clock.now()}.png`
    const done = await run($, clipboardArgv(h.os, out))
    if (done?.exitCode !== 0) return
    const said = done.stdout.trim()
    const file = said.startsWith('file:') ? said.slice('file:'.length) : out
    if (isPicture(file) && (await isInPrompt($, n))) {
      await ingest($, { id: `draft-${n}`, n, status: 'draft', file, mediaType: mediaTypeOf(file) })
    }
  } finally {
    if (isDone) capturing.delete(n)
  }
}

/** Keeps the draft thumbnails in step with the `[Image #n]` in the prompt. */
async function syncDraft($: $, text: string) {
  const wanted = new Set(tokensOf(text))
  const drafts = (await read($, images)).filter(i => i.status === 'draft')
  const isStale = (i: PastedImage) => i.status === 'draft' && (i.n === undefined || !wanted.has(i.n))
  if (drafts.some(isStale)) {
    await update($, images, list => list.filter(i => !isStale(i)))
  }
  for (const n of wanted) {
    if (drafts.some(d => d.n === n) || capturing.has(n)) continue
    capturing.add(n)
    void captureDraft($, n)
  }
}

/** Brings the thumbnails in step with the prompt as soon as a tag comes or goes. */
async function pollPrompt($: $) {
  if (isPolling) return
  isPolling = true
  try {
    const box = await $.prompt.read().catch(() => null)
    if (!box) return
    const tokens = tokensOf(box.text).join(',')
    if (tokens === lastTokens) return
    lastTokens = tokens
    await syncDraft($, box.text)
  } finally {
    isPolling = false
  }
}

async function ingestSent($: $, rowId: string, blocks: Sent[]) {
  const h = await ensureHost($)
  for (const { index, block, n } of blocks) {
    const ext = EXT[block.source.media_type] ?? 'png'
    const id = `sent-${rowId.replace(/[^\w-]/g, '')}-${index}`
    const file = `${h.work}/${id}.${ext}`
    const done = await run($, writeBase64Argv(file), block.source.data)
    if (done?.exitCode === 0) {
      await ingest($, { id, n, status: 'sent', file, mediaType: block.source.media_type, rowId })
    }
  }
}

async function forgetAll($: $) {
  const h = host
  host = null
  submittedNs = []
  lastTokens = ''
  await update($, images, () => [])
  if (h && isOwnWork(h.work)) await run($, ['rm', '-rf', h.work])
}

// ---- drawing -----------------------------------------------------------------

function labelOf(img: PastedImage) {
  return img.n !== undefined ? `[Image #${img.n}]` : 'Image'
}

function altOf(img: PastedImage) {
  return `${labelOf(img)} ${img.width}×${img.height}`
}

function infoOf(img: PastedImage) {
  return `${img.width}×${img.height} · ${formatSize(img.size)}`
}

function timeOf(at: number) {
  const d = new Date(at)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function cellsOf($: $, img: PastedImage, columns: number, rows: number) {
  const key = `${img.bmp}:${columns}x${rows}:${glyphSet}`
  let cells = cellCache.get(key)
  if (!cells) {
    let px = pixelCache.get(img.bmp)
    if (!px) {
      const { base64 } = await $.fs.read(img.bmp, { as: 'bytes' })
      px = decodeBmp(fromBase64(base64))
      // Decoded pictures are large: keep the last few only.
      if (pixelCache.size >= 4) pixelCache.delete(pixelCache.keys().next().value ?? '')
      pixelCache.set(img.bmp, px)
    }
    cells = cellsToBase64(fitCells(px, columns, rows, glyphSet))
    if (cellCache.size >= 64) cellCache.delete(cellCache.keys().next().value ?? '')
    cellCache.set(key, cells)
  }

  return cells
}

async function svgOf($: $, img: PastedImage) {
  let svg = svgCache.get(img.jpg)
  if (!svg) {
    const { base64 } = await $.fs.read(img.jpg, { as: 'bytes' })
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${img.width} ${img.height}">` +
      `<image width="${img.width}" height="${img.height}" href="data:image/jpeg;base64,${base64}"/></svg>`
    svgCache.set(img.jpg, svg)
  }

  return svg
}

/** One picture: `rows` cells tall on the terminal, at most `px` CSS pixels elsewhere. */
async function picture($: $, e: Drawn, img: PastedImage, rows: number, maxColumns: number, px: number) {
  try {
    if (e.surface === 'terminal') {
      const { Image, Raster } = $.ui.resolve(e)
      const box = boxFor(img.width, img.height, rows, maxColumns)
      if (isKitty) {
        return (
          <Image
            key={`img-${img.id}`}
            source={{ file: img.png, format: 'png' }}
            columns={box.columns}
            rows={box.rows}
            alt={altOf(img)}
          />
        )
      }

      return (
        <Raster
          key={`img-${img.id}`}
          columns={box.columns}
          rows={box.rows}
          cells={await cellsOf($, img, box.columns, box.rows)}
        />
      )
    }
    const { Svg } = $.ui.resolve(e)
    const height = Math.round(Math.min(px, (maxColumns * 8 * img.height) / img.width))
    const width = Math.round((height * img.width) / img.height)

    return <Svg source={await svgOf($, img)} alt={altOf(img)} width={width} height={height} />
  } catch {
    // A copy went missing (a cleaned temp dir, a reload mid-write).
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>({altOf(img)}: preview unavailable)</Text>
  }
}

async function drawBand($: $, e: RenderInput<'AbovePrompt'>, drafts: PastedImage[], below: RenderElement) {
  const { Box, Text } = $.ui.resolve(e)
  const boxes = fitRow(drafts, e.props.maxRows - 1, e.props.bodyColumns, bandRows)
  const tiles = await Promise.all(
    drafts.map(async (img, i) => {
      const box = boxes[i] ?? { columns: 4, rows: 1 }
      const caption = `#${img.n ?? i + 1} · ${img.width}×${img.height}`

      return (
        <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
          {await picture($, e, img, box.rows, box.columns, 120)}
          <Text dimColor>{box.columns >= caption.length ? caption : `#${img.n ?? i + 1}`}</Text>
        </Box>
      )
    }),
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {tiles}
      </Box>
      {below}
    </Box>
  )
}

async function drawGallery($: $, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const all = [...(await read($, images))].reverse()
  if (all.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No pasted image yet.</Text>
        <Text dimColor>Paste one (ctrl+v) or drop a file into the prompt: it shows up here.</Text>
      </Box>
    )
  }
  const maxColumns = Math.max(10, e.props.bodyColumns - 2)
  const items = await Promise.all(
    all.slice(0, SHOWN).map(async img => (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>{img.status === 'draft' ? `${labelOf(img)} in your prompt` : `${labelOf(img)} sent at ${timeOf(img.at)}`}</Text>
          <Text dimColor> {infoOf(img)}</Text>
        </Text>
        {await picture($, e, img, 12, maxColumns, 320)}
        <Box flexDirection="row" gap={1}>
          <Button key={`copy-${img.id}`} label="Copy path" onPress={() => void copyPath($, img.file, e.surface)} />
        </Box>
      </Box>
    )),
  )

  return (
    <Box flexDirection="column">
      {items}
      {all.length > SHOWN && <Text dimColor>+{all.length - SHOWN} older</Text>}
    </Box>
  )
}

// ---- hooks ---------------------------------------------------------------------

export const register: Register = (on, options) => {
  renderer = String(options.renderer ?? 'auto')
  bandRows = Math.max(2, Math.min(24, Number(options.bandRows ?? 10) || 10))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'images',
      description: 'Show the images pasted in this session',
      argumentHint: '[clear]',
    })
    isKitty = renderer === 'kitty' || (renderer === 'auto' && (await looksLikeKitty($)))
    // Terminal.app draws block glyphs from the font, which leaves gaps: half blocks only there.
    const program = (await $.env.get('TERM_PROGRAM')) ?? ''
    glyphSet = renderer === 'halfblocks' || (renderer === 'auto' && program === 'Apple_Terminal') ? 'half' : 'full'
    await ensureHost($)
    $.clock.every(POLL_MS, () => void pollPrompt($))

    return started
  })

  // A /clear or an exit: the conversation's images go with it.
  on('session.end', async ($, e, next) => {
    await forgetAll($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    submittedNs = e.attachments?.some(a => a.type === 'image') ? tokensOf(e.text) : []
    const entered = await next(e)
    if (submittedNs.length > 0) {
      await update($, images, list => list.filter(i => i.status !== 'draft'))
    }

    return entered
  })

  // Every image that reaches the conversation, from the terminal or the desktop.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const isPerson = e.message.type === 'user' && e.door !== 'tool-result' && e.door !== 'tool-message'
    if (!e.agentId && isPerson) {
      const ns = e.door === 'prompt' ? submittedNs : []
      const blocks = e.message.content.flatMap((block, index) => (isImageBlock(block) ? [{ index, block }] : []))
      if (blocks.length > 0) {
        const rowId = e.uuid
        const sent = blocks.map((b, k) => ({ ...b, n: ns[k] }))
        submittedNs = []
        $.clock.after(0, () => void ingestSent($, rowId, sent))
      }
    }

    return stored
  })

  on('command.run', { command: 'images' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, images, () => [])

      return { text: 'Image gallery cleared.' }
    }
    const all = await read($, images)
    await $.ui.open({ id: GALLERY, title: 'Images' })

    return {
      text: all.length
        ? `${all.length} image${all.length > 1 ? 's' : ''} in the Images pane.`
        : 'No pasted image yet: the Images pane fills as you paste.',
    }
  })

  // The images sitting in the prompt, before sending.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const drafts = (await read($, images)).filter(i => i.status === 'draft').sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    if (drafts.length === 0) return next(e)

    return drawBand($, e, drafts, await next(e))
  })

  // Every image of the session, newest first.
  on('ui.render', { component: 'Pane', requestId: GALLERY }, ($, e) => drawGallery($, e))
}
