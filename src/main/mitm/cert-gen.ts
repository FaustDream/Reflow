/**
 * MITM 证书的**运行时按机器随机生成**（PowerShell，零第三方依赖）。
 *
 * 为什么要换掉构建期预生成（docs/033 §4 的历史方案）：
 *   旧方案把 `leaf.key` 打进安装包 → 世界上所有用户共享同一把叶子私钥，
 *   任何拿到安装包的人都能对已信任 CA 的用户冒充白名单域窃取登录 Cookie。
 *   且构建期 SAN 是运行时白名单的超集（含已下架平台域名），无谓扩大爆炸半径。
 *
 * 新方案：
 *   - CA 首次生成后**常驻当前用户证书库**（私钥不落盘），10 年有效期；
 *     叶子证书按机器随机签发（365 天 —— Chromium 拒绝 >398 天的证书）。
 *   - 叶子证书的 SAN **精确等于** `whitelist.ts` 的 MITM_HOSTS：白名单变化后
 *     下次启用时自动重签叶子（CA 已被信任，无需用户重装）。
 *   - 产物（leaf.crt/leaf.key/ca.crt）落在 userData/mitm/，不出现在安装包里。
 *
 * 为什么是 PowerShell 而不是 node-forge：PS 的 New-SelfSignedCertificate +
 * certutil 是 Windows 自带能力（本项目 MITM 本就 Windows-only），不引入依赖；
 * 私钥导出用 .NET 的 RSAParameters 手工组 PKCS#1 DER（已在 Win10/11 PowerShell 5.1 实测）。
 * 通过 -EncodedCommand（UTF-16LE base64）传递，免疫引号与代码页问题。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { MITM_HOSTS } from './whitelist'
import { loadState, saveState } from './system'

/** 叶子证书剩余有效期低于该值时重签 */
const MIN_VALIDITY_MS = 30 * 24 * 3600_000
const PS_TIMEOUT_MS = 90_000

export function certDir(): string {
  return join(app.getPath('userData'), 'mitm')
}

export function caCertPath(): string {
  return join(certDir(), 'ca.crt')
}

export function leafCertPath(): string {
  return join(certDir(), 'leaf.crt')
}

export function leafKeyPath(): string {
  return join(certDir(), 'leaf.key')
}

/** 叶子文件齐、SAN 与当前白名单一致、且剩余有效期充足时无需重签 */
function leafStillValid(): boolean {
  const { sanHosts, leafFingerprint } = loadState()
  if (!existsSync(leafCertPath()) || !existsSync(leafKeyPath())) return false
  if (JSON.stringify(sanHosts ?? []) !== JSON.stringify([...MITM_HOSTS])) return false
  if (!leafFingerprint) return false
  const current = createHash('sha256').update(readFileSync(leafCertPath())).digest('hex')
  if (current !== leafFingerprint) return false
  try {
    const cert = new X509Certificate(readFileSync(leafCertPath()))
    return Date.parse(cert.validTo) - Date.now() > MIN_VALIDITY_MS
  } catch {
    return false
  }
}

interface PsGenResult {
  caThumbprint: string
  leafThumbprint: string
  notAfter: string
}

/** PS 脚本用 @('a','b') 数组字面量；域名是代码内常量，只需防单引号 */
function psArrayLiteral(hosts: readonly string[]): string {
  return `@(${hosts.map((h) => `'${h.replace(/'/g, "''")}'`).join(',')})`
}

function buildScript(caThumbprint: string): string {
  return `
$ErrorActionPreference = 'Stop'
$targets = ${psArrayLiteral(MITM_HOSTS)}
$outDir = '${certDir().replaceAll('\\', '/')}'
$cn = 'Reflow Local MITM CA'
$caThumb = '${caThumbprint}'

$ca = $null
if ($caThumb) {
  $ca = Get-ChildItem Cert:/CurrentUser/My | Where-Object { $_.Thumbprint -eq $caThumb -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Select-Object -First 1
}
if (-not $ca) {
  $ca = Get-ChildItem Cert:/CurrentUser/My | Where-Object { $_.Subject -like ("CN=$cn*") -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1
}
if (-not $ca) {
  $ca = New-SelfSignedCertificate -Subject "CN=$cn" -FriendlyName $cn -CertStoreLocation Cert:/CurrentUser/My -HashAlgorithm SHA256 -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage CertSign, DigitalSignature -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=TRUE') -Provider 'Microsoft Software Key Storage Provider'
}
# 叶子 365 天：Chromium 对 >398 天的证书直接拒绝
$leaf = New-SelfSignedCertificate -Subject 'CN=Reflow MITM Leaf' -DnsName $targets -Signer $ca -CertStoreLocation Cert:/CurrentUser/My -HashAlgorithm SHA256 -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment -NotAfter (Get-Date).AddDays(365) -TextExtension @('2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.1') -Provider 'Microsoft Software Key Storage Provider'

function ExportCertPem($cert, $path) {
  $b64 = [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
  [void]$sb.AppendLine($b64)
  [void]$sb.AppendLine('-----END CERTIFICATE-----')
  [IO.File]::WriteAllText($path, $sb.ToString())
}
ExportCertPem $leaf (Join-Path $outDir 'leaf.crt')
ExportCertPem $ca (Join-Path $outDir 'ca.crt')

# 叶子私钥 → PKCS#1 PEM：PS 5.1（.NET Framework 4.8）没有 ExportPkcs8PrivateKey，
# 用 RSAParameters 手工组 DER（整数走 DER 定长/长形式编码，负数前补 0x00）
function ToDerInteger([byte[]]$b) {
  $i = 0
  while ($i -lt $b.Length -and $b[$i] -eq 0) { $i++ }
  $v = New-Object System.Collections.Generic.List[byte]
  if ($i -ge $b.Length) { $v.Add(0) } else {
    if ($b[$i] -band 0x80) { $v.Add(0) }
    for ($j = $i; $j -lt $b.Length; $j++) { $v.Add($b[$j]) }
  }
  $len = $v.Count
  $head = New-Object System.Collections.Generic.List[byte]
  $head.Add(0x02)
  if ($len -lt 0x80) { $head.Add([byte]$len) }
  elseif ($len -lt 0x100) { $head.Add(0x81); $head.Add([byte]$len) }
  else { $head.Add(0x82); $head.Add([byte](($len -shr 8) -band 0xff)); $head.Add([byte]($len -band 0xff)) }
  $head.AddRange($v)
  return $head.ToArray()
}
function ToDerSequence([byte[][]]$parts) {
  $body = New-Object System.Collections.Generic.List[byte]
  foreach ($p in $parts) { $body.AddRange($p) }
  $len = $body.Count
  $head = New-Object System.Collections.Generic.List[byte]
  $head.Add(0x30)
  if ($len -lt 0x80) { $head.Add([byte]$len) }
  elseif ($len -lt 0x100) { $head.Add(0x81); $head.Add([byte]$len) }
  else { $head.Add(0x82); $head.Add([byte](($len -shr 8) -band 0xff)); $head.Add([byte]($len -band 0xff)) }
  $head.AddRange($body)
  return $head.ToArray()
}
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($leaf)
$p = $rsa.ExportParameters($true)
$keyDer = ToDerSequence @(
  (ToDerInteger ([byte[]]@(0))),
  (ToDerInteger $p.Modulus),
  (ToDerInteger $p.Exponent),
  (ToDerInteger $p.D),
  (ToDerInteger $p.P),
  (ToDerInteger $p.Q),
  (ToDerInteger $p.DP),
  (ToDerInteger $p.DQ),
  (ToDerInteger $p.InverseQ)
)
$kb64 = [Convert]::ToBase64String($keyDer, 'InsertLineBreaks')
$ksb = New-Object System.Text.StringBuilder
[void]$ksb.AppendLine('-----BEGIN RSA PRIVATE KEY-----')
[void]$ksb.AppendLine($kb64)
[void]$ksb.AppendLine('-----END RSA PRIVATE KEY-----')
[IO.File]::WriteAllText((Join-Path $outDir 'leaf.key'), $ksb.ToString())

# 叶子键对用完即删（文件即全部）；CA 保留在库里供来年重签叶子
$leaf | Remove-Item
@{ caThumbprint = $ca.Thumbprint; leafThumbprint = $leaf.Thumbprint; notAfter = $leaf.NotAfter.ToString('o') } | ConvertTo-Json -Compress
`
}

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`证书生成失败（PowerShell）：${err.message}`))
          return
        }
        resolve(String(stdout ?? ''))
      }
    )
  })
}

/** 从 PS 输出里取最后一行 JSON（前面可能是 CLIXML 进度流） */
function parseResult(stdout: string): PsGenResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
  const last = lines[lines.length - 1]
  if (!last) throw new Error(`证书生成输出异常：${stdout.slice(0, 200)}`)
  const parsed = JSON.parse(last) as Partial<PsGenResult>
  if (!parsed.caThumbprint || !parsed.leafThumbprint) {
    throw new Error(`证书生成输出缺字段：${last.slice(0, 200)}`)
  }
  return parsed as PsGenResult
}

/**
 * 确保 MITM 证书可用（无则生成 / 过期或白名单变化则重签）。
 * @returns 是否本次新生成了叶子证书
 */
export async function ensureMitmCerts(): Promise<boolean> {
  if (leafStillValid()) return false
  mkdirSync(certDir(), { recursive: true })
  const { caThumbprint } = loadState()
  const stdout = await runPowerShell(buildScript(caThumbprint ?? ''))
  const result = parseResult(stdout)
  const leafFingerprint = createHash('sha256').update(readFileSync(leafCertPath())).digest('hex')
  const state = loadState()
  saveState({
    ...state,
    caThumbprint: result.caThumbprint,
    leafFingerprint,
    sanHosts: [...MITM_HOSTS]
  })
  return true
}

export interface MitmCerts {
  caPath: string
  cert: Buffer
  key: Buffer
}

/** 读取代理握手用的证书；缺失时提示先启用一次（会自动生成） */
export function loadCerts(): MitmCerts {
  try {
    return {
      caPath: caCertPath(),
      cert: readFileSync(leafCertPath()),
      key: readFileSync(leafKeyPath())
    }
  } catch (err) {
    throw new Error(
      'MITM 证书缺失：请打开设置里的 MITM 开关重新启用（将自动按机器随机生成）。' +
        (err instanceof Error ? ` 原因：${err.message}` : '')
    )
  }
}
