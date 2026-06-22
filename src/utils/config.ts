/**
 * 集中可调参数：service worker / side panel / ai / content 共享单一来源。
 * content script 虽走独立 IIFE 打包（vite.content.config.ts），但它本就 import i18n，
 * 因此一并 import 本模块；打包器会内联，无额外风险。
 */
export const CONFIG = {
  /** AI 流式输出转发到侧边栏的节流间隔（ms） */
  AI_STREAM_THROTTLE_MS: 70,
  /** 单步动作执行超时（ms） */
  EXEC_STEP_TIMEOUT_MS: 5000,
  /** 右键暂存（pendingContextSelection / pendingDebugLoad）过期时间（ms） */
  PENDING_TTL_MS: 20000,
  /** 执行锁的失效超时：超过该时长视为陈旧锁，允许新操作（ms） */
  LOCK_STALE_MS: 120000,
  /** AI 单次返回的最大 token 数 */
  AI_MAX_TOKENS: 8192,

  // ── content script ──
  /** 清洗后 outerHTML 长度上限，避免超大页面撑爆 token */
  MAX_HTML_LEN: 80000,
  /** 「刚打开下拉、下一次 click 视为选项」的时间窗（ms） */
  EXPECT_OPTION_MS: 8000,
  /** 执行前 fill gate 等待用户点击页面的超时（ms） */
  FILL_GATE_MS: 60000,
  /** 执行器轮询元素状态的间隔（ms） */
  POLL_INTERVAL_MS: 100,
  /** 页面内提示条停留时长（ms） */
  TOAST_MS: 3000,
  /** 错误提示条停留时长（ms） */
  TOAST_ERROR_MS: 6000,
} as const;
