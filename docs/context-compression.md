# 派发前上下文压缩与回退 — 接入点、度量来源与实现契约

本文件是「派发前上下文压缩与回退」的实现契约与勘察记录：调用链、插入点、上下文占用的
数据来源与误差、压缩服务可用性与回退、配置项、日志格式、handoff 摘要、验收对照。
所有仓库路径相对仓库根（`D:\CodeProject\Deepseek-Harness-Plugins\Mate`）。

- 运行时对象：桌面版 DSH **0.2.2-rc.1**（`resources/app.asar`；`dsh/desktop-runtime.json`
  记录 `release.version = 0.2.2-rc.1`），当前 profile 为 `desktop`（`DSH_HOME=C:\Users\qaiii\.dsh`）。
  文中 DSH 包行为均来自解包后的 `node_modules/@deepseek-ai/*` 源码与 README，不是推测。
- 代码行号取自 2026-11-08 的最终工作树；改动后可能整体漂移，**以函数名与代码锚点为准**。
- 本文件只描述最终实现，不再保留早期「建议/待定」标记；实现与本文不一致时以
  `src/*.ts` 为准，并应同步更新本文。

## 0. 需求与术语

行为摘要：

1. 新增 `contextCompression` 设置：`enabled` 默认 `false`，`threshold` 默认 `80`（百分数）。
2. Mate 把需求派发进**复用的空闲会话**时，若功能开启且该会话的上下文占用 ≥ 阈值：
   先尝试压缩该会话；压缩成功 → 继续复用该会话。
3. 压缩不可用/失败/没有可压缩区间 → **新建会话**，并在首条 prompt 最前面加一份
   handoff 摘要（目标项目、当前任务、已完成工作项；有界；无历史时降级为最小摘要）。
4. 决策日志必须带四个可诊断字段：触发原因（reason）、阈值（threshold）、实际占用
   （actual occupancy）、最终策略（strategy）。
5. 功能关闭时，派发行为与改动前完全一致：零测量、零压缩、零决策日志。
   功能开启但占用低于阈值时：只做一次**只读的进程内测量**并记一条 `strategy=none`
   的 decision 日志，不压缩、不新建会话，首条 prompt 与 `buildBrief` 基线逐字节相同。
   开启但不可测（无投影/无窗口）同样保持原复用路径。

**术语与假设（已采用的语义）：**

- 本文的“会话”指 **Mate 即将派发进去复用的、执行实现工作的 DSH 会话**
  （`RequirementView.dispatch.sessionId` 那一类会话），**不是** Mate 插件自身所在的
  Host 进程会话，也不是 Mate 的“需求分析”会话。
- 闸门只覆盖 **复用分支**：`dispatchMode` 为 `auto`/`reuse-idle` 且确实选中了一个已有
  空闲会话（`DispatchOptions.reuseSessionId` 或 `Dispatcher.findReusable`）。
  `dispatchMode === 'new'` 直接创建新会话、不测量、不压缩、**不注入 handoff**
  （handoff 只用于“本来要复用、因压缩回退而新建”的情况）。
- 占用百分比的分子是“下一次请求将携带的 prompt token 估计”，分母是**本次派发目标路由**
  的 context window；两者都取不到时按“不可判定”处理，保持原复用路径。

## 1. 调用链与可插入点

### 1.1 当前派发调用链（file:line）

| 步骤 | 位置 | 说明 |
| --- | --- | --- |
| 1 | `src/app.ts:975` `MateApp.runDispatch(id)` | 派发总入口；校验状态/Mate/项目，解析最终模型路由 |
| 2 | `src/app.ts:992` `requested = …` + `resolveDispatchModel(…)` | 最终路由：`sessionOverrides ?? analysis.sessionModel ?? mate.dispatchModel ?? mate.model`，再过 Mate 允许清单 |
| 3 | `src/app.ts:1006` `reusableSession(wantedReuse, projectPath)` | 复核 Mate 在分析阶段选中的复用会话仍空闲且同项目 |
| 4 | `src/app.ts:1008` `this.dispatcher.dispatch(…)` → `src/dispatch.ts:158` | 真正的建/选会话与 prompt |
| 5 | `src/dispatch.ts:170-181` | 选会话：`requested ?? findReusable(projectPath)`；随后插入上下文守卫 |
| 6 | `src/dispatch.ts:147` `Dispatcher.findReusable` | `controller.list({})` 里找 `cwd === projectPath && !running && title` 以 `Mate · ` 开头的最新会话 |
| 7 | `src/dispatch.ts:226-285` `guardReusedContext` | **本需求核心闸门**：测量 → 决策 → 压缩/回退；见 §2、§3 |
| 8 | `src/dispatch.ts:187-198` `controller.selectModel` | 对最终 session 设定派发模型（复用会话也会被改模型；压缩成功后再改） |
| 9 | `src/dispatch.ts:200-204` `controller.rename` | 标题改为 `Mate · <需求标题>` |
| 10 | `src/dispatch.ts:206-212` `controller.prompt({ mode: 'queue', content: [text] })` | 首条 prompt；回退新会话时文本为 `handoff + '\n\n' + brief`，**每次派发恰好一次** |
| 11 | `src/dispatch.ts:102` `buildBrief(requirement, mate, projectPath, followUp)` | 新会话/复用会话的首条 brief；`followUp` 为复用分支追加“延续上一会话”的一句 |
| 12 | `src/dispatch.ts:294` `Dispatcher.createSession` | 新会话创建（Workspace 挂载 / headless），含既有 warning 回退路径 |
| 13 | `src/app.ts:1081` `measureContext` / `1129 projectionPressure` / `1160 modelWindow` / `1171 compactContext` | Host 侧测量与压缩适配器（通过 `DispatchContextCompression` 注入 Dispatcher） |
| 14 | `src/index.ts:129 apply` → `160` 构造 `MateApp` | Host 服务接线；`178` sessionQuery、`206` tokenMeter+sessions、`248` agents+compaction，均为可选嵌套 inject |

`MateApp` 通过 `AppDeps`（`src/app.ts:66-90` 附近）拿服务；`Dispatcher` 由
`MateApp` 构造函数创建（`src/app.ts:122-135`），第 5 个构造参数是
`DispatchContextCompression`（`src/dispatch.ts:83-87`：`config()` / `measure()` / `compact()`），
让 Dispatcher 的测试可以注入假实现而不触发模型调用。

### 1.2 三个精确插入点

**(a) 复用会话已选定、`controller.prompt` 之前** —— `src/dispatch.ts:170-181`：

```ts
let sessionId: string | null = null
if (mode !== 'new') {
  sessionId = requested ?? (mode === 'reuse-idle' ? await this.findReusable(projectPath) : null)
}
// 复用分支守卫：只有被复用的会话才可能超阈值
let handoffSummary: string | null = null
if (sessionId !== null) {
  handoffSummary = await this.guardReusedContext(sessionId, requirement, overrides, projectPath, warnings)
  if (handoffSummary !== null) sessionId = null   // 压缩不可用 → 改走新会话
}
const reused = sessionId !== null
if (sessionId === null) sessionId = await this.createSession(projectPath, options, warnings)
```

放在 `selectModel`/`rename` **之前**的原因：一旦回退到新会话，`selectModel`/`rename`
必须作用在新会话上；先配置再丢弃会留下被改名/改模型的复用会话。压缩成功后仍按原路径继续
`selectModel → rename → prompt`。

**(b) 新会话首条 prompt 内容组装点** —— `src/dispatch.ts:206-212`：`handoffSummary` 只在
“压缩回退”时非空，拼为 `` `${handoffSummary}\n\n${brief}` `` 作为**单个 text block**、
**首条 prompt 一次**发送；`buildBrief`（`src/dispatch.ts:102`）不感知 handoff，因此正常
复用/新建路径的 brief 内容与改动前一致。

**(c) 配置读取点** —— 只从持久化全局记录读（浏览器参数不可信）：

- `src/store.ts:74` `settings(): MateGlobalRecord`（同步内存读）；
- `src/store.ts:82-84` `contextCompression(): ContextCompressionConfig`，对缺省/坏值容错解析；
- `src/app.ts:768-819` `updateSettings`：`args.contextCompression` 严格校验后写入
  `patch.contextCompression`，返回新的 `SettingsView`；错误码 `context-compression-invalid`；
- `src/store.ts:225-292` `buildSnapshot`：`settings.contextCompression` 进入快照；
- 持久化 schema：`src/domain.ts:31-45`（`MateGlobalRecord.contextCompression?`）、
  `src/domain.ts:74-77`（`ContextCompressionSchema`）、`src/domain.ts:236`（`.optional()`）、
  `src/domain.ts:250-266`（新装默认值）；
- 共享视图类型：`src/shared.ts:87-90`（`ContextCompressionConfig`）、
  `src/shared.ts:312-330`（`SettingsView.contextCompression`）。

domain `version` 保持 1：字段可选，旧 `mate.json` 可直接读，无需迁移。

### 1.3 顺序与幂等约束

- `Dispatcher.dispatch` 是唯一建/选会话并 prompt 的地方；守卫只改 `sessionId` 与 prompt
  文本，**不得**在 guard 内自行 prompt，否则会双发。
- 压缩只在超阈值时尝试一次；失败只回退一次，不重试（压缩本身可能已产生一次摘要模型调用）。
- 回退时只有一个 `context-compression-fallback` dispatch warning，需求记录里可看到原因；
  正常复用/新建路径不产生该 warning。
- `MateApp.scheduleDispatch` 有 `inflight` 去重（`dispatch:<id>`），但不同需求仍可并发派发；
  守卫的测量/压缩允许失败，失败不会把派发本身卡死（最终要么复用、要么新会话）。

## 2. 上下文占用量与窗口上限（最终实现顺序）

`MateApp.measureContext(sessionId, model)`（`src/app.ts:1081`）按以下顺序取样本，
第一个成功即返回；全部失败返回 `null`（决策侧得到 `reason='measurement-unavailable'`）。
窗口在所有路径都遵循同一优先级：**目标路由窗口优先**（§2.4）。

### 2.1 主路径：`sessionController.projections({ sessionId })`

【已核实】DSH api-session-controller 暴露 `projections(request, signal)`，请求体只带
`{ sessionId }`，返回：

```ts
// sessionId 不存在 → null
// 正常 → { kind: 'sequenced', asOfSeq: number, values: { [projectionKey]: value } }
// 持久化格式待迁移 → { kind: 'migration-required', values: <cached hints> }（可能缺键）
```

`values` 是**完整投影**（不带 key 子集 → 所有 client-visible 投影，包括被列表摘要排除的
键）。本实现从 `values.contextPressure` 取值：

```ts
contextPressure: {
  pressureTokens?: number   // 最近一次 provider 上报的 prompt 侧 token（input + cacheRead + cacheWrite）
  projectedTokens?: number  // 下一次请求的 prompt 预估：pressureTokens + surface 自采样以来的净变化
  contextWindow?: number    // 最近 request/context 事件记录的窗口
}
```

【已核实】来源：`@deepseek-ai/dsh-api-session-controller/lib/types/history/controller.js`
`projections()`（live 走 `ctx.sessionProjections.snapshot(session)`，cold 走
`sessionQuery.observeSession(..., { projectionMode: 'all' })`）；
`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js`
`contextPressureProjectionDefinition.wire.view`。该投影 `wire.summary: false`，只影响列表行，
**不影响完整投影读取**。

实现细节（`src/app.ts:1129 projectionPressure`）：

- **结构探测**：`typeof this.deps.controller.projections === 'function'`；老 Host 没有该
  方法时直接返回 `null`，落到 §2.2/§2.3，不抛错。`SessionControllerLike` 因此新增了
  可选方法 `projections?`（`src/dispatch.ts:35-45`）。
- 调用带 `this.lifetime.signal`；任何异常吞掉并返回 `null`。
- `usedTokens = projectedTokens ?? pressureTokens`（优先“下一次请求”的估算）；
  两者都缺 → `null` → 继续下一来源。
- `source`：`pressureTokens` 存在时为 `'provider'`（该样本有 provider 锚点，即使分子用了
  `projectedTokens`）；只有 `projectedTokens`（纯启发式增量）时为 `'estimate'`。
- 本路径 **live 与 cold 会话都可用**、不激活会话；cold 会话的 `migration-required` 结果
  只要 `values.contextPressure` 仍在（缓存 hints）就照常使用。

### 2.2 次路径：`ctx.tokenMeter.contextPressure(live session)`

- 服务名 `tokenMeter`（`@deepseek-ai/dsh-token-meter`，`TokenMeter extends Service`，
  `super(ctx, 'tokenMeter')`，静态 `inject = ['sessionProjections']`）。
- **入参必须是 live 的 `Session` 对象**：`ctx.sessions.get(id)` 只返回 live 会话
  （`@deepseek-ai/dsh-session/lib/index.js` `SessionStore` 的 `get(id)`/`list()` 注释均为
  “live sessions”）。cold 会话没有 body → 这条路径返回 `null`。
- `contextPressure(session)`：同步、O(1)，返回 **`{ pressureTokens?, contextWindow? }`**。
  【已核实】服务方法**不返回** `projectedTokens`（`lib/types/index.js` 的
  `contextPressure(session)` 只解构这两个字段；`projectedTokens` 只存在于投影 wire view，
  由 §2.1 读取）。
- 实现（`src/index.ts:206-243` + `src/app.ts:1093-1106`）：先取 `pressureTokens`；
  没有 provider 锚点（会话还没完成过调用）时退到 `measure().totalTokens`。
  `measure(session, requestHeader?)` 返回 `{ logRevision, baseline, surfaceDeltaTokens,
  totalTokens, surfaceTokens, nodes }`；注意 `totalTokens` 是 **request+response** 压力
  （含最近 assistant 输出），作为 occupancy 偏高，只在无 provider 锚点时使用。
- 该路径的样本 `source` 恒为 `'provider'`；窗口用本服务返回的 `contextWindow` 兜底
  （§2.4 中低于目标路由窗口优先级）。

### 2.3 `controller.list()` 的 `projections.values`（不能当占用）

- 列表行只带 **summary 投影**：summary = 所有 client-visible 投影中未被
  `wire.summary: false` 排除的键。被排除的键含 `turnOutline`、`sessionStats`、`todos`、
  `imageLimits`、**`contextPressure`**、**`contextBreakdown`**。
- 【已核实】`tokenUsage` **没有** `summary: false`（默认 true）→ 列表行有 `tokenUsage`；
  `contextPressure`/`contextBreakdown` **没有**。
- 结论：不能从 `controller.list()` 读“当前上下文占用”。`tokenUsage` 是整个 log 的累计
  计费桶，不是下一次请求的 prompt 大小，不能替代 occupancy。
- 列表行另有 `agentAvailable`（= `ctx.agents.get(id)?.session === session`），可用于
  预判是否有 live Agent；cold 行恒为 `false`，但不作为本实现的判定依据（直接调用
  `agents.get` 更准）。
- 【已核实】来源：`@deepseek-ai/dsh-session-projection/README.md`、`@deepseek-ai/dsh-api-session-controller/lib/types/list.js` `projectionsFor()`。

### 2.4 窗口上限：目标路由优先

```ts
const info = await ctx.llm.resolveModelInfo(provider, model) // 服务名 llm
// info: { provider, id, name?, context?: { contextWindow: number },
//         defaultMaxTokens?, systemPromptUpdate?, toolUpdate?, reasoning? }
```

【已核实】`@deepseek-ai/dsh-llm/lib/types/index.js` `normalizeModelInfo()`：`context` 只
透出 `{ contextWindow }`，且要求正整数；无 capacity 的 adapter 该字段缺省。

**优先级（最终实现）**：

1. `MateApp.modelWindow(model)`（`src/app.ts:1160`）—— 用**本次派发真正要用的路由**
   （`overrides`/`model` 参数）调 `resolveModelInfo().context.contextWindow`；Host 侧由
   `src/index.ts:77 makeContextWindowReader` 适配，注入 `AppDeps.contextWindow`
   （`src/app.ts:79`）。失败/缺省返回 `null`。
2. 仅当目标路由窗口未知时，才用样本自带的窗口（projection 的 `contextWindow` /
   tokenMeter 的 `contextWindow`）。它是会话上一次 `request/context` 记录的窗口。

为什么目标路由优先：`request/context` 事件只在 provider/model/contextWindow/
systemPromptUpdate 变化时才追加（`@deepseek-ai/dsh-agent-loop/lib/index.js` 约 1064-1076 行），
复用会话里存的窗口可能属于旧模型；而 Mate 随后会用 `selectModel` 切到目标路由。

两个窗口都取不到 → 决策返回 `reason='window-unknown'`，保持原复用路径（不猜）。
逐源测量都未命中 → `reason='measurement-unavailable'`，同样保持复用并记日志。

### 2.5 兜底：`sessionQuery` 当前 surface + CJK 感知字符估算

`ctx.sessionQuery`（桌面组合由 `dsh-session-query-sqlite` 提供；Mate 在
`src/index.ts:178` 嵌套注入）：

- **优先 `readSurface(id)`**：返回 `{ session, inheritedEventCount, capturedThroughSeq,
  events }`，`events` 是**当前模型 surface**（shadowed/已压缩历史已排除）。
- `readSurface` 抛错或不存在（`readSurface?`）时退回 `readSession(id)`（完整 raw log，
  含 shadowed 历史；此时会高估，属于最后兜底）。
- 估算函数：`src/compression.ts:430 estimateTokensFromSessionSnapshot(snapshot)`，逐
  surface 事件取文本（`data.message` / `data.content` 的 text 与 tool-call arguments），
  用 `estimateTokensFromText`（`src/compression.ts:362`）：**CJK 约 1 token/字，其余约
  4 字符/token**，上限 `maxChars = 2_000_000`。
- 该样本 `source='estimate'`，窗口仍按 §2.4（目标路由窗口）。

**误差声明（必须保留）**：这是近似值，不是 tokenizer。已知偏差：

- CJK 只有落在 `isCjkCodePoint` 覆盖区间（CJK 统一表意、假名、全角、扩展 A-F 等）才按
  1 token/字计价；token-meter 官方固定启发式（4 字符/token）会严重低估 CJK 与 JSON/code；
  本实现做了 CJK 感知修正，但仍无 provider tokenizer 校准，中文实际约 0.6–1 token/字；
- JSON、代码、密集标点被低估；短 id 文本可能被高估；
- **tools schema 不计入**：它在 `request/header`（log-only 事件），surface 里没有，估算会
  少算数千 token 量级；system prompt 若以 `system/message` 在 surface 上则会计入；
- 读取被 `maxChars` 截断时低估；`readSession` 兜底路径会重复计入已压缩（shadowed）历史，
  从而高估；
- 结论：该来源只用于“provider 锚点不可用”的兜底，误差方向不保证，日志 `source=estimate`
  与 `tokens` 应一起读。

### 2.6 度量来源排序与误差

| 优先级 | 来源 | 精度 | 适用范围 | 代价/风险 |
| --- | --- | --- | --- | --- |
| 1 | `controller.projections().values.contextPressure`（`projectedTokens ?? pressureTokens`） | 高（provider 锚点 + surface 增量）；cold 读缓存 | live + cold | 一次异步读；`migration-required` 可能缺键；从未请求过则无样本 |
| 2 | `ctx.sessions.get` + `ctx.tokenMeter.contextPressure`（无锚点再用 `measure().totalTokens`） | 高（provider），但只有 `pressureTokens`；`totalTokens` 含输出会偏高 | 仅 live | 需要 `sessions` + `tokenMeter`；O(1)/O(surface) |
| 3 | `sessionQuery.readSurface`（`readSession` 兜底）+ CJK 字符启发式 | 低：见 §2.5 误差 | live + cold（有持久化即可） | 依赖 `sessionQuery`；无 provider 校准 |
| — | `controller.list().projections.values.tokenUsage` | 不可用（累计计费桶，非占用） | — | 不能当 occupancy |

样本 `source` 语义：`'provider'` = provider 上报的 prompt 大小锚定（含 projection 的
`projectedTokens` 增量）；`'estimate'` = 纯本地启发式。

## 3. 压缩服务：`ctx.compaction` 与回退

### 3.1 API（【已核实】，DSH 0.2.2-rc.1）

- `@deepseek-ai/dsh-compaction` 定义抽象服务 `CompactionEngine`，服务名 **`compaction`**
  （`super(ctx, 'compaction')`）。桌面组合挂载的实现在 `@deepseek-ai/dsh-compaction-basic`
  （base 组合 `cordis.patch.yml` 的 `compaction-basic` 行）。
- 三个入口（`dsh-compaction-basic/lib/index.js`）：

```ts
compactIfNeeded(agent: Agent, trigger: 'pressure' | 'context-overflow', signal: AbortSignal): Promise<CompactionResult | null>
compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>
compactRegion(start, end, agent, signal): Promise<CompactionResult>
```

- 本实现只用 **`compactNow(agent, signal)`**（`src/index.ts:261`，不传 `sourceCommandId`）。
  语义：给**空闲** Agent 做一次“低于自动阈值也强制压缩”的压缩，通过
  `agent.runMaintenance()` 预留下一轮 admission、`turn: null`；**resolve 时 marker 对已持久化**。
  返回 `null` = 没有可安全压缩的有用区间（“No compactable history yet”）。
- 成功返回（`compactSurfaceRegion` 的 return）：

```ts
{ compactionId, sourceCommandId?, startSeq, summarySeq, summary,
  shadowedRange: { start, end }, shadowedSeqs: number[], shadowedTokenCount: number }
```

  适配器只透出 `tokensFreed = shadowedTokenCount`（`CompactionOutcome`）。
- 失败面（全部归为 `{ ok: false, reason }` 或抛错，最终都走回退）：
  - `ManualCompactionError`，`code ∈ {busy, cancelled, changed, summary, commit, persistence}`
    （`dsh-command-compact/lib/index.js` 的 `expectedFailure` 穷举）；
  - `runMaintenance` 在非 idle phase 抛普通 `Error("agent … already has active work")`；
  - `TargetPressureConfigError`：adapter 缺 capacity / 输出+headroom 挤爆窗口 / 保留预算
    ≥ 阈值。
- `compactIfNeeded` 不是本需求入口（它是 Agent 循环 `agent/pre-step` 的自动触发器，由
  compaction-basic 自己的监听器调用）；派发前主动压缩用 `compactNow`。
- 参考：`@deepseek-ai/dsh-command-compact` 的 `/compact` 就是
  `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`，
  说明“插件主动调用 compactNow”是被支持的用法。

### 3.2 Agent 获取与 cold 会话

- `ctx.agents.get(sessionId)`（服务名 `agents`，`@deepseek-ai/dsh-agent`）返回**裸 Agent**
  （只读），live registry 才有；agent 由 `dsh-agent-loop` 的 driver 注册。
- `ctx.sessions.get(id)` 同样只覆盖 live 会话。
- **cold / 未 resume 的复用会话没有 live Agent** → 无法 `compactNow` → 适配器返回
  `{ ok:false, reason:'no-live-agent (…)' }` → 走“新建会话 + handoff”。
- live 但正在跑（或已有 maintenance）的 Agent：`compactNow` 会抛（busy / active work）。
  复用候选在 `findReusable`/`reusableSession` 已要求 `!running`，但存在竞态，仍需
  try/catch（适配器已统一捕获）。
- 适配器缺失（profile 未挂载 compaction 服务）时 `compactContext` 返回
  `{ ok:false, reason:'compaction-service-unavailable' }`（`src/app.ts:1171`）。

### 3.3 决策/回退矩阵（最终行为）

| 配置 | 占用 | 压缩结果 | 最终策略 |
| --- | --- | --- | --- |
| 关闭 | — | 不测量、不压缩、不写决策日志 | 原样复用（与改动前逐字节一致） |
| 开启 | 不可测（measurement-unavailable） | 不尝试 | 原样复用，日志 `usage=unknown` |
| 开启 | 窗口未知（window-unknown） | 不尝试 | 原样复用，日志 `usage=unknown` |
| 开启 | < threshold（低于阈值） | 不尝试 | 原样复用，日志记录真实占用 |
| 开启 | ≥ threshold（含等于） | 无 live Agent / 压缩服务缺失 / 抛错 / 返回 `null` | **新建会话一次 + handoff**，warning `context-compression-fallback`，不重试 |
| 开启 | ≥ threshold | 返回成功结果（有 `shadowedSeqs`） | 继续复用被压缩的会话，不注入 handoff |

- 判定用 `>= threshold`（`src/compression.ts:204 decideContextAction`）。
- 每条派发**恰好一次 prompt**；回退只发生在 prompt 之前，因此不存在“旧会话已 prompt 又
  新会话再 prompt”。
- 压缩成功后不重新测量（日志记录的是触发本次压缩的占用）；直接继续原
  `selectModel → rename → prompt` 路径。

### 3.4 与 compaction-basic 默认自动阈值的重叠

【已核实】`dsh-compaction-basic` 默认 `thresholdRatio = 0.8`、`headroomTokens = 65536`、
`retainRatio = 0.16`，自动触发点为 `floor(min(W × 0.8, W − O − B))`，在
`agent/pre-step`（下一次请求前）执行。也就是说，一个“刚结束一轮、已超 80%”的会话在下一次
请求前本来就会被 DSH 自动压缩；Mate 的价值在于：**派发这一刻**（prompt 入队前）做判定、
把回退策略与 handoff 掌握在自己手里，并记录四字段日志。二者阈值相近是预期行为，Mate 不改
compaction-basic 的全局配置。

## 4. 配置项（最终）

| 项 | 值/行为 |
| --- | --- |
| 持久化位置 | `mate` storage domain 的 global 记录 → `contextCompression?`（`~/.dsh/storages/mate.json`） |
| 默认值 | `{ enabled: false, threshold: 80 }`（`DEFAULT_CONTEXT_COMPRESSION`，`src/compression.ts:15`） |
| 旧配置 | 缺字段/坏值 → 容错解析为默认值，**不抛错、不改写**（`resolveContextCompressionConfig`，`src/compression.ts:69`） |
| 严格校验 | `enabled` 必须 boolean；`threshold` 必须整数 1..100；错误码 `context-compression-invalid`，错误项含 `code/path/message`（`src/compression.ts:88 validateContextCompressionConfig`、`src/app.ts:779`） |
| 读取 | Host：`store.contextCompression()`（`src/store.ts:82`）；客户端：`Snapshot.settings.contextCompression` |
| domain | `version` 保持 1；schema 可选字段（`src/domain.ts:236`）；新装 initial 写入默认值（`src/domain.ts:250-266`） |
| 行为 | 关闭 → 派发路径零测量/零压缩/零决策日志 |

设置页（`src/client/dialogs.tsx`，UI 与 Host 共用同一纯校验）：

- `settings.contextCompression.title` 区块：**“启用上下文压缩” checkbox** + **阈值数字输入**；
- 阈值输入 `min/max/step` 来自 `CONTEXT_COMPRESSION_THRESHOLD_MIN/MAX`，`disabled={!enabled}`
  （开关关闭时不可编辑）；打开弹窗时以快照冻结初值；
- 非法输入（0、101、小数、非数字）用 `validateContextCompressionDraft`（内部复用
  `validateContextCompressionConfig`）内联本地化报错，`canSave=false` 阻止保存，配置不被破坏；
- 保存时随其它设置一起发 `settings.update` 的 `contextCompression`；保存成功后刷新快照持久
  （`src/client/dialogs.tsx:873-999、1424-1455`；文案 `src/client/locales.ts`
  `settings.contextCompression.*`，中英各一套）。

## 5. 决策日志（四要素，最终格式）

`src/compression.ts:249 formatContextDecisionLog` 输出单行：

```text
[dsh-mate] context-compression: reason=<reason> threshold=<n>% usage=<pct|unknown>% tokens=<used|unknown>/<window|unknown> strategy=<none|compress|new-session> [session=...] [req=#N] [id=...] [failure=...]
```

- 四个必含字段：`reason` / `threshold` / `usage`（+ `tokens` 原始值）/ `strategy`；
- `reason ∈ {disabled, measurement-unavailable, window-unknown, below-threshold, threshold-reached}`；
- `strategy ∈ {none, compress, new-session}`；
- 可选 `session`、`req=#N`、`id`、`failure`（失败详情压缩空白并截断到 240 字符）；
- 何时写：
  - 功能关闭 → **不写**（守卫在读配置后直接返回，不测量）；
  - 功能开启且命中复用分支 → 每次决策**恰好一行**（含 below-threshold，便于验证“未误触发”）；
  - 测量/估算抛错时另有诊断行（`[dsh-mate] context measurement failed for <sessionId>: …`、
    `[dsh-mate] context meter failed for …`、`[dsh-mate] context estimate failed for …`），
    随后决策行仍为 `measurement-unavailable`。

示例：

```text
[dsh-mate] context-compression: reason=threshold-reached threshold=80% usage=87.3% tokens=104760/120000 strategy=new-session session=session-abc req=#12 id=req_… failure=no-live-agent (the session has no idle Agent to compact)
[dsh-mate] context-compression: reason=below-threshold threshold=80% usage=42.0% tokens=50400/120000 strategy=none session=session-def req=#13 id=req_…
```

## 6. handoff 摘要（最终）

`src/compression.ts:330 buildHandoffSummary`；只在“本要复用、压缩回退→新建会话”时构造，
并由 `src/dispatch.ts:206-212` 拼到首条 brief 之前。

内容（固定顺序）：

```text
# Handoff summary (fresh session)
The previous session could not be compacted before dispatch, so this task continues in a new session. Re-read the recent work before changing anything.

- Target project: <projectTitle 或目录名> (<projectPath>)
- Current task: <需求标题>
- Current task detail: <需求 brief，截断到 600 字符>            # 可选
- Completed work items:                                        # 必含；有历史时逐条列出
  - <已完成项> …
- Remaining work items:                                        # 可选
  - <未完成项> …
- Previous session: <被放弃的 sessionId>                        # 有值时
```

无历史（`completedWorkItems` 为空）时，已完成工作项退化为单行：

```text
- Completed work items: (none recorded yet; start from the current task)
```

- 目标项目 = 派发目标 `projectPath` + `projectTitle`（跨项目时用目录名）。
- 当前任务 = `RequirementView.title`；可选 detail = `RequirementView.brief`。
- 已完成工作项来源（`src/dispatch.ts:357 completedWorkItemsOf`）：
  `requirement.result.acceptance` 中 `met === true` 的 `item`；为空则用
  `requirement.result.doneSummary`；仍为空 → 最小摘要占位。
- 未完成项来源（`src/dispatch.ts:367 remainingWorkItemsOf`）：
  `requirement.result.remaining`，为空则 `requirement.analysis.subTasks[].title`。
- 上限（`src/compression.ts:22-29`）：总长 `HANDOFF_MAX_CHARS = 4000`、
  brief `HANDOFF_BRIEF_MAX_CHARS = 600`、单条 `HANDOFF_ITEM_MAX_CHARS = 200`、
  最多 `HANDOFF_MAX_ITEMS = 20`；去重、压缩空白、末尾 `…` 截断，永不抛错。
- 只注入一次（单 text block 的前半部分），不影响正常复用/新建路径的 brief。

## 7. 验收对照（工作项 1-7）

实施状态：7 项均已落地。`pnpm typecheck` 与
`pnpm exec vitest run --pool=threads` 通过（Lead 验证；本文不重跑构建/测试）。

| 工作项 | 实现 | 证据 |
| --- | --- | --- |
| 1 调用链勘察与度量来源 | 本文 §1-§6；DSH 包源码核对（token-meter / api-session-controller / compaction / compaction-basic / agent / session-query） | 本文件；`src/dispatch.ts:226-285`；`src/app.ts:1081-1178` |
| 2 配置项（持久化/默认值/向后兼容/校验） | `ContextCompressionConfig` + optional global 字段 + 容错/严格双解析 + `settings.update` 校验 + `SettingsView`/snapshot 暴露 | `src/compression.ts:15-125`、`src/domain.ts:31-77/236/250-266`、`src/store.ts:82-84`、`src/app.ts:779-819`；`src/compression.test.ts`（config 3 例）、`src/context.test.ts`（settings 7 例） |
| 3 设置页 UI | “启用上下文压缩”开关 + 阈值输入（关闭时 disabled）+ 中英本地化错误 + 阻止非法保存 | `src/client/dialogs.tsx:873-999、1424-1455`、`src/client/locales.ts`；`src/client/settings.test.ts`（该文件 17 例中 6 例覆盖本功能：4 个 section SSR 例 + 2 个 draft 校验例；其余 11 例属模型时段调度） |
| 4 阈值决策（纯函数，四组合） | `decideContextAction`：disabled / 不可测 / 窗口未知 / <阈值 / ≥阈值；`>=` 语义 | `src/compression.ts:204-233`；`src/compression.test.ts`（decision 2 例）、`src/context.test.ts:184-330`（disabled×2、enabled 低于、enabled 超阈值） |
| 5 派发集成（复用分支压缩、失败回退新会话 + handoff、单次 prompt） | `guardReusedContext` 位于复用选中与 `selectModel` 之间；成功复用、失败新建一次 + handoff + `context-compression-fallback` warning；`mode=new` 不介入 | `src/dispatch.ts:170-212、226-285、357-371`；`src/compression.ts:330-359`；`src/context.test.ts:184-330、481-587` |
| 6 日志四要素 | `formatContextDecisionLog` 固定顺序输出 reason/threshold/usage/tokens/strategy + 可选 session/req/id/failure | `src/compression.ts:242-273`；`src/compression.test.ts:140-179`；`src/context.test.ts` 日志断言 |
| 7 测试与文档 | 纯函数 + Dispatcher + app 级 wiring + 设置页测试；本文档 | `src/compression.test.ts`（13）、`src/context.test.ts`（17）、`src/client/settings.test.ts`（17）；全仓 11 个测试文件、205 个用例（`pnpm exec vitest run --pool=threads` 实测），全绿 |

补充测试覆盖点：`context.test.ts` 中的 app 级用例覆盖“通过 controller projection face
测量并优先使用目标路由窗口”（`measures through the controller projection face and prefers
the route window`）；`compression.test.ts` 覆盖 handoff 上界/去重/最小摘要/CJK 估算。

## 8. 已验证事实 vs 残留不确定

【已核实】（本机 DSH 0.2.2-rc.1 源码/文档）：

- 测量顺序与 `source` 语义、`usedTokens = projectedTokens ?? pressureTokens`（§2.1）；
- `controller.projections({sessionId})` 的完整投影面（live + cold，含 summary 排除键，
  cold 走 `projectionMode:'all'`）；
- `list()` 行不含 `contextPressure`/`contextBreakdown`；`tokenUsage` 是累计桶不是占用；
- `tokenMeter.contextPressure(session)` 服务方法**只有** `{pressureTokens?, contextWindow?}`
  （`projectedTokens` 只在投影 wire view）；`measure().totalTokens` 含 response；
- `ctx.sessions.get/list`、`ctx.agents.get` 只覆盖 live；cold 会话无 Agent → 回退；
- `compactNow(agent, signal, sourceCommandId?)` 的签名、`null` 语义、结果字段、
  `ManualCompactionError` 错误码、`agent.runMaintenance` 非 idle 抛错；
- 桌面组合挂载 `session`/`agent`/`session-projection`/`token-meter`/`compaction-basic`/
  `command-compact`/`agent-loop`；desktop profile bundles 含 `@deepseek-ai/dsh-base` 与
  `dsh-mate`，未禁用这些行；
- 4 字符/token 低估 CJK 与 JSON/code；`request/context` 只在路由/窗口变化时追加；
- 配置持久化、默认值、向后兼容、严格校验、日志格式、handoff 上限与回退矩阵（§3-§6）；
- `src/compression.test.ts` 13 例、`src/context.test.ts` 17 例、`src/client/settings.test.ts`
  17 例（当前工作树文件）；全仓 11 个测试文件、205 个用例。

残留不确定（不阻塞验收，已由降级路径覆盖）：

- DSH `engines.dsh` 下界 `0.2.1-rc.5` 是否已提供 `controller.projections` 及相同投影键——
  本次只核对 0.2.2-rc.1；实现用 `typeof controller.projections === 'function'` 结构探测，
  老 Host 自动落到 tokenMeter/estimate。
- 复用候选在真实使用中 cold / live 的比例（决定走精确测量还是回退的概率）取决于用户是否
  打开过该会话；cold 时压缩必然不可用，走 handoff 回退，符合需求。
- 从没发起过请求的会话没有 provider 锚点（`contextPressure` 缺省）→ 按
  measurement-unavailable/window-unknown 处理，保持复用。
- `migration-required` 的投影缓存 hints 可能缺 `contextPressure` → 依次落到后续来源。
- CJK/JSON/code 的实际 token 比没有 provider tokenizer 校准（token-meter 明确未实现），
  `source=estimate` 的样本有误差。
- 若会话已压缩过而兜底使用 `readSession`（`readSurface` 不可用/抛错），估算会重复计入
  shadowed 历史（高估）；这是最后兜底路径的已知代价。

## 9. 桌面组合验证（服务可用性）

`@deepseek-ai/dsh-base/cordis.patch.yml` 的相关挂载行：

| 行 | id | 包 | 提供的服务 |
| --- | --- | --- | --- |
| 40 | `session` | `@deepseek-ai/dsh-session` | `sessions`（live Session 注册表） |
| 82 | `agent` | `@deepseek-ai/dsh-agent` | `agents`（live Agent handle） |
| 138 | `session-persistence-jsonl` | … | 持久化 log（cold 会话可读） |
| 157 | `session-query-sqlite` | `@deepseek-ai/dsh-session-query-sqlite` | `sessionQuery` |
| 172 | `session-projection` | `@deepseek-ai/dsh-session-projection` | `sessionProjections` |
| 352 | `token-meter` | `@deepseek-ai/dsh-token-meter` | `tokenMeter` |
| 355 | `compaction-basic` | `@deepseek-ai/dsh-compaction-basic` | `compaction` |
| 360 | `command-compact` | `@deepseek-ai/dsh-command-compact` | `/compact` 命令 |
| 517 | `agent-loop` | `@deepseek-ai/dsh-agent-loop` | Agent driver（注册 factory） |

- 当前桌面 profile（`C:\Users\qaiii\.dsh\profiles\desktop\package.json`）的
  `dsh.profile.bundles` 显式包含 `@deepseek-ai/dsh-base` 与 `dsh-mate`；profile 的
  `cordis.patch.yml` 只改配置，没有禁用上述行。
- 因此桌面 profile 中主路径（`sessionController`，Host 必需注入）与三个可选来源都存在；
  插件仍按“可选服务 + 防御式读取”接线，保证 headless/CLI 或未来 profile 缺服务时只降级。

## 10. 可选服务的 cordis 接线模式

- `ctx.inject(deps, cb)` 的 `deps` 数组表示**全部 required**：数组里任一服务不存在，cb
  不会执行。`Inject` 类型为 `(keyof M)[] | { [K]?: M[K] }`（值为 service config，不是
  required 开关），没有“required:false”写法（`@deepseek-ai/cordis/src/registry.ts`）。
- 现有可选服务模式（本仓库已用）：嵌套 inject，回调里 `scope.get(name)` 判空后 setter
  注入应用；也可在已激活的插件 ctx 上直接 `ctx.get(name)`（“read a service without the
  inject requirement”，返回 `undefined` 表示未提供；`@deepseek-ai/cordis/src/reflect.ts`）。
- 最终接线：
  - 主测量：`sessionController`（必需注入）上的可选 `projections?`，**不需要新增服务**；
    `MateApp` 的 `projectionPressure` 结构探测后调用。
  - 次测量：`src/index.ts:206` `ctx.inject(['tokenMeter','sessions'])` → 两服务都在才
    接 `setContextMeter`；任一缺失则不接，measureContext 直接落到估算/不可测。
  - 兜底估算：`src/index.ts:178` `ctx.inject(['sessionQuery'])` → `setContextEstimator`
    （`readSurface` 优先，`readSession` 兜底）。
  - 压缩：`src/index.ts:248` `ctx.inject(['agents','compaction'])` → 两服务都在且
    `compactNow` 是函数才接 `setContextCompactor`；缺失时压缩适配器返回
    `compaction-service-unavailable` → 回退新会话。
- 所有适配器内部 try/catch，任何服务异常都转成“不可用/失败”而不是让派发抛错。

## 11. 参考文件清单

仓库内：

- `src/app.ts`（`runDispatch` / `updateSettings` / `snapshot` / `measureContext` /
  `projectionPressure` / `modelWindow` / `compactContext` / setter 接线）
- `src/dispatch.ts`（`SessionControllerLike.projections?` / `dispatch` / `findReusable` /
  `guardReusedContext` / `buildBrief` / `createSession` / `completedWorkItemsOf` /
  `remainingWorkItemsOf`）
- `src/compression.ts`（默认值、容错/严格校验、测量类型、`decideContextAction`、
  `formatContextDecisionLog`、`buildHandoffSummary`、CJK 估算）
- `src/index.ts`（Host 服务接线、`ctx.inject` 嵌套、`makeContextWindowReader`）
- `src/store.ts` / `src/domain.ts` / `src/shared.ts`（配置持久化、schema、视图类型）
- `src/client/dialogs.tsx` / `src/client/locales.ts`（设置页与文案）
- `src/compression.test.ts` / `src/context.test.ts` / `src/client/settings.test.ts`（测试）
- `docs/scheduling.md`（本文件的结构/风格参照）

DSH 侧（桌面版 0.2.2-rc.1，`resources/app.asar` 内）：

- `@deepseek-ai/dsh-api-session-controller`：`README.md`、
  `lib/types/history/controller.js`（`projections`）、`lib/types/list.js`（summary 行）
- `@deepseek-ai/dsh-session-projection`：`README.md`（summary/排除键语义）
- `@deepseek-ai/dsh-token-meter`：`README.md`、`lib/types/index.js`（`contextPressure`/
  `measure`）、`lib/types/usage-projection.js`、`lib/types/estimate.js`
- `@deepseek-ai/dsh-session`：`README.md`、`lib/index.js`（`SessionStore`）
- `@deepseek-ai/dsh-llm`：`lib/types/index.js`（`resolveModelInfo`/`normalizeModelInfo`）
- `@deepseek-ai/dsh-agent`：`README.md`（`ctx.agents.get` live registry）
- `@deepseek-ai/dsh-agent-loop`：`lib/index.js`（`request/context` 追加、`runMaintenance`）
- `@deepseek-ai/dsh-compaction`：`README.md`、`lib/types/index.js`（`CompactionEngine`）
- `@deepseek-ai/dsh-compaction-basic`：`README.md`、`lib/index.js`（`compactNow`/
  `compactIfNeeded`/结果与失败面、默认阈值）
- `@deepseek-ai/dsh-command-compact`：`README.md`、`lib/index.js`（`compactNow` 调用范式）
- `@deepseek-ai/dsh-session-query`：`README.md`、`lib/index.js`（`readSurface`/`readSession`）
- `@deepseek-ai/dsh-base/cordis.patch.yml`、`dsh/desktop-runtime.json`
