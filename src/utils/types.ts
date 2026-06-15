export interface Profile {
  id: string;
  name: string;
  fields: Record<string, string>;
}

export interface AIConfig {
  // 'custom'          = 任意 OpenAI 兼容接口（本地模型 / 中转 / 第三方）
  // 'custom-anthropic'= 任意 Claude/Anthropic 兼容接口
  provider: 'anthropic' | 'openai' | 'custom' | 'custom-anthropic';
  apiKey: string;
  model: string;
  /** 可选：自定义 API Base URL，留空则使用该 provider 的默认地址 */
  baseUrl?: string;
}

// ── Fill actions (AI 输出的结构化指令，避免在 MV3 下 eval 代码) ──────────────

export type LocatorBy =
  | 'label' | 'placeholder' | 'role' | 'text' | 'altText' | 'title'
  | 'name' | 'id' | 'css';

export interface FillTarget {
  by: LocatorBy;
  value: string;
  /** 仅当 by === 'role' 时使用，例如 'button' / 'textbox' */
  role?: string;
}

/**
 * 动作类型字符串与 Playwright Locator 方法名一一对应。
 * 文本框 → fill；下拉 → selectOption；复选/单选 → check/uncheck；按钮 → click 等。
 */
export type PlaywrightAction =
  | 'fill' | 'selectOption' | 'check' | 'uncheck'
  | 'click' | 'press' | 'pressSequentially' | 'type'
  | 'clear' | 'setInputFiles' | 'hover' | 'focus'
  // 调试用低层事件
  | 'mousedown' | 'mouseup' | 'mousemove' | 'pointerdown' | 'pointerup' | 'pointermove'
  | 'dispatchEvent';

export interface FillAction {
  type: PlaywrightAction;
  target: FillTarget;
  /** fill / selectOption / press / setInputFiles 等需要值的方法所用的值 */
  value?: string;
  /**
   * 可选：原始 Playwright 定位链表达式（以 page. 开头，不含末尾动作方法），
   * 用于结构化 target 无法表达的高级/消歧场景，如：
   * "page.locator('text=Aims and Scope').locator('..').getByRole('textbox')"
   * 提供时优先于 target。
   */
  raw?: string;
  /**
   * 可选：AI 快照中的元素引用（快照里的 [ref=eN] 标记，如 "e12"）。
   * 仅在采集快照的同一页面生命周期内有效；校验阶段会用它把失败的定位
   * 固化为稳定的语义定位（写回 raw/target），缓存中不依赖 ref。
   */
  ref?: string;
  /** 给用户看的简短描述（用于进度显示），可选 */
  label?: string;
}

/** 定位校验问题（生成后 / 手动校验时产出） */
export interface ValidationIssue {
  /** 动作在 actions 数组中的下标 */
  index: number;
  /** 动作的简短描述（label 或定位表达式） */
  label: string;
  /** 被校验的定位表达式（人类可读） */
  locator: string;
  /** 命中元素数量 */
  count: number;
  /** error = 命中多个（必坏）；warn = 命中 0 个（可能是动态元素） */
  severity: 'error' | 'warn';
  /** 是否已被自动修复 */
  fixed?: boolean;
  /** 修复来源：ref = aria-ref 固化；ai = AI 修复；pick = 用户点选 */
  fixedBy?: 'ref' | 'ai' | 'pick';
  /** 给用户看的中文说明 */
  message: string;
}

/** 第一阶段：AI 识别出的表单字段（供用户确认/增删改） */
export interface DetectedField {
  /** 可见标签 / 可访问名称 */
  label: string;
  /** text / email / password / number / tel / select / checkbox / radio / textarea / date / range / file ... */
  type: string;
  required?: boolean;
}

/** detectFields 返回：识别到的字段 + AI 生成的表单名 */
export interface FormAnalysis {
  formName: string;
  fields: DetectedField[];
}

/**
 * 表单缓存项：字段 JSON 与动作 JSON 一一对应。
 * 通过 (urlPattern, formName) 唯一标识；通过 (urlPattern 正则 + domHash) 命中。
 */
export interface FormCacheEntry {
  id: string;
  /** 可为正则表达式源串，匹配时用 new RegExp(urlPattern).test(currentUrl) */
  urlPattern: string;
  /** AI 生成、用户可改的表单名 */
  formName: string;
  /** 用户所选 DOM 的哈希（由 aria 快照计算） */
  domHash: string;
  /** 用户所选容器的 selector */
  selector: string;
  /** 字段 JSON */
  fields: DetectedField[];
  /** 动作 JSON 字符串（AI 结构化输出，未生成时为 ''） */
  actions: string;
  /** 可执行的 Playwright 代码（执行成功后写入，作为权威可复用内容） */
  code?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavedScript {
  selector: string;
  script: string;
  instruction: string;
  profileId?: string;
  timestamp: number;
  url: string;
  fingerprint: string;
}

/**
 * 采集模式：
 * - 'html' = 采集所选容器的真实 DOM HTML（清洗后），保留 id/name/type/placeholder 等真实属性（当前唯一模式）
 * - 'aria' = 旧的 ARIA 无障碍快照模式（已从 UI 移除；类型保留以兼容历史代码路径）
 */
export type CaptureMode = 'aria' | 'html';

// Messages: sidepanel → background
export type SidePanelMessage =
  | { type: 'startSelection'; tabId: number }
  // 选中 DOM 后：采集快照并计算 domHash（供缓存匹配 / 后续阶段复用）
  | { type: 'snapshotForm'; tabId: number; selector: string; mode: CaptureMode }
  // 阶段 1：AI 识别表单字段（复用已采集的快照，无需再次连接页面）
  | { type: 'analyzeForm'; snapshot: string; mode: CaptureMode }
  // 阶段 1（本地）：在页面内解析所选容器的 DOM 识别字段（不调用 AI）
  | { type: 'localAnalyzeForm'; tabId: number; selector: string }
  // 阶段 2（本地）：在页面内为已确认字段生成动作（唯一定位+默认值，不调用 AI）
  | { type: 'localGenerateFill'; fields: DetectedField[]; tabId: number; scopeSelector: string }
  // 阶段 2：根据已确认字段生成动作 JSON（不执行）；生成后在 tab 上自动校验定位
  | { type: 'generateFill'; instruction: string; profileId?: string; fields: DetectedField[]; snapshot: string; mode: CaptureMode; tabId: number; scopeSelector: string }
  // 阶段 3：执行 Playwright 代码（以代码区为准）；scopeSelector = 所选容器，定位链在容器内解析
  | { type: 'executeFill'; tabId: number; code: string; scopeSelector?: string }
  // 手动校验动作 JSON 的定位（count 检查 + ref 固化，不调 AI）
  | { type: 'validateActions'; tabId: number; actionsJson: string; scopeSelector?: string }
  | { type: 'getScriptsForUrl'; url: string }
  | { type: 'deleteScript'; cacheKey: string };

// Messages: background → sidepanel (broadcast via runtime.sendMessage)
export type BackgroundMessage =
  | { type: 'fillProgress'; status: string; step?: number; total?: number }
  // AI 流式输出（识别 / 生成阶段实时文字）
  | { type: 'aiStream'; phase: 'detect' | 'generate'; text: string }
  // 快照就绪：返回 payload（aria 快照或真实 HTML）、domHash、以及本次采集所用模式
  | { type: 'snapshotReady'; snapshot: string; domHash: string; mode: CaptureMode }
  // 阶段 1 结果：识别到的字段 + 表单名
  | { type: 'formAnalyzed'; fields: DetectedField[]; formName: string }
  // 阶段 2 结果：生成的动作 JSON（已自动校验/修复；issues 为校验报告）
  | { type: 'fillGenerated'; script: string; issues?: ValidationIssue[] }
  // 手动校验结果：script 为应用 ref 固化后的动作 JSON
  | { type: 'validationResult'; script: string; issues: ValidationIssue[] }
  // 通用完成/错误
  | { type: 'fillComplete'; success: boolean; error?: string }
  | { type: 'opError'; error: string }
  // 右键“Pick DOM”未命中（或命中无代码）时：通知侧边栏读取暂存的所选区域并进入分析流程
  | { type: 'contextSelected' }
  // 右键“调试”：通知侧边栏把指定缓存项强制载入
  | { type: 'debugLoadEntry'; id: string };

// Messages: content script → background/sidepanel
export type ContentMessage =
  | { type: 'elementSelected'; selector: string; tagName: string }
  | { type: 'selectionCancelled' }
  // 录制：捕获到一个用户动作（已归一化为结构化 FillAction）
  | { type: 'recordedAction'; action: FillAction }
  // 录制：页面内按 ESC 结束录制
  | { type: 'recordingStopped' }
  // 拾取修复：用户在页面上点选了目标元素。selector = 唯一 CSS（兜底）；
  // locator = playwright generateSelector 产出的语义定位链（如 "page.getByRole('button', { name: '提交' })"），
  // injected 不可用时为空串
  | { type: 'targetPicked'; selector: string; locator?: string }
  // 拾取修复：页面内按 ESC 取消
  | { type: 'pickCancelled' }
  // 页面内快速菜单：选择某缓存表单 → 填充
  | { type: 'quickMenuFill'; id: string }
  // 页面内快速菜单：选择 Pick DOM → 进入选取流程
  | { type: 'quickMenuPickDom' };

// Messages: background/sidepanel → content script
export type ToContentMessage =
  | { type: 'startSelection' }
  | { type: 'stopSelection' }
  // html 模式：请求所选容器清洗后的真实 outerHTML（content 通过 sendResponse 同步返回）
  | { type: 'getOuterHtml'; selector: string }
  // 本地分析：请求所选容器的字段列表（content 通过 sendResponse 返回 { formName, fields }）
  | { type: 'localAnalyze'; selector: string }
  // 本地生成：为已确认字段生成动作（content 通过 sendResponse 返回 { actions }）
  | { type: 'localGenerate'; selector: string; fields: DetectedField[] }
  // 页面内快速菜单：展示匹配当前 URL 的缓存表单
  | { type: 'showQuickMenu'; forms: Array<{ id: string; formName: string }>; pickDom: boolean }
  // 页面内提示条（填充结果反馈）
  | { type: 'aifillToast'; text: string; kind: 'success' | 'error' | 'info' }
  // 录制：开始 / 停止在页面上监听用户操作
  | { type: 'startRecording' }
  | { type: 'stopRecording' }
  // 拾取修复：开始 / 停止"点选目标元素"模式
  | { type: 'startPickTarget' }
  | { type: 'stopPickTarget' }
  // Playwright injected 桥：aria 快照（含 ref）/ selector 计数（content 同步 sendResponse 返回）
  | { type: 'pwAriaSnapshot'; selector: string }
  | { type: 'pwCount'; selector: string; scopeSelector?: string }
  // aria-ref 固化：ref → generateSelector 语义定位 + CSS 兜底
  | { type: 'pwSolidifyRef'; ref: string }
  // 执行单步动作：selector 为 playwright selector 语法（internal:role=... >> nth=0 等）
  | { type: 'pwExecStep'; selector: string; action: string; args: any[]; scopeSelector?: string; timeout?: number };

/** getOuterHtml 的响应体 */
export interface OuterHtmlResponse {
  html: string;
  /** 是否因超过长度上限而被截断 */
  truncated?: boolean;
  error?: string;
}
