#!/usr/bin/env node
/**
 * 生成 MITM 用的本地 CA 与叶子证书（一次性，产物进 resources/mitm/）。
 *
 * 为什么预生成而不是运行时生成：
 *   运行时生成需要引入 node-forge 之类的库（+ 运行时开销 + 打包体积）。
 *   我们的解密域名白名单是固定的，一张覆盖全部白名单域名的叶子证书就够用，
 *   所以构建期用 openssl 生成、随包分发，运行时只读文件。
 *
 * 产物：
 *   resources/mitm/ca.crt    安装到「当前用户/受信任的根证书颁发机构」
 *   resources/mitm/leaf.crt  代理握手用的叶子证书（SAN 覆盖全部白名单域名）
 *   resources/mitm/leaf.key  叶子私钥
 *   resources/mitm/ca.key    CA 私钥（**不进安装包**，仅用于日后重签叶子证书）
 *
 * 重新生成会让已装过的旧 CA 失效，需要重新安装（设置里有「重装证书」）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'resources', 'mitm')

/** 与 src/main/mitm/whitelist.ts 保持一致 */
const HOSTS = [
  'order.jd.com',
  'api.m.jd.com',
  'h5api.m.goofish.com',
  'h5api.m.taobao.com',
  'mobile.yangkeduo.com',
  'app.dewu.com',
  'open.kwaixiaodian.com',
  'waimai-guide.ele.me',
  'wx.waimai.meituan.com',
  // 美团综合订单（App 内才有），与 src/main/mitm/whitelist.ts 保持一致
  'i.meituan.com'
]

const force = process.argv.includes('--force')
if (existsSync(join(OUT, 'leaf.crt')) && !force) {
  console.log('[certs] 已存在，跳过（要重签请加 --force）')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
for (const f of ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key', 'leaf.csr', 'leaf.ext', 'ca.srl']) {
  rmSync(join(OUT, f), { force: true })
}

console.log('[certs] 生成 CA…')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(OUT, 'ca.key'), '-out', join(OUT, 'ca.crt'),
  '-days', '3650',
  '-subj', '/CN=Reflow Local MITM CA/O=Reflow/C=CN',
  '-addext', 'basicConstraints=critical,CA:TRUE',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
], { stdio: 'inherit' })

console.log('[certs] 生成叶子证书（SAN 覆盖 %d 个域名）…', HOSTS.length)
writeFileSync(join(OUT, 'leaf.ext'), [
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
  `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`
].join('\n'))

execFileSync('openssl', [
  'req', '-new', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(OUT, 'leaf.key'), '-out', join(OUT, 'leaf.csr'),
  '-subj', '/CN=reflow-mitm'
], { stdio: 'inherit' })

execFileSync('openssl', [
  'x509', '-req', '-in', join(OUT, 'leaf.csr'),
  '-CA', join(OUT, 'ca.crt'), '-CAkey', join(OUT, 'ca.key'), '-CAcreateserial',
  '-out', join(OUT, 'leaf.crt'), '-days', '3650',
  '-extfile', join(OUT, 'leaf.ext')
], { stdio: 'inherit' })

rmSync(join(OUT, 'leaf.csr'), { force: true })
rmSync(join(OUT, 'leaf.ext'), { force: true })

console.log('[certs] 完成：', OUT)
