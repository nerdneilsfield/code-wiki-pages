# history_and_conflicts（`internal/storage/dolt/history.go`）

这个子模块是 Dolt backend 的“法务档案室 + 冲突仲裁入口”。如果说 `store.go` 负责“现在怎么写”，这里负责“过去发生了什么”和“分叉后怎么收敛”。

## 为什么存在

普通数据库的历史通常靠审计表或事件日志补齐；而 Dolt 原生提供版本化查询（`dolt_history_*`、`AS OF`、`dolt_conflicts`）。这个模块的价值在于把这些底层能力变成稳定 API，同时补齐两个现实问题：

1. **安全拼接问题**：`AS OF 'ref'`、`DOLT_CONFLICTS_RESOLVE('table')` 这类语句无法完全参数化，必须做输入校验。
2. **数据反序列化问题**：历史表里有些时间字段是 TEXT，需要手动解析，不然上层会拿到不一致时间语义。

## 核心心智模型

可以把它想成“Git blame + SQL 版冲突工具”的组合：

- `getIssueHistory`：看某个 issue 的变更年表。
- `getIssueAsOf`：把仓库时间线拨到某个 ref，读取当时快照。
- `getInternalConflicts` / `ResolveConflicts`：查看并处理当前 merge 冲突。
- `validateRef` / `validateTableName` / `ValidateDatabaseName`：在“必须拼字符串”的地方加防火墙。

## 关键注意点

- `validateRef` 使用 `^[a-zA-Z0-9_\-]+$`，故不支持任意复杂 ref 表达式；这是安全优先的取舍。
- `getIssueAsOf` 用 `fmt.Sprintf` 拼接 ref 是**有意**行为，前提是先 `validateRef`。
- `ResolveConflicts` 仅支持 `ours` / `theirs` 两种策略，未知策略直接报错。
- 冲突读取走 `dolt_conflicts` 表，返回的是表级冲突计数（`tableConflict`），而不是字段级细节。

## 与主模块关系

这个子模块被 `DoltStore` 的 merge/sync 路径复用，特别是 [federation_sync](federation_sync.md) 在自动/手动冲突处理时依赖 `GetConflicts` 与 `ResolveConflicts` 语义。
