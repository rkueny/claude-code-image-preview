// Pure pixel work: base64, BMP decoding and the cell grid a `Raster` draws.
// No `$` here.
//
// Each terminal cell (about twice as tall as wide) is sampled as 4×8
// sub-pixels. Of the block glyphs below (half, quarter and eighth blocks), the
// one whose two-color split of those 32 sub-pixels leaves the least error is
// drawn, in the mean colors of its two parts: the approach of chafa's
// "symbols" mode, which shows about eight times the detail of plain half
// blocks.

export type Pixels = { width: number; height: number; rgb: Uint8Array }

type B64Array = Uint8ArrayConstructor & { fromBase64?: (s: string) => Uint8Array }
type B64Bytes = Uint8Array & { toBase64?: () => string }

export function fromBase64(s: string): Uint8Array {
  const native = (Uint8Array as B64Array).fromBase64
  if (native) return native(s)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)

  return out
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as B64Bytes).toBase64
  if (native) return native.call(bytes)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(bin)
}

/** Decodes an uncompressed 24- or 32-bit BMP (what sips and BMP3: write). */
export function decodeBmp(bytes: Uint8Array): Pixels {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP')
  const offset = dv.getUint32(10, true)
  const width = dv.getInt32(18, true)
  const rawHeight = dv.getInt32(22, true)
  const bpp = dv.getUint16(28, true)
  const compression = dv.getUint32(30, true)
  const height = Math.abs(rawHeight)
  const isTopDown = rawHeight < 0
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP of ${bpp} bits`)
  if (compression !== 0 && compression !== 3 && compression !== 6) throw new Error('compressed BMP')

  // 32-bit: BGRA unless bit fields say otherwise.
  let masks = [0x00ff0000, 0x0000ff00, 0x000000ff]
  if (bpp === 32 && compression !== 0) {
    masks = [dv.getUint32(54, true), dv.getUint32(58, true), dv.getUint32(62, true)]
  }
  const stride = Math.ceil((width * bpp) / 32) * 4
  const step = bpp / 8
  const rgb = new Uint8Array(width * height * 3)

  for (let y = 0; y < height; y++) {
    const row = offset + (isTopDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const p = row + x * step
      const o = (y * width + x) * 3
      if (bpp === 24) {
        rgb[o] = bytes[p + 2] ?? 0
        rgb[o + 1] = bytes[p + 1] ?? 0
        rgb[o + 2] = bytes[p] ?? 0
      } else {
        const v = dv.getUint32(p, true)
        rgb[o] = channel(v, masks[0] ?? 0)
        rgb[o + 1] = channel(v, masks[1] ?? 0)
        rgb[o + 2] = channel(v, masks[2] ?? 0)
      }
    }
  }

  return { width, height, rgb }
}

function channel(value: number, mask: number) {
  if (!mask) return 0
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  const max = mask >>> shift

  return Math.round(((((value & mask) >>> 0) >>> shift) * 255) / max)
}

/** Area-averages `px` down (or nearest-samples it up) to `w × h`. */
export function resample(px: Pixels, w: number, h: number): Pixels {
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * px.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * px.height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * px.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * px.width) / w))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < px.height; yy++) {
        for (let xx = x0; xx < x1 && xx < px.width; xx++) {
          const o = (yy * px.width + xx) * 3
          r += px.rgb[o] ?? 0
          g += px.rgb[o + 1] ?? 0
          b += px.rgb[o + 2] ?? 0
          n++
        }
      }
      const o = (y * w + x) * 3
      if (n > 0) {
        rgb[o] = Math.round(r / n)
        rgb[o + 1] = Math.round(g / n)
        rgb[o + 2] = Math.round(b / n)
      }
    }
  }

  return { width: w, height: h, rgb }
}

/** Sub-pixels per cell. */
const SW = 4
const SH = 8

/** A glyph and the sub-pixels (`y * SW + x`) it paints in its foreground. */
type Glyph = { cp: number; fg: number[] }

function glyph(cp: number, isFg: (x: number, y: number) => boolean): Glyph {
  const fg: number[] = []
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) if (isFg(x, y)) fg.push(y * SW + x)

  return { cp, fg }
}

/**
 * Every distinct two-part split the block glyphs make (a glyph and its
 * complement are one split with the colors swapped).
 */
const GLYPHS: Glyph[] = [
  // Lower eighths: ▁ ▂ ▃ ▄ ▅ ▆ ▇
  ...[1, 2, 3, 4, 5, 6, 7].map(k => glyph(0x2580 + k, (_, y) => y >= SH - k)),
  // Left quarter, half, three quarters: ▎ ▌ ▊
  glyph(0x258e, x => x < 1),
  glyph(0x258c, x => x < 2),
  glyph(0x258a, x => x < 3),
  // Quadrants: ▘ ▝ ▖ ▗ ▚
  glyph(0x2598, (x, y) => x < 2 && y < 4),
  glyph(0x259d, (x, y) => x >= 2 && y < 4),
  glyph(0x2596, (x, y) => x < 2 && y >= 4),
  glyph(0x2597, (x, y) => x >= 2 && y >= 4),
  glyph(0x259a, (x, y) => (x < 2) === (y < 4)),
]

/** Lower half block alone: what fonts draw cleanly where the terminal does not draw blocks itself. */
const HALF: Glyph[] = [glyph(0x2584, (_, y) => y >= SH / 2)]

/** `full`: every block glyph (terminals that draw them: iTerm2, WezTerm, VS Code…). `half`: ▄ only (Terminal.app). */
export type GlyphSet = 'full' | 'half'

const SPACE = 0x20

export type Cells = { words: Uint32Array; columns: number; rows: number }

/**
 * The cells of a `Raster` `columns × rows` showing `px`: per cell, the glyph
 * and the two colors that render its 4×8 sub-pixels best.
 */
export function fitCells(px: Pixels, columns: number, rows: number, set: GlyphSet = 'full'): Cells {
  const glyphs = set === 'half' ? HALF : GLYPHS
  const sub = resample(px, columns * SW, rows * SH)
  const words = new Uint32Array(columns * rows * 3)
  const n = SW * SH
  const r = new Float64Array(n)
  const g = new Float64Array(n)
  const b = new Float64Array(n)

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sq = 0
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const o = ((cy * SH + y) * sub.width + cx * SW + x) * 3
          const i = y * SW + x
          r[i] = sub.rgb[o] ?? 0
          g[i] = sub.rgb[o + 1] ?? 0
          b[i] = sub.rgb[o + 2] ?? 0
          sr += r[i]!
          sg += g[i]!
          sb += b[i]!
          sq += r[i]! * r[i]! + g[i]! * g[i]! + b[i]! * b[i]!
        }
      }

      // Error of one flat color, then of each split: Σ|p|² − |Σp|²/count per part.
      let bestErr = sq - (sr * sr + sg * sg + sb * sb) / n
      let best: Glyph | null = null
      let fgColor = [0, 0, 0]
      let bgColor = [sr / n, sg / n, sb / n]
      for (const gl of glyphs) {
        let fr = 0
        let fgr = 0
        let fb = 0
        for (const i of gl.fg) {
          fr += r[i]!
          fgr += g[i]!
          fb += b[i]!
        }
        const nf = gl.fg.length
        const nb = n - nf
        const br = sr - fr
        const bg = sg - fgr
        const bb = sb - fb
        const err = sq - (fr * fr + fgr * fgr + fb * fb) / nf - (br * br + bg * bg + bb * bb) / nb
        // A split must earn its place over a flat cell: keeps smooth areas calm.
        if (err < bestErr * 0.9) {
          bestErr = err
          best = gl
          fgColor = [fr / nf, fgr / nf, fb / nf]
          bgColor = [br / nb, bg / nb, bb / nb]
        }
      }

      const w = (cy * columns + cx) * 3
      const bgPacked = pack(bgColor)
      words[w] = best ? best.cp : SPACE
      words[w + 1] = best ? pack(fgColor) : bgPacked
      words[w + 2] = bgPacked
    }
  }
  limitPairs(words)

  return { words, columns, rows }
}

function pack([r = 0, g = 0, b = 0]: number[]) {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
}

/**
 * The terminal paints 1024 color pairs at once and the rest as their nearest:
 * past that, map every color to a 32-color palette fitted to the picture
 * (32 × 32 = 1024 pairs), so what shows is what was chosen.
 */
function limitPairs(words: Uint32Array) {
  const pairs = new Set<number>()
  for (let i = 0; i < words.length; i += 3) {
    pairs.add((words[i + 1] ?? 0) * 0x1000000 + (words[i + 2] ?? 0))
    if (pairs.size > 1024) break
  }
  if (pairs.size <= 1024) return

  const colors: number[] = []
  for (let i = 0; i < words.length; i += 3) colors.push(words[i + 1] ?? 0, words[i + 2] ?? 0)
  const palette = kMeans(colors, 32)
  const memo = new Map<number, number>()
  const nearest = (c: number) => {
    let hit = memo.get(c)
    if (hit === undefined) {
      hit = palette[nearestIndex(palette, c)] ?? c
      memo.set(c, hit)
    }

    return hit
  }
  for (let i = 0; i < words.length; i += 3) {
    words[i + 1] = nearest(words[i + 1] ?? 0)
    words[i + 2] = nearest(words[i + 2] ?? 0)
  }
}

function dist(a: number, b: number) {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255)
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255)
  const db = (a & 255) - (b & 255)

  return dr * dr + dg * dg + db * db
}

function nearestIndex(palette: number[], c: number) {
  let best = 0
  let bestD = Infinity
  for (let k = 0; k < palette.length; k++) {
    const d = dist(palette[k] ?? 0, c)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }

  return best
}

/** A palette of `k` colors for `colors`: k-means, seeded by spread. */
function kMeans(colors: number[], k: number): number[] {
  const unique = [...new Set(colors)]
  if (unique.length <= k) return unique
  const palette = [unique[0] ?? 0]
  while (palette.length < k) {
    let far = unique[0] ?? 0
    let farD = -1
    for (let i = 0; i < unique.length; i += Math.max(1, Math.floor(unique.length / 2048))) {
      const c = unique[i] ?? 0
      const d = dist(palette[nearestIndex(palette, c)] ?? 0, c)
      if (d > farD) {
        farD = d
        far = c
      }
    }
    palette.push(far)
  }
  for (let round = 0; round < 6; round++) {
    const sums = palette.map(() => [0, 0, 0, 0])
    for (const c of colors) {
      const s = sums[nearestIndex(palette, c)]!
      s[0]! += (c >> 16) & 255
      s[1]! += (c >> 8) & 255
      s[2]! += c & 255
      s[3]! += 1
    }
    sums.forEach((s, i) => {
      if (s[3]) palette[i] = pack([s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]])
    })
  }

  return palette
}

export function cellsToBase64(cells: Cells) {
  return toBase64(new Uint8Array(cells.words.buffer))
}

/** Cells for a picture `rows` tall: a cell is about twice as tall as wide. */
export function boxFor(width: number, height: number, rows: number, maxColumns: number) {
  let r = Math.max(1, rows)
  let c = Math.round((r * 2 * width) / height)
  if (c > maxColumns) {
    c = maxColumns
    r = Math.max(1, Math.round((c * height) / (2 * width)))
  }

  return { columns: Math.max(1, Math.min(255, c)), rows: Math.min(255, r) }
}

type Box = { columns: number; rows: number }

/** Each tile's border on every side, and the caption row under its picture. */
const TILE_CHROME_ROWS = 3
const TILE_CHROME_COLUMNS = 2
const TILE_GAP = 1
const TILE_MAX_COLUMNS = 48

/**
 * Picture boxes for one row of tiles that fits the band whole, so it never
 * scrolls: the tallest, up to `wanted` rows, whose tiles fit `maxRows` and
 * whose widths add up within `bodyColumns`.
 */
export function fitRow(sizes: readonly { width: number; height: number }[], maxRows: number, bodyColumns: number, wanted: number): Box[] {
  const tallest = Math.max(1, Math.min(wanted, maxRows - TILE_CHROME_ROWS))
  for (let rows = tallest; rows > 1; rows--) {
    const boxes = sizes.map(s => boxFor(s.width, s.height, rows, TILE_MAX_COLUMNS))
    const width = boxes.reduce((sum, b) => sum + b.columns + TILE_CHROME_COLUMNS, 0) + TILE_GAP * (boxes.length - 1)
    if (width <= bodyColumns) return boxes
  }

  return sizes.map(s => boxFor(s.width, s.height, 1, TILE_MAX_COLUMNS))
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
