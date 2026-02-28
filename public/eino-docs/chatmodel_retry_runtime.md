# ChatModel Retry Runtime

## 问题域：为什么需要这个模块？

调用大语言模型（LLM）的本质是向外部服务发起网络请求——而这个外部服务是不可靠的。网络抖动、速率限制、服务暂时降级、甚至模型提供商的内部错误，这些瞬态故障随时可能发生。在构建 Agent 系统时，如果每次遇到这种故障就立即让整个 Agent 运行失败，用户体验会极差，系统稳定性也无法保障。

这个问题看起来简单，但有几个非显而易见的挑战：

**挑战一：错误分类的困境**——不是所有错误都适合重试。有些错误是永久性的（比如 API key 无效、请求格式错误），重试只会浪费资源。有些是瞬态的（比如网络超时、503 服务不可用），重试能够成功。需要一种方式让调用方或系统策略来决定哪些错误值得重试。

**挑战二：流式场景的复杂性**——非流式调用失败很明确，但流式调用的失败可能发生在中途。模型可能已经输出了 200 个 token，然后连接断开。此时是应该从失败点继续？还是重新开始整个请求？重新开始会导致重复的 token 和额外费用。

**挑战三：回调机制的适配**——eino 框架有丰富的回调机制，允许在模型调用的前后插入自定义逻辑。如果内部的 ChatModel 实现不支持回调，就需要在这个重试层替它处理。

**挑战四：检查点序列化**——WillRetryError 是一个 AgentEvent，会在检查点中序列化保存。但原始的 error 可能是任意类型，Gob 序列化会失败。

`chatmodel_retry_runtime` 模块就是为了解决这些问题而设计的。它是一个**透明的重试包装器**，封装了所有重试相关的复杂逻辑。

## 核心架构与心智模型

### 心智模型：一个有弹性的代理

想象 `retryChatModel` 是一个"有弹性的代理"（resilient proxy），它站在你和原始 ChatModel 之间。当你向它发起请求时：

1. **它接收你的请求**——就像普通的 ChatModel 一样，实现相同的接口
2. **它尝试转发请求**——调用内部的原始 ChatModel
3. **它评估结果**——如果成功，直接返回；如果失败，判断这个错误是否"值得再试一次"
4. **它决定行动**——如果值得重试，它会按照退避策略等待一段时间，然后重新发起请求
5. **它持续尝试**——直到成功、达到最大重试次数、或遇到不可重试的错误

## 组件深度解析

### retryChatModel：重试包装器的核心

`retryChatModel` 是实现 `model.ToolCallingChatModel` 接口的结构体：

```go
type retryChatModel struct {
    inner                 model.ToolCallingChatModel
    config                *ModelRetryConfig
    innerHandlesCallbacks bool
}
```

**Generate 方法**：实现了带重试的非流式调用。核心逻辑是重试循环，每次循环都：
1. 调用 inner（可能经过回调代理）
2. 成功则返回
3. 失败则判断 `IsRetryAble`
4. 不可重试则返回错误
5. 可重试且有次数则等待后继续
6. 可重试但无次数则返回 `RetryExhaustedError`

**Stream 方法**：实现了带重试的流式调用，比 Generate 更复杂，需要复制流来检测错误。

### ModelRetryConfig：重试策略的配置

```go
type ModelRetryConfig struct {
    MaxRetries  int
    IsRetryAble func(ctx context.Context, err error) bool
    BackoffFunc func(ctx context.Context, attempt int) time.Duration
}
```

**MaxRetries**：最大重试次数（不是总调用次数）。

**IsRetryAble**：错误分类函数，极其灵活，允许调用方根据错误类型、HTTP 状态码等决定是否重试。

**BackoffFunc**：退避函数。默认实现**指数退避 + 随机抖动**：
- 基础延迟 100ms
- 指数增长：100ms, 200ms, 400ms, 800ms...
- 最大延迟 10s
- 随机抖动：0-50%

### 错误类型：层次化的错误表示

**ErrExceedMaxRetries**：哨兵错误，用于 `errors.Is` 检查。

**RetryExhaustedError**：包装错误，包含最后发生的错误和总重试次数。

**WillRetryError**：既是 error 又是 AgentEvent，用于观察重试事件。巧妙的设计：
- `ErrStr` 导出，用于 Gob 序列化
- `err` 未导出，只用于运行时 Unwrap，避免序列化失败

## 设计决策与权衡

### 决策一：同步消费流进行错误检测

**选择**：同步消费 `checkCopy` 来检测错误。

**权衡**：逻辑简单、确定性强，但增加了响应延迟。

**原因**：流式调用的正确性比延迟更重要。如果返回一个可能中途失败的流，调用方很难处理。

### 决策二：WillRetryError 的部分序列化

**选择**：只序列化错误消息字符串，不序列化原始 error。

**权衡**：避免了 Gob 序列化复杂错误类型的困难，但丢失了原始 error 的类型信息和堆栈。

**原因**：WillRetryError 的主要目的是"事件观察"，错误消息已经足够。

### 决策三：默认重试所有错误

**选择**：`defaultIsRetryAble` 返回 `err != nil`。

**权衡**：容错性强，但可能浪费资源重试永久性错误。

**原因**："宁可误判为瞬态，不可误判为永久"的保守策略。

## 边界情况与注意事项

### 流式调用的延迟陷阱

由于 `Stream` 方法需要同步消费第一个流来检测错误，**响应延迟至少是模型生成完整内容的时间**。

### 错误的堆栈信息丢失

`WillRetryError` 中的 `err` 字段在检查点恢复后会变成 `nil`。

### WithTools 的性能开销

每次 `WithTools` 调用都会创建新的 `retryChatModel` 实例。

### 并发安全性

`retryChatModel` 实例可以在多个 goroutine 中并发使用，但内部的 `inner ChatModel` 可能不是线程安全的。

## 总结

`chatmodel_retry_runtime` 模块是一个设计精良的"重试包装器"，通过透明的接口适配、灵活的策略配置、健壮的错误处理，实现了一个"开箱即用但可深度定制"的重试层。它的核心价值在于**将重试的复杂性封装起来，让上层业务逻辑不需要关心瞬态故障的处理**。