# GitLab 字段映射器模块技术深度解析

## 1. 问题背景与模块定位

在多系统同步的场景中，不同的问题跟踪系统（如 GitLab、Jira、Linear）有各自独特的数据模型、字段格式和状态表示。为了实现 Beads 内部统一问题模型与外部跟踪器之间的无缝转换，需要一个专门的转换层。

`gitlab_fieldmapper` 模块正是解决这个问题的核心组件。它实现了 `tracker.FieldMapper` 接口，专门负责将 GitLab 特有的数据格式与 Beads 内部数据模型进行双向转换。这种设计使得同步引擎可以通过统一的接口处理不同的跟踪系统，而不需要关心每个系统的具体数据格式。

## 2. 核心组件与数据模型

### 2.1 gitlabFieldMapper 结构体

`gitlabFieldMapper` 是该模块的核心结构体，定义如下：

```go
type gitlabFieldMapper struct {
        config *MappingConfig
}
```

设计意图是采用配置驱动而非硬编码的方式，使得字段映射规则可以灵活调整，而无需修改代码。`MappingConfig` 定义了所有需要的映射关系：

- PriorityMap：GitLab 优先级标签到 Beads 优先级（0-4）的映射
- StateMap：GitLab 状态到 Beads 状态的映射
- LabelTypeMap：GitLab 类型标签到 Beads 问题类型的映射
- RelationMap：GitLab 关联类型到 Beads 依赖类型的映射

## 3. 核心功能与实现原理

### 3.1 优先级转换

GitLab 使用基于标签的优先级系统，而非数值。`PriorityToBeads` 方法将 GitLab 的优先级标签映射为 Beads 的数值优先级（0-4），而 `PriorityToTracker` 则进行反向映射。两个方法都提供了默认值，确保在配置不完整时也能正常工作。

### 3.2 状态转换

状态转换先尝试使用配置中的映射，然后才使用硬编码的默认值。GitLab 有 "opened"、"reopened" 和 "closed" 三种主要状态，而反向映射比较简单，只有 "closed" 和 "opened" 两种状态。

### 3.3 类型转换

类型转换同样基于配置，默认返回 "task" 类型。反向映射直接将 Beads 的 IssueType 转换为字符串，这意味着 Beads 的类型名称需要与 GitLab 的类型标签名称保持一致。

### 3.4 完整问题转换

`IssueToBeads` 方法是整个模块的核心，负责完整的问题转换。它首先检查输入类型，然后委托给专门的转换函数，特别处理了依赖关系的转换，将 GitLab 的 IID（项目内部 ID）转换为字符串格式的外部 ID。

### 3.5 Beads 问题转换为 GitLab 字段

`IssueToTracker` 方法非常简洁，直接将工作委托给专门的函数，返回 GitLab API 所需的字段映射。

## 4. 数据流程与依赖关系

### 4.1 数据流程

从 GitLab 到 Beads 的转换流程包括获取原始数据、封装为标准格式、调用转换方法、处理依赖关系等步骤。反向转换流程类似，但方向相反。

### 4.2 依赖关系

该模块的依赖关系如下：

- 依赖的模块：
  - [tracker](internal-tracker-tracker.md)：提供 FieldMapper 接口和相关数据类型
  - [gitlab.mapping](internal-gitlab-mapping.md)：提供 MappingConfig 配置类型
  - [gitlab.types](internal-gitlab-types.md)：提供 GitLab 特定的数据类型
  - [types](internal-types-types.md)：提供 Beads 内部数据类型

- 被依赖的模块：
  - [gitlab.tracker](internal-gitlab-tracker.md)：在 GitLab 跟踪器实现中使用该字段映射器

## 5. 设计决策与权衡

### 5.1 配置驱动 vs 硬编码

决策采用配置驱动的映射方式，通过 MappingConfig 结构提供灵活性。这种设计适应了不同 GitLab 实例可能有不同标签和状态配置的情况，但需要额外的配置管理。

### 5.2 类型安全与动态转换

决策使用 interface{} 类型处理不同跟踪系统的特定数据，并在转换时进行类型断言。这保持了接口的通用性，但失去了编译时类型检查。

### 5.3 默认值策略

决策在所有转换方法中都提供合理的默认值，确保在配置不完整时系统仍能正常工作。这提高了系统的健壮性，但如果默认值不合适，可能导致数据不一致。

## 6. 使用指南与常见模式

### 6.1 配置示例

通常，MappingConfig 的配置会类似于：

```go
config := &MappingConfig{
    PriorityMap: map[string]int{
        "priority::critical": 0,
        "priority::high":     1,
        "priority::medium":   2,
        "priority::low":      3,
        "priority::trivial":  4,
    },
    StateMap: map[string]string{
        "opened":   "open",
        "closed":   "closed",
        "reopened": "open",
    },
    LabelTypeMap: map[string]string{
        "type::bug":    "bug",
        "type::feature": "feature",
        "type::task":    "task",
    },
    RelationMap: map[string]string{
        "blocks": "blocks",
        "relates_to": "relates_to",
    },
}

mapper := &gitlabFieldMapper{config: config}
```

### 6.2 扩展映射规则

要扩展或修改映射规则，只需更新 MappingConfig 实例中的相应映射表，而无需修改 gitlabFieldMapper 的代码。

### 6.3 与同步引擎集成

gitlabFieldMapper 通常不会直接使用，而是通过 gitlab.tracker.Tracker 间接使用。在创建 GitLab 跟踪器时，会将配置好的字段映射器传递给它。

## 7. 注意事项与潜在问题

- 反向优先级映射使用线性扫描，在优先级数量较少时可以接受，但大量优先级时可能影响性能
- 类型映射需要确保 Beads 中定义的 IssueType 名称与 GitLab 中使用的类型标签名称保持一致
- 当前实现中，当类型断言失败时会返回 nil，可能需要添加上游处理或日志记录

## 8. 总结

gitlab_fieldmapper 模块是 Beads 系统与 GitLab 集成的关键组件，它通过配置驱动的方式实现了两个系统之间数据模型的双向转换。理解这个模块的关键在于认识到它作为一个适配器的角色——它将 GitLab 特定的数据模型转换为 Beads 内部的统一模型，同时也处理反向转换。
