// The commands the mod runs on the machine, built as argument vectors: how
// pictures are measured and converted (sips on macOS, ImageMagick on Linux),
// read from the clipboard and opened. Pure: register.tsx runs them.

export type Os = 'darwin' | 'linux' | 'other'
export type Tool = 'sips' | 'magick' | 'convert' | null

export type Host = {
  os: Os
  /** The converter found on this machine, or null (then nothing is drawn). */
  tool: Tool
  /** Where this session's copies go. */
  work: string
  /** The folder Claude Code stores this session's pasted images in. */
  pasteDir: string | null
}

export const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export function mediaTypeOf(file: string) {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''

  return Object.keys(EXT).find(k => EXT[k] === ext) ?? (ext === 'jpeg' ? 'image/jpeg' : 'image/png')
}

/** Claude Code's project folder name for a cwd: every non-alphanumeric is `-`. */
export function projectFolder(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Claude Code's temp root, where it stores pasted images under
 * `<root>/<project>/<session>/images/<n>.<ext>`: `$CLAUDE_CODE_TMPDIR` (or
 * `/tmp`) plus `claude-<uid>`.
 */
export function tempRoot(tmpdir: string | undefined, uid: string) {
  return `${(tmpdir || '/tmp').replace(/\/+$/, '')}/claude-${uid}`
}

const PICTURE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

export function isPicture(path: string) {
  return PICTURE.test(path)
}

export function isPastedName(name: string, n: number) {
  return new RegExp(`^${n}\\.[a-z]+$`).test(name)
}

/** Fits `width × height` inside `maxW × maxH` without enlarging. */
export function fit(width: number, height: number, maxW: number, maxH = maxW) {
  const k = Math.min(1, maxW / width, maxH / height)

  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) }
}

export function measureArgv(tool: Tool, file: string): string[] | null {
  if (tool === 'sips') return ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]
  if (tool === 'magick') return ['magick', 'identify', '-format', '%w %h', `${file}[0]`]
  if (tool === 'convert') return ['identify', '-format', '%w %h', `${file}[0]`]

  return null
}

export function parseMeasure(tool: Tool, stdout: string) {
  let width = 0
  let height = 0
  if (tool === 'sips') {
    width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
    height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
  } else {
    ;[width = 0, height = 0] = stdout.trim().split(' ').map(Number)
  }

  return width > 0 && height > 0 ? { width, height } : null
}

export type Copies = { png: string; bmp: string; jpg: string }

export function copiesOf(base: string): Copies {
  return { png: `${base}.view.png`, bmp: `${base}.cells.bmp`, jpg: `${base}.thumb.jpg` }
}

/** PNG at most 1024 px a side: what the kitty protocol draws. */
export function pngArgv(tool: Tool, file: string, out: string, width: number, height: number): string[] | null {
  const t = fit(width, height, 1024)
  if (tool === 'sips') return ['sips', '-s', 'format', 'png', '-z', `${t.h}`, `${t.w}`, file, '--out', out]
  if (tool) return [tool, `${file}[0]`, '-resize', `${t.w}x${t.h}!`, `png:${out}`]

  return null
}

/** 24-bit BMP at most 800×800: what the block renderer samples, the viewer included. */
export function bmpArgv(tool: Tool, file: string, out: string, width: number, height: number): string[] | null {
  const t = fit(width, height, 800, 800)
  if (tool === 'sips') return ['sips', '-s', 'format', 'bmp', '-z', `${t.h}`, `${t.w}`, file, '--out', out]
  if (tool) {
    return [tool, `${file}[0]`, '-background', 'black', '-flatten', '-resize', `${t.w}x${t.h}!`, '-type', 'TrueColor', `BMP3:${out}`]
  }

  return null
}

/** The JPEG sizes tried, largest first, until one fits the desktop's Svg. */
export const JPEG_STEPS = [
  [480, 60],
  [320, 50],
  [200, 40],
] as const

export function jpgArgv(tool: Tool, file: string, out: string, width: number, height: number, side: number, quality: number): string[] | null {
  const t = fit(width, height, side)
  if (tool === 'sips') {
    return ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', `${quality}`, '-z', `${t.h}`, `${t.w}`, file, '--out', out]
  }
  if (tool) {
    return [tool, `${file}[0]`, '-background', 'white', '-flatten', '-resize', `${t.w}x${t.h}!`, '-quality', `${quality}`, `jpg:${out}`]
  }

  return null
}

/** The desktop's Svg takes 131072 characters: the JPEG's base64 must fit. */
export const JPEG_MAX_BYTES = 90_000

/**
 * Reads the clipboard's picture. A file copied in the Finder prints
 * `file:<path>` (its PNG flavor is only the file's icon); otherwise the picture
 * is written to `out` as PNG. Exits non-zero when the clipboard holds neither.
 */
export function clipboardArgv(os: Os, out: string): string[] | null {
  if (os === 'darwin') {
    return [
      'osascript',
      '-e', 'on run argv',
      '-e', 'try',
      '-e', 'return "file:" & (POSIX path of (the clipboard as «class furl»))',
      '-e', 'end try',
      '-e', 'set f to open for access (POSIX file (item 1 of argv)) with write permission',
      '-e', 'set eof f to 0',
      '-e', 'try',
      '-e', 'write (the clipboard as «class PNGf») to f',
      '-e', 'on error e',
      '-e', 'close access f',
      '-e', 'error e',
      '-e', 'end try',
      '-e', 'close access f',
      '-e', 'return "png"',
      '-e', 'end run',
      out,
    ]
  }
  if (os === 'linux') {
    return [
      'sh', '-c',
      '(wl-paste --no-newline --type image/png 2>/dev/null || xclip -selection clipboard -t image/png -o 2>/dev/null) > "$1" && [ -s "$1" ]',
      'sh', out,
    ]
  }

  return null
}

/** Decodes base64 from stdin into `out`. */
export function writeBase64Argv(out: string) {
  return ['sh', '-c', 'base64 -d > "$1"', 'sh', out]
}

/** Only ever this mod's own session folder under the temp dir. */
export function isOwnWork(work: string) {
  return /\/claude-image-preview\/[\w-]+$/.test(work)
}
