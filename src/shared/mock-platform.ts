/**
 * 工单 005：mock 平台本地服务的共享常量。
 * 主进程适配器（mock-adapter.ts）与渲染层入口按钮共用，server.mjs 侧保持同端口。
 */
export const MOCK_PLATFORM_PORT = 8931
export const MOCK_PLATFORM_ORIGIN = `http://127.0.0.1:${MOCK_PLATFORM_PORT}`
