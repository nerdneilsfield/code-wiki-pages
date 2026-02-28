# storage_contracts 模块技术深度解析

## 概述：问题空间与设计意图

`storage_contracts` 模块是 beads 项目的数据持久化层抽象，它定义了一组接口契约，使业务逻辑能够与底层的数据库实现解耦。想象一下这个模块的角色：它就像是一个**精密的合约系统**，一边连接着 CLI 命令、公式引擎、追踪器集成等"消费者"，另一边连接着 Dolt（一个支持版本控制的 MySQL 兼容数据库）等"生产者"。

这个模块存在的根本原因是 beads 项目需要一个**可替换的存储后端**。在代码库中你可以看到 `InstrumentedStorage` 这样的装饰器，它能够在不修改核心存储逻辑的情况下添加 OpenTelemetry 追踪和指标收集。这种能力正是通过接口抽象实现的——如果没有这层契约，装饰器模式就无法工作。

从数据模型的角度看，这个模块处理的是 beads 项目的核心实体：**Issue（问题）**。一个 Issue 包含了标题、描述、设计文档、验收标准、状态、优先级、类型、负责人、创建时间、依赖关系、标签、评论等丰富的信息。storage_contracts 定义了如何创建、读取、更新、删除这些实体，以及如何管理它们之间的关联关系。

## 架构角色与数据流

### 核心抽象

该模块包含两个核心接口：`Storage` 和 `Transaction`。

**Storage 接口**是整个存储层的门户，它定义了所有持久化操作的入口。你可以将其想象成一家医院的**挂号窗口**——所有来看病的患者（数据请求）都必须通过这个窗口。窗口提供了分诊（路由）、挂号（创建）、问诊（查询）、治疗（更新）等全方位服务。具体来说，Storage 接口提供了以下能力：

- **Issue 生命周期管理**：CreateIssue、GetIssue、UpdateIssue、CloseIssue、DeleteIssue、SearchIssues
- **依赖关系管理**：AddDependency、RemoveDependency、GetDependencies、GetDependents、GetDependencyTree
- **标签管理**：AddLabel、RemoveLabel、GetLabels、GetIssuesByLabel
- **工作查询**：GetReadyWork（获取就绪的工作项）、GetBlockedIssues（获取被阻塞的问题）
- **评论与事件**：AddIssueComment、GetIssueComments、GetEvents
- **配置管理**：SetConfig、GetConfig、GetAllConfig
- **事务支持**：RunInTransaction
- **统计信息**：GetStatistics

**Transaction 接口**则提供了**原子性操作**的能力。它是 Storage 接口的一个子集，但专门设计用于在单个数据库事务中执行多个操作。回到医院的比喻，如果 Storage 是挂号窗口，那么 Transaction 就像是**手术室**——在手术室内发生的所有操作要么全部成功，要么全部失败（回滚）。这对于创建具有依赖关系的问题集、或者在原子操作中同时修改配置和实体等场景至关重要。

### 依赖关系图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              消费者 (Consumers)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  cmd/bd (CLI命令)   │  internal/telemetry (装饰器)  │  internal/formula  │
│  internal/tracker  │  internal/routing              │  其他模块           │
└──────────┬─────────────────────────┬──────────────────────────┬────────────┘
           │                         │                          │
           ▼                         ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    internal/storage.storage                                  │
│                     Storage Interface (契约)                                 │
│                     Transaction Interface (子契约)                          │
└──────────┬─────────────────────────┬────────────────────────────────────────┘
           │                         │
           ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    internal/storage/dolt                                     │
│                 DoltStore (实现)                                             │
│                 doltTransaction (事务实现)                                   │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Dolt: 版本控制型 SQL 数据库                         │  │
│  │  - Commit/Push/Pull/Branch/Merge                                      │  │
│  │  - 时间旅行查询 (AS OF)                                               │  │
│  │  - Cell-level merge                                                   │  │
│  │  - Federation (多写者支持)                                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 数据流动的关键路径

以创建一个带有依赖关系的问题为例，数据流是这样的：

1. **CLI 层** (`cmd/bd/create.go`) 接收用户输入，构造 `types.Issue` 对象
2. **Storage 层** 调用 `Storage.CreateIssue()` 接口方法
3. **Dolt 实现** 将数据写入 Dolt 数据库的 issues 表
4. **版本控制** Dolt 自动创建提交（commit），将更改记录到版本历史
5. **返回** 将创建成功的问题对象返回给调用者

如果是涉及多个操作的原子性场景：

1. 调用 `Storage.RunInTransaction(ctx, commitMsg, fn)`
2. 在回调函数中执行多个操作（如创建父问题、子问题，添加依赖关系）
3. 所有操作在同一个数据库事务中执行
4. 成功则提交（commit），失败则回滚（rollback）

## 核心组件深度解析

### Storage 接口

```go
type Storage interface {
    // Issue CRUD
    CreateIssue(ctx context.Context, issue *types.Issue, actor string) error
    CreateIssues(ctx context.Context, issues []*types.Issue, actor string) error
    GetIssue(ctx context.Context, id string) (*types.Issue, error)
    // ... more methods
}
```

**设计意图**：这个接口采用**贫血模型**的设计模式——接口只定义行为，不包含状态。它所有的方法都接受 `context.Context` 作为第一个参数，这体现了 Go 语言的并发编程最佳实践：允许取消、超时和传递请求级别的值。

**actor 参数**：每个修改操作都接受一个 `actor` 字符串参数，表示"谁执行了这个操作"。这在协作工作流中至关重要，因为它允许追踪每个变更的来源（是人类用户、某个 agent，还是自动化脚本）。

**错误常量**：模块定义了一组专用错误，帮助调用者精确识别问题：

- `ErrAlreadyClaimed`：当尝试认领一个已被其他用户认领的问题时返回
- `ErrNotFound`：当请求的实体不存在时返回
- `ErrNotInitialized`：当数据库未初始化（如缺少 issue_prefix 配置）时返回
- `ErrPrefixMismatch`：当问题 ID 不匹配配置的前缀时返回

### Transaction 接口

```go
type Transaction interface {
    CreateIssue(ctx context.Context, issue *types.Issue, actor string) error
    CreateIssues(ctx context.Context, issues []*types.Issue, actor string) error
    UpdateIssue(ctx context.Context, id string, updates map[string]interface{}, actor string) error
    // ...
}
```

**事务语义**的关键点：

1. 所有操作共享同一个数据库连接
2. 在提交之前，修改对其他连接不可见
3. 如果任何操作返回错误，整个事务回滚
4. 如果回调函数 panic，事务也会回滚
5. 成功返回时，事务自动提交

**与 Store 的区别**：Transaction 接口暴露的方法是 Storage 的一个子集，专门挑选出那些需要在事务上下文中执行的操作。这是一种**有意的收窄**——通过限制可用操作，降低事务被滥用的风险。

### 错误处理的设计哲学

模块采用了**错误作为值**的模式。所有方法都返回 `error` 类型，调用者需要显式检查。这种设计选择背后的原因是：

1. **明确性**：调用者不能忽略错误，必须做出响应
2. **可组合性**：错误可以包装（wrap），保留调用栈信息
3. **可测试性**：测试可以轻松模拟各种错误场景

## 设计决策与权衡

### 1. 接口抽象 vs 具体实现

**选择**：使用接口而非具体类型

**权衡**：接口提供了灵活性和可测试性，但略微增加了运行时开销（虽然 Go 的接口调度非常高效）。更重要的是，接口使得单元测试变得简单——你可以创建一个 mock 实现来验证业务逻辑，而不需要启动真实的 Dolt 数据库。

**替代方案**：如果直接依赖 `*dolt.DoltStore`，测试将需要真实的数据库，这会大大降低测试速度和可靠性。

### 2. Dolt 作为存储后端

**选择**：使用 Dolt（版本控制型 SQL 数据库）

**理由**：

- **版本历史**：内置的 commit 历史意味着每个数据变更都有可追溯的记录
- **分支与合并**：支持数据层面的分支，允许多个工作流并行进行
- **Federation**：支持多作者通过 Dolt remotes 同步数据
- **SQL 兼容**：利用成熟的 SQL 查询能力

**权衡**：Dolt 需要运行 `dolt sql-server`，这增加了运维复杂度。对于单用户场景，这可能是过度设计。

### 3. 同步 vs 异步接口

**选择**：所有接口方法都是同步的

**权衡**：同步方法更容易理解和调试，但可能在高并发场景下成为瓶颈。异步接口虽然性能更高，但会显著增加代码复杂度，特别是需要处理取消和超时时。

### 4. 显式 actor 参数

**选择**：每个修改操作都要求显式传入 actor

**权衡**：

- **优点**：变更完全可追溯，支持审计和协作
- **缺点**：调用方需要维护和传递 actor 信息

这种设计反映了 beads 作为一个**协作工具**的定位——它需要知道"谁做了什么"。

## 依赖分析

### 上游依赖（谁调用这个模块）

1. **cmd/bd**（CLI 命令）：最直接的消费者，每个命令（create、update、close 等）都通过 Storage 接口操作数据
2. **internal/telemetry**：通过装饰器模式包装 Storage，添加可观测性
3. **internal/formula**：公式引擎需要查询问题数据来执行工作流
4. **internal/tracker**：追踪器集成（Jira、GitLab、Linear）需要与存储层交互以同步数据

### 下游依赖（这个模块调用谁）

1. **internal/types**：定义 Issue、Dependency、Comment 等核心数据模型
2. **Dolt 驱动**：通过 Go 的 `database/sql` 接口连接 Dolt

### 数据契约

关键的数据类型定义在 `internal/types/types.go` 中，其中 `Issue` 是核心实体：

```go
type Issue struct {
    ID          string
    Title       string
    Description string
    Design      string
    AcceptanceCriteria string
    Status      Status
    Priority    int
    IssueType   IssueType
    Assignee    string
    Owner       string
    // ... 大量字段
}
```

这个结构体非常**宽（wide）**——它包含了几十种字段，涵盖了问题的各个方面。设计选择是**扁平化**所有信息到一个结构体中，而不是使用外键关联。这种选择在 beads 的使用场景下是合理的，因为：

1. 问题是一个**核心聚合根**，其所有属性在大多数查询中都需要
2. 避免了复杂的 JOIN 操作
3. 简化了序列化/反序列化（可以直接 JSON 化）

## 使用指南与扩展点

### 基本使用模式

```go
// 获取存储实例（通常通过依赖注入）
store := GetStore() // 返回 storage.Storage 接口

// 创建问题
issue := &types.Issue{
    Title: "实现新功能",
    Status: types.StatusOpen,
}
err := store.CreateIssue(ctx, issue, "user@example.com")

// 事务操作
err := store.RunInTransaction(ctx, "bd: 创建相关问题", func(tx storage.Transaction) error {
    if err := tx.CreateIssue(ctx, parent, actor); err != nil {
        return err
    }
    if err := tx.CreateIssue(ctx, child, actor); err != nil {
        return err
    }
    dep := &types.Dependency{
        IssueID:    child.ID,
        DependsOnID: parent.ID,
    }
    return tx.AddDependency(ctx, dep, actor)
})
```

### 扩展点

1. **装饰器模式**：像 `InstrumentedStorage` 那样包装 Storage 接口，添加横切关注点
2. **缓存层**：在 Storage 前面添加缓存，提高读取性能
3. **路由层**：根据 Issue ID 前缀将请求路由到不同的存储实例（见 `internal/routing`）

### 配置

存储层通过以下配置项进行配置（通过 Storage 接口的 GetConfig/SetConfig）：

- `issue_prefix`：问题 ID 的前缀（如 "bd-"、"gt-"）
- 数据库连接相关的配置

## 边缘情况与陷阱

### 1. 事务中的"读己之所写"

在事务内部，`GetIssue` 和 `SearchIssues` 方法提供**读己之所写（read-your-writes）**语义——它们能看到同一事务中未提交的修改。这是 Transaction 接口提供这些方法的原因。

**陷阱**：如果在事务中使用 `Storage` 接口而不是 `Transaction` 接口，将看不到事务内的未提交修改。

### 2. 前缀验证

Dolt 实现层不强制前缀验证，但 CLI 层会检查。这意味着：

- 直接调用存储接口可以绕过前缀检查（用于导入场景）
- 使用前缀验证的场景应该使用 `CreateIssue` 而非底层操作

### 3. 事务中的 Wisp 路由

Wisp（临时问题）是 beads 的一个特殊功能，允许创建短暂存在的、不会被 git 同步的问题。在事务中，`isActiveWisp` 方法会查询事务上下文中的 wisps 表，以确保能看到未提交的临时问题。

### 4. Dolt 提交消息

`RunInTransaction` 的 commitMsg 参数用于创建 Dolt 提交。重要的是理解**两层提交**：

1. SQL 事务提交（将数据写入 Dolt 的工作集）
2. Dolt 提交（在版本历史中创建快照）

如果 commitMsg 为空，不会创建 Dolt 提交，但 SQL 事务仍会提交。

### 5. "Nothing to commit" 错误

当事务中只有对 dolt-ignored 表（如 wisps 表）的写入时，Dolt 会报告"nothing to commit"。这是正常行为，`isDoltNothingToCommit` 函数专门处理这种情况。

## 相关模块

- [Dolt Storage Backend](internal-storage-dolt.md)：Storage 接口的 Dolt 实现，深入理解版本控制数据库的使用
- [Core Domain Types](internal-types-types.md)：Issue、Dependency 等核心数据类型的定义
- [Query Engine](internal-query-evaluator.md)：搜索和过滤问题的查询能力
- [Versioning and Sync Types](internal-storage-versioned.md)：处理冲突、同步状态等版本控制相关的类型
- [Metadata Validation](internal-storage-metadata.md)：元数据字段的验证和模式配置