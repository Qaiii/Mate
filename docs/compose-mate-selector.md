# 发送需求：Mate 选择器与「上次选择」记忆

「发送需求」弹窗（`ComposeDialog`，标题「发送需求」）里的 Mate 选择器会自动记住上次选中的 Mate，下次打开时默认选中它，省去重复选择。

本文说明选择器的交互规则、浏览器本地存储契约、回退与异常兜底，以及如何验证。

## 交互规则

- **常驻可见**：选择器始终显示在弹窗中，不再只在「有多个 Mate」时出现。
- **可选项**：来自 `snapshot.mates` 中未归档的 Mate，与看板 Mate 列表一致；已归档或已删除的 Mate 不会出现在选项里。
- **默认选中**：每次打开弹窗时按下方「回退规则」计算初始选中项。
- **即时持久化**：用户在选择器中切换 Mate 时立刻写入本地存储，不需要点发送。
- **空列表**：没有任何可用 Mate 时选择器禁用并显示占位项；发送按钮保持原有禁用行为（无 Mate 时无法发送）。
- **提交**：发送时把所选 Mate 随 `requirement.create` 请求提交，字段名为 `mateId`：

```ts
// requirement.create payload
{ brief, mateId, projectSource, projectPath, projectTitle? }
```

Host 半已经支持 `args.mateId`，本次不需要修改 Host。

## 存储契约

- **位置**：浏览器 `localStorage`（仅当前浏览器 profile 内有效，不写入插件自己的 storage domain）。
- **key**：`dsh-mate.compose.last-mate.v1`（带版本前缀）。
- **value**：JSON 字符串，结构固定为：

```json
{"version":1,"mateId":"<mate id>"}
```

- **写入时机**：用户在选择器中切换 Mate 时写入；只写非空 `mateId`，写失败静默忽略。
- **读取时机**：每次打开发送需求弹窗时读取，而不是模块加载时缓存一次。因此其它标签页写入的新值会在本标签页下次打开弹窗时生效。
- **代码位置**：
  - 存储封装：`src/client/compose.ts`
  - UI 接入点：`src/client/dialogs.tsx` 的 `ComposeDialog`
  - 单元测试：`src/client/compose.test.ts`

## 回退规则

打开发送需求弹窗时，按以下顺序决定初始选中项：

1. 存储中的 `mateId` 仍在当前可用 Mate 列表中 → 选中它（优先于「设置」里的默认 Mate）
2. 否则使用「设置 → 默认 Mate」（`settings.defaultMateId`），若它仍存在
3. 否则使用可用列表的第一项
4. 列表为空 → 无选中值，选择器禁用，发送按钮保持原有禁用行为

「可用 Mate 列表」指 `snapshot.mates` 中未归档的 Mate。

## 异常兜底

以下情况全部静默处理：不弹错误提示、不崩溃，统一走上面的回退规则：

- `localStorage` 不可用（隐私模式、浏览器禁用存储、非浏览器环境）
- `getItem` / `setItem` 抛异常
- 存储值不是 JSON、JSON 损坏
- 缺少字段、`version` 不是 `1`、`mateId` 不是非空字符串
- 存储的 Mate 已被归档或删除（失效条目）

读不到可用的存储值时，视为「没有上次选择」，直接按回退规则处理。

## 多标签页

- `localStorage` 在所有标签页之间共享，写冲突按「后写覆盖先写」（last write wins）。
- 每次打开发送需求弹窗都会读取最新值，因此后写的选择会在其它标签页下次打开弹窗时生效。
- 不做跨标签页实时推送：弹窗已经打开时不会被动改选，这是预期行为。

## 手动重置

- 打开 DevTools → **Application → Local Storage**，删除 key `dsh-mate.compose.last-mate.v1`；或清除站点数据。下次打开发送需求弹窗会回退到「设置 → 默认 Mate」（未设置则为 Mate 列表第一项）。
- 也可以手动写入非法值（例如 `{bad json`、`{"version":2}`、一个已失效的 Mate id）来验证回退：不会报错，选择器按回退规则选中可用项。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

手工自测清单：

| 场景 | 预期 |
| --- | --- |
| 首次使用（清空 localStorage） | 默认选中「设置 → 默认 Mate」（未设置则选中列表第一项）；填写需求描述后发送按钮可用 |
| 选择 Mate B 后关闭再打开 / 刷新页面 | 默认选中 B |
| storage 写入非法值（`{bad json`、`{"version":2}`、失效 Mate id） | 正常回退，无错误提示 |
| 空 Mate 列表 | 选择器禁用，不崩溃 |
| 多标签页：标签页 A 选 B、标签页 B 选 C | 后写覆盖；新打开弹窗读到 C |
