/**
 * 轻量 markdown → HTML（2026-11-12）。
 *
 * 只为「更新记录 / 版本说明」服务，覆盖 CHANGELOG 与 Release 正文实际用到的几种写法：
 * 标题、列表（含一层缩进子项）、表格、引用、段落，行内支持 **粗体**、`代码`、[链接](url)。
 *
 * 为什么不用现成库：这里只需要 5% 的 markdown 能力，引一个解析器（还要处理 sanitize）
 * 不划算 —— 项目到目前连图表库都是手写的。
 *
 * 安全前提：**先整体转义，再拼自己生成的标签**。所以远端 Release 正文也能直接渲染，
 * 其中出现的任何 HTML 都只会以文字形式出现；链接限定 http(s)，其它协议一律按纯文本处理。
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch])
}

/** 行内标记。入参必须已经过 escapeHtml */
function renderInline(escaped: string): string {
  // 代码片段先摘出来：里面的 ** 和 [] 不该被后面的规则改写
  const codes: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`)
  return out
}

interface ListLine {
  /** 缩进空格数：0/1 视为主项，≥2 视为上一项的子项 */
  indent: number
  ordered: boolean
  text: string
}

function renderList(lines: ListLine[]): string {
  const tops = lines.filter((l) => l.indent < 2)
  if (!tops.length) return ''
  const tag = tops[0].ordered ? 'ol' : 'ul'
  let html = `<${tag}>`
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i]
    if (item.indent >= 2) continue // 子项跟随所属主项一起输出
    html += `<li>${renderInline(escapeHtml(item.text))}`
    // 紧随其后的缩进行属于当前项
    const children: ListLine[] = []
    let next = i + 1
    while (next < lines.length && lines[next].indent >= 2) {
      children.push(lines[next])
      next += 1
    }
    if (children.length) {
      const childTag = children[0].ordered ? 'ol' : 'ul'
      html += `<${childTag}>${children.map((c) => `<li>${renderInline(escapeHtml(c.text))}</li>`).join('')}</${childTag}>`
    }
    html += '</li>'
    i = next - 1
  }
  return `${html}</${tag}>`
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 渲染一段 markdown。返回可直接 v-html 的字符串（内容已转义） */
export function renderMarkdownLite(source: string): string {
  const lines = String(source ?? '').split(/\r?\n/)
  const blocks: string[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    blocks.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`)
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    if (!line.trim()) {
      flushParagraph()
      continue
    }

    // 标题：### 是分组标题（CHANGELOG 里最外层），再多给一级更深的
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = Math.min(6, heading[1].length + 1)
      blocks.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`)
      continue
    }

    // 表格：本行与下一行都得是 | 行，且下一行是 |---|---| 分隔行
    if (/^\s*\|/.test(line) && /^\s*\|/.test(lines[i + 1] ?? '') && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      flushParagraph()
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      i -= 1
      const head = header.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join('')
      const body = rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`
        )
        .join('')
      blocks.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }

    // 列表（无序 / 有序，允许缩进）
    const listMatch = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (listMatch) {
      flushParagraph()
      const items: ListLine[] = []
      let cursor = i
      while (cursor < lines.length) {
        const current = lines[cursor]
        const matched = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(current)
        if (matched) {
          items.push({
            indent: matched[1].length,
            ordered: /\d+\./.test(matched[2]),
            text: matched[3]
          })
          cursor += 1
          continue
        }
        // 缩进但没有列表标记 = 上一项的续行（CHANGELOG 里常见）
        if (/^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1].text += ` ${current.trim()}`
          cursor += 1
          continue
        }
        break
      }
      i = cursor - 1
      blocks.push(renderList(items))
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushParagraph()
      const quoted: string[] = []
      let cursor = i
      while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
        quoted.push(lines[cursor].replace(/^>\s?/, ''))
        cursor += 1
      }
      i = cursor - 1
      blocks.push(`<blockquote>${renderInline(escapeHtml(quoted.join(' ')))}</blockquote>`)
      continue
    }

    paragraph.push(line.trim())
  }

  flushParagraph()
  return blocks.join('')
}
