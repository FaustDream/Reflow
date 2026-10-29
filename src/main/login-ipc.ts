/**
 * 登录 IPC：把 QrLoginService 暴露给渲染层。
 *
 * 渲染层只拿到「二维码图片」或「弹窗已开」，拿不到任何 Cookie/令牌。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { QrLoginService, QR_STRATEGIES, isPureQr, supportsQrLogin } from './qr-login'
import type { QrLoginStatus } from './qr-login'
import { activePartition } from './accounts-ipc'

export interface LoginStartResult {
  ok: boolean
  /** 二维码（native/dom 模式）；page 模式为空，由独立窗口承载 */
  qrImage?: string
  source?: 'native' | 'dom' | 'page'
  message?: string
}

export function setupLoginIpc(getMainWindow: () => BrowserWindow | null): QrLoginService {
  const service = new QrLoginService((platformId) => {
    // 工单 021：登录写进「当前活动账号」的分区，多账号各自独立
    return activePartition(platformId)
  })

  // 状态推送渲染层（只推状态文本，不含凭据）
  service.on('status', (payload: QrLoginStatus & { id: string; platformId: string }) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('login:status', payload)
  })

  ipcMain.handle('login:capabilities', () => {
    return Object.keys(QR_STRATEGIES).map((platformId) => ({
      platformId,
      supportsLogin: supportsQrLogin(platformId),
      pureQr: isPureQr(platformId),
      source: QR_STRATEGIES[platformId]?.kind,
      /** 登录页地址：渲染层「点登录直接跳过去」要用，不必让用户先手动打开页面 */
      loginUrl: QR_STRATEGIES[platformId]?.loginUrl ?? ''
    }))
  })

  ipcMain.handle(
    'login:start',
    async (_event, platformId: string): Promise<LoginStartResult> => {
      try {
        const session = await service.start(platformId)
        return {
          ok: true,
          qrImage: session.qrImage || undefined,
          source: session.source
        }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('login:cancel', (_event, platformId: string) => {
    service.cancel(platformId)
    return { ok: true }
  })

  return service
}
