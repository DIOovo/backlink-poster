# Batch Backlink Poster 第一阶段实施报告

## ego(lite) Native Messaging 路径修复（2026-10-03）

本机 A/B 验证表明：仅在旧路径 `~/Library/Application Support/Ego/NativeMessagingHosts` 安装 manifest 时，ego(lite) 0.5.1.13 返回 `Specified native messaging host not found.`；仅在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` 安装完全相同的 manifest 时，Settings 显示 `Connected`，ping 返回 Host v1.0.0 与正确 outputRoot。`chrome://version` 确认浏览器为 ego(lite) 0.5.1.13、profile 位于 Citro Labs 目录；其 Chromium framework 二进制同时包含 Google/Chrome NativeMessagingHosts 查找路径，因此当前版本实际复用了 Chrome 的用户级 manifest 目录。

`native-host/install.sh` 的 `ego` 模式现明确写入经过验证的 Chrome manifest 路径，并支持要求的双参数命令 `./native-host/install.sh EXTENSION_ID ego`；原三参数 output root 形式与 `chrome` 模式保持兼容。新增 `native-host/uninstall.sh`，使用与安装脚本完全相同的路径映射，只删除 manifest，保留 host、config 与输出文件。`test/native-host-install.test.sh` 在隔离 HOME 中验证 ego/Chrome 安装、合法 JSON、绝对 host.py、allowed_origins 和卸载路径一致性。

最新 `dist` 重新加载后的实际结果：Settings → Test Connection 显示 `Connected` 与 Host v1.0.0，outputRoot 为 `/Users/gaoheyang/Downloads/backlink-results`。原生 ping 返回相同版本和路径。直接 Native Host 烟雾测试写入 68-byte PNG 与两行 CSV，磁盘校验后已删除；写入前后 Settings 标签保持前台、标签数不变，未出现 Save As 或下载 UI。单条 `/wp` Batch 实测为 `SUCCESS / local / DIRECT_FORM / wordpress_comment`，提交内容与 Identity 完整一致，产物为：

```text
/Users/gaoheyang/Downloads/backlink-results/2026-10-03T09-11-10-059Z-18980944/001-127.0.0.1-success.png
/Users/gaoheyang/Downloads/backlink-results/2026-10-03T09-11-10-059Z-18980944/results.csv
```

测试 Identity、Batch、local/session storage 已恢复为测试前状态；fixture 和烟雾文件已清理。修正后的 Native Host manifest 与默认 outputRoot 配置按要求保留，供该开发机后续使用。

## Comment Entry Discovery / Reply Activation（2026-10-03）

新增入口发现顺序：直接表单 → 本地 Reply 入口 → 点击后用新 DOM 在 0/500/1000/2000ms 重新检测 → 新 AI 分析。`src/batch/reply.ts` 负责保守选择候选；`src/batch/content.ts` 识别 WordPress `a.comment-reply-link` 及 `data-commentid`、`data-postid`、`data-belowelement`、`data-respondelement`，并排除登录、邮件回复、分享、举报、导航、页脚和正文普通链接。多个候选按高置信度和 DOM 顺序只选一个。

AI fallback 现在可返回直接表单或 `reply_trigger`。AI locator 仍要在页面端验证为唯一、可见、enabled 且位于评论上下文，点击后不会复用旧 DOM/ARIA/element reference。CSV 新增 `entry_strategy`，值为 `DIRECT_FORM`、`REPLY_TRIGGER_LOCAL` 或 `REPLY_TRIGGER_AI`。

新增 13 个命名测试（Reply selector 5 个、model schema 1 个、runner 7 个，另扩展 AI provider 用例断言），覆盖直接表单、WordPress Reply、只点击一个、表单移动、登录入口、正文误判、AI Reply、点击失败，以及 Reply 点击成功但没有出现表单时仍截图并记录指定错误。完整 `npm test` 结果为原 locator 7、batch/model 8、Reply selector 5、runner 16、AI provider 1 组，全部通过。

ego(lite) 使用唯一新 Space 3 和最新 `dist` 运行 `/reply-local`：扩展自动发现并点击 Reply，重新识别 `wordpress_comment`，准确填写原始 Content/Name/Email/Website，提交后状态为 `SUCCESS`、`detection_method=local`、`entry_strategy=REPLY_TRIGGER_LOCAL`。目标页 Reply 没有人工点击。实际产物：

```text
/Users/gaoheyang/Desktop/sea/backlink-poster/e2e-artifacts/reply-entry-20261003/2026-10-03T08-45-17-387Z-1867da49/001-127.0.0.1-success.png
/Users/gaoheyang/Desktop/sea/backlink-poster/e2e-artifacts/reply-entry-20261003/2026-10-03T08-45-17-387Z-1867da49/results.csv
/Users/gaoheyang/Desktop/sea/backlink-poster/e2e-artifacts/reply-entry-20261003/sidepanel-final-native.png
```

测试后已恢复扩展原有 `aiConfig`、`uiLocale` 和空 session，移除测试期间创建的两个 Native Messaging manifest 与 `native-host/config.json`，并按 ego-browser 要求完成该 Space。`build`、`typecheck`、`test`、`git diff --check` 均通过；没有 commit 或 push。

## 交付状态

功能代码与构建产物已完成。保留原项目技术栈、AI 设置、storage、InjectedScript 和底层 locator/fill 执行能力。没有 commit 或 push，没有新增依赖；原先已有的 package-lock.json 修改未改动。

ego(lite) 第一轮五条本地任务已真实运行并生成五张截图和 CSV。2026-10-03 又创建了一个完全独立的新测试 Space，重新加载当前最新 `dist`，完成 11 条主批次、Pause/Resume、Stop、侧栏重开、AI fallback、失败隔离、截图和 CSV 的浏览器端回归。测试中发现并修正了 challenge 被记为 `FORM_NOT_FOUND` 的状态语义问题；重新构建和加载后已确认它现在记录为 `SUBMIT_FAILED`。测试配置和临时存储均已恢复/清理。

## 修改文件及作用

| 文件 | 修改 |
|---|---|
| `src/batch/model.ts` | 新增任务/身份/队列类型、严格 CSV 导入导出、URL 和目录校验、截图命名、AI JSON schema 校验。 |
| `src/batch/content.ts` | 新增 WordPress 与通用本地检测、候选 DOM/ARIA、locator 固化、自动填写/readback、提交及结果证据判断。 |
| `src/batch/runner.ts` | 新增串行后台队列、专用标签复用、加载重试、AI fallback、暂停/停止、持久化恢复、截图与 CSV 下载。 |
| `src/background.ts` | 注册 Batch 消息路由；原手动流程的消息路由避开 Batch 消息。 |
| `src/content.ts` | 为 Batch 暴露现有 InjectedScript、唯一 locator、原生填值和 click 能力；修正受控输入 tracker 事件顺序及旧类型问题。 |
| `sidepanel.html`、`src/sidepanel.ts` | 将主流程替换为 Identity、粘贴/CSV 导入、任务表、Start/Pause/Stop、进度和结果查看。 |
| `options.html`、`src/options.ts` | 保留 AI Provider、Model、Base URL、API Key 和 Profiles；新增 Screenshot Folder。 |
| `src/utils/ai.ts` | 复用 provider/JSON 提取，新增仅识别字段的 AI prompt；为请求设置 45 秒上限。 |
| `src/utils/storage.ts` | 修复原 storage.get(null) 在 content 宽松 TypeScript 配置下的重载类型问题。 |
| `src/i18n/index.ts` | 避免 service worker 初始化语言时访问不存在的 document。 |
| `public/manifest.json` | 增加 downloads / alarms；content script 匹配缩小到 HTTP/HTTPS。 |
| `public/_locales/en/messages.json`、`public/_locales/zh_CN/messages.json` | 扩展名称和说明改为 Batch Backlink Poster。 |
| `package.json` | 增加 typecheck 和批量回归测试命令，并接入原 npm test。 |
| `test/batch.test.cjs` | CSV、URL、目录、命名、AI schema 测试。 |
| `test/batch-runner.test.cjs` | 串行隔离、暂停/恢复、停止、worker 恢复、防重复提交、防截错 Tab、持久化、权限测试。 |
| `test/batch-ai.test.cjs` | 模拟兼容 API，验证配置复用、JSON、无表单、无效响应及 API 失败。 |
| `test/batch-fixtures.mjs` | 本地 WordPress、审核、受控输入、无表单、失败和 challenge 页面，以及模拟 AI endpoint。 |
| `README.md`、本报告 | 新流程、路径、权限、重新加载、测试方式和限制。 |

## 执行流程

导入并持久化 → Start Batch → 专用 worker tab → 等待 complete + 渲染 → 本地检测/重试 → 必要时 AI → 固化定位 → 填写 → 读取并验证 Content / Name / Email → 持久化提交阶段和基线 → 自动点击一次 → 最多等待约 15 秒的新结果证据 → 截图/下载 → 持久化单条结果 → 下一条 → 导出 CSV。

Pause / Stop 都等待当前任务完成截图后生效。Side Panel 不拥有调度循环；关闭面板不会丢失队列。已提交阶段在 worker 恢复时只检查结果，不再次点击。整个浏览器/扩展重启后暂停，丢弃旧 tab ID，保留数据。

## Local Detector 与 AI fallback

优先识别 WordPress 的 commentform/comment/author/email/url/submit。通用规则使用 textarea/contenteditable、提交按钮、id/name/placeholder/ARIA/关联 label、附近标题及 form action。排除密码、搜索、登录、注册和 newsletter。正文和提交按钮必须属于同一候选容器；存在歧义时不随意选第一个。

本地候选无法可靠识别时，复用原 provider，把候选清洗 DOM 和 ARIA 发给 AI。AI 只返回 JSON 字段映射，不生成评论、脚本或任意动作。使用用户配置的模型和 API 地址；没有业务硬编码 qwen 模型或密钥。字段缺失/类型错误/低置信度/非唯一 locator 会明确失败。

## 截图与下载路径

每条终态任务都会尝试截图，包括无表单和提交失败。截图前滚动到结果/表单并激活专用 Tab；调用 captureVisibleTab 前后核对 tab ID 与 URL，同时监控切换和导航。截错风险时丢弃并记录错误，不伪造截图。

所有下载都使用 `saveAs:false` 和 `conflictAction:uniquify`，并等待下载完成。每个批次另有唯一目录，防止覆盖。

实际结构：

```text
<浏览器 Downloads 根目录>/<Screenshot Folder>/<唯一批次 ID>/
  screenshots/001-domain-success.png
  screenshots/002-domain-pending.png
  screenshots/003-domain-failed.png
  results.csv
```

CSV 包含全部 11 个要求字段；时间为 ISO 8601 UTC，逗号/双引号/换行正确转义。截图路径来自 downloads API 返回的实际文件路径，扩展没有任意绝对路径写入能力。

第一轮测试实际目录：

```text
/Users/gaoheyang/Downloads/backlink-results/qa-2026-10-02/2026-10-02T11-32-55-940Z-6e0ce16b/
```

## 权限

新增 `downloads`：保存 PNG 和 CSV，无逐张 Save As。

新增 `alarms`：唤醒被挂起的当前有限批次，不提供定时发帖功能。

保留原有 `<all_urls>` host 权限：用户可输入任意 HTTP/HTTPS 网站，且没有逐站 activeTab 手势时，captureVisibleTab 需要对应权限。未新增 debugger、scripting 或浏览器启动能力。Content script 匹配已缩小到 HTTP/HTTPS。

## 验证结果

- `npm run build`：通过，产物为 `dist/`。
- `npm run typecheck`：通过，含主项目严格配置与原 content 配置。
- `npm test`：通过，7 个原 locator 测试、7 个数据测试、8 个调度测试，以及 AI provider 模拟测试。
- `npm run lint --if-present`：执行，但项目未配置 lint；不计作 lint 通过。
- `git diff --check`：通过。

第一轮 ego(lite) 实测结果：

| 页面 | 预期/实际状态 | 截图 |
|---|---|---|
| `/wp` | SUCCESS | 已下载提交后页面 |
| `/noform` | FORM_NOT_FOUND | 已下载；后续任务继续 |
| `/pending` | PENDING_MODERATION | 已下载含审核提示的提交后页面 |
| `/controlled` | SUCCESS | 已下载；模拟受控输入没有回滚 |
| `/failed` | SUBMIT_FAILED | 已下载；旧审核提示没有被误判为新成功 |

五条由一次 Start Batch 串行运行，未手动选表单或逐条提交。服务器收到的成功/审核/受控输入请求均包含原始 Content、Name、Email、Website。AI 调用计数为 0。CSV 中对应五条截图文件均存在；成功、审核、失败图片已人工视觉检查。

AI fallback 使用本地模拟 provider 测试，未使用用户真实 Qwen API 配额。最新版本浏览器回归确认：关闭侧栏文档后后台继续执行；重新打开侧栏会读回任务进度；Pause 在当前任务截图后停住并可恢复；Stop 在当前任务截图后停止并导出部分 CSV；各类失败均不会阻断后续任务。

最新 11 条主批次实际结果依次为：`SUCCESS`、`FORM_NOT_FOUND`、`PENDING_MODERATION`、`SUCCESS`、`SUBMIT_FAILED`、`SUCCESS (ai)`、`AI_FAILED`、challenge（修正前为 `FORM_NOT_FOUND`）、`SUCCESS`、`LOAD_FAILED`、`SUCCESS`。全部 11 张截图与 CSV 行存在且一一匹配。challenge 修正后另跑一条任务，实际结果为 `SUBMIT_FAILED`，并生成截图与 CSV。

最新主批次保存位置：

```text
/Users/gaoheyang/Downloads/backlink-results/latest-dist-regression-2026-10-02/2026-10-02T12-08-06-217Z-dc97e0c1/
```

Pause/Resume 批次：

```text
/Users/gaoheyang/Downloads/backlink-results/latest-dist-regression-2026-10-02/2026-10-03T07-08-20-120Z-2e8ad944/
```

Stop 批次：

```text
/Users/gaoheyang/Downloads/backlink-results/latest-dist-regression-2026-10-02/2026-10-03T07-09-03-066Z-c5fbcfd1/
```

challenge 修正后复测：

```text
/Users/gaoheyang/Downloads/backlink-results/latest-dist-regression-2026-10-02/2026-10-03T07-11-24-035Z-ca2465ab/
```

## 重新加载和首轮测试

在 ego(lite) 打开 `chrome://extensions`，找到原扩展，点击重新加载，再打开侧栏。若首次加载，请选择 `/Users/gaoheyang/Desktop/sea/backlink-poster/dist/`，不要使用旧 `dist.crx`。

真实网站首轮选 2–3 个有权测试的 URL：标准 WordPress、一页有审核、一页无评论表单；填写不同 Content。检查三种状态、对应截图、CSV，并确认失败后仍处理下一条。

也可以按 README 启动本地 fixture server，用 `/wp`、`/pending`、`/noform` 进行无外部发布的测试。

## 已知限制与待办

- 不破解 CAPTCHA、Cloudflare 或登录；遇到挑战记录失败并继续。
- 第一版主要支持顶层文档表单。跨域 iframe、关闭的 Shadow DOM、复杂多步骤编辑器暂不保证。
- 截图是可见视口，并会临时激活 worker tab/window；不是全页拼接。
- 未确认状态保持失败，可能包含实际已经提交但证据不足的情况；不自动重试，避免重复发帖。
- 浏览器退出、下载被禁止、权限不足、存储配额或标签被关闭时不能保证完成截图；错误会记录。
- 最新版本已完成 ego(lite) 浏览器复测。测试结束后恢复了测试前的 AI 配置，移除了测试 Identity、Screenshot Folder、批次状态、任务数据、测试 session 状态和两个临时备份键；重新加载后确认状态为 `IDLE`、任务数为 0。
