# Linear Types 模块技术深度解析

## 1. 问题空间与模块定位

在集成外部 issue 跟踪系统时，最核心的挑战之一是如何准确、高效地在本地数据模型与远程 API 数据模型之间进行映射。对于 Linear 这样的 GraphQL API 驱动的系统，这一挑战尤为突出：

- **GraphQL 响应结构嵌套深**：Linear 的 API 返回高度嵌套的 JSON 结构，包含 `nodes`、`pageInfo` 等分页包装层
- **数据类型系统差异**：Linear 的状态类型（如 "unstarted"、"completed"）与内部模型的状态类型不完全对应
- **关系建模复杂**：Linear 支持多种 issue 关系类型（blocks、blockedBy、duplicate、related），需要转换为内部的依赖关系
- **API 交互的基础设施需求**：需要处理认证、分页、重试、错误处理等通用 API 调用逻辑

`linear_types` 模块正是为了解决这些问题而存在的。它不仅定义了与 Linear API 交互的数据契约，还提供了类型安全的转换基础设施，确保本地系统与 Linear 之间的数据一致性。

## 2. 心智模型：数据契约与转换管道

理解这个模块的最佳方式是将其视为一个**双向数据转换管道**：

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Linear GraphQL │───▶│  类型安全的 API  │───▶│  内部数据模型    │
│   API 响应      │    │  数据结构        │    │                  │
└─────────────────┘    └──────────────────┘    └──────────────────┘
         ▲                        ▲                        ▲
         │                        │                        │
         └────────────────────────┴────────────────────────┘
                           双向转换管道
```

核心抽象包括：

1. **API 数据契约**：精确匹配 Linear GraphQL API 响应结构的结构体（如 `Issue`、`Project`、`State`）
2. **请求/响应包装器**：处理 GraphQL 特定的请求格式（`GraphQLRequest`）和响应格式（`GraphQLResponse`）
3. **同步元数据**：跟踪同步操作状态和统计信息的类型（`SyncResult`、`SyncStats`、`PullStats`、`PushStats`）
4. **转换上下文**：辅助数据转换的临时结构（`IssueConversion`、`DependencyInfo`、`StateCache`）
5. **冲突表示**：表示同步冲突的数据结构（`Conflict`）

## 3. 核心组件深度解析

### 3.1 API 客户端与基础设施

#### `Client` 结构体
```go
type Client struct {
	APIKey     string
	TeamID     string
	ProjectID  string // Optional: filter issues to a specific project
	Endpoint   string // GraphQL endpoint URL (defaults to DefaultAPIEndpoint)
	HTTPClient *http.Client
}
```

**设计意图**：
- 这是 Linear 集成的核心入口点，封装了所有 API 交互所需的配置
- `ProjectID` 是可选的，允许在团队级别或项目级别进行同步
- `HTTPClient` 字段允许注入自定义 HTTP 客户端，便于测试和特殊网络配置

**关键配置常量**：
- `DefaultAPIEndpoint`：默认的 Linear GraphQL API 端点
- `DefaultTimeout`：30 秒的默认超时，平衡了响应性和可靠性
- `MaxRetries`：最多重试 3 次，配合指数退避策略处理速率限制
- `RetryDelay`：1 秒的基础重试延迟
- `MaxPageSize`：每页最多获取 100 个 issue，这是 Linear API 的限制

#### GraphQL 请求/响应包装器

```go
type GraphQLRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables,omitempty"`
}

type GraphQLResponse struct {
	Data   []byte         `json:"data"`
	Errors []GraphQLError `json:"errors,omitempty"`
}
```

**设计意图**：
- `GraphQLRequest` 标准化了 GraphQL 请求的格式，支持查询和变量
- `GraphQLResponse` 将原始 JSON 数据保留为 `[]byte`，允许灵活的反序列化
- `GraphQLError` 包含了完整的错误信息，包括错误路径和扩展代码，便于调试

### 3.2 核心数据模型

#### `Issue` 结构体
```go
type Issue struct {
	ID          string     `json:"id"`
	Identifier  string     `json:"identifier"` // e.g., "TEAM-123"
	Title       string     `json:"title"`
	Description string     `json:"description"`
	URL         string     `json:"url"`
	Priority    int        `json:"priority"` // 0=no priority, 1=urgent, 2=high, 3=medium, 4=low
	State       *State     `json:"state"`
	Assignee    *User      `json:"assignee"`
	Labels      *Labels    `json:"labels"`
	Project     *Project   `json:"project,omitempty"`
	Parent      *Parent    `json:"parent,omitempty"`
	Relations   *Relations `json:"relations,omitempty"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
	CompletedAt string     `json:"completedAt,omitempty"`
}
```

**设计意图**：
- 字段命名和 JSON 标签精确匹配 Linear API 的响应结构
- 使用指针类型（`*State`、`*User` 等）表示可选字段，避免零值混淆
- `Identifier` 字段是 Linear 的人类可读 ID（如 "TEAM-123"），而 `ID` 是内部 UUID
- `Priority` 字段使用整数编码，注释清晰说明了每个值的含义
- 时间字段使用字符串类型，因为 Linear API 返回 ISO 8601 格式的时间字符串

**关键关联**：
- `State`：工作流状态，包含类型信息（"backlog"、"unstarted"、"started"、"completed"、"canceled"）
- `Relations`：包含所有 issue 关系，是依赖关系转换的核心数据来源

#### `State` 结构体
```go
type State struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"` // "backlog", "unstarted", "started", "completed", "canceled"
}
```

**设计意图**：
- `Type` 字段是状态转换的关键，它将 Linear 的自定义状态映射到标准的工作流类别
- 这使得系统可以处理不同团队可能有不同状态名称但相同语义的情况

#### `Relation` 结构体
```go
type Relation struct {
	ID           string `json:"id"`
	Type         string `json:"type"` // "blocks", "blockedBy", "duplicate", "related"
	RelatedIssue struct {
		ID         string `json:"id"`
		Identifier string `json:"identifier"`
	} `json:"relatedIssue"`
}
```

**设计意图**：
- `Type` 字段定义了四种关系类型，需要转换为内部的依赖类型
- 注意 "blocks" 和 "blockedBy" 是反向关系，转换时需要正确处理方向
- `RelatedIssue` 包含了关联 issue 的 ID 和标识符，用于建立依赖链接

### 3.3 分页与响应包装器

Linear API 使用基于游标的分页，响应结构包含嵌套的 `nodes` 数组和 `pageInfo` 元数据。模块中的类型精确反映了这一结构：

```go
type IssuesResponse struct {
	Issues struct {
		Nodes    []Issue `json:"nodes"`
		PageInfo struct {
			HasNextPage bool   `json:"hasNextPage"`
			EndCursor   string `json:"endCursor"`
		} `json:"pageInfo"`
	} `json:"issues"`
}
```

**设计意图**：
- 这种嵌套结构直接映射了 GraphQL 查询的响应形状
- `PageInfo` 提供了分页所需的信息：是否有下一页和结束游标
- 类似的模式也应用于 `ProjectsResponse` 和 `TeamsResponse`

### 3.4 同步与转换类型

#### `SyncResult` 和 `SyncStats`
```go
type SyncResult struct {
	Success  bool      `json:"success"`
	Stats    SyncStats `json:"stats"`
	LastSync string    `json:"last_sync,omitempty"`
	Error    string    `json:"error,omitempty"`
	Warnings []string  `json:"warnings,omitempty"`
}

type SyncStats struct {
	Pulled    int `json:"pulled"`
	Pushed    int `json:"pushed"`
	Created   int `json:"created"`
	Updated   int `json:"updated"`
	Skipped   int `json:"skipped"`
	Errors    int `json:"errors"`
	Conflicts int `json:"conflicts"`
}
```

**设计意图**：
- `SyncResult` 提供了同步操作的完整结果，包括成功状态、统计信息、时间戳和错误
- `SyncStats` 细粒度地跟踪了同步过程中的各种操作计数，便于监控和调试
- 这些类型同时用于 API 响应和内部状态跟踪

#### `IssueConversion` 和 `DependencyInfo`
```go
type IssueConversion struct {
	Issue        interface{} // *types.Issue - avoiding circular import
	Dependencies []DependencyInfo
}

type DependencyInfo struct {
	FromLinearID string // Linear identifier of the dependent issue (e.g., "TEAM-123")
	ToLinearID   string // Linear identifier of the dependency target
	Type         string // Beads dependency type (blocks, related, duplicates, parent-child)
}
```

**设计意图**：
- `IssueConversion` 使用 `interface{}` 类型避免了循环导入，因为 `types.Issue` 可能会依赖这个模块
- 依赖信息被分离存储在 `DependencyInfo` 中，因为我们需要先导入所有 issue，然后才能建立它们之间的依赖关系
- `FromLinearID` 和 `ToLinearID` 使用 Linear 的标识符（如 "TEAM-123"）而不是 UUID，因为这是更稳定的引用方式

#### `Conflict` 结构体
```go
type Conflict struct {
	IssueID           string    // Beads issue ID
	LocalUpdated      time.Time // When the local version was last modified
	LinearUpdated     time.Time // When the Linear version was last modified
	LinearExternalRef string    // URL to the Linear issue
	LinearIdentifier  string    // Linear issue identifier (e.g., "TEAM-123")
	LinearInternalID  string    // Linear's internal UUID (for API updates)
}
```

**设计意图**：
- 冲突检测基于最后修改时间的比较
- 包含了足够的信息来呈现冲突给用户，并支持手动解决
- `LinearInternalID` 用于后续可能的 API 更新操作

#### `StateCache` 结构体
```go
type StateCache struct {
	States      []State
	StatesByID  map[string]State
	OpenStateID string // First "unstarted" or "backlog" state
}
```

**设计意图**：
- 缓存团队的工作流状态，避免重复的 API 调用
- `StatesByID` 提供了快速的 ID 到状态的映射
- `OpenStateID` 预缓存了默认的开放状态 ID，用于新创建的 issue

## 4. 数据流动与转换流程

让我们追踪一个典型的从 Linear 拉取 issue 的数据流程：

```
1. Client 发起 GraphQL 查询
   │
   ▼
2. Linear 返回 IssuesResponse JSON
   │
   ▼
3. 反序列化为 IssuesResponse 结构体
   │
   ▼
4. 遍历 Issues.Nodes 中的每个 Issue
   │
   ├─── 转换 Issue 基本信息
   │
   ├─── 转换 State 为内部状态类型
   │
   ├─── 处理 Labels
   │
   ├─── 收集 Relations 为 DependencyInfo
   │
   ▼
5. 创建 IssueConversion 结果
   │
   ▼
6. 所有 issue 处理完成后，批量创建依赖关系
   │
   ▼
7. 更新 SyncStats 和 SyncResult
```

**关键设计决策**：
- 依赖关系的创建被延迟到所有 issue 导入之后，因为依赖关系可能引用尚未导入的 issue
- 使用 `StateCache` 避免在转换每个 issue 时都查询状态信息
- 分页处理确保我们可以处理大量 issue 而不会内存溢出

## 5. 设计权衡与决策

### 5.1 精确匹配 vs 抽象简化

**决策**：选择精确匹配 Linear API 的响应结构，而不是创建更抽象的中间层。

**理由**：
- 精确匹配使得 API 变更的影响更加明显和可控
- 减少了转换逻辑的复杂性，因为数据结构与 API 响应一一对应
- 便于调试，可以直接查看原始 API 响应和反序列化后的结构

**权衡**：
- 当 Linear API 变更时，需要同步更新这些类型
- 代码与特定的 API 版本耦合较紧

### 5.2 指针类型 vs 值类型

**决策**：对于可选字段使用指针类型。

**理由**：
- 明确区分 "字段不存在" 和 "字段存在但值为零值" 的情况
- 与 GraphQL 的 null 语义直接对应

**权衡**：
- 需要更多的 nil 检查
- 增加了内存分配和间接访问的开销

### 5.3 时间字段使用字符串

**决策**：时间字段使用 `string` 类型而不是 `time.Time`。

**理由**：
- Linear API 返回的时间格式可能有变化，使用字符串可以保留原始格式
- 不同地区和时区的处理可以在转换层统一处理
- 避免了 JSON 反序列化时可能出现的时区问题

**权衡**：
- 需要额外的解析步骤将字符串转换为 `time.Time`
- 失去了类型安全的时间操作保障

### 5.4 使用 interface{} 避免循环导入

**决策**：在 `IssueConversion` 中使用 `interface{}` 类型。

**理由**：
- 避免了 `linear` 包和 `types` 包之间的循环依赖
- 保持了模块的独立性和可测试性

**权衡**：
- 失去了类型安全，需要在运行时进行类型断言
- 代码可读性略有降低

## 6. 扩展点与集成点

这个模块设计为与以下组件协作：

1. **[linear_tracker](internal-linear-linear_tracker.md)**：使用这些类型实现 `IssueTracker` 接口
2. **[linear_fieldmapper](internal-linear-linear_fieldmapper.md)**：使用这些类型进行字段映射
3. **[linear_mapping](internal-linear-linear_mapping.md)**：配置 Linear 与内部模型之间的映射关系

**关键扩展点**：
- `Client` 结构体可以通过 `HTTPClient` 字段注入自定义 HTTP 客户端
- `StateCache` 可以根据需要扩展以缓存更多元数据
- 新的 API 响应类型可以按照相同的模式添加

## 7. 常见陷阱与注意事项

### 7.1 关系方向处理

Linear 的 "blocks" 和 "blockedBy" 关系需要正确转换方向。确保在转换时：
- "blocks" 关系：当前 issue 阻塞了相关 issue
- "blockedBy" 关系：当前 issue 被相关 issue 阻塞

### 7.2 状态类型映射

Linear 允许自定义状态名称，但 `Type` 字段是标准化的。始终使用 `Type` 字段而不是 `Name` 字段来确定状态的语义。

### 7.3 分页处理

不要假设一次查询就能获取所有 issue。始终检查 `HasNextPage` 并使用 `EndCursor` 进行分页请求。

### 7.4 时间解析

Linear API 返回的时间字符串是 ISO 8601 格式，可能包含毫秒级精度。使用 `time.RFC3339Nano` 进行解析以保留完整精度。

### 7.5 标识符使用

在建立依赖关系时，优先使用 Linear 的 `Identifier`（如 "TEAM-123"）而不是 `ID`（UUID），因为标识符更稳定且更易于调试。

## 8. 总结

`linear_types` 模块是 Linear 集成的基础，它提供了：

1. **精确的 API 数据契约**：与 Linear GraphQL API 响应结构完全匹配
2. **类型安全的转换基础设施**：支持在 Linear 数据模型和内部数据模型之间进行双向转换
3. **同步操作的元数据**：跟踪同步状态、统计信息和冲突
4. **实用的缓存机制**：减少 API 调用次数，提高性能

这个模块的设计体现了"简单、直接、可维护"的原则，通过精确映射 API 结构和明确的分离关注点，使得 Linear 集成既可靠又易于理解和扩展。
