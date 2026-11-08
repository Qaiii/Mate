# 模型可用时段调度与排队派发 — 接入点、内置节假日数据与设计契约

本文件是「模型可用时段调度」的实现契约与勘察记录：调用链、数据结构、内置中国法定
节假日 + 调休（上班日）数据、闸门与队列（含队列上限与重启恢复）、设置页行为、已知
限制。人工验收回归步骤单独见 [scheduling-regression.md](scheduling-regression.md)。

所有仓库路径相对仓库根（`D:\CodeProject\Deepseek-Harness-Plugins\Mate`）。

- 本文件只描述最终实现，不再保留早期「建议/待定」标记；实现与本文不一致时以
  `src/*.ts` 为准，并应同步更新本文。
- 代码锚点以**导出名 / 函数名**为准；行号改动后会整体漂移，仅在必要时给出近似行。

## 0. 目录范围与约束

- 本仓库是 **DSH 插件**（`dsh-mate`），没有 `apps/web`，也没有独立主进程/渲染进程之
  分：Host 半（`src/*.ts`）与 Web 半（`src/client/*.tsx`）同在一个包内，由 `tsdown`
  分别打成 `lib/index.mjs` 与 `lib/client.js`。本次改动落在 `src/`（Host + 客户端）、
  `src/*.test.ts`（测试）与 `docs/`。
- 调度内核（时段判定、节假日日历、队列、唤醒定时器）**必须落在 Host 半**：模型调用、
  派发、持久化都在 Host。客户端只负责配置编辑与展示。
- 纯模块（不 import `node:*`、不读系统时钟、无 I/O）：
  - `src/schedule.ts`：配置校验、单个路由的可用性判定、可用性列表 helper；
  - `src/holidays.ts`：内置节假日/调休数据 + `resolveHolidayCalendar()` 折叠逻辑。
  Host 与浏览器半共用同一份校验与判定，因此「设置页显示的状态」与「Host 闸门的判定」
  不会分叉。
- 节假日数据**编译进插件**（`BUILTIN_HOLIDAY_DATA`），运行时**不访问外部数据源、不联
  网**；新年份的国务院通知发布后，更新源码数据 + 测试并随插件版本发布（见 §3.2）。

## 1. 接入点清单

### (1) 接收需求并调用模型做需求分析的入口

- `src/app.ts` `MateApp.createRequirement()`（创建需求，先做队列上限检查，见 §4.3）。
- `src/app.ts` `MateApp.scheduleAnalysis()` / `MateApp.runAnalysis(id)`。
- `src/app.ts` `MateApp.analyzeRequirement()` / `answerRequirement()`（重新分析/继续澄清）
  同样走 `scheduleAnalysis`。
- **时间闸门插入点**：`runAnalysis(id)` 内、`this.deps.analyzer.analyze(...)` 调用之前。
  `analyzer.analyze` 使用 `mate.model` 这一条模型路由。
- 模型调用点：`src/analyzer.ts` `MateAnalyzer.callText()`（`this.llm.stream`）。

### (2) 派发 / 建会话入口

- `src/app.ts` `MateApp.scheduleDispatch()` / `runDispatch(id)`。
- 派发模型选择：`requirement.sessionOverrides ?? requirement.analysis?.sessionModel
  ?? mate.dispatchModel ?? mate.model` → 若 Mate 配了 `dispatchModels` 允许清单，再经
  `resolveDispatchModel()` 映射到清单内的一条。**闸门判定的是这次真正要用的那一条
  路由**；为了让「判定的路由 == 实际使用的路由」，派发时会把这条解析出的路由显式交给
  `dispatcher.dispatch`（此前无指定时会交 `null` 用会话默认模型）。
- 建会话/发指令在 `src/dispatch.ts` `Dispatcher.dispatch()` → `createSession` /
  `controller.prompt`。
- **时间闸门插入点**：`runDispatch(id)` 内、`this.dispatcher.dispatch(...)` 之前；同处
  解析出的 `model` 即被判定路由。派发分支的重新判定还用于排队需求被唤醒后的
  `processQueued()`。

### (3) 模型 / provider 注册与可用模型白名单来源

- `src/app.ts` `MateApp.refreshModelCatalog()` 调用 `sessionController.modelCatalog()`，
  结果缓存在 `cachedCatalog`（`SettingsView.modelCatalog`：
  `{ provider, name, models: [{ id, name }] }[]`）。这是设置页里「按模型配置」的候选
  列表，也是面板「当前无可用模型」横幅的判定输入（`settings.modelCatalog` 的全部
  路由）。
- 单条路由的思考强度：`src/index.ts` `makeReasoningReader()` → `ctx.llm.resolveModelInfo`，
  经 `model.efforts` 命令暴露（与本需求无关，只说明模型路由形态）。
- 分析模型：`MateView.model`（每条 Mate 固定一条路由）。
- 派发模型：`RequirementView.sessionOverrides` / `AnalysisView.sessionModel` /
  `MateView.dispatchModels` 允许清单。
- 结论：本功能不做「模型目录过滤」，而是在**动作发生前**判定「这次要用的那条路由是否
  处在禁用时段」；被禁则排队等待，**不切换/降级到其它模型**。

### (4) 设置页所在目录与配置落盘

- 设置弹窗：`src/client/dialogs.tsx` `SettingsDialog`；由 `src/client/panel.tsx` 打开，
  `onSubmit` 走 `settings.update` 命令。
- 文案：`src/client/locales.ts`（`ZH` / `EN` 两张表，key 一一对应）。
- 命令分发：`src/app.ts` `MateApp.execute()` → `updateSettings()`。
- 持久化：`src/domain.ts` 的 storage domain `mate`，落在 `~/.dsh/storages/mate.json`
  （一个 unit 文件）。全局单例 `GlobalSchema`；需求表 `requirements`。
  新增字段：`global.schedule`（时段 + 节假日/调休 + 内置开关 + 手动时区）、
  `global.clientTimeZone`、`requirement.queue`。其中 `workdays` 缺省 `[]`、
  `useBuiltinHolidays` 缺省 `true`，domain `version` 保持 1（旧 `mate.json` 可直接读）。

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

### (6) 内置节假日数据的接入点

- 数据与折叠：`src/holidays.ts`（`BUILTIN_HOLIDAY_DATA`、`BUILTIN_HOLIDAY_YEARS`、
  `resolveHolidayCalendar()`、`HolidayCalendar`）。
- Host 闸门：`src/app.ts` `MateApp.evaluateRoute()` —— 用当前生效时区与本地年份调用
  `resolveHolidayCalendar(settings.schedule, { data, year })`，把 `holidays` /
  `workdays` 两个集合交给 `evaluateModelRoute()` → `isModelAvailable()` 判定。
  - `data` 默认取内置数据；`AppDeps.holidayData?: HolidayDataBundle | null` 是测试/集
    成注入点：`undefined` 用内置数据，`null` 模拟「数据不可用」，用于覆盖降级路径。
  - `calendar.degraded === true` 时 Host 记一条降级日志（见 §3.4）：当前年份未被数据
    覆盖时形如 `[dsh-mate] holidays: no built-in holiday data for 2025; falling back to
    weekend-only rules`，数据不可用时形如
    `[dsh-mate] holidays: holiday data unavailable; falling back to weekend-only rules`。
    同一数据缺口（同一组缺失年份，或「数据不可用」）只记一次，避免每次闸门判定刷屏。
  - 降级诊断在启动（`resume()`）和每次保存配置（`updateSettings`）时也会刷新一次，因此
    即使队列为空、当天没有闸门判定，也能在日志里看到数据缺口。
- 客户端：设置页的节假日/调休编辑器、模型可用状态预览、面板「无可用模型」横幅都调用
  同一 `resolveHolidayCalendar()` 与 `src/schedule.ts` 的纯 helper，不复制判定逻辑。

### 配置 / 状态落盘位置

| 数据 | 位置 |
| --- | --- |
| 禁用时段、手动节假日、调休上班日、内置开关、手动时区 | `mate.json` → global → `schedule` |
| 客户端上报时区 | `mate.json` → global → `clientTimeZone` |
| 排队中的需求 | `mate.json` → requirements 表 → `requirement.queue`（`status = 'queued'`） |

## 2. 数据结构

`src/shared.ts`：

```ts
type WeekdayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
type ScheduleDayKind = 'weekday' | 'weekend' | 'holiday' | WeekdayCode[]
interface DisabledWindow { kind: ScheduleDayKind; start: 'HH:mm'; end: 'HH:mm' } // end < start 跨零点
interface ModelSchedule { provider: string; model: string; disabledWindows: DisabledWindow[] }
interface ScheduleConfig {
  models: ModelSchedule[]
  holidays: string[]           // 手动节假日，'YYYY-MM-DD'；可覆盖内置调休上班日
  workdays: string[]           // 手动调休上班日，'YYYY-MM-DD'；可覆盖内置/手动节假日
  useBuiltinHolidays: boolean  // 是否应用内置中国法定节假日 + 调休数据，默认 true
  timezone: string | null      // 手动 IANA 覆盖
}
```

`src/schedule.ts` 新增的可用性 helper：

```ts
interface ModelRoute { provider: string; model: string }
interface ModelAvailability extends ModelRoute, AvailabilityResult {}

// 同一瞬时批量判定若干路由；holidays/workdays 缺省时取 schedule 的手动列表。
function modelAvailabilityAt(input: {
  nowMs: number
  schedule: ScheduleConfig | null | undefined
  routes: readonly ModelRoute[]
  timezone: string
  holidays?: ReadonlySet<string> | readonly string[]
  workdays?: ReadonlySet<string> | readonly string[]
}): ModelAvailability[]

// 上述结果中 available 的路由（保持输入顺序）。
function availableModelRoutes(input: ModelAvailabilityInput): ModelRoute[]
```

`isModelAvailable()` 新增可选第 5 个参数 `workdays`
（`ReadonlySet<string> | readonly string[]`）；`evaluateModelRoute()` 的入参新增可选
`workdays`；不传时取 `schedule.workdays` 的手动列表。这两个判定入口 + 批量 helper 用于
「当前哪些模型可用 / 最早何时可用」的展示与预热，不改变闸门语义。

`src/holidays.ts`：

```ts
interface HolidayYearData { holidays: string[]; workdays: string[] }
interface HolidayDataBundle {
  years: Record<string, HolidayYearData>   // '2024' → { holidays, workdays }
  source: string                           // 例如 'builtin-cn'
  updatedAt?: string                       // 数据修订标记（诊断用）
}
const BUILTIN_HOLIDAY_YEARS: readonly number[] = [2024, 2025, 2026]

interface HolidayCalendar {
  holidays: ReadonlySet<string>            // 生效节假日（内置 + 手动覆盖）
  workdays: ReadonlySet<string>            // 生效调休上班日（内置 + 手动覆盖）
  coveredYears: ReadonlySet<number>        // 内置数据覆盖的年份（关掉内置开关时为空）
  missingYears: readonly number[]          // 请求判定但未被数据覆盖的年份
  degraded: boolean                        // 内置数据不可用或未覆盖当前年份 → 仅周末规则
  source: string                           // 'builtin-cn' / 'none' / 注入来源
}
function resolveHolidayCalendar(
  config?: ScheduleConfig | null,
  options?: { data?: HolidayDataBundle | null; year?: number },
): HolidayCalendar
```

`src/shared.ts` 的队列上限：

```ts
/** 排队等待模型可用时段的需求上限（FIFO）。超过后新建需求被拒绝，错误码 queue-full。 */
const MAX_QUEUE_LENGTH = 50
```

`src/shared.ts` 的排队条目（与实现一致，供客户端展示）：

```ts
interface QueueEntryView {
  phase: 'analyze' | 'dispatch'
  reason: string                 // 目前恒为 'model-window'
  model: ModelSelection | null
  window?: string                // 例如 'weekday 22:00-06:00'
  enqueuedAt: number
  nextWakeAt: number | null      // 预计开始时间；null 表示暂时算不出
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
        { "kind": "weekday", "start": "09:00", "end": "00:30" },
        { "kind": "weekend", "start": "00:00", "end": "23:59" },
        { "kind": "holiday", "start": "00:00", "end": "23:59" },
        { "kind": ["mon", "wed", "fri"], "start": "22:00", "end": "06:00" }
      ]
    }
  ],
  "holidays": ["2026-10-01", "2026-10-02", "2026-10-03"],
  "workdays": ["2026-10-10"],
  "useBuiltinHolidays": true,
  "timezone": "Asia/Shanghai"
}
```

整体缺省（`emptySchedule()`）为
`{ "models": [], "holidays": [], "workdays": [], "useBuiltinHolidays": true, "timezone": null }`，
即全部模型全天可用、内置节假日数据生效、时区跟随客户端。

校验规则（`validateScheduleConfig()`，Host 与客户端共用；`settings.update` 是权威校
验，错误码 `schedule-invalid`，明细含 `code/path/message`）：

- `provider` / `model` 去空白后非空；同一 `provider+model` 不得重复（`duplicate-model`）；
- `start` / `end` 必须匹配 `^([01]\d|2[0-3]):[0-5]\d$`（`time-format`）；
  `start === end` 为零长度时段，拒绝（`zero-length`）；
- `kind` 为 `'weekday' | 'weekend' | 'holiday'` 或非空星期数组（`kind` / `weekday`），
  数组去重并按 ISO 顺序规范化；
- 同一模型的多段时段，若生效日集合有交集则墙钟时间不得重叠（`overlap`）；
  `'holiday'` 段自成一族（节假日分支优先，不与工作日/周末段冲突）；
- `holidays` / `workdays` 每项须为真实 `YYYY-MM-DD`（`holiday-format` /
  `workday-format`），去重并排序；
- `useBuiltinHolidays` 必须是 boolean；缺省视为 `true`（`holiday-toggle`）；
- `timezone` 为 `null` 或 `Intl` 接受的 IANA 区（`timezone`）。

判定语义（详见 `src/schedule.ts` 的 JSDoc 契约）：

- 未配置 / windows 为空 = 全天可用，不生成任何禁用段；
- **日分支**由该瞬时的本地日期决定，优先级：
  调休上班日（`workdays` 命中）> 节假日（`holidays` 命中）> 周末 > 工作日。
  即默认启用内置数据时，`2025-10-11`（调休周六）按**工作日**判定，`2025-10-01` 按
  **节假日**判定；
- 节假日分支下只应用 `kind: 'holiday'` 的段；工作日分支下应用 `'weekday'` 段与显式
  星期数组段；周末分支下应用 `'weekend'` 段与显式星期数组段；
- 跨零点按「瞬时本地时间」判定：`22:00-06:00` 在 23:30 与 05:30 都命中；
  即工作日 22:00-06:00 覆盖「周一~周五的 22:00-24:00 与 00:00-06:00」，
  周五午夜之后属于周六，按周末规则判定（见 §6 已知限制）；
- 闸门判定用调用方注入的 `now`；`nowMs` 在纯函数里绝不读系统时钟；
- `nextAvailableAt`：从 `now` 之后的下一个整分钟起向前扫描（上限 12 天，覆盖最长的
  9 天春节假期）到第一个可用瞬时；整天每一分钟都被禁用的本地日会整日跳过（只验证一次
  日边界），因此长假日不会退化成逐分钟空转。配置「永远禁用」或 12 天内找不到可用时刻
  时返回 `null`（Host 按 5 分钟重试）。

## 3. 内置节假日数据（中国法定节假日 + 调休）

### 3.1 覆盖范围与官方来源

内置数据覆盖 **2024 / 2025 / 2026** 三个年份，均取自国务院办公厅的官方通知：

| 年份 | 通知文号 | 官方链接 |
| --- | --- | --- |
| 2024 | 国办发明电〔2023〕7号 | <https://www.gov.cn/gongbao/2023/issue_10806/202311/content_6913823.html> |
| 2025 | 国办发明电〔2024〕12号 | <https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html> |
| 2026 | 国办发明电〔2025〕7号 | <https://www.gov.cn/zhengce/content/202511/content_7047090.htm> |

各年数据（`holidays` = 通知里的放假调休区间，含区间内的周末日；`workdays` = 通知里的
调休上班日）：

| 年份 | `holidays` 区间 | `workdays` 调休上班日 |
| --- | --- | --- |
| 2024 | 元旦 1/1；春节 2/10–2/17；清明 4/4–4/6；劳动 5/1–5/5；端午 6/10；中秋 9/15–9/17；国庆 10/1–10/7 | 2/4、2/18、4/7、4/28、5/11、9/14、9/29、10/12 |
| 2025 | 元旦 1/1；春节 1/28–2/4；清明 4/4–4/6；劳动 5/1–5/5；端午 5/31–6/2；国庆节、中秋节 10/1–10/8 | 1/26、2/8、4/27、9/28、10/11 |
| 2026 | 元旦 1/1–1/3；春节 2/15–2/23；清明 4/4–4/6；劳动 5/1–5/5；端午 6/19–6/21；中秋 9/25–9/27；国庆 10/1–10/7 | 1/4、2/14、2/28、5/9、9/20、10/10 |

代表性校验点（自动化用例覆盖，见 `src/holidays.test.ts` / `src/schedule.test.ts`）：

- `2025-10-01` 是节假日，按节假日分支判定（`'holiday'` 段生效，周末段不生效）；
- `2025-10-11` 是调休周六，按**工作日**判定（工作日/显式含 `sat` 的段生效，周末段不
  生效）；
- `2025-09-28` 是调休周日，同样按工作日判定；
- `2026-02-23` 在春节假期内，`2026-02-14`（调休周六）是工作日。

### 3.2 数据形态与更新路径

- 数据是纯常量 `BUILTIN_HOLIDAY_DATA`（`src/holidays.ts`），随插件打包；运行时**不联
  网、不读文件、不依赖 DSH 服务**，因此 Host/浏览器两端判定完全一致。
- 新年份通知发布后的更新步骤：
  1. 按官方通知把该年 `holidays` / `workdays` 加入 `BUILTIN_HOLIDAY_DATA.years`；
  2. 同步 `BUILTIN_HOLIDAY_YEARS` 与 `updatedAt`；
  3. 在 `src/holidays.test.ts` 增加该年代表性日期用例（至少一个节假日、一个调休上班
     日），跑 `pnpm typecheck` 与 `pnpm exec vitest run --pool=threads`；
  4. 随插件版本发布（用户升级插件即可获得新数据，无需改配置）。
- 不想升级插件、或官方临时调整某个日期时，用设置页的手动覆盖（`holidays` /
  `workdays`）即可，优先级见 §3.3。
- `defaultHolidayData()` 返回内置 bundle；`AppDeps.holidayData` 可注入替换 bundle
  （测试用；生产默认 `undefined` = 内置数据）。

### 3.3 手动覆盖优先级

`resolveHolidayCalendar()` 的折叠顺序（后者覆盖前者）：

```
内置数据（useBuiltinHolidays=true 时） < 手动 holidays < 手动 workdays
```

具体后果：

- 手动 `holidays` 里的一天会从内置/手动的调休上班日集合中移除 → 该日按节假日判定；
- 手动 `workdays` 里的一天会从节假日集合中移除 → 该日按工作日判定（即使它是周六/周
  日，或落在内置节假日区间内）；
- 同一天同时出现在手动 `holidays` 与 `workdays` 时，`workdays` 胜出（优先级更高）；
- `useBuiltinHolidays=false` 时内置数据完全不参与，**只剩**手动 `holidays` /
  `workdays` 与普通周末/工作日规则；此时即使用户没有填任何日期也不会产生降级日志
  （关掉内置数据是明确的用户选择）。

### 3.4 降级行为（数据不可用 / 年份未覆盖）

- 触发条件：
  1. 内置数据不可用（例如注入的 bundle 为 `null`，或数据对象损坏导致读取异常）；
  2. 当前判定的**本地年份**不在 `coveredYears` 内（例如 2027 年运行尚未更新数据的插
     件版本）。
- 行为：`HolidayCalendar.degraded === true`；当前年份的内置判定退化为**普通周末/工作日
  规则 + 手动覆盖项**（数据缺口年份不再有内置节假日/调休规则；其它已覆盖年份的日期
  仍在集合里，但不影响当前日期的判定）。数据读取异常时集合直接清空，同样走周末规则。
  **不抛错、不阻塞闸门、不拒绝需求**——只是缺了法定节假日与调休的额外分支。
- 诊断：Host 在闸门判定、启动恢复（`resume()`）与保存配置时记降级日志，两种具体文案：
  - 当前年份未被数据覆盖：
    `[dsh-mate] holidays: no built-in holiday data for <year[, year…]>; falling back to weekend-only rules`；
  - 数据不可用（注入 `null` / 读取异常）：
    `[dsh-mate] holidays: holiday data unavailable; falling back to weekend-only rules`。

  同一数据缺口（同一组缺失年份，或「不可用」）只记一次，避免每次判定刷屏。
- 手动 `holidays` / `workdays` 在降级时仍然生效，因此用户可以先用设置页补齐当年日期
  作为过渡。

## 4. 闸门与队列（Host）

### 4.1 闸门行为

- 闸门位置见 §1 的 (1)(2)。判定结果：
  - 可用 → 照旧调用模型 / 派发；
  - 不可用 → **不发起任何模型调用**，把需求置为 `status='queued'`、写入
    `queue = { phase, reason:'model-window', model, window, enqueuedAt, nextWakeAt,
    timezone, attempts }`，并 `log('[dsh-mate] …')` 记录阻塞原因与下次唤醒时间；
  - 禁止「越窗回退」：不得因为当前路由被禁就换另一条模型路由继续。
- `nextWakeAt` 取该路由下一次可用时刻（`isModelAvailable().nextAvailableAt`）。
- 闸门只作用于「发起模型调用前」；`status='running'` 的已派发会话与结束后的汇总调用
  不受影响（见 §6）。
- 本次**不改** `resolveDispatchModel()` 的「允许清单映射」语义（那是 Mate 的白名单，
  不是时段）；闸门在映射之后判定最终路由。

### 4.2 FIFO 顺序、唤醒与重启恢复

- 队列 = `status === 'queued'` 的需求，按 `queue.enqueuedAt` 升序、同刻按 `number`。
- 持久化：队列条目就在需求记录里（`requirement.queue`），与需求一起落在
  `mate.json`，因此 Host 重启不丢。
- 唤醒：`src/scheduler.ts` 的 `MateQueue` 在最早 `nextWakeAt` 处 arm 一个定时器（长于
  24h 时按 24h 上限分段重 arm；`nextWakeAt === null` 时按 5 分钟重试；队列为空时不 arm
  任何定时器）；到点后按 FIFO 逐条重新判定：可用则出队继续分析/派发，仍不可用则更新
  `nextWakeAt` 并重新等待。
- 重启恢复：`src/index.ts` 的 `apply()` 在 `MateApp.markStarted()` 之后调用
  `MateApp.resume()`：重新读取持久化的 FIFO 队列并**逐条重新判定**（不等已存的唤醒时
  间）。判定为可用 → 立即出队继续分析/派发；仍被阻塞 → **不信任可能过期的已存
  `nextWakeAt`**，而是按当前持久化配置重新计算预计开始时间并 arm 定时器（因此 Host 停机
  期间改过配置也能在启动时纠正 ETA）。`enqueuedAt` 保留；仍被阻塞的条目 `attempts` +1
  （启动重判算一次尝试），日志记为 `still in model window (attempt N)`。
- 设置页改了时段配置（`settings.update` 含 `schedule`）后立即
  `MateApp.reevaluateQueue()` 重算全部排队需求（不依赖旧的唤醒时间），因此新配置把
  时段改早也会立即恢复。客户端上报的生效时区变化（`state` 轮询里的 `timeZone`）同样会
  触发一次重算，避免队列保留旧时区算出的 ETA。
- 在途会话不受影响：`status='running'` 的需求在队列处理中会被跳过。
- 队列状态不变量：需求离开 `queued`（取消 / 重派 / 失败 / 完成 / 重新分析）时
  `queue` 置空；因此只有 `status === 'queued'` 的卡片会渲染「排队等待」徽标，取消或
  失败的卡片不会残留排队信息。

### 4.3 队列上限与拒绝（`queue-full`）

- 上限：`MAX_QUEUE_LENGTH = 50`（`src/shared.ts`），即同时处于 `status='queued'` 的
  需求最多 50 条。
- 检查点：`MateApp.createRequirement()` 在创建新需求前统计当前排队条数；达到上限时抛
  `CommandError('queue-full', …)`，**不创建需求、不占需求编号、不入队**。因此从 UI 提交
  时命令失败，需求不会出现在看板上。
- 客户端文案：`src/client/controller.ts` 把 `error.code === 'queue-full'` 映射为本地化
  提示，中文：`排队队列已满（上限 50 条），请等已排队需求开始后再提交`；其它错误码继续
  走通用错误展示。
- 上限只约束「新建需求」入口（`requirement.create`）：已在队列中的需求不会被上限驱逐，
  也不会因为上限而丢弃；排队项出队后名额自然释放。取消排队需求会清空其 `queue` 并释放
  名额。拆分/新增子需求等直接入库的路径不经过该上限检查（见 §6）。

## 5. 设置页与看板展示

### 5.1 设置弹窗（`SettingsDialog`）

设置页增加四块：

1. **生效时区**：显示 `settings.timezone.id` 与来源（手动 / DSH 客户端 / Host 本地），
   可填手动覆盖（IANA，留空跟随客户端）。
2. **模型可用时段**：按模型（`settings.modelCatalog`）分组列出禁用时段；每段可选
   工作日 / 周末 / 节假日 / 具体星期 + 起止 `HH:mm`，可增删；空配置显示「全天可用」；
   每个模型旁有实时可用状态徽标（「当前可用」/「当前禁用」，禁用时显示下次可用时间）。
3. **内置节假日开关**：`启用内置中国法定节假日（含调休）`，绑定
   `useBuiltinHolidays`；关闭后只用下方手动列表。
4. **节假日与调休上班日编辑器**：
   - 节假日：单个日期、日期区间、按年份批量录入（`MM-DD` 列表）/按年份删除；保存后
     展开为 `YYYY-MM-DD` 列表。
   - 调休上班日：同样的录入/展示/删除交互（单日、按年批量、按年分组、逐日删除、按年
     删除），对应 `workdays`。
   - 两组校验错误分别内联展示（错误码 `holiday-format` / `workday-format`）。

保存前用 `validateScheduleConfig` 做客户端校验，非法项内联提示且阻止保存（Host 端
`settings.update` 仍以同一函数校验为权威，错误码 `schedule-invalid`）。保存成功后若
`schedule` 有变化，Host 立即重算排队需求。

### 5.2 排队卡片与预计开始时间

- 排队中的需求在列表/看板卡片上显示徽标，形如
  `排队等待 · 预计 HH:mm 开始`（`HH:mm` 为 `queue.nextWakeAt` 换算到**生效时区**的本地
  时钟；只显示时刻，不显示日期——需要绝对日期时看 Host 的
  `gate: … until <ISO 时间>; queued` 日志）。
- 仅 `status === 'queued'` 的需求显示该徽标；历史遗留的 `queue` 字段不会让取消/失败
  的卡片继续显示排队状态。
- 若时刻格式化失败，`nextWakeAt` 缺失/无效时退化为「等待模型时段」；`HH:mm` 算不出来
  时退化为「等待模型时段 · <倒计时>后恢复」（时区不可用会先用浏览器本地时钟兜底，因此
  正常不会走到这个分支）。
- 悬浮/抽屉详情（`queueDetail`）显示：阶段（分析/派发）、触发时段的摘要（如
  `weekday 09:00-00:30`）、下次唤醒倒计时、判定时区、已重试次数。

### 5.3 「当前无可用模型」横幅

- 判定：客户端用 `settings.modelCatalog` 的全部去重路由 + `settings.timezone.id` +
  `resolveHolidayCalendar(settings.schedule)` 生成的有效节假日/调休集合 +
  `snapshot.serverTime`（Host 时钟，避免浏览器时区/时钟漂移）调
  `modelAvailabilityAt()`；当**目录非空且可用路由数为 0**时，面板顶部显示横幅。
- 文案：
  - 队列里已有排队需求：`当前无可用模型，已排队`（`earliestStart` 已知时追加一行
    `预计 MM/DD HH:mm 开始`）；
  - 队列为空：`当前无可用模型，新需求将排队等待`。
- 该横幅只做提示，不改变提交行为：此时提交需求仍会创建成功并进入 `queued`（除非队列
  已满，见 §4.3）。

## 6. 已知限制 / 决策

- 跨零点窗口按「瞬时日期」判定，不按「起始日」延续到次日：工作日 22:00-06:00 不会
  覆盖周六凌晨；需要覆盖时给周末再配一段。这是为了保持判定可解释、可测。
- 时段只影响「分析」与「派活」两个动作；在途会话、结束后的汇总调用不设闸门。
- 内置节假日数据只覆盖 **2024–2026**：当前年份未被数据覆盖或数据不可用时，自动退化
  为「仅周末规则」并记日志（§3.4），不会报错；用户可用手动列表补齐。
- 数据随插件发布，**不做运行时联网更新**；官方临时调整/新增年份需更新插件版本，或
  用设置页手动覆盖。
- 内置节假日是「中国日历日期」：匹配用的是生效时区的本地日期键（`YYYY-MM-DD`），不
  会按其它时区平移假期；若把生效时区设为中国以外，判定仍按这些日期键生效，但「当地
  的今天」可能与中国日期不同。
- 队列上限 50（`MAX_QUEUE_LENGTH`）：满后新建需求被拒绝（`queue-full`），已在队列中
  的需求不受影响，也不会被驱逐；上限只在 `requirement.create`（新建需求）入口检查，
  拆分/新增子需求直接入库，不经过该上限检查。
- 队列的「原始输入 / 目标项目 / 创建时间」直接复用 `RequirementView` 既有字段
  （`brief`、`projectPath`、`createdAt`），队列条目额外记录阻塞原因与下次唤醒时间，
  不复制一份需求数据。
- 派发在没有任何显式模型时，会显式选中 `mate.dispatchModel ?? mate.model` 这条默认
  路由（而不是把 `null` 留给会话默认）——否则闸门无法保证「判定的路由就是实际使用的
  路由」。
- 队列为空时不 arm 定时器；只有存在 `nextWakeAt` 未知的排队项时才按 5 分钟重试。
- `nextAvailableAt` 最多向前扫描 12 天（覆盖最长的 9 天春节假期）；整天被禁用的本地日
  整日跳过，因此「全时段禁用」不会因为逐分钟扫描而明显变慢。若配置把 12 天内的每一分钟
  都禁用，`nextWakeAt` 会为 `null`，Host 按 5 分钟重试（不会卡死，但预计开始时间显示为
  未知）。
- 「是否在禁用时段」以 Host 计算为准；客户端只用同一纯函数做展示与预校验。
  「无可用模型」横幅基于最近一次快照里的 `serverTime` 与生效时区计算，可能比 Host 实时
  判定晚一个轮询周期（默认 2.5s），不影响实际闸门。

## 7. 人工验收回归

完整的手工验收步骤（从零配置到排队、重启恢复、跨窗口自动继续、节假日/调休判定、队列
上限拒绝、全模型禁用横幅）见 **[scheduling-regression.md](scheduling-regression.md)**。
自动化回归入口：

```powershell
pnpm typecheck
pnpm exec vitest run --pool=threads
```

其中与本文直接对应的测试文件与用例：

| 文件 | 覆盖 |
| --- | --- |
| `src/holidays.test.ts` | 内置数据完整/覆盖 2024–2026、官方 2025/2026 日期、折叠顺序（手动 > 内置）、降级与年份缺失 |
| `src/schedule.test.ts` | 校验、日分支（含调休上班日）、跨零点、`nextAvailableAt` 12 天上限（含 2026 春节 9 天假期 ETA）、`modelAvailabilityAt` / `availableModelRoutes`；含 `judges 2025 National Day as a holiday branch`、`judges the 2025-10-11 makeup Saturday as a working day`、`acceptance: disabled 09:00-00:30 window` 等 |
| `src/app.gate.test.ts` | 闸门/队列端到端：`queues the requirement and makes zero model calls while the window is closed`、`persists a 09:00-00:30 cross-midnight window and restores the queue with its 00:30 ETA after restart`、`makes zero model calls while every model is disabled, then resumes analysis and dispatch`、`rejects a new requirement once the FIFO queue reaches MAX_QUEUE_LENGTH`、`judges built-in statutory holidays and 调休 workdays, and logs a weekend-only fallback` |
| `src/scheduler.test.ts` | 唤醒定时器（最早 `nextWakeAt`、24h 上限、5 分钟重试、FIFO） |
| `src/client/settings.test.ts`、`src/client/scheduleDraft.test.ts`、`src/client/controller.test.ts` | 设置页（开关/调休编辑器/校验）、排队 ETA 文案、全模型禁用横幅判定、`queue-full` 文案映射 |
