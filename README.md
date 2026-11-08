# Mate

DeepSeek Harness 的「项目经理」插件：可增删的 **Mate**（各自绑定模型与工作风格）把一句话需求分析成方案，按确认制或自动制派发到目标项目的会话，跟踪执行并在结束时汇总验收。

- Host 半：需求生命周期、模型调用、会话派发与对账、持久化。
- Web 半：一级侧边栏入口 **Mate** + 全宽看板面板。
- 数据落在 `~/.dsh/storages/mate.json`（插件自有 storage domain）。

## 功能

- **多个 Mate**：新建 / 编辑 / 归档 / 删除。名称既是显示名，也是它在对话里的自称；模型在一个按 provider 分组的列表里选。
- **Mate 记忆**：告诉它角色、限制、偏好或术语（可 Ctrl/⌘+Enter），它会用模型把这些话提炼成带分类的记忆条目存下来，之后每次分析都带上；每条可单独「忘记」。
- **一条输入就够**：发送时只写需求本身，标题由 Mate 起、项目由 Mate 选（看板当前项目页签作为上下文），优先级也由 Mate 判断；`Ctrl/⌘ + Enter` 发送。
- **需求本身就是一段会话**：Mate 理解后直接派发；理解不了或需要决策时，就在需求抽屉里连续讨论，直到可以派发。
- **看板**：`待确认 / 进行中 / 待验收 / 已完成 / 异常` 五列，项目是看板顶部的页签（带运行中标记），点「看板/列表」随时切换；看板不做状态筛选，列表保留。
- **需求卡片带会话入口**：已派发的卡片上有会话 chip，点它在右侧抽屉里预览该会话（最近 80 条消息），抽屉里可打开完整会话。
- **已有会话按状态上板**：Mate 未跟踪的会话以虚线卡并入对应列——运行中进 `进行中`，空闲（最近 24 小时）进 `已完成`。卡片上没有按钮，点开即右侧抽屉预览会话内容；抽屉里可「打开会话」「登记为需求」（接管跟踪，不改动会话本身）或「不再显示」；隐藏的会话可在设置里恢复。
- **派发模型限制**：可给 Mate 指定允许派发会话使用的「模型 × 思考强度」清单（留空则不限制）；每个模型的强度选项取自该模型自身的能力，分析时只会从清单里选，派发前还会再校验一次。
- **派生模型由 Mate 决定**：分析结果里由 Mate 选定实现会话用的模型，用户不再手填；只有需求文本里明确要求时才覆盖。
- **拆分由 Mate 判断**：Mate 认为一条需求太大时给出拆分建议，父项变「目标」只做进度汇总，不直接派发。
- **两种执行方式**：`auto`（默认）理解后直接派发、不懂就先讨论；`confirm` 每次派发都要你点确认。
- **模型可用时段调度**：按 provider/model 配置「禁用时间段」（工作日 / 周末 / 节假日 / 指定星期 + 起止时间，`end < start` 表示跨零点），并维护节假日日期列表（单个日期 / 区间 / 按年批量录入，纯本地）。在禁用时段内**分析需求与派活都不会发起模型调用**：需求进入 FIFO 队列并记录下一次可用时段的开始时间，到点自动唤醒继续处理；不会为了绕开时段而换用别的模型。设置页显示当前生效时区（手动 / DSH 客户端 / Host 本地）及其来源。

## 安装（桌面版）

```powershell
# 关闭 DeepSeek Harness 后执行
dsh plugin --profile desktop add -w D:\CodeProject\Deepseek-Harness-Plugins\Mate
```

或：桌面版侧边栏 **Plugins → Add plugin**，spec 填本仓库绝对路径。

启动桌面版后，侧边栏出现 **Mate** 图标。插件代码变更后需要 `pnpm build` 并**重启桌面版**（桌面版不加载 client HMR）。

## 开发

```powershell
pnpm install
pnpm build        # lib/index.mjs（Host） + lib/client.js（浏览器）
pnpm typecheck
pnpm test
```

快速验证循环（独立 profile，不碰桌面版）：

```powershell
dsh dev --from-default-profile web
dsh plugin --profile dev add -w .
dsh dev --no-open --port 3099
```

`lib/client.js` 必须保持 `window.__ModuleLoader__.load({ id: 'dsh-mate', factory: (require) => … })` 契约；平台模块（react / cordis / zod / dsh-client-*）走 `dsh.client.inject` 与 `require`，不打进包。

## 数据与接口

- Host 路由（`connection` 的精确 Fetch 路由）：`POST /api/dsh-mate/state`、`POST /api/dsh-mate/command`、`POST /api/dsh-mate/ping`。统一信封 `{ok, value}` / `{ok:false, error:{code,message,detail}}`。
- 浏览器半 2.5s 轮询 `state`（`rev` 未变只回 `unchanged`），命令后立即刷新。
- 时段/节假日配置存在 storage domain 的 global（`mate.json`），排队需求连同 `queue` 字段存在 `requirements` 表；`state` 请求携带浏览器 IANA 时区（供 Host 在没有手动覆盖时使用），`settings.update` 接收整份 `schedule` 并做服务端校验（非法返回 `schedule-invalid`）。
- 不写自定义会话事件、不自建 `ctx.remote` 命名空间：状态全在 storage domain，会话控制全部走 `ctx.sessionController`。

## 状态机

```
draft → analyzing → proposed ──confirm──→ approved → running → awaiting_review → done
              │  └→ clarifying ──answer─→ analyzing          │        └→ approved(打回)
              │  └→ (auto 且置信足够) → approved
              │  └→ 模型时段不可用 → queued ──时段开启──→ analyzing / approved
              └→ failed(异常)                                   cancelled(异常)
```

## 自检与诊断

- 面板渲染出错时显示错误信息与「重试」，不会整块空白；错误同时打印到浏览器控制台（`[dsh-mate] panel crashed`）。
- **设置**弹窗显示插件版本、Host 启动时间（`lastStartedAt`）、可见会话数与 Mate 数，并提供「测试连接」按钮。桌面版重启后若「Host 启动时间」仍停在旧值，说明 Host 半没有重新加载。
- Host 半初始化失败会打印 `[dsh-mate] initialization failed: …`，同时面板会显示 `starting` 错误。

## 已知限制

- 派发完成判定基于 `api-session/status` + 15s 对账（`state.pendingInput`），不是精确 turn 边界；刚派发的 20s 内不判定完成。
- 自动汇总依赖可选的 `sessionQuery` 服务；缺失时摘要只基于需求与方案。
- 时段闸门只作用于「需求分析」和「派活」两个动作；已派发会话结束后的自动汇总调用不排队（在途会话也绝不受时段结束影响）。
- 跨零点时段按「瞬时本地日期」判定：工作日的 `22:00-06:00` 覆盖周一~周五的 22:00-24:00 与 00:00-06:00，周五午夜之后按周末规则判定；需要覆盖周末凌晨时给周末单独配一段。
- 拆分出的子需求各自独立分析/派发；父「目标」的完成需要手动接受。
- 仅供本机使用；没有多人协作、跨机同步、费用估算。

## 兼容性

已实测运行于 `@deepseek-ai/dsh` **0.2.1-rc.5** 与 **0.2.2-rc.1**（桌面版 0.2.2-rc.1 上完整跑通 分析 → 派发 → 会话执行 → 汇总 → 验收；`pnpm typecheck` 对 0.2.2-rc.1 的 SDK 类型通过）。

- `engines.dsh: >=0.2.1-rc.5 <0.3.0`；peer 依赖同为 `>=0.2.1-rc.5 <0.3.0`。
- 运行时依赖：`@deepseek-ai/cordis ^4.0.5`（实测 4.1.0）、`@deepseek-ai/schemastery ^3.18.5`（实测 3.19.0）。
- 升级 DSH 后重点核对：`main` / `sidebar.panellist` 槽位、`connection.fetch.register`、`sessionController` 方法签名、`storageDomain` 域格式、`api-session/*` 事件。

## 许可

MIT




