# versioning_and_sync_types 模块说明

`versioning_and_sync_types` 定义了一组“版本化存储语义的数据载体”，用于描述历史、差异、冲突、远端与同步状态。它不执行同步算法，也不处理 I/O；它的职责是给上层和后端之间提供**统一的状态语言**。

## 核心心智模型

可以把这些结构体理解为五类“状态快照卡片”：

- `HistoryEntry`：某个 commit 时刻的 issue 快照
- `DiffEntry`：两个 commit 之间的变化对比
- `Conflict`：合并冲突的字段级描述
- `RemoteInfo` / `FederationPeer`：远端连接与认证描述
- `SyncStatus`：本地与对端相对进度（ahead/behind）

## 关键组件

### `HistoryEntry`
表示“某一历史点上的 issue 状态”，字段包括 `CommitHash`、`Committer`、`CommitDate`、`Issue`。这让历史查询结果既带版本元信息，也带业务实体内容。

### `DiffEntry`
表示提交间差异：`IssueID` + `DiffType`（`"added"` / `"modified"` / `"removed"`）+ `OldValue` / `NewValue`。这种建模适合 UI、CLI 或同步审计直接消费。

### `Conflict`
描述冲突点：`IssueID`、`Field`、`OursValue`、`TheirsValue`。其中 `Field` 允许为空（注释说明 table-level 冲突），因此调用方不能假设一定是字段粒度。

### `RemoteInfo`
最小远端描述（`Name` + `URL`），用于列举 remotes 或基础配置展示。

### `SyncStatus`
同步健康度快照：`Peer`、`LastSync`、`LocalAhead`、`LocalBehind`、`HasConflicts`。它把同步问题从“日志文本”提升为结构化可观测数据。

### `FederationPeer`
面向联邦同步场景的远端定义，包含 `RemoteURL`、`Username`、`Password`、`Sovereignty`、`LastSync`、`CreatedAt`、`UpdatedAt`。注意注释明确 `Password` 是解密后的运行态值，不是存储格式说明。

## 设计取舍

- 这些类型都偏“DTO/契约”而非行为对象，简洁但不封装业务逻辑。
- `Conflict` 的值字段用 `interface{}`，提高通用性，但牺牲编译期类型安全。
- `FederationPeer` 直接包含认证字段，提升调用便捷性，但对日志脱敏、内存生命周期管理提出更高要求。

## 与其他模块关系

- 与 [Storage Interfaces](Storage Interfaces.md) 同属接口语义层。
- 由具体后端（例如 [Dolt Storage Backend](dolt_storage_backend.md)）生产或消费。
- 结果常被 CLI/同步流程用于展示与决策。
