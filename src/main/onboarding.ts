/**
 * 工单 024：首次启动引导（已按决策 D-E 大幅简化）。
 *
 * 注入路线**不需要**：装根证书、改系统代理、管理员权限。
 * 因此引导只剩三件事：
 *  1. 说清工作原理（数据只在本机，不上传）
 *  2. SmartScreen 提示（不签名的代价，见 030）
 *  3. 选常用平台（减少首屏干扰）
 *
 * 状态存 userData/onboarding.json，完成后不再打扰。
 */
import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface OnboardingState {
  version: number
  completed: boolean
  completedAt?: number
  /** 用户选择的常用平台 id（空 = 全部显示） */
  platforms: string[]
}

const VERSION = 1

function filePath(): string {
  return join(app.getPath('userData'), 'onboarding.json')
}

const DEFAULT_STATE: OnboardingState = { version: VERSION, completed: false, platforms: [] }

export async function loadOnboarding(): Promise<OnboardingState> {
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const data = JSON.parse(raw) as OnboardingState
    if (data?.version !== VERSION) return { ...DEFAULT_STATE }
    return {
      version: VERSION,
      completed: Boolean(data.completed),
      completedAt: data.completedAt,
      platforms: Array.isArray(data.platforms) ? data.platforms : []
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export async function saveOnboarding(state: OnboardingState): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  const target = filePath()
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify({ ...state, version: VERSION }, null, 1), 'utf-8')
  await rename(tmp, target)
}

/** IPC：引导状态的读写 */
import { ipcMain } from 'electron'
export function setupOnboardingIpc(): void {
  ipcMain.handle('onboarding:load', async () => loadOnboarding())
  ipcMain.handle(
    'onboarding:complete',
    async (_event, payload: { platforms?: string[] }) => {
      const state: OnboardingState = {
        version: VERSION,
        completed: true,
        completedAt: Date.now(),
        platforms: Array.isArray(payload?.platforms) ? payload.platforms.slice(0, 20) : []
      }
      await saveOnboarding(state)
      return { ok: true }
    }
  )
  ipcMain.handle('onboarding:reset', async () => {
    await saveOnboarding({ ...DEFAULT_STATE })
    return { ok: true }
  })
}
