/**
 * 工单 009：商品图片下载与 webp→jpeg 转码。
 *
 * - 魔数判定真实格式（不信任 URL 后缀；阿里 CDN 的 _220x10000Q90.jpg 实际可能返回 webp）
 * - jpeg/png/gif 直接内嵌（Excel/ExcelJS 支持）；webp 经 @jsquash wasm 转 JPEG quality=90
 * - 并发 8、同 URL 去重、单张失败不阻断（原版行为一致）
 * - wasm 为纯 ESM 包，主进程为 CJS，用动态 import() 加载；wasm 二进制经 require.resolve 定位
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export type ImageExtension = 'jpeg' | 'png' | 'gif'

export interface PreparedImage {
  buffer: Buffer
  extension: ImageExtension
}

/** 按魔数判定图片类型；webp 单独返回（需转码），不支持返回 null */
export function detectImageType(buffer: Buffer): ImageExtension | 'webp' | null {
  if (buffer.length < 3) return null
  // JPEG：FF D8 FF（3 字节即可判定）
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length < 12) return null
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png'
  }
  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') {
    return 'gif'
  }
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

let webpInitialized: Promise<unknown> | null = null
let jpegInitialized: Promise<unknown> | null = null

/** 编解码器的最小结构化类型（规避 @jsquash 声明与 DOM lib 的 ImageData 泛型差异） */
interface CodecImage {
  data: Uint8ClampedArray
  width: number
  height: number
}
interface WebpDecoderModule {
  init: (config: { wasmBinary: Buffer }) => Promise<unknown>
  default: (buffer: Uint8Array) => Promise<CodecImage>
}
interface JpegEncoderModule {
  init: (config: { wasmBinary: Buffer }) => Promise<unknown>
  default: (img: CodecImage, quality: number) => Promise<ArrayBuffer>
}

/** 惰性初始化 wasm 编解码器（仅在首次遇到 webp 时付出加载成本） */
async function ensureCodecs(): Promise<{
  decodeWebp: (buffer: Uint8Array) => Promise<CodecImage>
  encodeJpeg: (img: CodecImage, quality: number) => Promise<ArrayBuffer>
}> {
  // @ts-expect-error 包为 ESM，无 CJS 类型出口，动态 import 运行时可用
  const webpModule = (await import('@jsquash/webp/decode.js')) as WebpDecoderModule
  // @ts-expect-error 同上
  const jpegModule = (await import('@jsquash/jpeg/encode.js')) as JpegEncoderModule

  if (!webpInitialized) {
    const wasmBinary = await readFile(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'))
    webpInitialized = webpModule.init({ wasmBinary })
  }
  if (!jpegInitialized) {
    const wasmBinary = await readFile(require.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'))
    jpegInitialized = jpegModule.init({ wasmBinary })
  }
  await Promise.all([webpInitialized, jpegInitialized])
  return { decodeWebp: webpModule.default, encodeJpeg: jpegModule.default }
}

/** webp buffer → jpeg buffer（quality=90，与原版 toJpegBuffer 一致） */
export async function transcodeWebpToJpeg(buffer: Buffer): Promise<Buffer> {
  const { decodeWebp, encodeJpeg } = await ensureCodecs()
  const image = await decodeWebp(new Uint8Array(buffer))
  const out = await encodeJpeg(image, 90)
  return Buffer.from(out)
}

/** 下载单张图片并整理为可内嵌格式；任何失败抛错（由调用方计入失败列表） */
export async function downloadAndPrepareImage(url: string, referer?: string): Promise<PreparedImage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {})
      }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const type = detectImageType(buffer)
    if (type === 'webp') {
      return { buffer: await transcodeWebpToJpeg(buffer), extension: 'jpeg' }
    }
    if (type === 'jpeg' || type === 'png' || type === 'gif') {
      return { buffer, extension: type }
    }
    throw new Error('不支持的图片格式或非图片响应')
  } finally {
    clearTimeout(timer)
  }
}

export interface ImageDownloadProgress {
  done: number
  total: number
  failed: number
}

/**
 * 批量下载订单图片（并发 8、URL 去重）。
 * @returns Map<imageUrl, PreparedImage>（失败的 URL 不在 Map 中）
 */
export async function downloadOrderImages(
  urls: string[],
  options: {
    concurrency?: number
    refererFor?: (url: string) => string | undefined
    onProgress?: (p: ImageDownloadProgress) => void
  } = {}
): Promise<{ images: Map<string, PreparedImage>; failed: string[] }> {
  const concurrency = options.concurrency ?? 8
  const unique = [...new Set(urls.filter(Boolean))]
  const images = new Map<string, PreparedImage>()
  const failed: string[] = []
  let done = 0

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const url = unique[cursor++]
      try {
        images.set(url, await downloadAndPrepareImage(url, options.refererFor?.(url)))
      } catch {
        failed.push(url)
      } finally {
        done += 1
        options.onProgress?.({ done, total: unique.length, failed: failed.length })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker))
  return { images, failed }
}
