/** One picture the person pasted, kept with the copies the mod draws from. */
export type PastedImage = {
  /** `draft-<n>` while it sits in the prompt, `sent-<row>-<i>` once sent. */
  id: string
  /** The `[Image #n]` placeholder it stands for in the prompt, when known. */
  n?: number
  status: 'draft' | 'sent'
  mediaType: string
  width: number
  height: number
  /** Size of the original, in bytes. */
  size: number
  /** The original picture on disk. */
  file: string
  /** PNG copy, at most 1024 px a side: what the kitty protocol draws. */
  png: string
  /** Small 24-bit BMP: what the half-block renderer samples. */
  bmp: string
  /** Small JPEG: what the desktop draws. */
  jpg: string
  /** Epoch ms when it was captured. */
  at: number
  /** The transcript row it was sent in. */
  rowId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { images: PastedImage[] }
  }
}
