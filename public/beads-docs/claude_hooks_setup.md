# claude_hooks_setup

`claude_hooks_setup` 的职责是：把 `bd prime` 命令安全注入 Claude Code 的 hook 配置（`settings.json`），并支持安装、检测、移除三个生命周期动作。你可以把它理解为“配置层的运维脚本引擎”：不实现业务功能，只负责把 beads 的初始化动作准确接入 Claude 的事件点。

## 问题与设计动机

Claude 配置是用户本地 JSON，常见状态是“已有自定义 hooks + 结构不完全统一”。直接覆盖文件会破坏用户配置；只做字符串拼接又容易重复注入。该子模块的核心目标是：

- 增量修改（只碰 `hooks`）
- 幂等安装（重复执行不重复添加）
- 精准移除（只删 beads 命令）
- 读写安全（原子写，避免中断损坏）

## 核心组件

### `type claudeEnv`

环境注入容器，包含：
- 输出通道：`stdout`, `stderr`
- 路径上下文：`homeDir`, `projectDir`
- 文件系统能力：`ensureDir`, `readFile`, `writeFile`

这是一种轻量 DI（依赖注入）模式：让 `installClaude/checkClaude/removeClaude` 可测试、可替换。

## 关键函数

### `defaultClaudeEnv() (claudeEnv, error)`

获取 home/workdir，并绑定默认实现：`EnsureDir`、`os.ReadFile`、`atomicWriteFile`。

### `projectSettingsPath(base string)` / `globalSettingsPath(home string)`

将“项目级 vs 全局级”路径策略显式化：
- 项目：`<project>/.claude/settings.local.json`
- 全局：`<home>/.claude/settings.json`

### `InstallClaude(project bool, stealth bool)`

CLI 入口包装：构造 env，调用 `installClaude`，失败时 `setupExit(1)`。

### `installClaude(env, project, stealth) error`

主流程：

1. 解析目标 settings 路径
2. `ensureDir` 创建目录
3. 读取并反序列化已有 JSON（不存在则空配置）
4. 规范化 `settings["hooks"]`
5. 清理历史 `nil` 值（GH#955 相关兼容）
6. 根据 `stealth` 选择命令：`bd prime` 或 `bd prime --stealth`
7. 调 `addHookCommand` 注入 `SessionStart`、`PreCompact`
8. `MarshalIndent` + 原子写回

### `CheckClaude()` / `checkClaude(env) error`

检查逻辑按“全局优先、项目次之”扫描：
- 命中任一位置即认为已安装
- 均未命中返回 `errClaudeHooksMissing`

### `RemoveClaude(project bool)` / `removeClaude(env, project) error`

移除时只删除 2 个事件 × 2 个命令变体：
- `SessionStart` / `PreCompact`
- `bd prime` / `bd prime --stealth`

并保留其他非 beads hooks。

### `addHookCommand(hooks, event, command) bool`

共享辅助函数（同包复用）：
- 若命令已存在，返回 `false`
- 不存在则创建标准 hook 对象并 append

### `removeHookCommand(hooks, event, command)`

按命令精确过滤。
若某事件下过滤后为空，会删除事件键（GH#955 中强调的“不要遗留空数组/异常结构”）。

### `hasBeadsHooks(settingsPath string) bool`

宽松探测器：解析 JSON，检查 `SessionStart` 和 `PreCompact` 中是否存在 `bd prime` 变体。

## 设计取舍

- 使用 `map[string]interface{}` 而非强类型 schema：兼容性强、迭代快；代价是类型断言多、编译期保障弱。
- 检查逻辑采用“存在即成功”而非严格校验双事件完整性：用户体验更宽容；代价是无法发现“半安装”细节。
- 复用 `addHookCommand/removeHookCommand`：减少重复；代价是与 Gemini 模块形成共享契约耦合。

## 新人注意事项

1. `addHookCommand/removeHookCommand` 内部直接 `fmt.Printf`，输出不走 `env.stdout`，测试捕获输出时要注意。
2. `hasBeadsHooks` 直接 `os.ReadFile`，不使用 env 注入读取器，测试替身能力弱于安装/移除路径。
3. 事件名是关键契约：Claude 用 `PreCompact`，不要和 Gemini 的 `PreCompress` 混淆。

## 相关文档

- [CLI Setup Commands](CLI Setup Commands.md)
- [gemini_hooks_setup](gemini_hooks_setup.md)
- [CLI Hook Commands](CLI Hook Commands.md)
