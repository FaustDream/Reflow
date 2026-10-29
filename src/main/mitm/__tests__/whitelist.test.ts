/**
 * 工单 034：MITM 白名单与响应判定的回归测试。
 *
 * 这几条是安全边界的一部分：
 * - 白名单只放行订单域名，别的域名**绝不能**被解密
 * - 静态资源不进内存
 * - JSONP 要能剥壳，否则淘宝系接口解析不了
 */
import { describe, expect, it } from 'vitest'
import { MAX_CAPTURE_BYTES, isMitmHost, parseBody, shouldCapture } from '../whitelist'

describe('isMitmHost：白名单', () => {
  it('白名单域名命中（含子域名）', () => {
    expect(isMitmHost('order.jd.com')).toBe(true)
    expect(isMitmHost('h5api.m.goofish.com')).toBe(true)
    expect(isMitmHost('cdn.order.jd.com')).toBe(true)
    expect(isMitmHost('ORDER.JD.COM')).toBe(true)
  })

  it('非白名单一律不解密', () => {
    expect(isMitmHost('www.jd.com')).toBe(false)
    expect(isMitmHost('mail.google.com')).toBe(false)
    expect(isMitmHost('order.jd.com.evil.test')).toBe(false)
    expect(isMitmHost('notorder.jd.com')).toBe(false)
  })
})

describe('shouldCapture：只抓值得抓的响应', () => {
  it('JSON 响应抓', () => {
    expect(shouldCapture('https://order.jd.com/x', 'application/json; charset=utf-8')).toBe(true)
  })

  it('静态资源不抓（避免缓冲几 MB 的 js/css/图片）', () => {
    expect(shouldCapture('https://h5api.m.goofish.com/app.js', 'application/javascript')).toBe(false)
    expect(shouldCapture('https://order.jd.com/a.css', 'text/css')).toBe(false)
    expect(shouldCapture('https://order.jd.com/a.png', 'image/png')).toBe(false)
    expect(shouldCapture('https://order.jd.com/f.woff2', 'font/woff2')).toBe(false)
  })

  it('非 JSON 但 URL 像订单接口的也抓', () => {
    expect(shouldCapture('https://order.jd.com/center/list.action?page=1', 'text/html')).toBe(true)
    expect(shouldCapture('https://mobile.yangkeduo.com/order.html', undefined)).toBe(true)
  })

  it('既不是 JSON、URL 也没有订单特征的跳过', () => {
    expect(shouldCapture('https://app.dewu.com/about', 'text/html')).toBe(false)
  })

  it('单次抓取上限是 8MB（防止大文件撑爆内存）', () => {
    expect(MAX_CAPTURE_BYTES).toBe(8 * 1024 * 1024)
  })
})

describe('parseBody：JSON / JSONP / 原文', () => {
  it('标准 JSON 解析成对象', () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 })
  })

  it('JSONP 剥壳后解析（淘宝/1688 常见）', () => {
    expect(parseBody('mtopjsonp3({"ret":["SUCCESS"]})')).toEqual({ ret: ['SUCCESS'] })
    expect(parseBody('cb({ "x": 2 });')).toEqual({ x: 2 })
  })

  it('空响应返回空串', () => {
    expect(parseBody('   ')).toBe('')
  })

  it('非 JSON 原样返回，不抛错', () => {
    expect(parseBody('<html>login</html>')).toBe('<html>login</html>')
    expect(parseBody('{坏掉的 json')).toBe('{坏掉的 json')
  })
})
