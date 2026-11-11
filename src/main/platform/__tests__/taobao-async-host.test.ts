import { describe, expect, it } from 'vitest'
import {
  decodeResponseText,
  parseTaobaoAsyncResponse,
  taobaoAsyncPageScript
} from '../taobao-async-host'

describe('淘宝网页版订单响应解析', () => {
  it('正常响应取 mainOrders', () => {
    const body = JSON.stringify({ mainOrders: [{ id: '1' }], extra: {} })
    expect(parseTaobaoAsyncResponse(body).mainOrders).toHaveLength(1)
  })

  it('空页（mainOrders: []）也算正常，调用方据此收尾', () => {
    const body = JSON.stringify({ mainOrders: [] })
    expect(parseTaobaoAsyncResponse(body).mainOrders).toEqual([])
  })

  it('rgv587 = 滑块风控，提示去过验证而不是重新登录', () => {
    const body = JSON.stringify({ rgv587_flag: 'sm', url: 'https://login.taobao.com/x' })
    // 同时含 login.taobao.com，但风控优先
    expect(() => parseTaobaoAsyncResponse(body)).toThrow(/滑块验证/)
  })

  it('被踢回登录页时提示重新扫码', () => {
    const body = JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED'], url: 'https://login.taobao.com/a' })
    expect(() => parseTaobaoAsyncResponse(body)).toThrow(/重新登录/)
  })

  it('返回 HTML（登录页）时给出可读原因', () => {
    expect(() => parseTaobaoAsyncResponse('<html><body>登录</body></html>')).toThrow(/不是 JSON/)
  })

  it('结构不对但有 ret 时把 ret 带出来', () => {
    const body = JSON.stringify({ ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法请求'] })
    expect(() => parseTaobaoAsyncResponse(body)).toThrow(/FAIL_SYS_ILLEGAL_ACCESS/)
  })
})

describe('页面脚本生成', () => {
  it('分页参数与 token 都注入到脚本里', () => {
    const script = taobaoAsyncPageScript(3, 'tok123')
    expect(script).toContain('pageNum=3')
    expect(script).toContain("pageNum: '3'")
    expect(script).toContain("prePageNo: '2'")
    expect(script).toContain('tok123')
  })

  it('token 做 JSON 转义，不会破坏脚本（引号注入）', () => {
    const script = taobaoAsyncPageScript(1, `a'b"c\\d`)
    // 能被 JS 引擎解析即可（不执行）
    expect(() => new Function(script)).not.toThrow()
  })

  it('没有 token 时也不生成非法脚本', () => {
    const script = taobaoAsyncPageScript(1)
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('pageNum=1')
  })
})

describe('网页版响应解码（GBK 分片）', () => {
  it('GBK 字节按 GBK 解，中文正常', () => {
    // 「中文」的 GBK 编码，按 UTF-8 解会变成两个替换字符
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeResponseText(gbk.buffer)).toEqual({ text: '中文', encoding: 'gbk' })
  })

  it('本来就是 UTF-8 的不动它', () => {
    const utf8 = new Uint8Array(Buffer.from('商品名称 ¥99', 'utf8'))
    expect(decodeResponseText(utf8.buffer)).toEqual({ text: '商品名称 ¥99', encoding: 'utf-8' })
  })

  it('纯 ASCII 走 UTF-8，不误判成 GBK', () => {
    const ascii = new Uint8Array(Buffer.from('{"mainOrders":[]}', 'utf8'))
    expect(decodeResponseText(ascii.buffer).encoding).toBe('utf-8')
  })

  it('GBK 解出来乱码更多时仍保留 UTF-8 结果', () => {
    // 合法 UTF-8 的 emoji：UTF-8 解得开，GBK 会解成乱码
    const bytes = new Uint8Array(Buffer.from('🎉 好物', 'utf8'))
    expect(decodeResponseText(bytes.buffer)).toEqual({ text: '🎉 好物', encoding: 'utf-8' })
  })
})
