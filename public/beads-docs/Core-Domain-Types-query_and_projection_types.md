# 查询与投影类型模块 (query_and_projection_types)

## 概述

`query_and_projection_types` 模块是整个 issue 跟踪系统的查询和数据投影核心。它定义了**如何筛选、排序和呈现** issue 数据的类型系统，为上层查询引擎、CLI 命令和 API 提供了统一的数据契约。

## 问题背景

在 issue 跟踪系统中，数据模型与查询需求往往是分离的：
- 核心 `Issue` 类型需要包含完整的领域信息（状态、优先级、依赖关系等）
- 但实际使用场景中，我们需要**不同的视图**：
  - 筛选出"准备好处理"的工作项
  - 查看带有依赖计数的 issue 列表
  - 展示 issue 的完整依赖树
  - 分析分子的进度统计

如果直接在核心 `Issue` 类型上添加各种查询条件和投影字段，会导致：
1. **关注点分离失败**：核心类型变得臃肿，既包含数据存储又包含查询逻辑
2. **性能问题**：每次查询都需要加载完整的 issue 数据
3. **耦合度高**：查询逻辑与数据模型紧密绑定，难以独立演进

## 设计思想

这个模块采用了**查询-投影分离**的设计模式：

- **查询类型**（如 `IssueFilter`、`WorkFilter`）：描述"我们想要什么数据"
- **投影类型**（如 `IssueDetails`、`IssueWithCounts`）：描述"数据应该如何呈现"

这种设计的核心优势是：
1. **单一职责**：每个类型只负责一个方面
2. **可组合性**：可以灵活地组合查询条件和投影方式
3. **性能优化**：投影类型可以只包含需要的字段，减少数据传输

## 核心组件

### 查询过滤器类型

#### IssueFilter

`IssueFilter` 是最通用的 issue 查询过滤器，支持丰富的筛选条件：

```go
type IssueFilter struct {
    // 基础属性筛选
    Status       *Status
    Priority     *int
    IssueType    *IssueType
    Assignee     *string
    
    // 标签筛选（支持 AND/OR/模式匹配）
    Labels       []string  // AND 语义：必须包含所有标签
    LabelsAny    []string  // OR 语义：至少包含一个标签
    LabelPattern string    // Glob 模式匹配
    LabelRegex   string    // 正则表达式匹配
    
    // 文本搜索
    TitleSearch  string
    TitleContains       string
    DescriptionContains string
    NotesContains       string
    
    // ID 相关筛选
    IDs          []string
    IDPrefix     string
    SpecIDPrefix string
    
    // 时间范围筛选
    CreatedAfter  *time.Time
    CreatedBefore *time.Time
    UpdatedAfter  *time.Time
    UpdatedBefore *time.Time
    ClosedAfter   *time.Time
    ClosedBefore  *time.Time
    
    // 存在性检查
    EmptyDescription bool
    NoAssignee       bool
    NoLabels         bool
    
    // 数值范围
    PriorityMin *int
    PriorityMax *int
    
    // 多仓库支持
    SourceRepo *string
    
    // 特殊标记筛选
    Ephemeral  *bool
    Pinned     *bool
    IsTemplate *bool
    
    // 依赖关系筛选
    ParentID *string
    NoParent bool
    
    // 分子类型筛选
    MolType  *MolType
    WispType *WispType
    
    // 排除条件
    ExcludeStatus []Status
    ExcludeTypes  []IssueType
    
    // 时间调度筛选
    Deferred    bool
    DeferAfter  *time.Time
    DeferBefore *time.Time
    DueAfter    *time.Time
    DueBefore   *time.Time
    Overdue     bool
    
    // 元数据筛选
    MetadataFields map[string]string
    HasMetadataKey string
    
    // 结果限制
    Limit int
}
```

**设计意图**：
- 使用指针类型区分"未设置"和"设置为空值"
- 支持丰富的筛选条件组合
- 包含了从简单到复杂的各种查询场景

#### WorkFilter

`WorkFilter` 是专门为"准备好处理的工作"设计的过滤器：

```go
type WorkFilter struct {
    Status       Status
    Type         string
    Priority     *int
    Assignee     *string
    Unassigned   bool
    Labels       []string
    LabelsAny    []string
    LabelPattern string
    LabelRegex   string
    Limit        int
    SortPolicy   SortPolicy
    
    // 分子相关筛选
    ParentID     *string
    MolType      *MolType
    WispType     *WispType
    
    // 特殊包含选项
    IncludeDeferred bool
    IncludeEphemeral bool
    IncludeMolSteps  bool
    
    // 元数据筛选
    MetadataFields map[string]string
    HasMetadataKey string
}
```

**与 IssueFilter 的区别**：
- 更专注于"可执行工作"的概念
- 包含排序策略
- 有特殊的包含/排除选项（如是否包含延迟的、临时的 issue）

#### StaleFilter

`StaleFilter` 用于查找"陈旧"的 issue：

```go
type StaleFilter struct {
    Days   int    // 未更新的天数
    Status string // 状态筛选
    Limit  int    // 结果限制
}
```

### 投影类型

#### IssueDetails

`IssueDetails` 是 issue 的完整视图，包含所有相关数据：

```go
type IssueDetails struct {
    Issue
    Labels       []string
    Dependencies []*IssueWithDependencyMetadata
    Dependents   []*IssueWithDependencyMetadata
    Comments     []*Comment
    Parent       *string
}
```

**使用场景**：
- `bd show` 命令
- API 的详情端点
- 需要完整 issue 信息的场景

#### IssueWithCounts

`IssueWithCounts` 是轻量级的 issue 视图，包含关键计数信息：

```go
type IssueWithCounts struct {
    *Issue
    DependencyCount int
    DependentCount  int
    CommentCount    int
    Parent          *string
}
```

**设计优势**：
- 只包含常用的计数信息，不需要加载完整的依赖和评论
- 使用指针嵌入 `Issue`，避免数据复制

#### IssueWithDependencyMetadata

`IssueWithDependencyMetadata` 扩展了 issue 信息，包含依赖关系类型：

```go
type IssueWithDependencyMetadata struct {
    Issue
    DependencyType DependencyType
}
```

#### BlockedIssue

`BlockedIssue` 专门用于展示被阻塞的 issue：

```go
type BlockedIssue struct {
    Issue
    BlockedByCount int
    BlockedBy      []string
}
```

#### TreeNode

`TreeNode` 用于构建依赖树：

```go
type TreeNode struct {
    Issue
    Depth     int
    ParentID  string
    Truncated bool
}
```

### 统计与状态类型

#### MoleculeProgressStats

`MoleculeProgressStats` 提供分子的进度统计：

```go
type MoleculeProgressStats struct {
    MoleculeID    string
    MoleculeTitle string
    Total         int
    Completed     int
    InProgress    int
    CurrentStepID string
    FirstClosed   *time.Time
    LastClosed    *time.Time
}
```

**设计意图**：
- 使用索引查询而非加载所有步骤到内存
- 提供高效的进度信息，适用于大型分子

#### Statistics

`Statistics` 提供整体统计数据：

```go
type Statistics struct {
    TotalIssues             int
    OpenIssues              int
    InProgressIssues        int
    ClosedIssues            int
    BlockedIssues           int
    DeferredIssues          int
    ReadyIssues             int
    PinnedIssues            int
    EpicsEligibleForClosure int
    AverageLeadTime         float64
}
```

#### EpicStatus

`EpicStatus` 展示史诗的完成状态：

```go
type EpicStatus struct {
    Epic             *Issue
    TotalChildren    int
    ClosedChildren   int
    EligibleForClose bool
}
```

### 排序策略

#### SortPolicy

`SortPolicy` 定义了工作项的排序方式：

```go
type SortPolicy string

const (
    // 混合策略：近期按优先级，旧的按创建时间
    SortPolicyHybrid SortPolicy = "hybrid"
    
    // 优先级策略：始终按优先级，然后按创建时间
    SortPolicyPriority SortPolicy = "priority"
    
    // 最旧优先：始终按创建时间
    SortPolicyOldest SortPolicy = "oldest"
)
```

## 数据流动

### 查询执行流程

1. **查询构建**：上层组件（如 CLI 命令、API）创建查询过滤器
2. **过滤器传递**：过滤器被传递给查询引擎或存储层
3. **数据查询**：存储层根据过滤器条件执行查询
4. **结果投影**：查询结果被转换为适当的投影类型
5. **数据返回**：投影后的数据返回给调用者

### 依赖关系

这个模块是**被依赖**的核心模块，它被：
- 查询引擎用于解析和执行查询
- 存储接口用于定义查询契约
- CLI 命令用于构建查询参数
- MCP 集成用于 API 数据传输

## 设计权衡

### 1. 丰富性 vs 简洁性

**选择**：提供了非常丰富的查询条件

**原因**：
- 系统需要支持多种查询场景
- 统一的过滤器类型避免了创建多个专用查询类型

**权衡**：
- ✅ 灵活性高，可以表达复杂查询
- ❌ 过滤器类型变得庞大，学习曲线较陡

### 2. 指针 vs 值类型

**选择**：可选项使用指针类型

**原因**：
- 区分"未设置"和"设置为空值"
- 允许部分更新查询条件

**权衡**：
- ✅ 语义清晰
- ❌ 使用时需要空值检查

### 3. 组合 vs 继承

**选择**：使用组合而非继承

**原因**：
- Go 语言没有继承
- 组合更灵活，可以按需组合功能

**权衡**：
- ✅ 灵活性高
- ❌ 可能需要重复一些字段

## 使用指南

### 常见查询模式

#### 1. 查找准备好处理的工作

```go
filter := &types.WorkFilter{
    Status:     types.StatusOpen,
    Unassigned: true,
    SortPolicy: types.SortPolicyPriority,
}
```

#### 2. 查找特定标签的 issue

```go
filter := &types.IssueFilter{
    Labels: []string{"bug", "critical"},
    Limit:  50,
}
```

#### 3. 查找逾期的 issue

```go
filter := &types.IssueFilter{
    Overdue: true,
}
```

### 扩展点

这个模块的设计相对稳定，但在以下情况下可能需要扩展：

1. **新的查询条件**：添加新的筛选字段到 `IssueFilter`
2. **新的投影类型**：创建新的结构体来支持特定的数据视图
3. **新的排序策略**：添加新的 `SortPolicy` 常量

## 注意事项

### 常见陷阱

1. **忘记检查指针是否为 nil**：使用过滤器字段时要进行空值检查
2. **混淆 AND/OR 标签筛选**：`Labels` 是 AND 语义，`LabelsAny` 是 OR 语义
3. **性能考虑**：复杂的过滤器可能导致慢查询，注意使用 `Limit` 限制结果数量

### 最佳实践

1. **使用默认值**：对于未设置的字段，使用合理的默认值
2. **组合过滤器**：可以先创建基础过滤器，再根据需要添加条件
3. **文档化查询**：对于复杂的查询，添加注释说明意图

## 总结

`query_and_projection_types` 模块是系统的查询和数据投影核心，它通过清晰的分离关注点，提供了灵活而强大的查询能力。理解这个模块的设计思想和使用方式，对于高效地使用和扩展系统至关重要。
