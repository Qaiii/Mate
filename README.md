# Mate

DeepSeek Harness 的「项目经理」插件：可增删的 **Mate**（各自绑定模型与工作风格）把一句话需求分析成方案，按确认制或自动制派发到目标项目的会话，跟踪执行并在结束时汇总验收。

- Host 半：需求生命周期、模型调用、会话派发与对账、持久化。
- Web 半：一级侧边栏入口 **Mate** + 全宽看板面板。
- 数据落在 `~/.dsh/storages/mate.json`（插件自有 storage domain）。

## 功能

- **多个 Mate**：新建 / 编辑 / 归档 / 删除；可分别指定分析用模型，以及派发到会话时为目标 session 指定的模型与思考强度。
- **看板**：`待确认 / 进行中 / 待验收 / 已完成 / 异常` 五列；另有列表视图；按 Mate、项目、状态、关键词筛选；顶部「活跃现场」条直接显示各项目正在运行的会话。
- **需求流水线**：新建 → 分析（摘要 / 工作项 / 验收点 / 风险 / 疑问 / 拆分建议）→ 确认 → 派发 → 跟踪 → 自动汇总 → 接受或打回。
- **两种执行方式**：`confirm` 必须点「确认并派发」；`auto` 在模型置信度 ≥ 阈值且无待答问题时直接派发，否则进入「澄清中」把问题抛给你，回答后带对话重新分析。
- **拆分**：方案可拆成多个子需求（父项变「目标」，只做进度汇总，不直接派发）。

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
- 不写自定义会话事件、不自建 `ctx.remote` 命名空间：状态全在 storage domain，会话控制全部走 `ctx.sessionController`。

## 状态机

```
draft → analyzing → proposed ──confirm──→ approved → running → awaiting_review → done
              │  └→ clarifying ──answer─→ analyzing          │        └→ approved(打回)
              │  └→ (auto 且置信足够) → approved
              └→ failed(异常)                                   cancelled(异常)
```

## 已知限制

- 派发完成判定基于 `api-session/status` + 15s 对账（`state.pendingInput`），不是精确 turn 边界；刚派发的 20s 内不判定完成。
- 自动汇总依赖可选的 `sessionQuery` 服务；缺失时摘要只基于需求与方案。
- 拆分出的子需求各自独立分析/派发；父「目标」的完成需要手动接受。
- 仅供本机使用；没有多人协作、跨机同步、费用估算。

## 兼容性

针对 `@deepseek-ai/dsh` **0.2.1-rc.5**（`engines.dsh: >=0.2.1-rc.5 <0.3.0`）。升级 DSH 后重点核对：`main` / `sidebar.panellist` 槽位、`connection.fetch.register`、`sessionController` 方法签名、`storageDomain` 域格式。

## 许可

MIT
