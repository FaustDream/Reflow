/**
 * 工单 008：闲鱼订单详情批量抓取（主进程编排）。
 *
 * 渲染层传入 webviewId 与待抓订单（orderId + idleBizCode），主进程：
 *   1. 仅对 idleBizCode==='6'（实物商品）发详情请求（原版 AGENTS.md 结论）
 *   2. **串行 + 限速**调用页面官方 mtop SDK（sign 由 SDK 计算，符合 D-2）
 *   3. 逐条回传进度/字段，失败计入 failed 不中断；人机验证则暂停整批
 *   4. 可取消
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { dispatchPageSdkRequest } from '../page-sdk'
import {
  normalizeXianyuDetail,
  XianyuMultiPackageError,
  XianyuValidateRequiredError,
  type XianyuDetailFields
} from './xianyu-detail'

/** 相邻两单请求间隔（ms），串行限速避免触发风控 */
const DETAIL_REQUEST_GAP_MS = 400
const PHYSICAL_GOODS_CODE = '6'
const DETAIL_API = 'mtop.idle.web.trade.order.detail'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FetchItem {
  orderId: string
  idleBizCode?: string
}

export interface DetailFetchOptions {
  getMainWindow: () => BrowserWindow | null
}

export function setupDetailFetchIpc({ getMainWindow }: DetailFetchOptions): void {
  // 每个 webview 一个取消标志（同一平台 Tab 同时只跑一批）
  const cancelFlags = new Set<number>()

  const emit = (channel: string, payload: unknown): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  ipcMain.handle(
    'xianyu:fetch-details',
    async (
      _event,
      payload: { webviewId: number; items: FetchItem[] }
    ): Promise<{ ok: boolean; message?: string }> => {
      const { webviewId } = payload
      const items = Array.isArray(payload.items) ? payload.items : []
      cancelFlags.delete(webviewId)

      // 实物商品才抓详情（虚拟商品无收货地址）
      const targets = items.filter(
        (i) => !i.idleBizCode || String(i.idleBizCode) === PHYSICAL_GOODS_CODE
      )
      const total = targets.length
      let done = 0
      let successCount = 0
      const failed: Array<{ orderId: string; message: string }> = []

      emit('orders:details-started', { platform: 'xianyu', total })

      for (const item of targets) {
        if (cancelFlags.has(webviewId)) {
          emit('orders:details-completed', {
            platform: 'xianyu',
            total,
            successCount,
            done,
            failed,
            cancelled: true
          })
          return { ok: true, message: '已取消' }
        }

        try {
          const response = await dispatchPageSdkRequest(webviewId, {
            v: '1.0',
            data: { tid: item.orderId },
            type: 'POST',
            appKey: '34839810',
            accountSite: 'xianyu',
            dataType: 'json',
            timeout: 20000,
            needLoginPC: false,
            showErrorToast: false,
            ext_querys: {
              spm_cnt: 'a21ybx.order-detail.0.0',
              spm_pre: 'a21ybx.bought.0.0.41aa'
            },
            api: DETAIL_API,
            valueType: 'string',
            needLogin: false,
            sessionOption: 'AutoLoginOnly',
            ecode: 0
          })

          if (!response.ok) throw new Error(response.error ?? '页面 SDK 调用失败')

          // 多包裹 / 人机验证需区别处理；其余错误计入该单失败
          const result = response.result as { ret?: unknown } | undefined
          const retText = Array.isArray(result?.ret) ? result!.ret.join(';') : ''
          if (/SESSION_EXPIRED/i.test(retText)) {
            throw new Error('会话已过期，请重新登录')
          }

          let fields: XianyuDetailFields
          try {
            fields = normalizeXianyuDetail(result)
          } catch (err) {
            if (err instanceof XianyuValidateRequiredError) throw err
            if (err instanceof XianyuMultiPackageError) {
              failed.push({ orderId: item.orderId, message: err.message })
              done += 1
              emit('orders:detail-progress', {
                platform: 'xianyu',
                done,
                total,
                orderId: item.orderId
              })
              await sleep(DETAIL_REQUEST_GAP_MS)
              continue
            }
            throw err
          }

          successCount += 1
          emit('orders:detail', { platform: 'xianyu', orderId: item.orderId, fields })
        } catch (err) {
          if (err instanceof XianyuValidateRequiredError) {
            emit('orders:details-completed', {
              platform: 'xianyu',
              total,
              successCount,
              done,
              failed,
              paused: true,
              message: err.message
            })
            return { ok: false, message: err.message }
          }
          failed.push({
            orderId: item.orderId,
            message: err instanceof Error ? err.message : String(err)
          })
        }

        done += 1
        emit('orders:detail-progress', {
          platform: 'xianyu',
          done,
          total,
          orderId: item.orderId
        })
        if (done < total) await sleep(DETAIL_REQUEST_GAP_MS)
      }

      emit('orders:details-completed', {
        platform: 'xianyu',
        total,
        successCount,
        done,
        failed,
        cancelled: false
      })
      return { ok: true }
    }
  )

  ipcMain.handle('xianyu:cancel-details', (_event, webviewId: number) => {
    cancelFlags.add(webviewId)
    return { ok: true }
  })
}
