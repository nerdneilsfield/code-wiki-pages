# ADK Reduction Middleware

## 1. 模块概览

**ADK Reduction Middleware** 是一个专门用于解决 LLM 对话上下文膨胀问题的工具集合。在 Agent 系统中，随着对话的进行，工具调用结果会不断累积，导致 Token 数量急剧增长，最终触发上下文窗口限制或降低推理效率。

这个模块采用了**双管齐下**的策略：
- **大结果转储（Offloading）**：单个工具结果过大时，将其保存到文件系统，只返回摘要和路径
- **旧结果清理（Clearing）**：总工具结果 Token 超出阈值时，用占位符替换旧结果，同时保留最近的消息

### 核心问题与动机

想象一下：Agent 执行 `grep` 查找匹配结果，返回了 1000 行代码；接着又执行了 `cat` 读取大文件，又返回几千行数据。几轮对话后，上下文可能已经包含数万个 Token 的工具输出，而真正重要的信息却淹没其中。

**为什么这是个问题？**
1. **Token 成本**：每个输入 Token 都要计费，累积的大结果会显著增加成本
2. **上下文限制**：大多数模型有明确的上下文窗口限制（如 128K、200K），超限会导致请求失败
3. **推理质量**：过多的无关信息会干扰模型的注意力机制，降低输出质量

## 2. 架构总览

```mermaid
graph TD
    A[Agent 调用工具] --> B{工具结果大小?}
    B -- 单个结果超大 --> C[toolResultOffloading]
    B -- 正常大小 --> D[保留原始结果]
    C --> E[保存到 Backend]
    E --> F[返回摘要消息]
    
    G[Agent 即将调用 ChatModel] --> H{总工具结果 Token?}
    H -- 超过阈值 --> I[clearToolResult]
    H -- 正常 --> J[保留所有结果]
    I --> K[清理旧结果]
    K --> L[保留最近消息]
    
    M[NewToolResultMiddleware] --> N[组合两种策略]
    N --> O[BeforeChatModel = clearToolResult]
    N --> P[WrapToolCall = toolResultOffloading]
```

这个架构的核心设计思想是**分层防御**：
1. 第一层是工具调用层的**单个结果拦截**——特别大的结果不会进入上下文
2. 第二层是模型调用前的**整体上下文修剪**——即使每个结果都不大，累积过多也要清理

### 核心组件角色

| 组件 | 职责 | 作用阶段 |
|------|------|----------|
| `toolResultOffloading` | 大结果转储与摘要生成 | 工具执行后 |
| `clearToolResult` | 旧工具结果清理 | ChatModel 调用前 |
| `ToolResultConfig` | 统一配置入口 | 中间件初始化 |
| `Backend` | 结果持久化接口 | 大结果存储 |

## 3. 核心设计决策

### 3.1 为什么选择"清理+转储"的双重策略？

**设计权衡分析：**

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 只清理 | 实现简单，无额外依赖 | 信息完全丢失，模型无法引用 | 短对话，结果不重要 |
| 只转储 | 信息完整保留 | 每个大结果都需要读回，增加调用次数 | 结果很大但必须引用 |
| **两者结合** | 兼顾效率与完整性，灵活可控 | 实现复杂度增加 | **生产级 Agent** |

最终选择双重策略是因为它提供了最佳的**成本-质量平衡**：对于真正巨大的结果，我们转储它们以便模型可以按需读取；对于累积的历史结果，我们清理掉旧的，因为模型通常更关注最近的交互。

### 3.2 Token 估算：为什么用字符数/4？

```go
func defaultTokenCounter(msg *schema.Message) int {
    count := len(msg.Content)
    for _, tc := range msg.ToolCalls {
        count += len(tc.Function.Arguments)
    }
    return (count + 3) / 4  // +3 是为了向上取整
}
```

**设计考虑：**
- **速度优先**：这是一个 O(1) 的操作，无需调用分词器
- **跨语言兼容**：不同语言的字符/Token 比率不同，但 4 是一个保守的近似值
- **启发式即可**：我们不需要精确到个位数——这只是触发清理/转储的阈值

**替代方案（未采用）：**
- 使用真实的 Tokenizer（如 tiktoken）：更准确，但增加依赖且速度慢
- 固定长度限制：简单但不灵活，无法适应不同语言

### 3.3 为什么需要 Backend 接口？

```go
type Backend interface {
    Write(context.Context, *filesystem.WriteRequest) error
}
```

**设计意图：解耦存储实现**

虽然模块默认与 [Filesystem Middleware](ADK Filesystem Middleware.md) 配合使用，但通过 `Backend` 接口，你可以：
- 将大结果保存到内存（测试用）
- 保存到分布式存储系统（生产用）
- 保存到对象存储（如 S3、OSS）

这体现了**依赖倒置原则**——模块依赖抽象接口，而不是具体实现。

## 4. 数据流向详解

### 4.1 大工具结果转储流程

当一个工具返回特别大的结果时：

1. **工具执行完毕** → `toolResultOffloading.stream()` 或 `.invoke()` 拦截结果
2. **Token 估算** → 调用 `counter()` 检查是否超过 `TokenLimit * 4` 字符
3. **路径生成** → 调用 `PathGenerator` 生成存储路径（默认 `/large_tool_result/{call_id}`）
4. **内容保存** → 调用 `backend.Write()` 保存完整结果
5. **摘要生成** → 提取前 10 行，每行最多 1000 字符
6. **返回替代消息** → 包含路径、摘要和读取工具的指引

```go
// handleResult 是核心决策点
func (t *toolResultOffloading) handleResult(ctx context.Context, result string, input *compose.ToolInput) (string, error) {
    if t.counter(...) > t.tokenLimit*4 {
        // 1. 生成路径
        path, _ := t.pathGenerator(ctx, input)
        
        // 2. 格式化摘要
        sample := formatToolMessage(result)
        
        // 3. 保存到后端
        t.backend.Write(ctx, &filesystem.WriteRequest{FilePath: path, Content: result})
        
        // 4. 返回替代消息
        return pyfmt.Fmt(tooLargeToolMessage, ...)
    }
    return result
}
```

### 4.2 旧工具结果清理流程

在 Agent 即将调用 ChatModel 之前：

1. **计算总 Token** → 遍历所有消息，累加工具结果的 Token
2. **阈值检查** → 如果超过 `ClearingTokenThreshold`，进入清理模式
3. **确定保护范围** → 从末尾向前累加，找到最近 `KeepRecentTokens` 的起始点
4. **执行清理** → 保护范围之前的旧工具结果被替换为占位符

```go
// reduceByTokens 实现了这个逻辑
func reduceByTokens(state *adk.ChatModelAgentState, ...) error {
    // 步骤1: 计算总工具结果 Token
    totalToolResultTokens := 0
    
    // 步骤2: 如果没超限，直接返回
    if totalToolResultTokens <= toolResultTokenThreshold {
        return nil
    }
    
    // 步骤3: 从后向前找保护范围的起始点
    recentStartIdx := len(state.Messages)
    cumulativeTokens := 0
    
    // 步骤4: 清理保护范围之前的旧结果
    for i := 0; i < recentStartIdx; i++ {
        msg := state.Messages[i]
        if msg.Role == schema.Tool && ... {
            msg.Content = placeholder
        }
    }
    return nil
}
```

## 5. 使用指南与最佳实践

### 5.1 基本配置示例

```go
// 创建文件系统后端（通常来自 Filesystem Middleware）
backend := &filesystem.InMemoryBackend{}

// 创建中间件
middleware, err := reduction.NewToolResultMiddleware(ctx, &reduction.ToolResultConfig{
    // 清理策略配置
    ClearingTokenThreshold:  30000,    // 总工具结果超过 30K tokens 时清理
    KeepRecentTokens:        50000,    // 保留最近 50K tokens 的消息
    ClearToolResultPlaceholder: "[已清理的旧工具结果]",
    
    // 转储策略配置
    Backend:          backend,
    OffloadingTokenLimit: 15000,       // 单个结果超过 15K tokens 时转储
    ReadFileToolName: "read_file",     // 告诉 LLM 用这个工具读取
    
    // 可选：排除某些工具不被清理
    ExcludeTools: []string{"final_answer"},
})

// 应用到 Agent
agent.WithMiddleware(middleware)
```

### 5.2 常见陷阱与注意事项

⚠️ **重要提醒：必须提供 read_file 工具**

这个模块**只负责写入**大结果，不负责读取。你需要：
- 要么使用 [Filesystem Middleware](ADK Filesystem Middleware.md)（它会自动提供 `read_file`）
- 要么自己实现一个读取工具，使用相同的 Backend

否则，LLM 会收到"请使用 read_file 工具读取"的消息，但实际上无法执行这个操作！

⚠️ **Token 估算只是近似值**

`defaultTokenCounter` 用字符数/4 估算，这不是精确值：
- 对于中文，可能需要字符数/2 或更低
- 对于代码，可能接近字符数/3
- 可以通过 `TokenCounter` 字段提供自定义实现

⚠️ **流式工具的处理**

对于流式工具（`StreamableTool`），`toolResultOffloading` 会先**完全读取整个流**，拼接成字符串，再进行处理。这意味着：
- 流式的"渐进式输出"优势在大结果时会丢失
- 内存使用会增加（需要缓冲完整结果）

## 6. 模块关系与依赖

```mermaid
graph LR
    A[ADK Reduction Middleware] --> B[Schema Core Types]
    A --> C[Compose Graph Engine]
    A --> D[ADK Agent Interface]
    A -- 可选依赖 --> E[ADK Filesystem Middleware]
    
    F[toolResultOffloading] --> G[compose.ToolMiddleware]
    H[clearToolResult] --> I[adk.ChatModelAgentState]
```

**关键依赖说明：**
- **Schema Core Types**：提供 `Message`、`ToolMessage` 等核心数据结构
- **Compose Graph Engine**：提供 `ToolMiddleware` 接口和工具调用拦截机制
- **ADK Agent Interface**：提供 `AgentMiddleware` 和 `ChatModelAgentState`
- **ADK Filesystem Middleware**（可选）：提供 `Backend` 的默认实现和 `read_file` 工具

## 7. 子模块详解

本模块由三个核心子模块组成，每个子模块负责一部分特定功能：

- **[middleware_entrypoint_and_contracts](middleware_entrypoint_and_contracts.md)**：统一入口与契约定义，包含 `ToolResultConfig`、`Backend` 接口等核心类型
- **[tool_result_clearing_policy](tool_result_clearing_policy.md)**：历史工具结果清理策略，实现了基于阈值和保护窗口的清理算法  
- **[tool_result_offloading_pipeline](tool_result_offloading_pipeline.md)**：大结果转储管线，负责检测、保存和摘要生成

详细实现和用法请参考各子模块文档。

## 8. 总结

ADK Reduction Middleware 是一个**务实的解决方案**，它不追求完美的信息保留，而是在以下三个目标之间做出明智的权衡：
1. ✅ 控制 Token 成本
2. ✅ 避免上下文超限
3. ✅ 保留模型完成任务所需的关键信息

它的设计体现了一个重要的工程原则：**不是所有信息都同等重要**。通过区分"单个超大结果"和"累积的旧结果"，并采用不同策略处理，这个模块让 Agent 能够在保持效率的同时，处理更长、更复杂的对话。
