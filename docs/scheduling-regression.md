# 模型可用时段调度 — 人工验收回归清单

本文件是「模型可用时段调度 + 内置节假日/调休 + 排队派发」的**人工验收回归清单**：
从零配置开始，逐步复现「窗内提交 → 排队 → 重启存活 → 跨窗口自动分析/派发」的完整链
路，并覆盖节假日/调休判定、队列上限拒绝、全模型禁用横幅。设计契约见
[scheduling.md](scheduling.md)；两者不一致时以 `src/*.ts` 为准。

- 仓库根：`D:\CodeProject\Deepseek-Harness-Plugins\Mate`
- 建议在 **dev profile** 上做人工验收（Host 日志直接出现在终端里，便于核对）；
  桌面版也能跑，但登录后日志不易观察。
- 每步都给出「操作 → 预期可观察结果」；把结果记到文末的验收记录表。

## 0. 环境准备

```powershell
cd D:\CodeProject\Deepseek-Harness-Plugins\Mate
pnpm install
pnpm build
dsh dev --from-default-profile web        # 首次：准备 dev profile
dsh plugin --profile dev add -w .
dsh dev --no-open --port 3099 2>&1 | Tee-Object -FilePath mate-acceptance.log
```

- 浏览器打开 <http://127.0.0.1:3099>，左侧出现 **Mate** 图标。
- 之后每次改源码都要 `pnpm build` 并重启 `dsh dev`（桌面版不加载 client HMR）。
- Host 日志就是上面 `dsh dev` 终端的输出（同时落在 `mate-acceptance.log`）；所有
  `[dsh-mate]` 行都从那里看。后续步骤用 `Select-String mate-acceptance.log -Pattern '\[dsh-mate\]'`
  过滤。
- §1–§5 请在**周一–周四、本地时间 09:00–18:00**（生效时区）之间执行：此时
  「工作日 09:00–00:30」窗口必然覆盖「现在」，预计开始时间稳定为**次日 00:30**。若有
  特殊原因必须在其它日期/时刻执行，按 §2 备注调整窗口，并按实际日分支推导预期 ETA（判
  定语义的权威证据见 §6 的自动化用例）。
- 确认要测的 **Mate 的分析模型**：打开 Mate 编辑器看它绑定的 provider/model（分析闸门
  判定的是这条路由）。下面所有「这个模型」都指它。

## 1. 零配置基线

1. 打开 **设置**。
2. 预期：
   - 「生效时区」显示一个 IANA 区（来源：手动 / DSH 客户端 / Host 本地之一）；
   - 「模型可用时段」为空 → 显示「全天可用」；
   - 「启用内置中国法定节假日（含调休）」为**开启**状态；
   - 节假日/调休列表为空；
   - Host 日志**没有**包含 `falling back to weekend-only rules` 的 `[dsh-mate] holidays:`
     行（当前年份在数据覆盖范围 2024–2026 内、数据正常时不应降级）。
3. 看板为空（全新 dev profile / 尚无其它需求时）；没有任何「排队中 / 等待模型时段」徽标。
   取消设置弹窗。

## 2. (a) 给一个模型加 09:00–00:30 禁用时段

1. 设置 → 「模型可用时段」→ 选择该 Mate 的分析模型 → 添加。
2. 添加一段：类型 `工作日`，开始 `09:00`，结束 `00:30`。`end < start` 表示跨零点：
   工作日当天 09:00–24:00 与次日 00:00–00:30（次日仍按工作日分支判定时）都算禁用。
3. 保存。
4. 预期：
   - 保存成功，弹窗关闭；再次打开设置能看到该模型下的时段行：类型「工作日」、开始
     `09:00`、结束 `00:30`（行悬浮提示为 `weekday 09:00-00:30`）；
   - 标准场景（周一–周四 09:00–18:00）下该模型旁徽标为**当前禁用**，并显示下次可用时间
     （次日 00:30，按生效时区显示为 `MM/DD HH:mm`）；
   - `~/.dsh/storages/mate.json`（或当前 `DSH_HOME` 对应的 `storages/mate.json`）的
     `global.schedule.models` 里出现该模型，`disabledWindows` 含
     `{"kind":"weekday","start":"09:00","end":"00:30"}`；`useBuiltinHolidays` 为 `true`。

备注（不能在周一–周四 09:00–18:00 执行时）：

- 「工作日」窗口只在**工作日分支**命中。若「现在」是周六/周日（且不是调休上班日）或法
  定节假日，该窗口不生效、徽标会显示「当前可用」：可把时段类型改为「指定星期」并勾选
  今天，或临时把今天加入「调休上班日」（见 §6.2），使其覆盖 now。
- 若「现在」在 01:00–08:59（不在 09:00–00:30 内），改成覆盖 now 的等价窗口：开始
  `现在 - 1 分钟`、结束 `现在 + 1 小时`（避免跨过午夜），保存后该模型应为「当前禁用」；
  此时把窗口结束时刻记为 `$END`。
- 若「现在」在工作日 00:00–00:30（窗口的次日凌晨段），窗口已覆盖 now，预计开始时间是
  **当天 00:30**。
- 后续步骤凡写 `09:00-00:30` 的地方用实际窗口等价替换，`$END` 用实际窗口的结束时刻
  （标准场景 = 次日 00:30）。

## 3. (b) 禁用时段内提交需求：0 次模型调用 + 排队中 + 预计开始时间

1. 看板/列表 → 新建需求，写一句话（例如 `验收：排队测试 1`），`Ctrl/⌘ + Enter` 提交。
2. 预期（提交后 5 秒内）：
   - 卡片出现在 **待确认** 列，状态徽标为 **排队中**；
   - 卡片上有排队徽标：`排队等待 · 预计 HH:mm 开始`，其中 `HH:mm` = 该模型下一次可用
     时刻（按生效时区显示）。标准场景（周一–周四 09:00–18:00 提交、工作日
     09:00–00:30 窗口）下为**次日 00:30**，即显示 `排队等待 · 预计 00:30 开始`；使用
     §2 等价窗口时则为 `$END`；
   - 点开需求抽屉：顶部显示「等待模型可用时段」横幅；详情含阶段「分析」、禁用时段
     `weekday 09:00-00:30`、判定时区（未重试过时详情不显示重试次数，`attempts > 0`
     才会出现「已重试 N 次」）；
   - Host 日志恰好一条阻塞记录，形如：
     `[dsh-mate] gate: requirement #N (xxxxxxxx) analyze blocked by model window weekday 09:00-00:30 on <provider>/<model> (tz <zone>) until <ISO 时间>; queued`
   - **0 次模型调用**的可观察证据：
     - 等 ≥ 60 秒，卡片始终保持 **排队中**，从不出现「分析中」；
     - 抽屉里没有分析结果/标题改写/澄清问题，需求详情没有 `analyze` 阶段的错误；
     - 日志里没有该需求的 `dequeued` 行，也没有 `[dsh-mate] … failed:` 行；
     - （可选、强证据）若使用可计费 provider，可在 provider 控制台确认排队期间没有新增
       请求/计费。
   - 记录该需求的 `#N` 与 ETA，用于下一步。
3. 自动化对照（`src/app.gate.test.ts`）：
   `queues the requirement and makes zero model calls while the window is closed` —— 断言
   `analyzed=[]`、`calls.create=0`、状态 `queued`、日志含 `analyze blocked by model window`。

## 4. (c) 重启 Host：队列与 ETA 存活

1. 保持需求仍在排队（窗口尚未打开）。在运行 `dsh dev` 的终端按 `Ctrl+C` 停止 Host。
2. 重新启动（`-Append` 保留重启前的日志供核对）：
   ```powershell
   dsh dev --no-open --port 3099 2>&1 | Tee-Object -FilePath mate-acceptance.log -Append
   ```
3. 刷新浏览器页面（或等面板自动重连）。
4. 预期：
   - 设置 → 「Host 启动时间」已变为新值（说明 Host 半确实重新加载，不是旧进程）；
   - 该需求仍在 **待确认 / 排队中**，排队徽标与 ETA 与重启前一致（`$END`，即次日
     00:30）——启动恢复会按持久化配置重新判定，正常场景下 ETA 不变；
   - 抽屉里的排队详情：判定时区不变；**重试次数变为 1**（启动恢复对仍被阻塞的条目做
     了一次重新判定，`attempts` 从 0 加到 1）；
   - Host 日志：因为窗口仍未打开，**不应**出现 `dequeued`，但会出现一次
     `[dsh-mate] queue: requirement #N (xxxxxxxx) still in model window … (attempt 1); next wake …`
     的重新判定记录；队列定时器已按重算后的 `nextWakeAt` arm；
   - 没有产生第二条需求、没有重复分析；`mate.json` 里该需求的 `queue.enqueuedAt`
     不变（只更新了 `attempts` 与 `nextWakeAt`）。
5. 记录：重启后 ETA 不变 = 通过；若 ETA 丢失/重置或需求变为草稿/失败 = 不通过。
6. 自动化对照（`src/app.gate.test.ts`）：
   - `persists a 09:00-00:30 cross-midnight window and restores the queue with its 00:30 ETA after restart`
     —— 重启后配置/队列仍在，过期的已存 `nextWakeAt` 会被按配置重算为 00:30，定时器按
     剩余时间 arm；到点后自动出队继续；
   - `keeps FIFO order and arms the timer on restart` —— 多条排队项的重启顺序与定时器。

## 5. (d) 跨过窗口：自动分析 + 自动派发

推荐用「把窗口提前到 2 分钟后」的方式验证，避免等到真实 00:30；这同时验证「改配置立
即重算排队需求」。

1. **避免在 23:5x 执行本步**（跨日分支会让预期时刻变化）。让排队需求保持排队。打开设
   置，把该模型的时段结束时间从 `$END` 改成 `现在 + 2 分钟`（例如 14:32），开始时间保
   持覆盖 now（例如 09:00 或 `现在 - 1 分钟`），保存。
2. 预期（保存后立即）：
   - Host 日志出现一次
     `[dsh-mate] queue: requirement #N (xxxxxxxx) still in model window …; next wake …`
     或重新入队记录；卡片 ETA 立刻变成窗口的新结束时刻（`现在 + 2 分钟`），不需要等旧
     唤醒时间；
   - 到点后（±5 秒），Host 日志出现：
     `[dsh-mate] queue: requirement #N (xxxxxxxx) dequeued for analyze`
   - 卡片离开「排队中」，进入 **分析中**（短暂）→ 分析完成：
     - Mate 为 `auto` 时：直接进入 **进行中**，看板出现执行会话（会话标题
       `Mate · <需求标题>`）；
     - Mate 为 `confirm` 时：进入 **待确认**，点「确认派发」→ **进行中**；
   - 需求抽屉里排队横幅消失，`queue` 字段清空；分析结果（标题/方案/项目）出现；
   - 日志没有重复的 `dequeued`（同一需求只出队一次），没有重复模型调用。
3. 恢复计时：把窗口结束时间改回 `09:00-00:30`（或删除该时段），保存。
4. 预期：无排队需求时不再有唤醒日志；已派发会话不受后续时段影响。
5. 自动化对照（`src/app.gate.test.ts`）：
   - `wakes at nextWakeAt, dequeues and analyzes exactly once`
   - `re-evaluates the queue when a schedule change opens the window`
   - `makes zero model calls while every model is disabled, then resumes analysis and dispatch`

## 6. (e) 节假日 / 调休上班日判定

固定日期（2025-10-01、2025-10-11 等）无法靠「等」验证，用自动化用例作为可重复的判
定证据；再用「把今天设为节假日/调休日」验证同一套在线判定引擎。

### 6.1 固定日期（自动化，权威）

```powershell
pnpm exec vitest run --pool=threads src/holidays.test.ts src/schedule.test.ts --reporter=verbose
```

预期：全部通过。输出中应能看到这些用例名（不同版本可能增删，以覆盖点为准）：

- `src/holidays.test.ts`：
  - `covers 2024-2026` —— 内置数据覆盖 2024/2025/2026；
  - `carries the official 2025 notice dates (国庆中秋 + 调休)` —— 2025-10-01…10-08 是节假日，
    2025-09-28 / 2025-10-11 / 2025-01-26 / 2025-02-08 / 2025-04-27 是调休上班日；
  - `carries the official 2026 notice dates` —— 2026-01-01…、2026-02-14/28、
    2026-05-09、2026-09-20、2026-10-10 等；
  - `applies manual holidays and workdays over the built-in data` —— 手动 `holidays` >
    内置调休上班日、手动 `workdays` > 手动/内置节假日（同日冲突 workday 胜出）；
  - `degrades to weekend-only rules when the data cannot be loaded`、
    `reports a year the data bundle does not cover` —— 降级与年份缺失。
- `src/schedule.test.ts`：
  - `judges 2025 National Day as a holiday branch` —— 2025-10-01 判定分支 `holiday`；
  - `isModelAvailable: holiday branch` 下的 `gives holidays precedence and applies only
    holiday windows` —— 节假日只应用 `kind: 'holiday'` 的段；
  - `judges the 2025-10-11 makeup Saturday as a working day` —— 2025-10-11（调休周六）
    分支 `weekday`：`weekday` 段生效、`weekend` 段不生效；
  - `judges a makeup Saturday as a working day (weekday window applies)`、
    `keeps an ordinary Saturday on the weekend branch` —— 调休工作日 vs 普通周六；
  - `acceptance: disabled 09:00-00:30 window` 下的
    `blocks 09:00 and reports 00:30 of the following local day as the next available instant`
    与 `judges 01:00 on the same day as available` —— 与 §2/§3 的跨零点窗口/预计开始时间
    一致；
  - `returns null when the next available minute is past the 12-day scan` —— 12 天扫描上限
    （覆盖最长 9 天春节假期；整天被禁用的本地日整日跳过）；
  - `computes an ETA across the nine-day 2026 Spring Festival holiday` —— 2026 春节
    2/15–2/23 全时段禁用时，ETA 为 2/24 00:00 本地。

2025-09-28 / 2026-02-14 等日期在 `holidays.test.ts` 中作为数据断言；其「按工作日分支判
定」的语义由上面的调休周六用例统一覆盖（判定逻辑与具体日期无关）。

### 6.2 在线判定（任何一天都能做，验证「今天」）

> 注意：单段 `00:00-23:59` 会留下 23:59–24:00 这一分钟可用（结束是开区间）。要「整天
> 禁用」请加两段：`00:00-12:00` 与 `12:00-00:00`。下面用两段式。

1. 设置里给该模型加两段 `节假日` 禁用时段：`00:00-12:00` 与 `12:00-00:00`，保存。此时
   若今天不是节假日，模型应为「当前可用」。
2. 在「节假日」编辑器里加入**今天**的日期，保存。
3. 预期：模型立即变为「当前禁用」（分支 = `holiday`）；此刻提交需求 → 排队；ETA 为下
   一个非节假日日的 00:00（若次日仍在假期内则顺延；若同时配了工作日段，00:00 起可能
   继续被工作日段挡住，按实际计算）。Host 日志阻塞记录的 window 摘要为当时命中的节假日
   段（如 `holiday 00:00-12:00` 或 `holiday 12:00-00:00`）。
4. 把今天同时加入「调休上班日」，保存。
5. 预期：该日改按 **工作日** 判定 → 节假日段不再生效，模型变为「当前可用」；保存后
   §6.2 第 3 步提交的排队需求会被立即重新判定并出队（开始分析），此时再提交新需求会直
   接开始分析（若另配了覆盖 now 的工作日时段，则按工作日段排队）。
6. 清理：从两个列表里删掉今天的日期，删除该模型的两段 `节假日` 时段，保存；取消/忽略
   本次验证产生的需求。

### 6.3 内置开关

1. 保持 `启用内置中国法定节假日（含调休）` 开启；沿用 §6.2 的两段 `节假日` 时段（或重
   新加上）。若测试日恰为 2025/2026 内置数据命中的法定节假日，模型应为「当前禁用」，
   提交需求会以 `holiday` 分支排队（阻塞 window 摘要为 `holiday …`）。
2. 关闭该开关并保存：内置节假日/调休全部不参与（只剩手动列表 + 周末/工作日规则）。若
   今天恰为内置法定节假日，模型应从「当前禁用」变为「当前可用」（节假日段不再命中）；
   Host 日志**不**出现降级日志（这是用户显式关闭，不是数据不可用）。
3. 若当前年份不在数据覆盖范围（或数据不可用）：Host 日志出现且仅出现一次
   `[dsh-mate] holidays: no built-in holiday data for <year>; falling back to weekend-only rules`
   （数据不可用时为 `[dsh-mate] holidays: holiday data unavailable; falling back to weekend-only rules`），
   判定退化为「仅周末」，不报错、不影响提交（该路径也可由 `src/holidays.test.ts` 的
   `degrades to weekend-only rules when the data cannot be loaded` /
   `reports a year the data bundle does not cover` 与 `src/app.gate.test.ts` 的
   `judges built-in statutory holidays and 调休 workdays, and logs a weekend-only fallback`
   覆盖）。

## 7. (f) 队列上限拒绝（`queue-full`）

队列上限是 `MAX_QUEUE_LENGTH = 50`。人工造 50 条排队需求很慢，因此上限语义以上限用
例为准；人工步骤验证「用户可见的拒绝提示」。

1. 让分析持续被禁用（保持 §2 的窗口覆盖「现在」，且这些需求的 Mate 分析模型与 §2 配置
   的是同一条路由），并确认至少存在一个可用 Mate。
2. **推荐的手工做法（DevTools 循环提交，几十秒填满队列）**：在 Mate 面板页面的浏览器
   DevTools Console 里执行（与浏览器半相同的同源相对路径）。每条之间留一点时间，让后台
   闸门把上一条需求真正置为 `queued`（上限只统计已排队的需求）：

   ```js
   const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
   const results = []
   for (let i = 0; i < 51; i += 1) {
     const r = await fetch('api/dsh-mate/command', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ command: 'requirement.create', args: { brief: `cap-${i}` } }),
     }).then((res) => res.json())
     results.push(r)
     await sleep(100)
   }
   await sleep(500)
   console.log('created:', results.filter((r) => r.ok).length)            // 应为 50
   console.log('rejected:', results.filter((r) => !r.ok).map((r) => r.error)) // 应为 1 条 queue-full
   ```

   预期：前 50 条创建成功并排队（看板待确认列 50 张排队卡）；第 51 条返回
   `error.code === 'queue-full'`，**没有新卡片**、需求总数仍为 50、已排队的 50 条不受
   影响。
3. 验证用户可见文案：队列满后，在 UI 里再提交一条需求 → 界面显示错误/提示
   `排队队列已满（上限 50 条），请等已排队需求开始后再提交`（按当前界面语言；中文
   50 来自 `MAX_QUEUE_LENGTH`）。
4. 自动化入口（权威、可重复）：

   ```powershell
   pnpm exec vitest run --pool=threads src/app.gate.test.ts --reporter=verbose
   ```

   预期：用例 `rejects a new requirement once the FIFO queue reaches MAX_QUEUE_LENGTH`
   通过，断言「第 51 条创建被拒绝、错误码 `queue-full`、需求表仍为 50 条、未分配新的
   需求编号、已有排队项不受影响」。
5. 清理：在 UI 里逐条取消/删除排队需求，或把窗口改到「现在可用」让它们继续（费时，
   建议取消）。

## 8. (g) 全模型禁用横幅

1. 先清空队列（取消/删除所有排队需求），保证看板没有 **排队中** 卡片。
2. 在设置里把 `settings.modelCatalog` 中**每一条**模型路由都加满全天禁用时段：
   - 工作日：`00:00-12:00` + `12:00-00:00`；
   - 周末：`00:00-12:00` + `12:00-00:00`；
   - 节假日：`00:00-12:00` + `12:00-00:00`。

   （单段 `00:00-23:59` 会留下 23:59 这一分钟可用，所以用两段式。）手动逐条配置较慢
   时，可在 DevTools Console 用当前快照的目录一次性生成并保存：

   ```js
   const state = await fetch('api/dsh-mate/state', {
     method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
   }).then((r) => r.json())
   const snap = state.value.snapshot
   const fullDay = (kind) => [
     { kind, start: '00:00', end: '12:00' },
     { kind, start: '12:00', end: '00:00' },
   ]
   const seen = new Set()
   const models = []
   for (const group of snap.settings.modelCatalog) {
     for (const entry of group.models) {
       const key = `${group.provider}\u0000${entry.id}`
       if (seen.has(key)) continue
       seen.add(key)
       models.push({
         provider: group.provider,
         model: entry.id,
         disabledWindows: [...fullDay('weekday'), ...fullDay('weekend'), ...fullDay('holiday')],
       })
     }
   }
   await fetch('api/dsh-mate/command', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       command: 'settings.update',
       args: { schedule: { ...snap.settings.schedule, models } },
     }),
   }).then((r) => r.json())
   ```

   清理时用同样方式把 `models` 换成 `[]`（或在设置里逐个删除）。
3. 预期（等待一个轮询周期，默认 2.5s）：
   - 面板顶部出现横幅：`当前无可用模型，新需求将排队等待`；
   - 该横幅只在「目录非空且所有路由都不可用」时出现，不影响设置页打开。
4. 此时提交一条需求：
   - 需求创建成功并排队；横幅变为：`当前无可用模型，已排队`（已知最早预计开始时间时，
     横幅第二行显示 `预计 MM/DD HH:mm 开始`）；
   - 与 §3 的排队徽标同时存在，文案不重复报错。
5. 清理：删除所有全天禁用时段并保存（或用上面的 Console 方式把 `models` 置空）→ 横幅
   消失；排队需求在立即重算后开始分析/派发（若不想让它们全部跑起来，先取消/删除这些
   需求）。
6. 自动化对照：
   - Host 闸门/队列：`src/app.gate.test.ts` 的
     `makes zero model calls while every model is disabled, then resumes analysis and dispatch`；
   - 横幅判定（全目录不可用 + 最早开始时间）：`src/client/scheduleDraft.test.ts` 的
     `catalog availability summary` 系列（含内置节假日/调休日历）；
   - 横幅文案键 `panel.noModel.queued` / `panel.noModel.queueing` 目前在
     `src/client/locales.ts` 与 `src/client/panel.tsx` 中静态核对（本仓库无 DOM 渲染测试）。

## 9. 收尾与重置

1. 删除所有时段、节假日/调休手动项，恢复 `useBuiltinHolidays` 开启，保存。
2. 取消/删除本次验收创建的需求与执行会话（按需）。取消排队中的需求会清空其排队信息并
   立即释放一个队列名额；取消后卡片不应再显示「排队等待 · 预计 HH:mm 开始」徽标。
3. 停止 `dsh dev`；如需清理 dev profile：`dsh plugin --profile dev remove dsh-mate`（可
   选，保留则下次直接复用）。
4. 若中途临时改过源码/配置（不建议），确认 `git status` 只有预期的 `docs/`、`README.md`
   改动，`src/` 无验收残留。

## 验收记录表

| 步骤 | 关键预期 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| (a) 时段配置 | 保存后能看到「工作日 09:00–00:30」时段行（悬浮 `weekday 09:00-00:30`），配置落盘 |  |  |
| (b) 窗内提交 | 状态 `queued`、0 次模型调用、ETA = 次日 00:30（标准场景）/ `$END`、1 条 `gate: … queued` 日志 |  |  |
| (c) 重启恢复 | 需求仍排队、ETA/`enqueuedAt` 不变、无重复分析 |  |  |
| (d) 跨窗口 | 改配置立即重算；到点 `dequeued for analyze` 一次；自动分析 → 派发 |  |  |
| (e) 节假日/调休 | 2025-10-01=holiday、2025-10-11=weekday、手动覆盖优先级、内置开关、降级日志一次 |  |  |
| (f) 队列上限 | 第 51 条拒绝、错误码 `queue-full`、提示文案正确、已有队列不变 |  |  |
| (g) 全模型禁用 | 横幅文案（无排队/已排队两态）正确、提交仍可用 |  |  |
| 整体 | `pnpm typecheck` + `pnpm exec vitest run --pool=threads` 全绿 |  |  |
