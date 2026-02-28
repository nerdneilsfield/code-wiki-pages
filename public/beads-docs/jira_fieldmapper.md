# Jira FieldMapper 模块技术深度解析

## 概述

**jira_fieldmapper** 模块是 Beads 系统与 Jira 之间的"翻译官"，它负责在 Beads 内部的领域模型与 Jira 的数据模型之间进行双向转换。这个模块解决的核心问题是：当两个系统使用不同的字段命名、状态枚举和数据结构时，如何让它们能够无缝地交换信息，同时保持双方语义的一致性。

## 问题空间

在集成不同的问题跟踪系统时，一个常见的挑战是它们对同一概念的表示方式往往不同：
- Jira 使用 "To Do"、"In Progress"、"Done" 来表示状态，而 Beads 可能使用 `StatusOpen`、`StatusInProgress`、`StatusClosed`
- Jira 有 "Bug"、"Story"、"Epic" 等 issue 类型，而 Beads 有自己的类型枚举
- 优先级的表示方式也可能完全不同

一个简单的字符串替换是不够的，因为：
1. 用户可能在 Jira 中自定义了状态名称（例如用 "Ready" 代替 "To Do"）
2. Jira API v2 和 v3 对描述字段的格式有不同要求（纯文本 vs ADF）
3. 需要处理缺失字段、类型转换和边界情况

## 核心组件

### jiraFieldMapper 结构体

`jiraFieldMapper` 是整个模块的核心，它实现了 `tracker.FieldMapper` 接口。这个结构体只包含两个字段：

```go
type jiraFieldMapper struct {
    apiVersion string            // "2" 或 "3"（默认："3"）
    statusMap  map[string]string // beads 状态 → Jira 状态名称
}
```

**设计意图**：保持最小化状态，只存储必要的配置。`apiVersion` 用于处理 Jira API 的版本差异，`statusMap` 允许用户自定义状态映射。

### 核心转换方法

#### 优先级转换

```go
func (m *jiraFieldMapper) PriorityToBeads(trackerPriority interface{}) int
func (m *jiraFieldMapper) PriorityToTracker(beadsPriority int) interface{}
```

这对方法在 Jira 的字符串优先级（"Highest" 到 "Lowest"）和 Beads 的整数优先级（0 到 4）之间进行转换。

**设计决策**：使用整数优先级在 Beads 内部是有意义的，因为它允许直接比较（数字越小优先级越高），而 Jira 使用字符串是为了用户友好的界面展示。

#### 状态转换

```go
func (m *jiraFieldMapper) StatusToBeads(trackerState interface{}) types.Status
func (m *jiraFieldMapper) StatusToTracker(beadsStatus types.Status) interface{}
```

状态转换是这个模块中最复杂的部分，因为它需要处理：
1. 用户自定义的状态映射（通过 `statusMap`）
2. 多个 Jira 状态可能映射到同一个 Beads 状态
3. 大小写不敏感的比较

**设计亮点**：在 `StatusToBeads` 中，先检查自定义映射，然后再使用默认映射，这样用户可以完全覆盖默认行为。

#### 类型转换

```go
func (m *jiraFieldMapper) TypeToBeads(trackerType interface{}) types.IssueType
func (m *jiraFieldMapper) TypeToTracker(beadsType types.IssueType) interface{}
```

类型转换相对简单，主要是在 Jira 的 issue 类型（如 "Bug"、"Story"）和 Beads 的类型枚举之间进行映射。

### Issue 级别的转换

#### IssueToBeads

```go
func (m *jiraFieldMapper) IssueToBeads(ti *tracker.TrackerIssue) *tracker.IssueConversion
```

这个方法将 Jira 的 `Issue` 转换为 Beads 的 `types.Issue`。它不仅转换基本字段，还处理：
- 从 HTML/ADF 格式描述转换为纯文本
- 安全的字段提取（避免空指针）
- 生成人类可读的浏览 URL

**设计亮点**：使用辅助函数（`priorityName`、`statusName`、`typeName`）来安全地从可能为 nil 的字段中提取值，这是防御性编程的好例子。

#### IssueToTracker

```go
func (m *jiraFieldMapper) IssueToTracker(issue *types.Issue) map[string]interface{}
```

这个方法将 Beads 的 `types.Issue` 转换为 Jira API 可以接受的字段映射。它的一个关键特性是根据 `apiVersion` 选择合适的描述格式：
- API v2：纯文本
- API v3：ADF（Atlassian Document Format）

## 数据流程

当从 Jira 拉取 issue 时，数据流向是：
1. Jira API 返回 `Issue` 结构体
2. `IssueToBeads` 将其转换为 `types.Issue`
3. 转换过程中调用 `PriorityToBeads`、`StatusToBeads`、`TypeToBeads` 进行字段级转换
4. 结果被包装在 `tracker.IssueConversion` 中返回

当向 Jira 推送 issue 时，数据流向相反：
1. 从 Beads 的 `types.Issue` 开始
2. `IssueToTracker` 将其转换为 Jira API 字段映射
3. 转换过程中调用 `PriorityToTracker`、`StatusToTracker`、`TypeToTracker`
4. 结果可以直接传递给 Jira API

## 设计决策与权衡

### 1. 自定义映射 vs 固定映射

**决策**：支持自定义状态映射，同时提供合理的默认值。

**权衡**：
- ✅ 灵活性：用户可以适配他们的 Jira 工作流
- ✅ 易用性：大多数情况下默认值就足够了
- ❌ 复杂性：需要维护两套映射逻辑

### 2. 接口类型 vs 具体类型

**决策**：在转换方法中使用 `interface{}` 作为输入/输出类型。

**原因**：这是为了与 `tracker.FieldMapper` 接口保持一致，该接口旨在支持多种跟踪器。虽然在 Go 中使用 `interface{}` 会失去一些类型安全，但在这里是必要的，因为不同的跟踪器可能有不同的类型表示。

### 3. 防御性编程 vs 快速失败

**决策**：采用防御性编程，在字段缺失时提供默认值而不是返回错误。

**权衡**：
- ✅ 健壮性：部分数据缺失不会导致整个同步失败
- ❌ 静默失败：问题可能不会立即被发现

**缓解措施**：对于关键字段（如状态），提供明确的默认值（如 `StatusOpen`），这样即使转换失败，issue 也会处于一个合理的状态。

### 4. API 版本处理

**决策**：在结构体中存储 `apiVersion`，并在需要时进行条件判断。

**替代方案**：可以创建两个不同的 mapper 实现，一个用于 v2，一个用于 v3。

**选择当前方案的原因**：API 版本差异目前只影响描述字段的格式，使用条件判断比创建两个完整的实现更简单。如果未来版本差异变得更大，可能需要重新考虑这个决策。

## 使用指南

### 创建 jiraFieldMapper

```go
mapper := &jiraFieldMapper{
    apiVersion: "3", // 或 "2"
    statusMap: map[string]string{
        string(types.StatusOpen): "Ready",
        string(types.StatusClosed): "Completed",
    },
}
```

### 转换优先级

```go
// Jira → Beads
beadsPriority := mapper.PriorityToBeads("High") // 返回 1

// Beads → Jira
jiraPriority := mapper.PriorityToTracker(1) // 返回 "High"
```

### 转换状态

```go
// Jira → Beads
beadsStatus := mapper.StatusToBeads("In Review") // 返回 StatusInProgress

// Beads → Jira
jiraStatus := mapper.StatusToTracker(types.StatusInProgress) // 返回 "In Progress"
```

## 边缘情况与注意事项

1. **自定义状态映射的大小写**：在 `StatusToBeads` 中比较状态名称时使用 `strings.EqualFold`，所以大小写不敏感。但在 `StatusToTracker` 中，`statusMap` 的值是直接返回的，所以要确保大小写正确。

2. **缺失字段**：如果 Jira issue 缺少某些字段（如优先级、状态），mapper 会提供默认值，而不是返回错误。这意味着同步不会因为部分数据缺失而失败，但可能会导致数据不完整。

3. **描述格式**：API v3 需要 ADF 格式的描述，而 API v2 接受纯文本。如果在创建 mapper 时设置了错误的 `apiVersion`，描述可能无法正确显示。

4. **issue 类型映射**：注意 Beads 的 `TypeFeature` 映射到 Jira 的 "Story"，而不是 "Feature"。这是因为 "Story" 在 Jira 中更常用。

## 依赖关系

`jiraFieldMapper` 实现了 `tracker.FieldMapper` 接口，这意味着它可以与 [Tracker Integration Framework](tracker_integration_framework.md) 中的其他组件无缝协作。它还依赖于：
- `types` 包中的核心领域类型（`Status`、`IssueType`、`Issue`）
- `jira.client` 包中的 Jira 特定类型（`Issue`）

## 扩展点

如果需要支持更多的 Jira 自定义字段或工作流，可以考虑：

1. **扩展 statusMap**：目前它只用于状态，但可以类似地添加其他字段的自定义映射。
2. **添加钩子**：在转换前后允许用户注入自定义逻辑。
3. **支持更多 API 版本差异**：如果未来 Jira API 有更多变化，可以考虑将版本特定的逻辑分离到不同的策略对象中。

## 总结

`jira_fieldmapper` 模块是一个专注于单一职责的组件——在 Beads 和 Jira 的数据模型之间进行转换。它的设计体现了几个重要的原则：
- **防御性编程**：安全地处理缺失字段
- **灵活性**：支持自定义映射
- **简单性**：保持最小化的状态和清晰的职责
- **兼容性**：处理不同版本的 Jira API

这个模块虽然不大，但它是整个 Jira 集成的关键部分，确保了两个系统之间能够顺畅地交换数据。
