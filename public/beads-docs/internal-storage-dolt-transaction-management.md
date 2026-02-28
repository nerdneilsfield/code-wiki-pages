# Transaction Management 模块技术深度分析

## 模块概述

`transaction_management` 是 Beads 项目中负责数据库事务管理的核心模块，它位于 `internal/storage/dolt/transaction.go` 文件中。这个模块解决的问题可能看起来很直接——提供数据库事务支持——但其实现涉及一个关键的设计挑战：**如何在传统 ACID 事务语义与 Dolt 版本控制系统（一个 Git 风格的 SQL 数据库）之间建立桥梁**。

想象一下，你经营一家使用 Git 作为版本控制系统的公司。每当你完成一项工作，你不仅要确保数据被保存到数据库（就像普通的事务提交），还要创建一个 Git 提交来记录这次变更的历史。这就是 `doltTransaction` 所做的事情：它把一个普通的 SQL 事务包装起来，在事务成功提交后，自动创建一个 Dolt 版本提交，使得所有的数据变更都能被版本化追踪。

## 架构与数据流

### 核心组件角色

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DoltStore                                       │
│  - 管理 sql.DB 连接池                                                        │
│  - 提供 RunInTransaction 入口点                                              │
│  - 维护版本控制配置（committer, remote, branch）                              │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      │ 创建事务
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        doltTransaction                                       │
│  - 封装 sql.Tx                                                              │
│  - 实现 storage.Transaction 接口                                            │
│  - 提供 Wisp 路由（issues 表 vs wisps 表）                                   │
│  - 处理元数据验证                                                            │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
        ┌───────────────────┐               ┌───────────────────┐
        │   issues 表        │               │   wisps 表        │
        │ (持久化问题)        │               │ (临时性问题)       │
        └───────────────────┘               └───────────────────┘
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      │
                                      ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                    SQL 事务提交                               │
        │                   (sql.Tx.Commit)                             │
        └───────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
        ┌───────────────────────────────────────────────────────────────┐
        │              Dolt 提交（版本历史）                            │
        │           (CALL DOLT_COMMIT)                                  │
        └───────────────────────────────────────────────────────────────┘
```

在深入细节之前，我们需要理解 `doltTransaction` 在整个存储层中的位置。它是 `DoltStore`（实现了 `storage.Storage` 接口）的事务执行器。当你调用 `DoltStore.RunInTransaction()` 时，流程如下：

1. `DoltStore` 首先通过 `db.BeginTx()` 开启一个 SQL 事务
2. 创建一个 `doltTransaction` 结构体，将 `sql.Tx` 和 `DoltStore` 引用封装进去
3. 将这个 `doltTransaction` 传递给用户提供的回调函数
4. 用户通过 `doltTransaction` 执行各种数据库操作
5. 如果一切顺利，先提交 SQL 事务，然后创建 Dolt 版本提交

### 设计决策：为什么事务提交和 Dolt 提交要分开？

这里有一个关键的设计决策：先提交 SQL 事务，再创建 Dolt 版本提交。代码注释中解释了这个决策的由来：

> 以前，DOLT_COMMIT 是在事务内部调用的。当它返回"nothing to commit"（所有写入都是对 dolt-ignored 表的操作）时，Go 的 sql.Tx 会处于一个损坏的状态，Commit() 会静默失败，导致 wisp 数据丢失。

这告诉我们一个重要的教训：**Dolt 的版本提交与 SQL 事务是两种完全不同的操作**。Dolt 提交是一个"外部"操作，它查看的是已提交的数据库状态，而不是事务内的待提交状态。如果所有的变更都是对"Dolt 忽略"表（比如 `wisps` 表——用于存储临时性问题）的操作，Dolt 不知道如何处理这种情况。通过先提交 SQL 事务，我们确保数据已经持久化到数据库，然后 Dolt 提交只是"记录这个状态"。

## 核心实现细节

### doltTransaction 结构体

```go
type doltTransaction struct {
	tx    *sql.Tx
	store *DoltStore
}
```

这个结构体非常精简，只有两个字段。`tx` 是 Go 标准库的数据库事务句柄，`store` 是对 `DoltStore` 的引用（主要用于访问配置、连接信息等）。这种设计遵循了"委托"模式——大多数操作实际上是委托给 `tx` 来执行的。

### 路由逻辑：issues 表 vs wisps 表

Beads 系统有一个独特的概念：普通的持久化问题存储在 `issues` 表中，而临时的"wisp"（类似短息消息的临时工作项）存储在 `wisps` 表中。这个设计使得 agent 之间的通信不需要创建持久的数据库记录。

`doltTransaction` 的几乎每个方法都包含类似的路由逻辑：

```go
table := "issues"
if t.isActiveWisp(ctx, id) {
    table = "wisps"
}
```

`isActiveWisp` 方法检查给定的 ID 是否存在于 `wisps` 表中：

```go
func (t *doltTransaction) isActiveWisp(ctx context.Context, id string) bool {
	var exists int
	err := t.tx.QueryRowContext(ctx, "SELECT 1 FROM wisps WHERE id = ? LIMIT 1", id).Scan(&exists)
	return err == nil
}
```

**这里有一个微妙的设计点**：与 `DoltStore` 级别的 `isActiveWisp` 不同（它在事务外查询），事务内的版本会在事务内部进行查询，这意味着它能够看到尚未提交的其他 wisp 操作。这种"read-your-writes"语义对于在一个事务中同时操作多个 wisp 非常重要。

### Wisp 路由的复杂性：隐式 vs 显式 Wisp

代码注释中提到了 GH#2053，这个 issue 揭示了 wisp 路由的一个边缘情况：wisp 可以通过两种方式创建——隐式的（ID 遵循 `-wisp-` 模式）和显式的（通过 `Ephemeral` 标志）。当一个 wisp 使用显式 ID（比如 "bd-123" 同时设置 `Ephemeral = true`）时，路由逻辑需要正确处理这种情况。事务级别的 `isActiveWisp` 通过直接查询数据库而不是依赖 ID 模式匹配来解决这个问题。

### CreateIssue 的 ID 生成逻辑

创建问题时的 ID 生成是一个复杂的过程，涉及多个步骤：

```go
// 确定使用哪个表
table := "issues"
if issue.Ephemeral {
    table = "wisps"
}

// 从配置中获取前缀
var configPrefix string
err := t.tx.QueryRowContext(ctx, "SELECT value FROM config WHERE `key` = ?", "issue_prefix").Scan(&configPrefix)

// 处理普通问题 vs wisp 的前缀
if issue.Ephemeral {
    prefix = wispPrefix(configPrefix, issue)
} else {
    prefix = configPrefix
    if issue.PrefixOverride != "" {
        prefix = issue.PrefixOverride
    } else if issue.IDPrefix != "" {
        prefix = configPrefix + "-" + issue.IDPrefix
    }
}

// 生成 ID
generatedID, err := generateIssueIDInTable(ctx, t.tx, table, prefix, issue, actor)
```

这个设计支持几种不同的 ID 生成场景：
- 普通问题：使用配置的 `issue_prefix`（如 "bd"）
- Wisp：使用 `wisp-` 前缀
- 指定 ID 前缀：如 "bd-frontend" 可以生成 "bd-frontend-1"
- 完全覆盖前缀：用于跨 rig 创建问题

### 元数据验证（GH#1416 和 GH#1417）

在创建和更新问题时，元数据会被验证是否符合配置的 schema：

```go
// Validate metadata against schema if configured (GH#1416 Phase 2)
if err := validateMetadataIfConfigured(issue.Metadata); err != nil {
    return err
}
```

对于更新操作，还有额外的元数据规范化处理：

```go
if key == "metadata" {
    // GH#1417: Normalize metadata to string, accepting string/[]byte/json.RawMessage
    metadataStr, err := storage.NormalizeMetadataValue(value)
    if err != nil {
        return fmt.Errorf("invalid metadata: %w", err)
    }
    // Validate against schema if configured (GH#1416 Phase 2)
    if err := validateMetadataIfConfigured(json.RawMessage(metadataStr)); err != nil {
        return err
    }
    args = append(args, metadataStr)
}
```

这是一个渐进式的改进：最初只有基本的存在性检查，后来添加了 schema 验证。这表明系统在不破坏现有行为的前提下，逐步增强了数据完整性保证。

### 依赖操作的幂等性处理

添加依赖关系时，有一个防止意外类型覆盖的保护机制：

```go
// Check for existing dependency to prevent silent type overwrites.
var existingType string
err := t.tx.QueryRowContext(ctx, fmt.Sprintf(`
    SELECT type FROM %s WHERE issue_id = ? AND depends_on_id = ?
`, table), dep.IssueID, dep.DependsOnID).Scan(&existingType)
if err == nil {
    if existingType == string(dep.Type) {
        return nil // idempotent
    }
    return fmt.Errorf("dependency %s -> %s already exists with type %q (requested %q); remove it first with 'bd dep remove' then re-add",
        dep.IssueID, dep.DependsOnID, existingType, dep.Type)
}
```

这个设计体现了**防御性编程**的原则：如果试图将一个依赖关系从"blocks"类型改为"relates-to"类型，系统会报错而不是静默覆盖。这避免了潜在的数据不一致。

### 更新操作的字段过滤

`UpdateIssue` 方法只允许更新特定的字段，这既是一个安全特性，也是一个数据完整性保护：

```go
for key, value := range updates {
    if !isAllowedUpdateField(key) {
        return fmt.Errorf("invalid field for update: %s", key)
    }
    // ... proceed with update
}
```

允许的字段包括：title, description, status, priority, assignee, owner, estimated_minutes, due_at, defer_until, metadata, waiters, 等等。

## 依赖关系分析

### 上游依赖（doltTransaction 调用什么）

`doltTransaction` 的实现依赖于以下几个关键组件：

1. **Go sql.DB 和 sql.Tx**：标准库的数据库抽象，提供了事务的基础能力
2. **Dolt 存储过程**：通过 `CALL DOLT_COMMIT` 与 Dolt 的版本控制系统集成
3. **types.Issue**：问题领域模型，定义了问题的数据结构
4. **storage 接口**：实现 `storage.Transaction` 接口定义的操作契约
5. **配置系统**：从 `config` 表读取 issue_prefix 等配置

### 下游依赖（什么调用 doltTransaction）

`doltTransaction` 被以下组件使用：

1. **DoltStore.RunInTransaction**：创建和管理事务的生命周期
2. **CLI 命令**：各种需要原子性数据库操作的命令（如 create, update, close）
3. **Tracker 集成**：同步外部 tracker 问题时使用事务确保原子性
4. **Formula 执行**：执行公式时可能需要事务来保证操作的一致性

### 数据契约

作为 `storage.Transaction` 接口的实现，`doltTransaction` 必须提供以下操作的原子性保证：

- **问题操作**：CreateIssue, CreateIssues, GetIssue, SearchIssues, UpdateIssue, CloseIssue, DeleteIssue
- **依赖操作**：AddDependency, RemoveDependency, GetDependencyRecords
- **标签操作**：AddLabel, RemoveLabel, GetLabels
- **配置操作**：SetConfig, GetConfig
- **元数据操作**：SetMetadata, GetMetadata
- **评论操作**：AddComment, ImportIssueComment, GetIssueComments

## 设计权衡与 trade-offs

### 1. 事务内 vs 事务外的 Wisp 检查

**选择**：在事务内进行 wisp 存在性检查

**权衡**：这种设计确保了"读己之所写"（read-your-writes）语义——如果你在一个事务中先创建了一个 wisp，然后立即查询它，你能找到它。但这意味着每个操作都需要额外的数据库查询来检查 wisp 状态。

**另一种设计**：在事务外检查（像原始的 DoltStore 实现那样），可以避免额外的查询，但会导致在一个事务内操作 wisp 时出现问题。

### 2. 先 SQL 提交，后 Dolt 提交

**选择**：SQL 事务先提交，然后创建 Dolt 版本提交

**权衡**：这种两阶段提交确保了数据不会丢失。即使 Dolt 提交失败（因为所有变更都在 dolt-ignored 表中），数据仍然安全地存储在数据库中。

**代价**：如果 Dolt 提交失败，数据已经在数据库中，但版本历史中没有记录。这可能导致数据状态的轻微不一致。

### 3. 隐式 vs 显式 Wisp 处理

**选择**：通过数据库查询来确定 wisp 状态，而不是依赖 ID 模式

**权衡**：更准确，能够处理显式 ID 的 wisp。代价是每次操作都需要查询数据库。

### 4. 依赖类型覆盖的保护

**选择**：不允许静默覆盖依赖类型，需要先删除再重新添加

**权衡**：更安全，防止意外的数据变更。但对用户来说不够方便，需要更多的手动操作。

## 边缘情况与陷阱

### 1. "Nothing to Commit" 情况

当所有操作都是对 dolt-ignored 表（wisps, wisp_dependencies 等）的写入时，Dolt 提交会返回"nothing to commit"。代码通过 `isDoltNothingToCommit` 函数处理这种情况：

```go
if err != nil && !isDoltNothingToCommit(err) {
    return fmt.Errorf("dolt commit: %w", err)
}
```

这是一个**预期的错误情况**，不需要向用户报告。

### 2. 并发事务与 Wisp 路由

在并发事务中，wisp 的状态可能是一个事务修改了某个 ID 从普通 issue 变成 wisp（或反之）。这种竞态条件可能导致问题被路由到错误的表。系统目前没有对这种情况加锁保护——这是一个已知的简化。

### 3. 配置缺失

如果 `issue_prefix` 配置不存在，`CreateIssue` 会返回一个明确的错误：

```go
if err == sql.ErrNoRows || configPrefix == "" {
    return fmt.Errorf("%w: issue_prefix config is missing", storage.ErrNotInitialized)
}
```

### 4. ID 前缀的双连字符

代码有一个防御措施防止生成的双连字符的 ID（如 "bd--1"）：

```go
// Normalize prefix: strip trailing hyphen to prevent double-hyphen IDs (bd-6uly)
configPrefix = strings.TrimSuffix(configPrefix, "-")
```

这是一个针对特定 bug（bd-6uly）的修复。

### 5. Metadata 的 JSON 序列化

对于 `waiters` 字段（一个字符串数组），代码使用 JSON 序列化存储：

```go
if key == "waiters" {
    waitersJSON, _ := json.Marshal(value)
    args = append(args, string(waitersJSON))
}
```

这意味着值的类型需要是 JSON 兼容的——如果是 `[]string`，它会被正确序列化。

## 使用指南

### 基本事务使用模式

```go
err := store.RunInTransaction(ctx, "Create new issue", func(tx storage.Transaction) error {
    // 创建问题
    issue := &types.Issue{
        Title: "My Issue",
        Status: types.StatusOpen,
    }
    if err := tx.CreateIssue(ctx, issue, "user@example.com"); err != nil {
        return err
    }
    
    // 添加依赖
    dep := &types.Dependency{
        IssueID:     issue.ID,
        DependsOnID: "bd-123",
        Type:        types.DependencyTypeBlocks,
    }
    return tx.AddDependency(ctx, dep, "user@example.com")
})
```

### Wisp 路由的隐式行为

你不需要显式指定使用哪个表——`doltTransaction` 会根据 issue 的 ID 自动路由：

```go
// 这会被路由到 wisps 表
wisp := &types.Issue{
    Title:      "Ephemeral message",
    Ephemeral: true,
}
tx.CreateIssue(ctx, wisp, "agent")
```

### 元数据验证

如果系统配置了 metadata schema，验证会透明地发生：

```go
// 如果 metadata 不符合 schema，会返回错误
issue := &types.Issue{
    Title: "Issue with invalid metadata",
    Metadata: json.RawMessage(`{"invalid": "schema"}`),
}
err := tx.CreateIssue(ctx, issue, "user") // 可能失败如果 schema 不匹配
```

## 总结

`doltTransaction` 模块解决的核心问题是如何在保持传统数据库事务语义的同时，利用 Dolt 的版本控制能力。其关键设计决策包括：

1. **双阶段提交**：SQL 事务先提交确保数据安全，然后 Dolt 提交记录版本历史
2. **透明的表路由**：根据 ID 自动在 issues 和 wisps 表之间路由
3. **防御性编程**：元数据验证、字段过滤、依赖类型保护
4. **渐进式增强**：从基本的创建/读取/更新/删除，逐步添加验证和完整性保护

对于新的贡献者，需要特别注意事务边界（不要在事务内调用非事务方法）、wisp 路由逻辑（每个操作都要检查表路由）、以及 Dolt 特定的边缘情况（如 "nothing to commit"）。