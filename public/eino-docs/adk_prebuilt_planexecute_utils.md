# utils 辅助工具详解

> 本文档分析 `planexecute` 模块中的辅助工具实现，主要关注 Session Key-Values 输出包装器。

---

## 1. outputSessionKVsAgent 概述

### 1.1 存在理由

在某些场景下，开发者希望**将 Session 中存储的所有 Key-Values 作为最终输出返回**，而不是依赖 Agent 的默认输出格式。

典型需求：
- 调试：查看 Session 中存储的所有中间状态
- 审计：记录完整的执行历史
- 集成：下游系统需要读取 Session 中的具体值

### 1.2 核心实现

```go
type outputSessionKVsAgent struct {
    adk.Agent
}

func (o *outputSessionKVsAgent) Run(ctx context.Context, input *adk.AgentInput,
    options ...adk.AgentRunOption) *adk.AsyncIterator[*adk.AgentEvent] {

    iterator, generator := adk.NewAsyncIteratorPair[*adk.AgentEvent]()

    // 1. 运行原始 Agent
    iterator_ := o.Agent.Run(ctx, input, options...)
    
    // 2. 转发所有事件
    go func() {
        defer generator.Close()
        for {
            event, ok := iterator_.Next()
            if !ok {
                break
            }
            generator.Send(event)
        }

        // 3. 追加 Session KVs 事件
        kvs := adk.GetSessionValues(ctx)
        event := &adk.AgentEvent{
            Output: &adk.AgentOutput{CustomizedOutput: kvs},
        }
        generator.Send(event)
    }()

    return iterator
}
```

---

## 2. 事件流分析

### 2.1 事件序列

```
原始 Agent 运行时:
  [AgentEvent1] → [AgentEvent2] → [AgentEvent3] → ...

outputSessionKVsAgent 包装后:
  [AgentEvent1] → [AgentEvent2] → [AgentEvent3] → ... → [AgentEvent{KVs}]
                                                              ↑
                                              追加的 Session KVs 输出
```

### 2.2 输出结构

```go
type AgentEvent struct {
    Output: &AgentOutput{
        CustomizedOutput: map[string]any{
            "Plan":           <Plan object>,
            "ExecutedSteps":  []ExecutedStep{...},
            // ... 其他 Session 值
        },
    },
}
```

---

## 3. 使用场景

### 3.1 调试模式

```go
// 原始 Agent
agent, _ := planexecute.New(ctx, &planexecute.Config{...})

// 包装以输出 Session
debugAgent, _ := agentOutputSessionKVs(ctx, agent)

// 运行
events := debugAgent.Run(ctx, input)
for event := range events.Iter() {
    fmt.Println(event)
    // 可以看到完整的 Session 状态
}
```

### 3.2 与其他模块对比

| 包装器 | 输出内容 | 适用场景 |
|--------|----------|----------|
| outputSessionKVsAgent | Session 中所有 KV | 调试、审计 |
| (无包装) | Agent 默认输出 | 生产环境 |

---

## 4. 设计权衡

### 4.1 为什么不在 Agent 内部直接输出 KVs？

**替代方案**：
```go
// 在 Replanner 内部
generator.Send(&AgentEvent{
    Output: &AgentOutput{CustomizedOutput: GetSessionValues(ctx)},
})
```

**当前方案的优势**：
1. **关注点分离**：Agent 逻辑和输出格式关注
2. **可组合**：可以包装任意 Agent，无需修改原 Agent 代码
3. **可选性**：需要时套一层，不需要时直接用原 Agent

### 4.2 事件顺序的考量

```go
// 先转发原始事件，最后追加 KVs
for {
    event, ok := iterator_.Next()
    if !ok {
        break
    }
    generator.Send(event)
}

// 所有原始事件发完后再发 KVs
kvs := adk.GetSessionValues(ctx)
event := &adk.AgentEvent{Output: &adk.AgentOutput{CustomizedOutput: kvs}}
generator.Send(event)
```

**设计理由**：
- 保持原始事件的顺序完整性
- KVs 作为"总结"或"追加信息"放在最后
- 避免 KVs 事件被其他事件"插入"导致语义混乱

---

## 5. 注意事项

### 5.1 线程安全

```go
go func() {
    defer generator.Close()
    for {
        event, ok := iterator_.Next()
        // ...
    }
    // KVs 在 goroutine 结束前发送
    kvs := adk.GetSessionValues(ctx)
    generator.Send(event)
}()
```

- `GetSessionValues` 是并发安全的（内部使用 mutex）
- 事件转发在独立 goroutine 中，不会阻塞

### 5.2 Checkpoint 兼容性

如果在执行过程中发生中断，Session 中的值会被持久化。重新恢复时：
- 原始 Agent 的事件流会继续
- Session KVs 会在最后追加（与正常执行一致）

---

## 6. 扩展思路

### 6.1 自定义输出过滤

如果只想输出部分 Session 值，可以扩展：

```go
func filteredSessionKVsAgent(ctx context.Context, agent adk.Agent, keys []string) (adk.Agent, error) {
    return &filteredOutputAgent{
        Agent: agent,
        keys:  keys,
    }, nil
}

type filteredOutputAgent struct {
    adk.Agent
    keys []string
}

func (f *filteredOutputAgent) Run(ctx context.Context, input *adk.AgentInput, 
    options ...adk.AgentRunOption) *adk.AsyncIterator[*adk.AgentEvent] {
    // 类似实现，但只输出 keys 中指定的键
}
```

### 6.2 格式化输出

可以将 KVs 格式化为更易读的形式：

```go
func (o *outputSessionKVsAgent) Run(...) *adk.AsyncIterator[*adk.AgentEvent] {
    // ...
    kvs := adk.GetSessionValues(ctx)
    formatted := formatSessionKVs(kvs)  // 自定义格式化
    event := &adk.AgentEvent{
        Output: &adk.AgentOutput{CustomizedOutput: formatted},
    }
    generator.Send(event)
}
```

---

## 7. 总结

`outputSessionKVsAgent` 是一个轻量但实用的包装器，体现了 ADK 的**组合式设计**理念：

1. **通过包装而非继承扩展功能**
2. **通过 Session 抽象共享状态**
3. **通过事件流保持响应式交互**

虽然功能简单，但在调试复杂的多 Agent 系统时非常有用。