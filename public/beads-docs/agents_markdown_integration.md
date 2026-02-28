# agents_markdown_integration

这个子模块围绕 `AGENTS.md` 做一件很工程化但非常关键的事：**把 beads 给 AI agent 的协作说明，以“可重复、可升级、可回滚”的方式注入到项目文档中**。它不是简单地 `append` 一段文本，而是通过 begin/end marker 管理一个受控片段，尽量不碰用户已有内容。

## 解决的问题

如果团队直接让用户手工复制粘贴 beads 说明，会出现三个老问题：

1. 文档版本漂移（每个仓库内容不一致）
2. 升级困难（无法自动替换旧说明）
3. 误删/误改风险（覆盖用户自己写的 AGENTS 指南）

`agents_markdown_integration` 的策略是把 beads 片段当作“托管区块”管理：
- 有则更新
- 无则追加
- 文件不存在则生成基础模板

## 核心组件

### `type agentsEnv`

运行环境抽象，封装了：
- `agentsPath`
- `stdout`
- `stderr`

这让主逻辑（安装/检查/移除）不用硬编码标准 I/O 和文件路径，便于测试替换。

### `type agentsIntegration`

集成元信息容器：
- `name`
- `setupCommand`
- `readHint`
- `docsURL`

它把“同一套 AGENTS 文件操作逻辑”参数化为不同集成文案，减少重复分支。

## 关键函数与内部机制

### `defaultAgentsEnv() agentsEnv`

返回默认环境：`AGENTS.md` + `os.Stdout/os.Stderr`。这是 CLI 场景的默认落点。

### `installAgents(env, integration) error`

安装流程是该子模块主路径：

1. 读取 `env.agentsPath`
2. 生成 beads 片段：`agents.EmbeddedBeadsSection()`
3. 分三种情况处理：
   - 文件存在且包含 marker：`updateBeadsSection`
   - 文件存在但无 marker：追加 beads 片段
   - 文件不存在/空：`createNewAgentsFile`
4. `atomicWriteFile` 原子写回
5. 打印引导信息（`readHint` / `docsURL`）

这相当于“文本级 migration”。不是全量重写，而是最小改动更新。

### `checkAgents(env, integration) error`

检查路径：
- 文件不存在 → 返回 `errAgentsFileMissing`
- 文件存在且有 marker → 通过
- 文件存在但无 marker → 返回 `errBeadsSectionMissing`

这里用哨兵错误表达状态，调用方可以据此决定退出码与提示文案。

### `removeAgents(env, integration) error`

移除策略是“只删托管区块，不动其他内容”：

1. 文件不存在直接成功返回
2. 找不到 marker 也成功返回
3. 找到 marker 则 `removeBeadsSection`
4. 原子写回

这是典型的“可逆补丁”设计。

### `updateBeadsSection(content string) string`

用 begin/end marker 定位区间并替换。若 marker 异常（缺失、顺序反转）就退化为追加，避免破坏用户已有文本。

### `removeBeadsSection(content string) string`

只移除 marker 包围区间，且最多吞掉一个紧邻结尾换行。注释明确说明：**不 trim 周边空白**，目的是最大限度保护非托管内容。

### `createNewAgentsFile() string`

生成基础 `AGENTS.md` 模板，并插入 beads 片段。模板包含 Build/Test、Architecture、Conventions 占位段落，降低“新仓库首次接入”的心智负担。

## 设计取舍

- 选择 marker 托管，而不是 AST/Markdown 结构化编辑：实现简单、容错高；代价是对 marker 文字强依赖。
- 选择原子写入，而不是直接覆盖：正确性优先；代价是实现稍复杂。
- 选择宽松退化（marker 异常时追加）而不是硬失败：用户体验更平滑；代价是可能留下历史坏片段，需要人工清理。

## 易踩坑

1. **marker 是隐式契约**：改 `agentsBeginMarker/agentsEndMarker` 会让升级与移除失效。
2. `updateBeadsSection` 用 `strings.Index` 找第一组 marker；若用户手工复制出多组 marker，行为可能不是你预期的“最后一组”。
3. `installAgents` 依赖 `internal/templates/agents.EmbeddedBeadsSection()` 的输出稳定性；模板改动会直接影响所有仓库接入结果。

## 相关文档

- [CLI Setup Commands](CLI Setup Commands.md)
- [CLI Hook Commands](CLI Hook Commands.md)
- [Hooks](Hooks.md)
