# Session Conversation Lifecycle Service

## 概述：会话的生命线管家

想象一下你正在经营一家高端咨询公司。每位客户来访时，你都需要：
- 为客户建立一个专属档案（**创建会话**）
- 记录每次对话的内容（**消息持久化**）
- 根据客户问题，要么直接查阅公司内部知识库给出答案（**KnowledgeQA**），要么派遣一位专家顾问调用各种工具深入分析（**AgentQA**）
- 对话结束后整理归档，必要时清理敏感信息（**删除会话**）

`session_conversation_lifecycle_service` 就是这个咨询公司的**前台经理**。它不直接回答问题，也不直接存储数据，而是**协调各方资源**，确保每次对话都能顺畅进行。

这个模块存在的核心原因是：**会话管理是一个跨领域的协调工作**。一次简单的用户提问，背后涉及：
- 权限校验（用户能否访问这些知识库？）
- 模型选择（用哪个 LLM 来总结？）
- 检索策略（搜哪些知识库？用什么阈值？）
- 上下文管理（历史对话要不要压缩？）
- 事件流控（如何把结果流式推送给前端？）

如果把这些逻辑分散到各个地方，系统会变得难以维护。因此，这个服务采用**外观模式（Facade Pattern）**，对外提供简洁的接口，对内协调十多个依赖组件。

---

## 架构与数据流

```mermaid
flowchart TB
    Handler[HTTP Handler 层] --> SessionService[sessionService]
    
    subgraph Repositories [数据持久化]
        SessionRepo[SessionRepository]
        MessageRepo[MessageRepository]
    end
    
    subgraph Services [业务服务]
        KBService[KnowledgeBaseService]
        ModelService[ModelService]
        AgentService[AgentService]
        MemoryService[MemoryService]
    end
    
    subgraph Pipeline [对话流水线]
        EventManager[EventManager]
        ContextStorage[ContextStorage]
    end
    
    subgraph EventBus [事件流]
        EventBus[EventBus]
    end
    
    SessionService --> SessionRepo
    SessionService --> MessageRepo
    SessionService --> KBService
    SessionService --> ModelService
    SessionService --> AgentService
    SessionService --> MemoryService
    SessionService --> EventManager
    SessionService --> ContextStorage
    SessionService --> EventBus
    
    Handler -.->|1. KnowledgeQA/AgentQA | SessionService
    SessionService -.->|2. 触发流水线事件 | EventManager
    EventManager -.->|3. 发射答案事件 | EventBus
    EventBus -.->|4. SSE 推送 | Handler
```

### 组件角色说明

| 组件 | 职责 | 耦合程度 |
|------|------|----------|
| `SessionRepository` | 会话记录的 CRUD | 强耦合（核心依赖） |
| `MessageRepository` | 消息历史持久化 | 强耦合 |
| `KnowledgeBaseService` | 知识库元数据查询 | 中耦合（仅用于模型选择和权限解析） |
| `ModelService` | LLM 模型获取 | 强耦合（每次 QA 都需要） |
| `AgentService` | Agent 引擎创建 | 强耦合（AgentQA 模式） |
| `EventManager` | 流水线事件触发 | 强耦合（KnowledgeQA 核心） |
| `ContextStorage` | 对话上下文缓存（Redis/内存） | 中耦合 |
| `EventBus` | 事件广播（用于流式响应） | 强耦合 |

### 数据流追踪：一次 KnowledgeQA 请求的旅程

```
用户提问 "什么是 RAG？"
    ↓
Handler 层解析请求，调用 sessionService.KnowledgeQA()
    ↓
sessionService 解析知识库 ID（考虑 @提及、Agent 配置、RetrieveKBOnlyWhenMentioned）
    ↓
构建 SearchTargets（统一表示要搜索的范围）
    ↓
选择 Chat 模型（优先级：请求覆盖 > KB 的 Remote 模型 > Session 模型 > 默认）
    ↓
创建 ChatManage 对象（携带所有配置参数）
    ↓
确定流水线类型：
    - 无 KB + 无网络搜索 → chat_stream / chat_history_stream
    - 有 KB 或有网络搜索 → rag_stream
    ↓
调用 EventManager.Trigger() 依次触发事件：
    LOAD_HISTORY → REWRITE → SEARCH → RERANK → MERGE → INTO_CHAT_MESSAGE → CHAT_COMPLETION_STREAM
    ↓
每个事件由对应的 Plugin 处理，结果存入 chatManage
    ↓
chat_completion_stream Plugin 通过 EventBus 发射 Answer 事件
    ↓
Handler 层订阅 EventBus，将事件转为 SSE 推送给前端
```

---

## 核心组件深度解析

### `sessionService` 结构体

```go
type sessionService struct {
    cfg                  *config.Config
    sessionRepo          interfaces.SessionRepository
    messageRepo          interfaces.MessageRepository
    knowledgeBaseService interfaces.KnowledgeBaseService
    modelService         interfaces.ModelService
    tenantService        interfaces.TenantService
    eventManager         *chatpipline.EventManager
    agentService         interfaces.AgentService
    sessionStorage       llmcontext.ContextStorage
    knowledgeService     interfaces.KnowledgeService
    chunkService         interfaces.ChunkService
    webSearchStateRepo   interfaces.WebSearchStateService
    kbShareService       interfaces.KBShareService
    memoryService        interfaces.MemoryService
}
```

**设计意图**：这是一个典型的**依赖注入**结构。所有依赖都通过接口注入，使得：
1. 单元测试时可以轻松替换为 Mock
2. 未来替换实现（如换数据库）不影响业务逻辑
3. 依赖关系清晰可见

**关键观察**：注意 `eventManager` 是直接引用具体类型而非接口。这是因为 `EventManager` 是内部包，且其事件触发机制较为复杂，抽象成接口的收益不大。

---

### `CreateSession` / `GetSession` / `DeleteSession`

这些是标准的 CRUD 方法，但有几个值得注意的设计细节：

```go
func (s *sessionService) DeleteSession(ctx context.Context, id string) error {
    // 1. 先清理 Redis 中的临时状态
    s.webSearchStateRepo.DeleteWebSearchTempKBState(ctx, id)
    s.sessionStorage.Delete(ctx, id)
    
    // 2. 再删除数据库记录
    s.sessionRepo.Delete(ctx, tenantID, id)
}
```

**为什么先清理缓存再删数据库？**

这是**缓存失效策略**的典型实践。如果先删数据库，清理缓存失败时，数据库已删除但缓存残留，会导致不一致。反过来，即使缓存清理失败（日志警告但不返回错误），至少数据库是一致的，下次读取时会重新加载。

**TenantID 从 Context 获取**：

```go
tenantID := ctx.Value(types.TenantIDContextKey).(uint64)
```

这是一个重要的**安全边界**。所有会话操作都必须携带租户 ID，且从上下文获取而非请求参数，防止用户越权访问其他租户的数据。

---

### `GenerateTitle` 与 `GenerateTitleAsync`

**问题**：为什么需要两个版本？

```go
// 同步版本：阻塞等待标题生成
title, err := s.GenerateTitle(ctx, session, messages, modelID)

// 异步版本：后台生成，通过事件通知
s.GenerateTitleAsync(ctx, session, userQuery, modelID, eventBus)
```

**设计权衡**：

| 维度 | 同步版本 | 异步版本 |
|------|----------|----------|
| 用户体验 | 创建会话时需等待 | 立即返回，标题稍后更新 |
| 资源占用 | 占用请求线程 | 后台 goroutine |
| 错误处理 | 可直接返回错误 | 错误只能记录日志 |
| 使用场景 | 批量导入等后台任务 | 用户交互式创建会话 |

**异步版本的 Bug 修复注释**：

```go
// BUG FIX: use bgCtx instead of ctx
// The original ctx is from the HTTP request and may be cancelled by the time we get here
go func() {
    bgCtx := context.Background()
    if tenantID != nil {
        bgCtx = context.WithValue(bgCtx, types.TenantIDContextKey, tenantID)
    }
    // ...
}()
```

这是一个经典的**上下文生命周期陷阱**。HTTP 请求的 `ctx` 在响应返回后会被取消，如果后台 goroutine 继续使用它，可能导致：
- 数据库查询被意外中断
- 日志记录失败
- 事件发射失败

解决方案是创建一个新的后台上下文，但**保留必要的元数据**（TenantID、RequestID）。

---

### `KnowledgeQA`：RAG 问答的核心入口

这是整个模块**最复杂**的方法，有超过 300 行代码。让我们分解它的核心逻辑：

#### 1. 知识库解析策略

```go
hasExplicitMention := len(knowledgeBaseIDs) > 0 || len(knowledgeIDs) > 0
if hasExplicitMention {
    // 用户明确 @ 了知识库，只用这些
} else if customAgent != nil && customAgent.Config.RetrieveKBOnlyWhenMentioned {
    // 配置要求必须 @ 提及，否则不检索
    knowledgeBaseIDs = nil
} else {
    // 使用 Agent 配置的知识库
    knowledgeBaseIDs = s.resolveKnowledgeBasesFromAgent(ctx, customAgent)
}
```

**设计意图**：这是一个**三层优先级**系统：

```
用户显式指定 > Agent 配置 > 默认行为
```

这种设计平衡了**灵活性**和**可控性**：
- 用户可以临时覆盖 Agent 的默认行为
- Agent 可以配置"只在被问到时检索"，避免无关检索
- 默认情况下使用 Agent 配置的知识库

#### 2. 模型选择策略

```go
// 优先级：
// 1. 请求的 summaryModelID（如果有效）
// 2. Session 的 SummaryModelID（如果是 Remote 模型）
// 3. 第一个有 Remote 模型的知识库
// 4. Session 的 SummaryModelID（非 Remote）
// 5. 第一个知识库的 SummaryModelID
```

**为什么 Remote 模型优先级高？**

Remote 模型通常指外部 LLM 服务（如 OpenAI、DeepSeek），而本地模型可能能力有限。优先使用 Remote 模型可以确保**回答质量**。这是一个**质量优先于成本**的权衡。

#### 3. 配置继承链

```go
// 默认值来自 config.yaml
rewritePromptSystem := s.cfg.Conversation.RewritePromptSystem
// ...

// CustomAgent 配置可以覆盖
if customAgent != nil {
    if customAgent.Config.SystemPrompt != "" {
        summaryConfig.Prompt = customAgent.Config.SystemPrompt
    }
    if customAgent.Config.Temperature > 0 {
        summaryConfig.Temperature = customAgent.Config.Temperature
    }
    // ... 更多覆盖
}
```

**配置优先级**：

```
请求参数 > CustomAgent 配置 > config.yaml 默认值
```

这种**分层配置**使得：
- 系统管理员可以设置全局默认值
- Agent 创建者可以定制 Agent 行为
- 用户可以在单次请求中临时覆盖

**风险**：配置来源太多，调试困难。建议添加配置溯源日志。

#### 4. 流水线选择

```go
if len(knowledgeBaseIDs) == 0 && len(knowledgeIDs) == 0 && !webSearchEnabled {
    // 纯聊天模式
    if maxRounds > 0 {
        pipeline = types.Pipline["chat_history_stream"]
    } else {
        pipeline = types.Pipline["chat_stream"]
    }
} else {
    // RAG 模式（包含网络搜索）
    pipeline = types.Pipline["rag_stream"]
}
```

**关键洞察**：这里体现了**模式分离**的设计思想。纯聊天不需要检索、重排序等步骤，使用简化的流水线可以：
- 减少延迟
- 降低成本
- 避免不必要的错误源

---

### `AgentQA`：Agent 模式的入口

与 `KnowledgeQA` 相比，`AgentQA` 的核心差异在于：

| 维度 | KnowledgeQA | AgentQA |
|------|-------------|---------|
| 核心引擎 | EventManager + Plugins | AgentEngine |
| 工具调用 | 无 | 支持（搜索、数据库、代码等） |
| 上下文管理 | 简单历史加载 | ContextManager（带压缩策略） |
| 多轮对话 | 固定轮数 | 可配置，支持压缩 |
| 系统提示 | 固定模板 | 可自定义 |

**关键代码片段**：

```go
// 创建 ContextManager（带压缩策略）
contextManager := s.getContextManagerForSession(ctx, session, summaryModel)

// 获取压缩后的上下文
llmContext, err := s.getContextForSession(ctx, contextManager, sessionID)

// 创建 Agent 引擎
engine, err := s.agentService.CreateAgentEngine(
    ctx, agentConfig, summaryModel, rerankModel, eventBus, contextManager, session.ID,
)

// 执行（异步，事件通过 EventBus 发射）
engine.Execute(ctx, sessionID, assistantMessageID, query, llmContext)
```

**设计模式**：这里是**策略模式**的应用。`ContextManager` 封装了不同的上下文压缩策略（滑动窗口、智能压缩），`AgentEngine` 封装了不同的 Agent 执行策略。

---

### `buildSearchTargets`：统一搜索目标表示

```go
func (s *sessionService) buildSearchTargets(
    ctx context.Context,
    tenantID uint64,
    knowledgeBaseIDs []string,
    knowledgeIDs []string,
) (types.SearchTargets, error)
```

**问题**：为什么需要这个方法？

**答案**：因为搜索可能涉及：
- 整个知识库（`SearchTargetTypeKnowledgeBase`）
- 知识库中的特定文件（`SearchTargetTypeKnowledge`）
- 共享知识库（需要解析实际租户 ID）

如果不统一表示，后续每个 Plugin 都要重复解析逻辑。这个方法体现了**DRY 原则**和**预处理优化**。

**权限解析逻辑**：

```go
if kb.TenantID == tenantID {
    kbTenantMap[kbID] = tenantID
} else if s.kbShareService != nil && userID != "" {
    hasAccess, _ := s.kbShareService.HasKBPermission(ctx, kbID, userID, types.OrgRoleViewer)
    if hasAccess {
        kbTenantMap[kbID] = kb.TenantID  // 共享 KB 用 KB 所有者的租户 ID
    }
}
```

这是一个**细粒度权限控制**的实现。共享知识库的检索必须在 KB 所有者的租户范围内进行，而不是当前用户的租户。

---

### `handleFallbackResponse`：检索失败时的降级策略

当检索不到相关内容时，系统不能直接报错，而是需要**优雅降级**：

```go
if chatManage.FallbackStrategy == types.FallbackStrategyModel {
    s.handleModelFallback(ctx, chatManage)  // 用 LLM 生成通用回答
} else {
    s.handleFixedFallback(ctx, chatManage)  // 返回预设的固定回答
}
```

**Model Fallback 的流式处理**：

```go
// 启动 goroutine 消费流式响应
go s.consumeFallbackStream(ctx, chatManage, responseChan)
```

**为什么用 goroutine？**

因为 `handleFallbackResponse` 是在事件流水线中同步调用的，如果阻塞等待 LLM 响应，整个流水线会卡住。用 goroutine 异步消费流式响应，通过 EventBus 发射事件，保持流水线的非阻塞特性。

---

## 依赖分析

### 被谁调用（Upstream）

| 调用方 | 调用方法 | 期望 |
|--------|----------|------|
| `internal/handler/session/handler.go` | `KnowledgeQA`, `AgentQA`, `SearchKnowledge` | 返回错误或直接通过 EventBus 发射事件 |
| `internal/handler/session/agent_stream_handler.go` | `AgentQA` | 异步执行，事件通过 SSE 推送 |
| `internal/application/service/chat_pipline/` | `KnowledgeQAByEvent` | 触发流水线事件 |

### 调用谁（Downstream）

| 被调用方 | 调用方法 | 用途 |
|----------|----------|------|
| `SessionRepository` | `Create`, `Get`, `Update`, `Delete` | 会话持久化 |
| `MessageRepository` | `GetFirstMessageOfUser` | 标题生成 |
| `KnowledgeBaseService` | `GetKnowledgeBaseByID`, `ListKnowledgeBases` | 模型选择、权限解析 |
| `ModelService` | `GetChatModel`, `GetRerankModel`, `ListModels` | 获取 LLM 实例 |
| `AgentService` | `CreateAgentEngine` | AgentQA 模式 |
| `EventManager` | `Trigger` | 触发流水线事件 |
| `ContextStorage` | `Get`, `Delete` | 上下文缓存 |
| `EventBus` | `Emit` | 发射事件到前端 |

### 数据契约

**输入**：
- `types.Session`：会话元数据
- `types.CustomAgent`：可选的自定义 Agent 配置
- `[]string`：知识库 ID 列表
- `string`：用户查询

**输出**：
- `error`：错误信息
- 事件通过 `EventBus` 异步发射（不直接返回结果）

**隐式契约**：
1. `ctx` 必须包含 `TenantIDContextKey`，否则 panic
2. `EventBus` 不能为 nil（KnowledgeQA/AgentQA 需要）
3. `CustomAgent` 在 AgentQA 模式下必须提供

---

## 设计决策与权衡

### 1. 事件驱动 vs 直接返回

**选择**：事件驱动

**理由**：
- 支持流式响应（SSE）
- 解耦处理逻辑和响应推送
- 便于添加中间事件（如思考过程、工具调用）

**代价**：
- 错误处理复杂（错误也需通过事件发射）
- 调试困难（需要追踪事件流）
- 测试复杂（需要 Mock EventBus）

### 2. 配置来源多元化

**选择**：支持多层配置覆盖

**理由**：
- 灵活性：不同场景需要不同配置
- 向后兼容：新配置不破坏旧逻辑

**代价**：
- 配置优先级容易混淆
- 调试时需要追踪配置来源
- 代码复杂度高（大量 if-else）

**改进建议**：添加配置溯源日志，记录每个配置项的最终来源。

### 3. 同步 vs 异步标题生成

**选择**：提供两个版本

**理由**：
- 同步版本用于后台任务（可等待）
- 异步版本用于用户交互（不阻塞）

**代价**：
- 代码重复
- 需要维护两个实现

### 4. TenantID 从 Context 获取

**选择**：不从参数传递

**理由**：
- 安全：防止参数篡改
- 一致：所有请求都经过中间件注入

**代价**：
- 测试时需要手动注入 Context
- 忘记注入会导致 panic（类型断言失败）

**改进建议**：添加 Context 验证辅助函数，提前返回友好错误。

---

## 使用示例

### 创建会话并发起 KnowledgeQA

```go
// 1. 创建会话
session := &types.Session{
    TenantID: tenantID,
    Title:    "",  // 稍后异步生成
}
created, err := sessionService.CreateSession(ctx, session)

// 2. 发起问答（异步，结果通过 EventBus 发射）
eventBus := event.NewEventBus()
err = sessionService.KnowledgeQA(
    ctx,
    created,
    "什么是 RAG？",
    []string{"kb-123"},  // 知识库 ID
    nil,                 // 不指定具体文件
    "msg-456",          // 助手消息 ID
    "",                  // 使用默认模型
    false,               // 不启用网络搜索
    eventBus,
    customAgent,         // 可选的自定义 Agent
    true,                // 启用记忆
)

// 3. 订阅事件（在 Handler 层）
go func() {
    for event := range eventBus.Subscribe() {
        switch event.Type {
        case event.EventAgentReferences:
            // 发送引用给前端
        case event.EventAgentFinalAnswer:
            // 发送答案片段给前端
        }
    }
}()
```

### 发起 AgentQA

```go
err = sessionService.AgentQA(
    ctx,
    session,
    "分析这个数据集的趋势",
    "msg-789",
    "",              // 使用 Agent 配置的模型
    eventBus,
    customAgent,     // 必须提供
    nil,             // 不指定知识库
    nil,
)
```

### 异步生成标题

```go
// 创建会话时不阻塞等待标题
sessionService.GenerateTitleAsync(ctx, session, userQuery, "", eventBus)

// 监听标题更新事件
// EventSessionTitle 事件会在标题生成完成后发射
```

---

## 边界情况与陷阱

### 1. Context 中的 TenantID 缺失

```go
tenantID := ctx.Value(types.TenantIDContextKey).(uint64)  // 会 panic！
```

**症状**：生产环境偶发 panic，堆栈指向这一行。

**原因**：测试或某些内部调用忘记注入 TenantID。

**解决方案**：

```go
tenantIDVal := ctx.Value(types.TenantIDContextKey)
if tenantIDVal == nil {
    return errors.New("tenant ID missing in context")
}
tenantID, ok := tenantIDVal.(uint64)
if !ok {
    return errors.New("tenant ID has wrong type")
}
```

### 2. EventBus 为 nil

```go
if err := eventBus.Emit(ctx, event); err != nil {  // panic if eventBus is nil!
```

**症状**：某些测试场景或内部调用时 panic。

**解决方案**：在方法开头添加检查：

```go
if eventBus == nil {
    return errors.New("eventBus is required")
}
```

### 3. 异步标题生成的 Context 取消

如前所述，这是一个已修复的 Bug。关键教训：**后台 goroutine 不要直接使用请求的 Context**。

### 4. 共享知识库的租户 ID 解析

```go
// 错误：直接用当前租户 ID 检索共享 KB
searchTargets, err := s.buildSearchTargets(ctx, session.TenantID, kbIDs, nil)

// 正确：buildSearchTargets 内部会解析共享 KB 的实际租户 ID
```

**症状**：共享知识库检索不到内容。

**原因**：共享 KB 的数据存储在 KB 所有者的租户命名空间下。

### 5. 配置覆盖顺序混淆

```go
// 错误理解：认为 config.yaml 优先级最高
// 实际：请求参数 > CustomAgent > config.yaml
```

**建议**：在关键配置覆盖处添加日志：

```go
logger.Infof(ctx, "Using custom agent's temperature: %f (overrides config.yaml)", customAgent.Config.Temperature)
```

---

## 扩展点

### 1. 添加新的流水线事件

在 `types.Pipline` 中定义新的事件序列，然后在 `KnowledgeQA` 中选择使用：

```go
// 在 types 包中
var Pipline = map[string][]EventType{
    "rag_stream":       {LOAD_HISTORY, REWRITE, SEARCH, RERANK, MERGE, INTO_CHAT_MESSAGE, CHAT_COMPLETION_STREAM},
    "new_custom_flow":  {LOAD_HISTORY, NEW_EVENT, SEARCH, CHAT_COMPLETION_STREAM},  // 新流水线
}
```

### 2. 添加新的 Fallback 策略

在 `types.FallbackStrategy` 中添加新值，然后在 `handleFallbackResponse` 中添加处理逻辑：

```go
case types.FallbackStrategyHybrid:
    s.handleHybridFallback(ctx, chatManage)
```

### 3. 自定义上下文压缩策略

实现 `llmcontext.CompressionStrategy` 接口，然后在 `ContextConfig` 中指定：

```go
contextConfig := &types.ContextConfig{
    CompressionStrategy: "my_custom_strategy",
}
```

---

## 相关模块

- [chat_pipeline_plugins_and_flow](chat_pipeline_plugins_and_flow.md) - 流水线 Plugin 详解
- [agent_core_orchestration_and_tooling_foundation](agent_core_orchestration_and_tooling_foundation.md) - Agent 引擎
- [llm_context_management_and_storage](llm_context_management_and_storage.md) - 上下文管理
- [session_lifecycle_http_handler](session_lifecycle_http_handler.md) - HTTP 处理器
- [conversation_history_repositories](conversation_history_repositories.md) - 数据持久化

---

## 运维考虑

### 1. Redis 缓存清理

删除会话时，务必清理 Redis 中的相关键：
- `session:{id}:context` - 对话上下文
- `session:{id}:websearch` - 网络搜索临时状态

### 2. 事件丢失监控

如果 EventBus 发射失败，用户会看到流式响应中断。建议添加：
- 事件发射失败计数器
- 告警阈值（如连续 10 次失败）

### 3. 慢查询日志

`KnowledgeQA` 和 `AgentQA` 是核心路径，建议记录：
- 总耗时
- 各阶段耗时（检索、重排序、生成）
- 检索结果数量

### 4. 模型调用成本追踪

每次调用 LLM 都产生成本，建议记录：
- 模型 ID
- Token 用量
- 调用来源（KnowledgeQA / AgentQA / 标题生成）
