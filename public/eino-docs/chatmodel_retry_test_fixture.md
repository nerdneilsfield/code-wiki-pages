# chatmodel_retry_test_fixture 模块技术深潜

## 概览：为什么需要这个模块

在分布式AI Agent系统中，大语言模型（LLM）调用失败是常态而非例外。网络抖动、服务过载、模型速率限制（rate limit）——这些瞬态错误（transient errors）随时可能发生。一个健壮的Agent必须具备自动重试能力，而不是将错误直接暴露给上层调用者。

`chatmodel_retry_test_fixture` 模块是ADK框架中专门用于测试ChatModel重试机制的测试夹具（test fixture）模块。它解决的问题远非"验证重试代码能跑"这么简单——它验证的是一套复杂的数据契约：当重试发生时，消息历史如何累积？流式输出中的错误如何传播？下游Agent应该看到成功的数据还是失败的片段？

这个模块的核心价值在于：它不仅测试"重试逻辑本身"，更测试**重试前后的数据一致性**——确保重试成功后，下游组件接收到的消息是完整的、正确的、没有任何失败痕迹的。

## 架构角色与数据流

### 在整体架构中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              adk_runtime                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  chatmodel_react_and_retry_runtime                                          │
│  ├── chatmodel_agent_core_runtime      ← ChatModelAgent 核心实现            │
│  ├── chatmodel_retry_runtime           ← retryChatModel 包装器             │
│  ├── react_runtime_state_and_tool_result_flow                              │
│  └── chatmodel_retry_test_fixture      ← 当前模块（测试夹具）               │
│       └── inputCapturingModel                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

从模块树结构可以看出，`chatmodel_retry_test_fixture` 是 `chatmodel_react_and_retry_runtime` 的子模块。它与核心重试运行时（`retry_chatmodel.go`）同属一个父模块，但扮演的角色截然不同：

- **retry_chatmodel.go**：生产代码，实现重试逻辑
- **chatmodel_retry_test.go**：测试代码，验证重试逻辑的正确性

### 数据流追踪

理解这个模块的最好方式是追踪一条典型的重试场景中的数据流动：

```
用户输入 "Hello"
     │
     ▼
ChatModelAgent.Run()
     │
     ├─[无工具路径]─► compose.NewChain → newRetryChatModel(model, config).Generate()
     │                          │
     │                          ▼
     │                   第一次调用失败 (errRetryAble)
     │                          │
     │                          ▼
     │                   backoff → 第二次调用成功
     │                          │
     │                          ▼
     └─[有工具路径]─► newReact() → newRetryChatModel(model, config).Stream()
                              │
                              ▼
                        流式输出第二个chunk失败
                              │
                              ▼
                        backoff → 重新Stream
```

关键数据流：
1. **输入捕获**：通过 `inputCapturingModel` 记录所有传入的 `[]*schema.Message`
2. **输出验证**：在顺序工作流中，验证下游Agent收到的消息是否包含成功的chunk而非失败的错误
3. **错误传播**：验证 `WillRetryError` 和 `RetryExhaustedError` 正确地在事件流中传播

## 核心组件深度解析

### 1. inputCapturingModel —— 输入捕获模型

这是模块中唯一的核心组件（根据代码分析，其他如 `streamErrorModel`、`nonRetryAbleStreamErrorModel` 等都是测试中定义的局部类型）。

```go
type inputCapturingModel struct {
    capturedInputs [][]Message
}
```

**设计意图**：在顺序工作流（SequentialAgent）测试中，这是一个关键的验证工具。当Agent A 发生重试并最终成功时，我们需要验证Agent B（即下游Agent）接收到的输入是否正确——它应该只看到成功的消息，而不应该包含任何重试失败的痕迹。

**实现细节**：
- `capturedInputs` 是一个二维切片，外层切片记录每次调用的输入，内层切片是当时的完整消息历史
- 实现了 `model.ToolCallingChatModel` 接口的 `Generate()` 和 `Stream()` 方法
- 每次调用时，将输入追加到 `capturedInputs` 中

**为什么需要这个组件**：

考虑一个典型的顺序工作流：
```
AgentA (有重试配置) → AgentB
```

如果AgentA的前两次调用失败，第三次才成功，那么：
- AgentB应该看到什么？是前两次失败的消息？还是最终成功的消息？
- 答案显然是后者。但如何验证这一点？——使用 `inputCapturingModel` 作为AgentB的模型，捕获它收到的输入，然后断言这些输入中只包含成功的消息内容。

### 2. 辅助测试模型

虽然这些不是 "Core Components"，但理解它们有助于理解测试策略：

#### streamErrorModel

```go
type streamErrorModel struct {
    callCount   int32
    failAtChunk int      // 在第几个chunk失败
    maxFailures int      // 允许的最大失败次数
    returnTool  bool     // 是否在第一个chunk返回tool call
}
```

这个模型模拟**流式输出中的错误**。与直接返回错误的 `Generate()` 不同，流式输出可能在中间某个chunk失败。测试验证：
- 当流式输出失败时，重试机制能正确捕获并重试
- `WillRetryError` 会被嵌入到流式reader的错误转换器中

#### nonRetryAbleStreamErrorModel

模拟不可重试的流式错误。验证：
- 当流式输出中出现不可重试错误时，错误立即向上传播
- 不会触发重试逻辑
- 下游Agent不会收到任何调用（流程被中断）

## 设计决策与权衡

### 1. 错误类型设计：为什么需要 WillRetryError？

在 `retry_chatmodel.go` 中，你会看到两个特殊的错误类型：

```go
// 可重试错误发生时，发送给用户的事件中包含此错误
type WillRetryError struct {
    ErrStr       string   // 可序列化，用于checkpoint恢复
    RetryAttempt int
    err          error    // 运行时使用，不序列化
}

// 重试次数耗尽时返回
type RetryExhaustedError struct {
    LastErr      error
    TotalRetries int
}
```

**设计权衡**：
- `WillRetryError` 的 `err` 字段是**未导出的**。这是因为Gob序列化无法处理未注册的自定义错误类型。既然错误只需要在运行时用于 `errors.Unwrap()`，而checkpoint恢复后错误字段本就是nil，这个设计是合理的。
- 导出 `ErrStr` 而非直接序列化 `err`，是因为字符串可以安全地进行Gob编码。

### 2. 流式重试的特殊处理

流式重试比非流式（Generate）重试复杂得多：

```go
// retry_chatmodel.go 中的 Stream 实现
copies := stream.Copy(2)        // 复制流：一个用于检查错误，一个用于返回
checkCopy := copies[0]
returnCopy := copies[1]

streamErr := consumeStreamForError(checkCopy)  // 消费第一个拷贝来检查是否有错误
if streamErr == nil {
    return returnCopy, nil  // 没有错误，返回正常
}
// 有错误，关闭返回流，然后重试
```

**为什么需要复制流？** 因为流式输出是"一次性"的——一旦读取就无法回退。我们需要：
1. 一个拷贝用于检查错误（完全消费）
2. 另一个拷贝用于返回给调用者（如果无错误）

这涉及内存和性能的权衡，但这是正确性优先的选择。

### 3. 默认 IsRetryAble 策略

```go
func defaultIsRetryAble(_ context.Context, err error) bool {
    return err != nil  // 默认情况下，所有错误都可重试
}
```

这是一个**激进但合理的设计**。在LLM调用场景中：
- 大多数错误是瞬态的（网络、限流、服务不可用）
- 让用户明确指定不可重试的错误，比让用户列举所有可重试的错误更安全
- 当然，用户可以通过 `IsRetryAble` 函数覆盖这个行为

### 4. 指数退避算法

```go
func defaultBackoff(_ context.Context, attempt int) time.Duration {
    baseDelay := 100 * time.Millisecond
    maxDelay := 10 * time.Second
    
    // 指数增长：100ms → 200ms → 400ms → 800ms → 1600ms → 3200ms → 6400ms → 10s
    delay := baseDelay * time.Duration(1<<uint(attempt-1))
    if delay > maxDelay {
        delay = maxDelay
    }
    
    // 添加随机抖动 (0-50%)，防止惊群效应
    jitter := time.Duration(rand.Int63n(int64(delay / 2)))
    return delay + jitter
}
```

**设计意图**：
- 100ms的初始延迟足够小，用户几乎感知不到
- 10s的上限防止无限等待
- 随机抖动是必须的——否则所有失败的请求会在同一时刻重试，造成"惊群效应"（thundering herd）

## 使用指南与最佳实践

### 配置重试机制

在创建 `ChatModelAgent` 时配置 `ModelRetryConfig`：

```go
agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:        "MyAgent",
    Description: "A test agent",
    Model:       myModel,
    ModelRetryConfig: &adk.ModelRetryConfig{
        MaxRetries: 3,
        IsRetryAble: func(ctx context.Context, err error) bool {
            // 只对特定错误进行重试
            return errors.Is(err, context.DeadlineExceeded) || 
                   errors.Is(err, context.Canceled)
        },
        BackoffFunc: func(ctx context.Context, attempt int) time.Duration {
            // 自定义退避策略
            return time.Duration(attempt) * time.Second
        },
    },
})
```

### 验证重试数据一致性

如果你需要验证重试后的数据正确性，可以参考测试中的模式：

```go
// 1. 创建一个捕获输入的模型作为下游Agent
capturingModel := &inputCapturingModel{}

// 2. 创建下游Agent
agentB, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:        "AgentB",
    Model:       capturingModel,
    // ...
})

// 3. 运行工作流后，验证输入
if len(capturingModel.capturedInputs) != 1 {
    t.Errorf("expected 1 call to AgentB, got %d", len(capturingModel.capturedInputs))
}

// 4. 验证消息内容不包含失败痕迹
for _, msg := range capturingModel.capturedInputs[0] {
    assert.NotContains(t, msg.Content, "retry-able error")
}
```

## 边缘情况与陷阱

### 1. 流的消费与关闭

在流式重试中，有一个关键陷阱：

```go
streamErr := consumeStreamForError(checkCopy)
if streamErr == nil {
    return returnCopy, nil
}

returnCopy.Close()  // 重要：必须关闭返回流，否则资源泄漏
```

如果忘记关闭返回流，会导致资源泄漏。测试中必须验证这一点。

### 2. 错误传播的时机

- **Generate**：错误在方法返回时立即传播
- **Stream**：错误可能被嵌入到 `StreamReader` 的转换器中，在消费流时才被发现

这意味着流式场景下的错误处理是**延迟的**，需要用户在消费流时检查错误：

```go
for {
    msg, err := stream.Recv()
    if err != nil {
        if errors.As(err, &WillRetryError) {
            // 正在重试，可以选择等待或处理
        }
        // 处理最终错误
    }
}
```

### 3. Checkpoint 恢复后的错误状态

当使用 `WillRetryError` 进行Gob序列化后恢复checkpoint时：

```go
// 恢复后
var willRetry *WillRetryError
errors.As(restoredErr, &willRetry)
// willRetry.err 是 nil，因为没有序列化
// willRetry.ErrStr 有错误消息字符串
```

这意味着恢复后无法通过 `errors.Unwrap()` 获取原始错误，只能获取错误字符串。这是一个已知的限制。

### 4. 并发安全性

`inputCapturingModel` 的 `capturedInputs` 切片不是线程安全的。如果在并发场景下使用，需要添加互斥锁或使用原子操作。

## 相关模块与参考

- **[chatmodel_retry_runtime](chatmodel_retry_runtime.md)**：生产代码中的重试机制实现
- **[chatmodel_agent_core_runtime](adk/chatmodel.md)**：ChatModelAgent 的核心实现，包括重试配置的使用位置
- **[react_runtime_state_and_tool_result_flow](react_runtime_state_and_tool_result_flow.md)**：ReAct执行流程，如何与重试机制交互
- **[flow_agent_orchestration](flow_agent_orchestration.md)**：顺序/并行/循环工作流的实现

## 测试覆盖范围

本模块的测试覆盖了以下场景：

| 测试场景 | 验证点 |
|---------|--------|
| `TestChatModelAgentRetry_NoTools_DirectError_Generate` | 无工具时的直接错误重试 |
| `TestChatModelAgentRetry_NoTools_DirectError_Stream` | 无工具时的流式错误重试 |
| `TestChatModelAgentRetry_StreamError` | 流式输出中途失败的重试 |
| `TestChatModelAgentRetry_WithTools_DirectError_Generate` | 有工具时的Generate重试 |
| `TestChatModelAgentRetry_NonRetryableError` | 不可重试错误的处理 |
| `TestChatModelAgentRetry_MaxRetriesExhausted` | 超过最大重试次数的行为 |
| `TestChatModelAgentRetry_BackoffFunction` | 退避函数的调用时机 |
| `TestSequentialWorkflow_RetryAbleStreamError_SuccessfulRetry` | 顺序工作流中成功重试后下游收到正确数据 |
| `TestSequentialWorkflow_NonRetryAbleStreamError_StopsFlow` | 不可重试错误中断工作流 |

---

**总结**：`chatmodel_retry_test_fixture` 模块虽然名为"测试夹具"，但它验证的是AI Agent系统中最核心的可靠性契约——当底层模型调用失败时，整个系统是否能正确恢复，并且保持数据的完整性和一致性。对于新加入团队的开发者，理解这些测试用例背后的数据流动逻辑，是掌握ADK重试机制的关键。