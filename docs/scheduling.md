# 模型可用时段调度与排队派发 — 接入点与设计

本文件既是需求勘察的「接入点清单」，也是本次改动的内部契约。所有路径相对仓库根
（`D:\CodeProject\Deepseek-Harness-Plugins\Mate`）。

## 0. 目录范围与约束

- 本仓库是 **DSH 插件**（`dsh-mate`），没有 `apps/web`，也没有独立主进程/渲染进程之
  分：Host 半（`src/*.ts`）与 Web 半（`src/client/*.tsx`）同在一个包内，由 `tsdown`
  分别打成 `lib/index.mjs` 与 `lib/client.js`。因此「只能改 apps/web 和 docs」的约束
  **不适用于本仓库**；本次改动落在 `src/`（Host + 客户端）、`tests/`、`docs/`。
- 调度内核（时段判定、队列、唤醒定时器）**必须落在 Host 半**：模型调用、派发、持久化
  都在 Host。客户端只负责配置编辑与展示。
- `src/schedule.ts` 是无副作用、同构的纯模块（不 import `node:*`、不读系统时钟），
  因此 Host 与浏览器半共用同一份校验与判定逻辑。

## 1. 接入点清单

### (1) 接收需求并调用模型做需求分析的入口

- `src/app.ts` `MateApp.createRequirement()`（约 321 行）→ `scheduleAnalysis(id)`。
- `src/app.ts` `MateApp.scheduleAnalysis()` / `MateApp.runAnalysis(id)`（约 683/703 行）。
- `src/app.ts` `MateApp.analyzeRequirement()` / `answerRequirement()`（重新分析/继续澄清）
  同样走 `scheduleAnalysis`。
- **时间闸门插入点**：`runAnalysis(id)` 内、`this.deps.analyzer.analyze(...)` 调用之前
  （约 716 行 `try {` 之后第一段）。`analyzer.analyze` 使用 `mate.model` 这一条模型路由。
- 模型调用点：`src/analyzer.ts` `MateAnalyzer.callText()`（`this.llm.stream`）。

### (2) 派发 / 建会话入口

- `src/app.ts` `MateApp.scheduleDispatch(id)` / `runDispatch(id)`（约 687/784 行）。
- 派发模型选择：`requirement.sessionOverrides ?? requirement.analysis?.sessionModel
  ?? mate.dispatchModel ?? mate.model` → 若 Mate 配了 `dispatchModels` 允许清单，再经
  `resolveDispatchModel()`（app.ts 约 1209 行）映射到清单内的一条。**闸门判定的是这次
  真正要用的那一条路由**；为了让「判定的路由 == 实际使用的路由」，派发时会把这条解析
  出的路由显式交给 `dispatcher.dispatch`（此前无指定时会交 `null` 用会话默认模型）。
  这是本次唯一一处派发行为变化，属于闸门正确性的必要条件。
- 建会话/发指令在 `src/dispatch.ts` `Dispatcher.dispatch()` → `createSession` /
  `controller.prompt`。
- **时间闸门插入点**：`runDispatch(id)` 内、`this.dispatcher.dispatch(...)`（约 805 行）
  之前；同处解析出的 `model` 即被判定路由。

### (3) 模型 / provider 注册与可用模型白名单来源

- `src/app.ts` `MateApp.refreshModelCatalog()`（约 1104 行）调用
  `sessionController.modelCatalog()`，结果缓存在 `cachedCatalog`
  （`SettingsView.modelCatalog`：`{ provider, name, models: [{ id, name }] }[]`）。
  这是设置页里「按模型配置」的候选列表来源。
- 单条路由的思考强度：`src/index.ts` `makeReasoningReader()` → `ctx.llm.resolveModelInfo`，
  经 `model.efforts` 命令暴露（与本需求无关，只说明模型路由形态）。
- 分析模型：`MateView.model`（每条 Mate 固定一条路由）。
- 派发模型：`RequirementView.sessionOverrides` / `AnalysisView.sessionModel` /
  `MateView.dispatchModels` 允许清单。
- 结论：本功能不做「模型目录过滤」，而是在**动作发生前**判定「这次要用的那条路由是否
  处在禁用时段」；被禁则排队等待，**不切换/降级到其它模型**。

### (4) 设置页所在目录与配置落盘

- 设置弹窗：`src/client/dialogs.tsx` `SettingsDialog`（约 816 行）；由
  `src/client/panel.tsx`（约 422 行）打开，`onSubmit` 走 `settings.update` 命令。
- 文案：`src/client/locales.ts`（`ZH` / `EN` 两张表，key 一一对应）。
- 命令分发：`src/app.ts` `MateApp.execute()` → `updateSettings()`（约 659 行）。
- 持久化：`src/domain.ts` 的 storage domain `mate`，落在 `~/.dsh/storages/mate.json`
  （一个 unit 文件）。全局单例 `GlobalSchema`；需求表 `requirements`。
  新增字段：`global.schedule`（时段 + 节假日 + 手动时区）、`global.clientTimeZone`、
  `requirement.queue`。全部可选，domain `version` 保持 1（旧数据可直接读）。

### (5) dsh 客户端设置中的时区读取方式

勘察结论（DSH 0.2.2-rc.1 桌面版，`resources/app.asar` 内 `@deepseek-ai` 包）：

- DSH **没有**一个用户可配置、Host 可读的「时区设置字段」；其设置体系是
  `ctx.remote.settings` + 每个插件 entry 的 Config 表单（`@deepseek-ai/dsh-settings`、
  `dsh-client-ui-settings*`），时区只出现在「定时任务」的时间选择器里
  （`timing.zone`，按任务选 IANA 区，不落到全局设置）。
- DSH 客户端在运行时用
  `new Intl.DateTimeFormat().resolvedOptions().timeZone` 取得浏览器 IANA 区
  （包内 `resolvedClientTimeZone()`，`dsh-llm` 客户端 time-zone 模块），随请求上下文
  上报给 Host；这就是运行时上下文里 “Browser time zone for this request” 的来源。
- 插件 Host 半拿不到渲染进程的该值。因此本功能的取值链为：
  1. `global.schedule.timezone` 手动覆盖（设置页可填）；
  2. `global.clientTimeZone` —— **Mate 客户端**在每次 `state` 轮询里上报自己用
     `Intl.DateTimeFormat().resolvedOptions().timeZone` 解析到的浏览器区（与 DSH 同源）；
  3. Host 进程 `Intl.DateTimeFormat().resolvedOptions().timeZone`；
  4. 以上都失败时 `'UTC'`。
  实际使用来源以 `TimeZoneSource = 'manual' | 'client' | 'host'` 记录，并由
  `SettingsView.timezone` 暴露给设置页展示（满足「记录实际使用的来源便于排查」）。

### 配置 / 状态落盘位置

| 数据 | 位置 |
| --- | --- |
| 禁用时段、节假日、手动时区 | `mate.json` → global → `schedule` |
| 客户端上报时区 | `mate.json` → global → `clientTimeZone` |
| 排队中的需求 | `mate.json` → requirements 表 → `requirement.queue`（`status = 'queued'`） |

## 2. 数据结构（`src/shared.ts`）

```ts
type WeekdayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
type ScheduleDayKind = 'weekday' | 'weekend' | 'holiday' | WeekdayCode[]
interface DisabledWindow { kind: ScheduleDayKind; start: 'HH:mm'; end: 'HH:mm' } // end < start 跨零点
interface ModelSchedule { provider: string; model: string; disabledWindows: DisabledWindow[] }
interface ScheduleConfig {
  models: ModelSchedule[]
  holidays: string[]          // 'YYYY-MM-DD'，区间/批量在设置页展开成单个日期后落盘
  timezone: string | null     // 手动 IANA 覆盖
}
interface QueueEntryView {
  phase: 'analyze' | 'dispatch'
  reason: 'model-window'
  model: ModelSelection | null
  window?: string             // 例如 'weekday 22:00-06:00'
  enqueuedAt: number
  nextWakeAt: number | null
  timezone: string
  attempts: number
}
```

`RequirementStatus` 新增 `'queued'`；`SettingsView` 新增 `schedule` 与
`timezone: { id, source }`；`StateRequest` 新增 `timeZone?`。

配置示例（设置页保存到 `~/.dsh/storages/mate.json` 的 global.schedule）：

```json
{
  "models": [
    {
      "provider": "deepseek-account",
      "model": "deepseek-flash",
      "disabledWindows": [
        { "kind": "weekday", "start": "08:00", "end": "18:00" },
        { "kind": "weekend", "start": "00:00", "end": "23:59" },
        { "kind": "holiday", "start": "00:00", "end": "23:59" },
        { "kind": ["mon", "wed", "fri"], "start": "22:00", "end": "06:00" }
      ]
    }
  ],
  "holidays": ["2026-10-01", "2026-10-02", "2026-10-03"],
  "timezone": "Asia/Shanghai"
}
```

- `end < start`（如 `22:00-06:00`）表示跨零点；同一模型的多段之间不允许重叠；
- `holidays` 为本地维护的 `YYYY-MM-DD` 列表，空数组合法（没有节假日）；
- `timezone: null` 表示跟随 DSH 客户端上报的时区，取不到时退回 Host 本地时区；
- 整体缺省（`{ "models": [], "holidays": [], "timezone": null }`）即全部模型全天可用。

判定语义（详见 `src/schedule.ts` 的 JSDoc 契约）：

- 未配置 / windows 为空 = 全天可用，不生成任何禁用段；
- `branch` 由「该瞬时的本地日期」决定：节假日 > 周末 > 工作日；
- 节假日分支下只有 `kind: 'holiday'` 的段生效（节假日优先于星期规则）；
- 跨零点按「瞬时本地时间」判定：`22:00-06:00` 在 23:30 与 05:30 都命中；
  即工作日 22:00-06:00 覆盖「周一~周五的 22:00-24:00 与 00:00-06:00」，
  周五午夜之后属于周六，按周末规则判定（见 §5 已知限制）；
- 闸门判定用调用方注入的 `now`，纯函数内部绝不读系统时钟。

## 3. 闸门与队列（Host）

- 闸门位置见 §1 的 (1)(2)。判定结果：
  - 可用 → 照旧调用模型 / 派发；
  - 不可用 → **不发起任何模型调用**，把需求置为 `status='queued'`、写入
    `queue = { phase, reason:'model-window', model, window, enqueuedAt, nextWakeAt, timezone, attempts }`，
    并 `log('[dsh-mate] …')` 记录阻塞原因与下次唤醒时间；
  - 禁止「越窗回退」：不得因为当前路由被禁就换另一条模型路由继续。
- `nextWakeAt` 取该路由下一次可用时刻（`isModelAvailable().nextAvailableAt`）。
- 队列 = `status === 'queued'` 的需求，FIFO 按 `queue.enqueuedAt`（同刻按 `number`）。
  数据已在 storage domain 中持久化，Host 重启后 `MateStore.queuedRequirements()`
  直接恢复顺序。
- 唤醒：`src/scheduler.ts` 的 `MateQueue` 在最早 `nextWakeAt` 处 arm 一个定时器（长于
  24h 时按 24h 上限分段重 arm，`nextWakeAt === null` 时按 5 分钟重试；队列为空时不 arm
  任何定时器）；到点后按 FIFO 逐条重新判定：可用则出队继续分析/派发，仍不可用则更新
  `nextWakeAt` 并重新等待。设置页改了时段配置后立刻重算全部排队需求（不依赖旧的唤醒
  时间），因此新配置把时段改早也会立即恢复。
- 在途会话不受影响：闸门只作用于「发起模型调用前」；`status='running'` 的需求和
  会话在时段结束后不会被取消或打断。
- 本次**不改** `resolveDispatchModel()` 的「允许清单映射」语义（那是 Mate 的白名单，
  不是时段）；闸门在映射之后判定最终路由。

## 4. 设置页

`SettingsDialog` 增加三块：

1. **生效时区**：显示 `settings.timezone.id` 与来源（手动 / DSH 客户端 / Host 本地），
   可填手动覆盖（IANA，留空跟随客户端）。
2. **模型可用时段**：按模型（`settings.modelCatalog`）分组列出禁用时段；每段可选
   工作日 / 周末 / 节假日 / 具体星期 + 起止 `HH:mm`，可增删；空配置显示「全天可用」。
3. **节假日**：单个日期、日期区间、按年份批量录入（`MM-DD` 列表）/按年份删除；保存后
   展开为 `YYYY-MM-DD` 列表。

保存前用 `validateScheduleConfig` 做客户端校验，非法项内联提示且阻止保存（Host 端
`settings.update` 仍以同一函数校验为权威，错误码 `schedule-invalid`）。

## 5. 已知限制 / 决策

- 跨零点窗口按「瞬时日期」判定，不按「起始日」延续到次日：工作日 22:00-06:00 不会
  覆盖周六凌晨；需要覆盖时给周末再配一段。这是为了保持判定可解释、可测。
- 时段只影响「分析」与「派活」两个动作；在途会话、结束后的汇总调用不设闸门。
- 队列的「原始输入 / 目标项目 / 创建时间」直接复用 `RequirementView` 既有字段
  （`brief`、`projectPath`、`createdAt`），队列条目额外记录阻塞原因与下次唤醒时间，
  不复制一份需求数据。
- 派发在没有任何显式模型时，会显式选中 `mate.dispatchModel ?? mate.model` 这条默认
  路由（而不是把 `null` 留给会话默认）——否则闸门无法保证「判定的路由就是实际使用的
  路由」。
- 队列为空时不 arm 定时器；只有存在 `nextWakeAt` 未知的排队项时才按 5 分钟重试。
- 不接外部节假日数据源，纯本地维护（按需求要求）。
- 「是否在禁用时段」以 Host 计算为准；客户端只用同一纯函数做展示与预校验。
