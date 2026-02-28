# Context Management and Compression Contracts 模块深度解析

## 1. 问题域与模块定位

在构建企业级对话式 AI 系统时，我们面临一个核心挑战：LLM 的上下文窗口是有限的（通常从几千到几十万 token 不等），但实际对话场景中用户会话可能持续很长时间，积累大量的历史消息。如果简单地将所有历史消息都发送给 LLM，会导致：

- **上下文溢出**：直接触发 LLM 的 token 限制错误
- **成本激增**：每次请求都发送大量历史内容，API 费用大幅增加
- **响应延迟**：处理更大的上下文需要更多计算时间
- **注意力稀释**：LLM 可能在长上下文中忽略关键信息

这就是 `context_management_and_compression_contracts` 模块要解决的问题。它定义了一套标准化的接口，用于智能管理会话上下文，在保持对话连贯性的同时，确保上下文始终在 LLM 的能力范围内。

## 2. 核心抽象与心智模型

### 2.1 心智模型：上下文窗口的"智能窗口管理器"

可以将这个模块想象成一个**智能窗口管理器**：

- 它不负责消息的持久化存储（那是消息历史仓库的职责），而是维护一个"工作区"，专门用于与 LLM 交互
- 当对话进行时，它不断向工作区添加新消息
- 当工作区变得太满时，它会根据策略"智能折叠"旧内容，而不是简单丢弃
- 系统提示（system prompt）就像窗口的"标题栏"，始终保持可见

### 2.2 核心组件

#### ContextManager 接口

这是模块的主接口，定义了上下文管理的完整生命周期：

```go
type ContextManager interface {
    AddMessage(ctx context.Context, sessionID string, message chat.Message) error
    GetContext(ctx context.Context, sessionID string) ([]chat.Message, error)
    ClearContext(ctx context.Context, sessionID string) error
    GetContextStats(ctx context.Context, sessionID string) (*ContextStats, error)
    SetSystemPrompt(ctx context.Context, sessionID string, systemPrompt string) error
}
```

**设计意图**：
- `AddMessage`：向上下文追加新消息，注意这与存储消息不同——这里是为 LLM 消费准备的
- `GetContext`：核心方法，返回适合当前 LLM 的上下文，**可能触发压缩逻辑**
- `ClearContext`：重置会话上下文，适用于开始新话题等场景
- `GetContextStats`：提供可观测性，帮助调试和优化压缩策略
- `SetSystemPrompt`：特殊处理系统提示，确保它始终在上下文中且位置正确

#### ContextStats 结构体

```go
type ContextStats struct {
    MessageCount         int  `json:"message_count"`
    TokenCount           int  `json:"token_count"`
    IsCompressed         bool `json:"is_compressed"`
    OriginalMessageCount int  `json:"original_message_count"`
}
```

**设计意图**：这个结构体不仅仅是为了监控，它还承载了重要的设计决策：
- `IsCompressed` 标志让调用者知道返回的上下文是否经过处理
- `OriginalMessageCount` 帮助了解压缩的程度，便于评估信息损失
- 明确区分消息数量和 token 数量，因为不同消息的 token 密度差异很大

#### CompressionStrategy 接口

```go
type CompressionStrategy interface {
    Compress(ctx context.Context, messages []chat.Message, maxTokens int) ([]chat.Message, error)
    EstimateTokens(messages []chat.Message) int
}
```

**设计意图**：这是一个典型的**策略模式**应用。通过将压缩逻辑抽象为接口：
- 可以支持多种压缩策略（如简单截断、摘要压缩、重要性保留压缩等）
- 策略可以在运行时切换，例如根据不同的 LLM 模型或会话类型选择
- 压缩算法的改进不会影响 `ContextManager` 的核心逻辑

## 3. 架构角色与数据流向

### 3.1 在系统中的位置

从模块树可以看出，这个模块位于 `core_domain_types_and_interfaces` 下，属于**核心领域契约层**。这意味着：
- 它不包含具体实现，只定义行为契约
- 多个上层模块会依赖这些接口
- 具体实现可能在其他模块中（如 `application_services_and_orchestration` 下的 `conversation_context_and_memory_services`）

### 3.2 典型数据流向

让我们追踪一次完整的对话流程中，上下文管理是如何工作的：

```
用户消息 → HTTP Handler → Session Service → ContextManager.AddMessage()
                                              ↓
LLM 请求 ← Chat Pipeline ← ContextManager.GetContext() ← CompressionStrategy (如果需要)
         ↓
LLM 响应 → ContextManager.AddMessage() → 下一轮对话
```

**关键路径分析**：
1. 每条新消息首先通过 `AddMessage` 进入上下文管理器
2. 当需要调用 LLM 时，`GetContext` 被调用
3. `GetContext` 内部会先调用 `CompressionStrategy.EstimateTokens` 评估当前上下文大小
4. 如果超过限制，调用 `CompressionStrategy.Compress` 进行压缩
5. 返回最终的上下文消息列表给调用者

### 3.3 依赖关系

**被以下模块依赖**（推测）：
- `application_services_and_orchestration/chat_pipeline_plugins_and_flow`：在组装 LLM 请求时需要获取上下文
- `application_services_and_orchestration/conversation_context_and_memory_services`：可能包含具体实现
- `http_handlers_and_routing/session_message_and_streaming_http_handlers`：在处理会话消息时管理上下文

**依赖以下模块**：
- `core_domain_types_and_interfaces/agent_conversation_and_runtime_contracts`：依赖 `chat.Message` 类型

## 4. 设计决策与权衡

### 4.1 分离上下文管理与消息存储

**决策**：`ContextManager` 明确区分了"用于 LLM 的上下文"和"持久化的消息历史"

**原因**：
- 这两个关注点有不同的需求：存储需要完整性和可审计性，而上下文需要时效性和适配性
- 允许我们在不丢失历史的情况下，为 LLM 提供最优的上下文
- 可以支持不同的存储后端和上下文管理策略组合

**权衡**：
- ✅ 优点：灵活性高，职责清晰
- ❌ 缺点：需要确保两者之间的一致性，增加了一定的复杂度

### 4.2 策略模式用于压缩算法

**决策**：将压缩逻辑抽象为 `CompressionStrategy` 接口

**原因**：
- 压缩是一个活跃的研究领域，可能需要不断迭代改进
- 不同的场景可能需要不同的策略（如客服对话 vs 技术支持对话）
- 便于 A/B 测试不同的压缩效果

**权衡**：
- ✅ 优点：符合开闭原则，易于扩展和测试
- ❌ 缺点：增加了接口数量，简单场景下可能显得过度设计

### 4.3 系统提示的特殊处理

**决策**：单独提供 `SetSystemPrompt` 方法，而不是将其作为普通消息处理

**原因**：
- 系统提示在 LLM 交互中具有特殊地位，通常需要始终保留
- 它的位置通常在上下文的最开始，需要特殊维护
- 可能需要在对话过程中动态更新（如切换任务类型）

**权衡**：
- ✅ 优点：确保系统提示的正确处理，提供明确的 API
- ❌ 缺点：接口略微复杂，需要在实现中特殊处理这种消息类型

### 4.4 Token 估算而非精确计算

**决策**：`CompressionStrategy` 只要求 `EstimateTokens` 而非精确计算

**原因**：
- 精确的 token 计算需要访问特定 LLM 的 tokenizer，可能增加依赖和计算成本
- 估算在大多数情况下已经足够用于决策是否需要压缩
- 不同的 LLM 可能有不同的 tokenization 规则，精确计算难以通用

**权衡**：
- ✅ 优点：实现简单，性能好，通用性强
- ❌ 缺点：可能偶尔出现误判，导致稍微超过或低于理想的上下文大小

## 5. 使用指南与常见模式

### 5.1 基本使用流程

```go
// 1. 初始化 ContextManager（实际使用时通过依赖注入获取）
var cm ContextManager = ...

// 2. 设置系统提示
err := cm.SetSystemPrompt(ctx, sessionID, "你是一个 helpful 的助手...")

// 3. 添加用户消息
userMsg := chat.Message{Role: "user", Content: "你好，请帮我..."}
err = cm.AddMessage(ctx, sessionID, userMsg)

// 4. 获取上下文并调用 LLM
contextMsgs, err := cm.GetContext(ctx, sessionID)
llmResponse := callLLM(contextMsgs)

// 5. 添加助手回复
assistantMsg := chat.Message{Role: "assistant", Content: llmResponse}
err = cm.AddMessage(ctx, sessionID, assistantMsg)
```

### 5.2 实现自定义压缩策略

如果你需要实现自己的压缩策略，只需实现 `CompressionStrategy` 接口：

```go
type MyCompressionStrategy struct{}

func (s *MyCompressionStrategy) EstimateTokens(messages []chat.Message) int {
    // 你的 token 估算逻辑
    total := 0
    for _, msg := range messages {
        total += len(msg.Content) / 4 // 简单估算：4 个字符约等于 1 个 token
    }
    return total
}

func (s *MyCompressionStrategy) Compress(ctx context.Context, messages []chat.Message, maxTokens int) ([]chat.Message, error) {
    // 你的压缩逻辑
    // 例如：保留系统提示和最近的 N 条消息
    // 或者：对旧消息进行摘要处理
}
```

### 5.3 监控与调试

使用 `GetContextStats` 来监控上下文管理效果：

```go
stats, err := cm.GetContextStats(ctx, sessionID)
if err != nil {
    // 处理错误
}

log.Printf("上下文状态: 消息数=%d, Token数=%d, 已压缩=%v, 原始消息数=%d",
    stats.MessageCount,
    stats.TokenCount,
    stats.IsCompressed,
    stats.OriginalMessageCount,
)
```

## 6. 边缘情况与注意事项

### 6.1 系统提示过大怎么办？

当前接口设计假设系统提示本身不会超过 token 限制。如果你的系统提示可能很大，需要注意：
- `SetSystemPrompt` 没有返回压缩后的状态
- 系统提示通常会被完整保留，过大的系统提示可能导致即使没有历史消息也会溢出

**建议**：在设置系统提示前自行检查大小，或者考虑将部分系统提示逻辑移到其他地方。

### 6.2 并发安全性

接口定义中没有明确说明并发安全性。在实际使用中：
- 如果多个 goroutine 可能同时操作同一个 session 的上下文，实现需要保证线程安全
- 建议在实现中使用读写锁或其他并发控制机制

### 6.3 消息顺序的假设

`GetContext` 返回的消息顺序应该是有意义的，通常：
- 系统提示（如果有）在最前面
- 然后是按时间顺序排列的对话历史
- 最新的消息在最后

压缩策略在实现时需要尊重这个顺序，否则可能导致 LLM 理解混乱。

### 6.4 Token 估算的准确性

由于 `EstimateTokens` 只是估算，可能会出现以下情况：
- 估算值小于实际值：导致压缩后的上下文仍然超过限制
- 估算值大于实际值：导致过度压缩，丢失不必要的信息

**缓解方法**：在实现中可以考虑添加一个安全边际，例如将估算值乘以 1.1 作为实际使用的限制。

## 7. 扩展与演化路径

### 7.1 可能的扩展方向

1. **上下文重要性标记**：允许标记某些消息为"重要"，确保它们在压缩时被保留
2. **多策略组合**：支持链式调用多个压缩策略，形成更复杂的压缩行为
3. **压缩历史记录**：记录压缩前后的变化，便于回溯和调试
4. **自适应压缩**：根据 LLM 的反馈动态调整压缩策略

### 7.2 与其他模块的协作

这个模块设计为与以下模块紧密协作：
- [Context Storage Contracts](application-services-and-orchestration-conversation-context-and-memory-services-llm-context-management-and-storage-context-storage-contracts-and-implementations.md)：提供上下文的持久化能力
- [Context Compression Strategies](application-services-and-orchestration-conversation-context-and-memory-services-llm-context-management-and-storage-context-compression-strategies.md)：包含具体的压缩策略实现
- [Context Manager Orchestration](application-services-and-orchestration-conversation-context-and-memory-services-llm-context-management-and-storage-context-manager-orchestration.md)：可能包含高级的编排逻辑

## 8. 总结

`context_management_and_compression_contracts` 模块是一个精心设计的核心契约模块，它解决了 LLM 应用中最实际的问题之一：如何在有限的上下文窗口中进行长时间对话。

通过将上下文管理从消息存储中分离出来，通过策略模式支持灵活的压缩算法，通过专门的系统提示处理确保关键信息不丢失，这个模块为构建生产级的对话式 AI 系统提供了坚实的基础。

作为新加入团队的工程师，理解这个模块的设计意图和权衡，将帮助你更好地理解整个系统的架构，并在需要时做出正确的扩展和改进决策。
