# maintenance_and_repository_hygiene 模块深潜

这个子模块负责“把仓库维持在可持续状态”：`cleanup` 清理闭环生命周期数据、`reset` 做彻底卸载、`detect-pollution` 发现测试污染、`preflight` 做提交前体检。它像运维中的保洁和巡检系统：平时不显眼，但一旦缺席，系统会迅速堆积隐患。

## 架构角色

这是 CLI 里的**维护策略执行层**：

- 输入是运维意图（删什么、是否强制、是否 dry-run）；
- 中间是安全护栏（`--force`、确认提示、备份、只读检查）；
- 输出是可审计结果（JSON 或终端摘要）。

## 核心结构

### `CleanupEmptyResponse`

当没有可删 closed issue 时返回该结构，避免空输出不明确。字段 `Filter` 与 `Ephemeral` 让调用方知道“为什么是 0（筛选太严还是本来就没数据）”。

### `resetItem`

`bd reset` 的删除计划单元。每一项包含 `Type/Path/Description`，用于 dry-run 预览和实际执行。它把“将要删除什么”显式结构化，降低误操作。

### `pollutionResult`

测试污染检测结果项：包含 issue 本体、置信分数、命中原因。这个结构使污染清理变成“可解释判定”而不是黑盒删除。

### `CheckResult` / `PreflightResult`

`preflight` 的检查管道输出。`CheckResult` 是单项，`PreflightResult` 是总览，支持 `Passed/Skipped/Warning` 三态。

## 关键流程

### `cleanup`

流程：构建 closed filter（可附加 `older-than`、`ephemeral`）→ 查询 → 排除 pinned → `--force/--dry-run` 保护 → 调用批量删除逻辑。

关键点：

- 默认不会执行破坏操作，除非明确 `--force`；
- pinned issue 被保护，不进入删除集合；
- 命令强调“生命周期清理”，不是全面修复（修复建议走 doctor）。

### `reset`

`runReset` 先收集删除项（hooks、merge driver config、.gitattributes、worktrees、.beads），默认只展示预览；`--force` 才真正执行。

非显然设计：

- hook 删除前会识别是不是 beads hook（`isBdHook`），避免误删用户自定义 hook；
- 删除 hook 后尝试恢复 `.backup`；
- `.gitattributes` 修改是细粒度移除 beads 条目，不是粗暴覆盖。

### `detect-pollution`

使用启发式打分识别测试 issue：标题前缀、描述长度、顺序模式、同分钟批量创建等。分数 >= 0.7 才纳入结果。

清理路径带两层保险：

1. 交互确认（可 `--yes` 跳过）；
2. 删除前备份到 `.beads/pollution-backup.jsonl`。

并且命令已标记 deprecated，建议迁移到 `bd doctor --check=pollution`。

### `preflight`

`--check` 模式会顺序运行：

- `go test -short ./...`
- `golangci-lint run ./...`
- `go.sum` 变更检查（提示 vendorHash 风险）
- `version.go` 与 `default.nix` 版本一致性检查

若存在硬失败，命令 `os.Exit(1)`，便于 CI 直接消费。

## 设计取舍

1. **安全优先**：reset/cleanup/pollution 都强调 dry-run、force、确认、备份。
2. **可解释优先**：污染检测输出 reasons；preflight 输出 command 与截断日志。
3. **工程务实**：preflight 直接调用外部命令，不封装复杂执行引擎，便于理解但依赖本地环境一致性。

## 新贡献者注意

- 维护命令的默认行为通常是“只预览不破坏”，改动时不要破坏这个心理契约。
- `detect-pollution` 是 deprecated，新增能力优先考虑 doctor 路径。
- `reset` 会涉及 git hooks 与 worktree 共享目录，路径处理必须谨慎。
- preflight 的 `Skipped`/`Warning` 语义不同于 `Failed`，输出和退出码要保持一致。

## 关联模块

- [CLI Doctor Commands](CLI Doctor Commands.md)
- [Storage Interfaces](Storage Interfaces.md)
- [Dolt Storage Backend](Dolt Storage Backend.md)
- [Beads Repository Context](Beads Repository Context.md)
