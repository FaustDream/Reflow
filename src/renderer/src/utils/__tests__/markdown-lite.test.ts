/**
 * 轻量 markdown 渲染（2026-11-12）。
 *
 * 重点在两个方向：CHANGELOG 里真实出现的写法要渲染对；
 * 远端 Release 正文里的 HTML / 非 http 链接不能被当成活的标记执行。
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdownLite } from '../markdown-lite'

describe('行内标记', () => {
  it('粗体与代码', () => {
    const html = renderMarkdownLite('- **分页**：每页可选 `50` 条')
    expect(html).toContain('<strong>分页</strong>')
    expect(html).toContain('<code>50</code>')
  })

  it('代码片段里的星号不被当成粗体', () => {
    const html = renderMarkdownLite('- 写法是 `**x**`')
    expect(html).toContain('<code>**x**</code>')
    expect(html).not.toContain('<strong>')
  })

  it('http(s) 链接转成 a 标签', () => {
    const html = renderMarkdownLite('见 [项目主页](https://github.com/FaustDream/Reflow)')
    expect(html).toContain('href="https://github.com/FaustDream/Reflow"')
    expect(html).toContain('>项目主页</a>')
  })
})

describe('安全：先转义再拼标签', () => {
  it('HTML 标签只以文字出现', () => {
    const html = renderMarkdownLite('<img src=x onerror="alert(1)"> 与 <b>粗体</b>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;img')
  })

  it('脚本里带 markdown 语法也不会被解析成活标签', () => {
    const html = renderMarkdownLite('<script>**x**</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('非 http 协议不当链接（javascript: / file:）', () => {
    const html = renderMarkdownLite('[点我](javascript:alert(1)) [文件](file:///C:/x)')
    expect(html).not.toContain('href=')
  })
})

describe('块级结构', () => {
  it('列表与缩进子项', () => {
    const html = renderMarkdownLite(`- 第一项
  1. 子项 A
  2. 子项 B
- 第二项`)
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html.match(/<li>/g)?.length).toBe(4)
  })

  it('缩进但没有列表标记的行并入上一项', () => {
    const html = renderMarkdownLite('- 主条目\n  补充说明')
    expect(html).toContain('主条目 补充说明')
    expect(html.match(/<li>/g)?.length).toBe(1)
  })

  it('表格', () => {
    const html = renderMarkdownLite('| 平台 | 之前 |\n|---|---|\n| 京东 | 翻页 |')
    expect(html).toContain('<th>平台</th>')
    expect(html).toContain('<td>京东</td>')
  })

  it('标题层级整体下沉一级（弹窗里已有 h3 位置）', () => {
    expect(renderMarkdownLite('### 变更')).toContain('<h4>变更</h4>')
    expect(renderMarkdownLite('## 1.1.0')).toContain('<h3>1.1.0</h3>')
  })

  it('引用', () => {
    expect(renderMarkdownLite('> 提示')).toContain('<blockquote>提示</blockquote>')
  })

  it('空输入返回空串', () => {
    expect(renderMarkdownLite('')).toBe('')
    expect(renderMarkdownLite(undefined as unknown as string)).toBe('')
  })
})
