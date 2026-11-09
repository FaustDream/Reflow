import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { detectImageType, transcodeWebpToJpeg, downloadOrderImages } from '../images'

const require = createRequire(import.meta.url)

// 最小 1x1 像素 PNG（8 字节签名 + IHDR/IDAT/IEND）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
// JPEG SOI 最小头
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

describe('工单 009：detectImageType（魔数判定，不信任后缀）', () => {
  it('jpeg/png/webp/gif 魔数', () => {
    expect(detectImageType(JPEG_HEAD)).toBe('jpeg')
    expect(detectImageType(PNG_1X1)).toBe('png')
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
      Buffer.from('VP8 ')
    ])
    expect(detectImageType(webp)).toBe('webp')
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])
    expect(detectImageType(gif)).toBe('gif')
  })

  it('非图片/过短返回 null', () => {
    expect(detectImageType(Buffer.from('<!doctype html>'))).toBeNull()
    expect(detectImageType(Buffer.from([0xff]))).toBeNull()
  })
})

describe('工单 009：webp → jpeg wasm 转码（真实编解码往返）', () => {
  it('用 webp 编码器生成真实 webp，再转 jpeg（RIFF/WEBP → FFD8）', async () => {
    // 生成 2x2 红色 ImageData → webp
    const width = 2
    const height = 2
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 200
      data[i * 4 + 1] = 30
      data[i * 4 + 2] = 30
      data[i * 4 + 3] = 255
    }
    const enc = await import('@jsquash/webp/encode.js')
    const wasmBinary = await readFile(require.resolve('@jsquash/webp/codec/enc/webp_enc.wasm'))
    await enc.init({ wasmBinary })
    const webpBuffer = Buffer.from(
      await enc.default({ data, width, height } as unknown as ImageData, { quality: 90 })
    )
    expect(detectImageType(webpBuffer)).toBe('webp')

    const jpeg = await transcodeWebpToJpeg(webpBuffer)
    expect(detectImageType(jpeg)).toBe('jpeg')
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
  }, 30000)
})

describe('工单 009：downloadOrderImages 并发/去重/失败隔离', () => {
  it('URL 去重、按返回格式整理、失败 URL 计入 failed 不抛错', async () => {
    const urls = ['https://example.com/a.png', 'https://example.com/a.png', 'https://example.com/bad']
    const fetchMock = (async (url: string) =>
      url.includes('bad')
        ? ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(4), redirect: 'follow' })
        : ({
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              PNG_1X1.buffer.slice(PNG_1X1.byteOffset, PNG_1X1.byteOffset + PNG_1X1.byteLength),
            redirect: 'follow'
          })) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock
    try {
      const { images, failed } = await downloadOrderImages(urls, { concurrency: 4 })
      expect(images.size).toBe(1)
      expect(failed).toEqual(['https://example.com/bad'])
      expect(images.get('https://example.com/a.png')?.extension).toBe('png')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
