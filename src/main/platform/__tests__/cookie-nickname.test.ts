import { describe, expect, it } from 'vitest'
import { decodeNickname } from '../cookie-login'

/**
 * 昵称 Cookie 的解码（2026-10-29）。
 *
 * 淘宝把昵称写成 `%5Cu58A8%5Cu8FF9` —— URL 解码后是 `\u58A8\u8FF9` **字面量**，
 * 不做 Unicode 转义还原的话，界面会显示成一串 `\u58A8…`，看起来就像「没有昵称」。
 */
describe('decodeNickname（昵称 Cookie 解码）', () => {
  it('淘宝的 %5CuXXXX 转义形态还原成中文', () => {
    // 0x58A8 = 墨, 0x8FF9 = 迹
    expect(decodeNickname('%5Cu58A8%5Cu8FF9')).toBe('墨迹')
  })

  it('已经解码一半的 \\uXXXX 字面量也能还原', () => {
    expect(decodeNickname('\\u58A8\\u8FF9')).toBe('墨迹')
  })

  it('普通百分号编码的 UTF-8 昵称', () => {
    expect(decodeNickname('%E5%BC%A0%E4%B8%89')).toBe('张三')
  })

  it('原样昵称与空值', () => {
    expect(decodeNickname('逆向人珲')).toBe('逆向人珲')
    expect(decodeNickname('')).toBe('')
  })

  it('非法百分号编码不抛错，原样返回', () => {
    expect(decodeNickname('%E5%BC')).toBe('%E5%BC')
  })
})
