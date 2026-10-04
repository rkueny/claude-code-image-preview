// The commands the mod runs on the machine: how pictures are measured and
// converted (sips on macOS, ImageMagick on Linux, PowerShell's System.Drawing
// on Windows), read from the clipboard, written and cleaned up. Pure:
// register.tsx runs them, and scripts/check-host.ts runs them in CI.

export type Os = 'darwin' | 'linux' | 'windows' | 'other'
export type Tool = 'sips' | 'magick' | 'convert' | 'gdi' | null

export type Host = {
  os: Os
  /** The converter found on this machine, or null (then nothing is drawn). */
  tool: Tool
  /** Where this session's copies go. */
  work: string
  /** The folder Claude Code stores this session's pasted images in. */
  pasteDir: string | null
}

/** A command: its argument vector, and variables set for it (Windows passes its paths there). */
export type Cmd = { argv: string[]; env?: Record<string, string> }

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

/** A folder path without its trailing separators. */
export function trimDir(dir: string) {
  return dir.replace(/[\\/]+$/, '')
}

/**
 * Claude Code's temp root, where it stores pasted images under
 * `<root>/<project>/<session>/images/<n>.<ext>`: `$CLAUDE_CODE_TMPDIR` (or
 * `/tmp`) plus `claude-<uid>`.
 */
export function tempRoot(tmpdir: string | undefined, uid: string) {
  return `${trimDir(tmpdir || '/tmp')}/claude-${uid}`
}

/**
 * Where to look for that root on Windows, which has no uid: each temp folder
 * itself, then its `claude*` folders (`scan` lists one folder's subfolders).
 */
export async function windowsTempRoots(bases: readonly (string | undefined)[], scan: (dir: string) => Promise<string[]>) {
  const roots: string[] = []
  for (const base of new Set(bases.filter((b): b is string => !!b).map(trimDir))) {
    roots.push(base)
    for (const name of await scan(base)) if (/^claude/i.test(name)) roots.push(`${base}/${name}`)
  }

  return roots
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

// ---- Windows: PowerShell ---------------------------------------------------------

/** UTF-16LE base64, what `powershell -EncodedCommand` reads. */
function encodeCommand(script: string) {
  let bin = ''
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bin += String.fromCharCode(c & 255, c >> 8)
  }

  return btoa(bin)
}

/**
 * A PowerShell script run by Windows PowerShell, present on every Windows. Its
 * inputs travel as `IP_*` variables, so no path needs quoting.
 */
function powershell(script: string, env: Record<string, string>): Cmd {
  const prelude = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n"

  return {
    argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(prelude + script)],
    env,
  }
}

const PS_MEASURE = `Add-Type -AssemblyName System.Drawing
$i = [System.Drawing.Image]::FromFile($env:IP_IN)
"pixelWidth: $($i.Width)"
"pixelHeight: $($i.Height)"
$i.Dispose()`

/** Draws IP_IN at IP_W × IP_H into IP_OUT as IP_FMT (png keeps alpha; bmp and jpg flatten on IP_BG). */
const PS_RESIZE = `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:IP_IN)
$w = [int]$env:IP_W; $h = [int]$env:IP_H
$format = if ($env:IP_FMT -eq 'png') { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb } else { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb }
$bmp = New-Object System.Drawing.Bitmap($w, $h, $format)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::FromName($env:IP_BG))
$wrap = New-Object System.Drawing.Imaging.ImageAttributes
$wrap.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $wrap)
$g.Dispose(); $src.Dispose()
if ($env:IP_FMT -eq 'jpg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$env:IP_Q)
  $bmp.Save($env:IP_OUT, $codec, $params)
} elseif ($env:IP_FMT -eq 'bmp') {
  $bmp.Save($env:IP_OUT, [System.Drawing.Imaging.ImageFormat]::Bmp)
} else {
  $bmp.Save($env:IP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
}
$bmp.Dispose()`

/** A file copied in the Explorer prints `file:<path>`; a picture is saved to IP_OUT as PNG; else exit 1. */
const PS_CLIPBOARD = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -gt 0) { "file:$($files[0])"; exit 0 }
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$img.Save($env:IP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
'png'`

const PS_DECODE = `$text = [System.IO.File]::ReadAllText($env:IP_B64)
[System.IO.File]::WriteAllBytes($env:IP_OUT, [System.Convert]::FromBase64String($text.Trim()))
Remove-Item -LiteralPath $env:IP_B64 -Force`

const PS_REMOVE = `if (Test-Path -LiteralPath $env:IP_OUT) { Remove-Item -LiteralPath $env:IP_OUT -Recurse -Force }`

function gdiResize(file: string, out: string, w: number, h: number, format: 'png' | 'bmp' | 'jpg', background: string, quality = 90): Cmd {
  return powershell(PS_RESIZE, {
    IP_IN: file,
    IP_OUT: out,
    IP_W: `${w}`,
    IP_H: `${h}`,
    IP_FMT: format,
    IP_BG: background,
    IP_Q: `${quality}`,
  })
}

// ---- every system ---------------------------------------------------------------

export function measureCmd(tool: Tool, file: string): Cmd | null {
  if (tool === 'sips') return { argv: ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file] }
  if (tool === 'magick') return { argv: ['magick', 'identify', '-format', '%w %h', `${file}[0]`] }
  if (tool === 'convert') return { argv: ['identify', '-format', '%w %h', `${file}[0]`] }
  if (tool === 'gdi') return powershell(PS_MEASURE, { IP_IN: file })

  return null
}

export function parseMeasure(tool: Tool, stdout: string) {
  let width = 0
  let height = 0
  if (tool === 'sips' || tool === 'gdi') {
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
export function pngCmd(tool: Tool, file: string, out: string, width: number, height: number): Cmd | null {
  const t = fit(width, height, 1024)
  if (tool === 'sips') return { argv: ['sips', '-s', 'format', 'png', '-z', `${t.h}`, `${t.w}`, file, '--out', out] }
  if (tool === 'gdi') return gdiResize(file, out, t.w, t.h, 'png', 'Transparent')
  if (tool) return { argv: [tool, `${file}[0]`, '-resize', `${t.w}x${t.h}!`, `png:${out}`] }

  return null
}

/** 24-bit BMP at most 800×800: what the block renderer samples. */
export function bmpCmd(tool: Tool, file: string, out: string, width: number, height: number): Cmd | null {
  const t = fit(width, height, 800, 800)
  if (tool === 'sips') return { argv: ['sips', '-s', 'format', 'bmp', '-z', `${t.h}`, `${t.w}`, file, '--out', out] }
  if (tool === 'gdi') return gdiResize(file, out, t.w, t.h, 'bmp', 'Black')
  if (tool) {
    return {
      argv: [tool, `${file}[0]`, '-background', 'black', '-flatten', '-resize', `${t.w}x${t.h}!`, '-type', 'TrueColor', `BMP3:${out}`],
    }
  }

  return null
}

/** The JPEG sizes tried, largest first, until one fits the desktop's Svg. */
export const JPEG_STEPS = [
  [480, 60],
  [320, 50],
  [200, 40],
] as const

export function jpgCmd(tool: Tool, file: string, out: string, width: number, height: number, side: number, quality: number): Cmd | null {
  const t = fit(width, height, side)
  if (tool === 'sips') {
    return { argv: ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', `${quality}`, '-z', `${t.h}`, `${t.w}`, file, '--out', out] }
  }
  if (tool === 'gdi') return gdiResize(file, out, t.w, t.h, 'jpg', 'White', quality)
  if (tool) {
    return { argv: [tool, `${file}[0]`, '-background', 'white', '-flatten', '-resize', `${t.w}x${t.h}!`, '-quality', `${quality}`, `jpg:${out}`] }
  }

  return null
}

/** The desktop's Svg takes 131072 characters: the JPEG's base64 must fit. */
export const JPEG_MAX_BYTES = 90_000

/**
 * Reads the clipboard's picture. A file copied in the Finder or the Explorer
 * prints `file:<path>` (the Finder's PNG flavor is only the file's icon);
 * otherwise the picture is written to `out` as PNG. Exits non-zero when the
 * clipboard holds neither.
 */
export function clipboardCmd(os: Os, out: string): Cmd | null {
  if (os === 'darwin') {
    return {
      argv: [
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
      ],
    }
  }
  if (os === 'linux') {
    return {
      argv: [
        'sh', '-c',
        '(wl-paste --no-newline --type image/png 2>/dev/null || xclip -selection clipboard -t image/png -o 2>/dev/null) > "$1" && [ -s "$1" ]',
        'sh', out,
      ],
    }
  }
  if (os === 'windows') return powershell(PS_CLIPBOARD, { IP_OUT: out })

  return null
}

/** Decodes the base64 text file `b64` into `out`, then deletes `b64`. */
export function decodeBase64Cmd(os: Os, b64: string, out: string): Cmd | null {
  if (os === 'windows') return powershell(PS_DECODE, { IP_B64: b64, IP_OUT: out })
  if (os === 'other') return null

  return { argv: ['sh', '-c', 'base64 -d < "$1" > "$2" && rm -f "$1"', 'sh', b64, out] }
}

/** Deletes a folder and everything in it. */
export function removeCmd(os: Os, dir: string): Cmd | null {
  if (os === 'windows') return powershell(PS_REMOVE, { IP_OUT: dir })
  if (os === 'other') return null

  return { argv: ['rm', '-rf', dir] }
}

/** Only ever this mod's own session folder under the temp dir. */
export function isOwnWork(work: string) {
  return /[\\/]claude-image-preview[\\/][\w-]+$/.test(work)
}
