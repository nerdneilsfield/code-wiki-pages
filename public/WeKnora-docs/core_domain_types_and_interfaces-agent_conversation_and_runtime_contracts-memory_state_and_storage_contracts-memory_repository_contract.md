# memory_repository_contract 模块技术深度文档

## 1. 概述

`memory_repository_contract` 模块定义了 WeKnora 系统中记忆存储和检索的核心抽象契约。这个模块的核心是 `MemoryRepository` 接口，它负责将对话会话作为"情节"(Episode)存储到知识图中，并能够根据关键词检索相关的历史对话。

想象一下，这个模块就像一个图书馆的目录系统——它不仅保存着每本书的内容（对话会话），还建立了主题索引和交叉引用网络，让你能够快速找到与当前主题相关的所有历史记录。

## 2. 核心组件解析

### 2.1 MemoryService 接口

`MemoryService` 位于业务逻辑层，是记忆系统对外的统一入口。

```go
type MemoryService interface {
    AddEpisode(ctx context.Context, userID string, sessionID string, messages []types.Message) error
    RetrieveMemory(ctx context.Context, userID string, query string) (*types.MemoryContext, error)
}
```

**设计意图**：
- `AddEpisode` 方法接收原始消息流，负责将其转化为结构化的记忆单元，这是一个"写"操作
- `RetrieveMemory` 方法根据当前查询，智能地返回相关的历史记忆上下文，这是一个"读"操作

这个接口的设计体现了职责分离原则：服务层负责业务逻辑编排，而将实际的存储和检索操作委托给 `MemoryRepository`。

### 2.2 MemoryRepository 接口

`MemoryRepository` 是数据访问层的核心抽象，定义了记忆图的持久化和查询契约。

```go
type MemoryRepository interface {
    SaveEpisode(ctx context.Context, episode *types.Episode, entities []*types.Entity, relations []*types.Relationship) error
    FindRelatedEpisodes(ctx context.Context, userID string, keywords []string, limit int) ([]*types.Episode, error)
    IsAvailable(ctx context.Context) bool
}
```

**核心方法解析**：

1. **SaveEpisode**  
   这是一个事务性操作，它不是简单地保存一个 Episode，而是同时保存：
   - Episode（对话情节本身）
   - Entity（从对话中提取的实体）
   - Relationship（实体之间的关系）
   
   这种设计确保了记忆图的完整性——要么全部成功保存，要么全部回滚。

2. **FindRelatedEpisodes**  
   这个方法体现了记忆检索的核心逻辑：
   - 按用户隔离（userID）确保隐私和上下文隔离
   - 使用关键词进行语义关联查找
   - 通过 limit 控制返回结果集大小，避免上下文过载

3. **IsAvailable**  
   这是一个健康检查方法，允许上层服务在记忆存储不可用时优雅降级。

### 2.3 核心数据模型

#### Episode（对话情节）

```go
type Episode struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    SessionID string    `json:"session_id"`
    Summary   string    `json:"summary"`
    CreatedAt time.Time `json:"created_at"`
}
```

**设计洞察**：
- `Summary` 字段是关键——它不是原始对话的简单拼接，而是经过提炼的摘要，这使得检索更加高效和准确
- 通过 `UserID` 和 `SessionID` 建立了用户→会话→情节的层级关系

#### MemoryContext（记忆上下文）

```go
type MemoryContext struct {
    RelatedEpisodes   []Episode      `json:"related_episodes"`
    RelatedEntities   []Entity       `json:"related_entities"`
    RelatedRelations  []Relationship `json:"related_relations"`
}
```

这个结构是检索操作的返回值，它提供了一个全面的上下文视图，不仅仅是相关的对话情节，还包括相关的实体和关系，使得 LLM 能够更好地理解历史语境。

## 3. 架构与数据流

### 3.1 模块在系统中的位置

`memory_repository_contract` 位于系统的核心领域层，它连接了上层的会话服务和下层的图数据库实现：

```
┌─────────────────────────────────────┐
│     会话与对话服务层                  │
│  (session_lifecycle_api等)          │
└──────────────┬──────────────────────┘
               │ 调用
               ↓
┌─────────────────────────────────────┐
│      MemoryService                  │
│   (业务逻辑编排层)                   │
└──────────────┬──────────────────────┘
               │ 委托
               ↓
┌─────────────────────────────────────┐
│   MemoryRepository (本模块)          │
│     (抽象契约层)                     │
└──────────────┬──────────────────────┘
               │ 实现
               ↓
┌─────────────────────────────────────┐
│   图数据库实现层                      │
│  (neo4j_retrieval_repository等)     │
└─────────────────────────────────────┘
```

### 3.2 典型数据流

#### 数据写入流程（添加记忆）

1. **会话服务** 接收用户消息，形成完整对话
2. 调用 `MemoryService.AddEpisode()`，传入用户ID、会话ID和消息列表
3. `MemoryService` 内部执行：
   - 从消息中提取关键实体和关系
   - 生成对话摘要
   - 构建 `Episode`、`Entity`、`Relationship` 对象
   - 调用 `MemoryRepository.SaveEpisode()`
4. `MemoryRepository` 实现将数据持久化到图数据库

#### 数据检索流程（回忆记忆）

1. **会话服务** 收到新的用户查询
2. 调用 `MemoryService.RetrieveMemory()`，传入用户ID和查询
3. `MemoryService` 内部执行：
   - 从查询中提取关键词
   - 调用 `MemoryRepository.FindRelatedEpisodes()`
   - 组合返回的情节、实体和关系，构建 `MemoryContext`
4. 将 `MemoryContext` 返回给会话服务，用于丰富 LLM 上下文

## 4. 设计决策与权衡

### 4.1 接口分离：MemoryService vs MemoryRepository

**决策**：将业务逻辑与数据访问分离为两个不同的接口

**原因**：
- **单一职责原则**：`MemoryService` 关注"做什么"（如何处理对话），`MemoryRepository` 关注"怎么做"（如何存储数据）
- **可测试性**：可以轻松mock `MemoryRepository` 来测试 `MemoryService` 的业务逻辑
- **实现灵活性**：可以有多种 `MemoryRepository` 实现（Neo4j、内存、其他图数据库），而不影响上层业务逻辑

### 4.2 批量原子操作：SaveEpisode 的设计

**决策**：`SaveEpisode` 方法一次性接收 Episode、Entities 和 Relations 三个参数

**权衡**：
- ✅ **优点**：确保记忆图的一致性，避免部分保存导致的数据不一致
- ⚠️ **缺点**：方法签名较为复杂，调用者需要准备所有数据
- **为什么这样设计**：在图数据库中，节点和边是相互依赖的，单独保存没有意义，因此必须作为一个原子操作

### 4.3 用户隔离：FindRelatedEpisodes 中的 userID 参数

**决策**：所有检索操作都强制要求 userID 参数

**原因**：
- **隐私保护**：天然确保用户只能访问自己的记忆
- **性能优化**：可以在图数据库中按用户进行分区，提高查询效率
- **简单明确**：API 设计清晰，不会出现忘记过滤用户的错误

### 4.4 可用性检查：IsAvailable 方法

**决策**：包含一个专门的健康检查方法

**权衡**：
- ✅ **优点**：允许系统优雅处理存储服务不可用的情况
- ⚠️ **缺点**：增加了接口的复杂性，且可能被误用（比如在每次操作前都检查，而不是利用错误处理）
- **为什么这样设计**：记忆系统是增强性功能，而非核心功能——当记忆存储不可用时，系统应该能够继续运行，只是没有记忆增强能力

## 5. 实现者指南

### 5.1 如何实现 MemoryRepository

如果你要为新的图数据库实现 `MemoryRepository`，需要注意以下几点：

1. **事务保证**：`SaveEpisode` 必须是原子的——要么全部保存成功，要么全部回滚
2. **用户隔离**：确保不同用户的数据在存储层面也是隔离的
3. **关联查询**：`FindRelatedEpisodes` 需要实现实体→关系→情节的关联查询
4. **错误处理**：对于图数据库特有的错误（如连接失败、约束冲突），提供有意义的错误信息

### 5.2 使用场景与注意事项

#### 适用场景

- 需要维护长期对话上下文的智能助手
- 需要根据历史对话进行个性化响应的系统
- 需要从历史对话中提取知识并应用于新场景的应用

#### 注意事项

1. **摘要质量**：Episode 的摘要质量直接影响检索效果，投入精力优化摘要生成逻辑是值得的
2. **实体提取**：实体识别的准确性决定了记忆关联的质量
3. **Limit 参数**：合理设置 `FindRelatedEpisodes` 的 limit，避免返回过多历史导致上下文窗口溢出
4. **性能考量**：图查询通常比关系数据库查询慢，考虑使用缓存或异步更新策略

## 6. 与其他模块的关系

### 6.1 依赖模块

- [memory_state_and_episode_models](core_domain_types_and_interfaces-agent_conversation_and_runtime_contracts-memory_state_and_storage_contracts-memory_state_and_episode_models.md)：提供核心数据类型（Episode、MemoryContext等）
- [graph_retrieval_and_memory_repositories](data_access_repositories-graph_retrieval_and_memory_repositories.md)：包含 MemoryRepository 的具体实现

### 6.2 被依赖模块

- [memory_service_contract](core_domain_types_and_interfaces-agent_conversation_and_runtime_contracts-memory_state_and_storage_contracts-memory_service_contract.md)：定义了使用 MemoryRepository 的服务层接口
- [conversation_context_and_memory_services](application_services_and_orchestration-conversation_context_and_memory_services.md)：实现了记忆服务，使用 MemoryRepository 来管理对话记忆

## 7. 总结

`memory_repository_contract` 模块是 WeKnora 系统中记忆功能的基石，它通过简洁而强大的接口定义，将图数据库的复杂性抽象为易于理解的记忆操作。

这个模块的设计体现了几个关键原则：
1. **接口驱动设计**：通过接口分离关注点，提高系统的灵活性和可测试性
2. **领域建模**：将对话抽象为情节、实体和关系，符合人类记忆的认知模型
3. **用户中心**：从设计之初就考虑用户隔离和隐私保护
4. **优雅降级**：通过可用性检查，确保系统在记忆功能不可用时仍能正常运行

对于新加入团队的开发者来说，理解这个模块的关键在于认识到它不是一个简单的 CRUD 接口，而是一个专门为对话记忆场景设计的领域抽象——它将图数据库的强大能力包装成符合记忆心理学的操作模型。
