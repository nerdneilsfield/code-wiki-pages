# clear_tool_result_policy 模块技术深度解析

## 概述

**一句话概括**：这是一个上下文管理中间件，通过在每次大语言模型调用前检测并清除过期的工具调用结果，在有限的上下文窗口中为新的对话内容腾出空间，同时保护最近的关键消息不被误删。

在实际的 AI Agent 应用中，对话往往会产生大量的工具调用结果。这些结果可能是文件读取的完整内容、数据库查询的详细返回值，或者是代码执行的完整输出。随着对话轮次增加，这些历史工具结果会迅速填满模型的上下文窗口，导致两个严重问题：一是新生成的工具结果无处存放，二是模型可能"遗忘"近期对话的关键上下文。`clear_tool_result_policy` 模块正是为了解决这个矛盾而设计的——它充当了一位"图书管理员"的角色，定期清理书架上久远的书籍（旧的工具结果），但在读者正在阅读的部分（最近的对话上下文）留出足够的空间。

---

## 架构定位与设计意图

### 在系统中的位置

从模块树的结构来看，这个模块位于 `adk_middlewares_and_filesystem` 下的 `generic_tool_result_reduction`（通用工具结果缩减）子系统中。它与以下模块协同工作：

```
adk_middlewares_and_filesystem
└── generic_tool_result_reduction
    ├── reduction_tool_result_contracts  (工具结果配置契约)
    ├── clear_tool_result_policy         (← 当前模块：基于 token 阈值的清除策略)
    ├── large_tool_result_offloading     (大结果卸载到文件系统)
    └── large_tool_result_offloading_test_backends
```

### 解决的问题空间

在多轮对话 Agent 场景中，上下文窗口是一种稀缺资源。考虑一个典型的场景：用户让 Agent 读取并分析多个大型代码文件，每次文件读取都可能返回数万 token 的内容。如果不进行管理，只需要十几轮对话，上下文窗口就会被填满，此时模型将无法继续生成有意义的回复。

一个 naive 的解决方案是简单地"删除最旧的工具结果"。但这会导致一个关键问题：如果用户正在讨论某个早期分析结果的关键细节，而该结果恰好被清除了，模型就失去了引用早期上下文的能力。想象一下，用户说"刚才那个文件中关于用户认证的函数在哪里？"——如果相关的工具结果已经被无条件删除，模型将无法回答这个问题。

**这就是本模块的设计 insight**：不是简单地删除旧内容，而是在两个约束之间寻找平衡——一是总体 token 预算上限（`ToolResultTokenThreshold`），二是保护最近一定 token 预算的消息不被触动（`KeepRecentTokens`）。这种"滑动窗口"式的保护机制确保了即使在清理旧结果时，模型仍然保留对近期对话上下文的完整访问能力。

---

## 核心组件分析

### ClearToolResultConfig

这是中间件的配置结构体，定义了清理行为的所有可调参数：

```go
type ClearToolResultConfig struct {
    // 工具结果的总 token 阈值。当所有工具结果的 token 总和超过此值时，
    // 超出 KeepRecentTokens 范围的旧结果将被替换为占位符
    ToolResultTokenThreshold int
    
    // 保护最近消息的 token 预算。从对话末尾开始计算，
    // 落在这个预算范围内的消息不会丢失其工具结果
    KeepRecentTokens int
    
    // 替换旧工具结果使用的占位符文本
    ClearToolResultPlaceholder string
    
    // 自定义 token 计数函数。如果为 nil，使用默认的字符数/4 估算
    TokenCounter func(msg *schema.Message) int
    
    // 排除列表：这些工具的结果永远不会被清除
    ExcludeTools []string
}
```

设计这个配置结构时，作者做出了几个务实的选择。首先，`ToolResultTokenThreshold` 和 `KeepRecentTokens` 都提供了默认值（分别为 20000 和 40000 token），这意味着即使不显式配置，模块也能以合理的参数运行。其次，`TokenCounter` 是一个函数指针而非固定算法，这允许调用者根据具体场景使用更精确的 token 估算方法（比如基于 TikToken 等真实分词器）。最后，`ExcludeTools` 提供了一种"安全阀"机制，确保某些关键工具（如返回关键状态或配置的工具）的结果永远不会被清除。

### 默认 Token 估算策略

```go
func defaultTokenCounter(msg *schema.Message) int {
    count := len(msg.Content)
    
    // 工具调用的参数也需要计入
    for _, tc := range msg.ToolCalls {
        count += len(tc.Function.Arguments)
    }
    
    // 简单估算：约4个字符对应1个 token
    return (count + 3) / 4
}
```

这个默认实现采用了一种简单但实用的启发式方法：字符数除以 4。为什么是 4？这是一个经验值——对于英文文本，平均每个 token 约包含 4 个字符；对于中文，这个比例更低（因为汉字是双字节且包含更多信息）。虽然不如真实分词器精确，但在实际应用中，这个估算足够用于上下文管理的决策，且计算成本极低。

值得注意的是，这个函数不仅计算消息的 `Content` 字段，还累加了 `ToolCalls` 中 `Function.Arguments` 的长度。这确保了工具调用的请求部分也被纳入 token 统计，虽然在清理逻辑中实际上只处理工具结果（Tool Role 的消息）。

### reduceByTokens：核心清除逻辑

这是模块的心脏，它实现了"带保护的滑动窗口"算法：

```go
func reduceByTokens(state *adk.ChatModelAgentState, toolResultTokenThreshold, 
    keepRecentTokens int, placeholder string, counter func(*schema.Message) int, 
    excludedTools []string) error {
    // 步骤1：计算所有工具结果的 token 总数
    totalToolResultTokens := 0
    for _, msg := range state.Messages {
        if msg.Role == schema.Tool && msg.Content != placeholder {
            totalToolResultTokens += counter(msg)
        }
    }
    
    // 如果未超出阈值，无需任何操作
    if totalToolResultTokens <= toolResultTokenThreshold {
        return nil
    }
    
    // 步骤2：计算需要保护的"最近消息"起始索引
    // 从后向前遍历，累积 token 数，直到接近 keepRecentTokens
    recentStartIdx := len(state.Messages)
    cumulativeTokens := 0
    
    for i := len(state.Messages) - 1; i >= 0; i-- {
        msgTokens := counter(state.Messages[i])
        if cumulativeTokens + msgTokens > keepRecentTokens {
            recentStartIdx = i
            break
        }
        cumulativeTokens += msgTokens
        recentStartIdx = i
    }
    
    // 步骤3：清除 protection window 之外的工具结果
    for i := 0; i < recentStartIdx; i++ {
        msg := state.Messages[i]
        if msg.Role == schema.Tool && msg.Content != placeholder && 
           !excluded(msg.ToolName, excludedTools) {
            msg.Content = placeholder
        }
    }
    
    return nil
}
```

理解这个算法的关键在于把握"protection window"的概念。假设我们有 10 条消息，总计 50000 token 的工具结果，而阈值设为 20000，保护预算设为 10000。算法会：

1. **第一步**：检测到 50000 > 20000，触发清理
2. **第二步**：从最后一条消息开始向前计算，找到累积 token 数刚好不超过 10000 的位置——这个位置之前的消息属于"旧消息"，之后的消息属于"最近消息"
3. **第三步**：只清除"旧消息"中的工具结果，"最近消息"中的工具结果保持原样

这种设计的精妙之处在于：即使在大量工具结果需要清理的情况下，模型仍然能访问最近对话中的完整工具输出。这对于用户最近一次提问相关的工具调用尤其重要。

---

## 数据流与依赖关系

### 调用链分析

```
用户请求
    ↓
Agent.Run()
    ↓
ChatModelAgent (adk.chatmodel)
    ↓
AgentMiddleware.BeforeChatHook
    ↓
clear_tool_result.newClearToolResult() 
    ↓
reduceByTokens() ← 操作 state.Messages
    ↓
LLM 调用 (使用清理后的状态)
```

数据流动的关键点：

1. **输入**：`adk.ChatModelAgentState` 结构体，其中包含 `Messages []Message` 字段
2. **处理**：中间件在 LLM 调用之前检查并可能修改 `Messages` 数组
3. **输出**：修改后的 `Messages` 数组，旧的工具结果被替换为占位符

### 与其他模块的关系

**上游依赖**：
- `adk.chatmodel.AgentMiddleware`：模块创建的中间件类型，需要符合其函数签名
- `schema.Message`：操作的消息数据结构

**下游依赖**：
- 模块本身不直接调用其他业务模块，它是一个"过滤器"性质的中间件
- 但它的输出会影响 `ChatModelAgentState` 的后续使用方式

**重要发现**：`clear_tool_result` 模块已经 deprecated！新代码应该使用 `NewToolResultMiddleware`（来自 `tool_result` 包），它组合了清除策略和大型结果卸载策略：

```go
// 新的推荐方式：同时使用清除和卸载
func NewToolResultMiddleware(ctx context.Context, cfg *ToolResultConfig) (adk.AgentMiddleware, error) {
    bc := newClearToolResult(ctx, &ClearToolResultConfig{...})   // 清除
    tm := newToolResultOffloading(ctx, &toolResultOffloadingConfig{...}) // 卸载
    return adk.AgentMiddleware{
        BeforeChatModel: bc,
        WrapToolCall:    tm,
    }, nil
}
```

这种组合策略的优势是：小型工具结果使用清除策略管理，大型工具结果则被卸载到文件系统，两种策略互补。

---

## 设计决策与权衡

### 1. 字符级 Token 估算 vs 精确分词

**选择**：使用 `len(content) / 4` 的简单启发式算法

**权衡考量**：
- 优点：计算速度快，无额外依赖，实现简洁
- 缺点：对于非英文文本（如中文、德文）可能不准确

在上下文管理的场景中，精确的 token 计数并非必要——我们只需要一个"大致合理"的估计来触发清理。真实的 token 计数会增加额外的计算开销和依赖，而带来的收益有限。

### 2. 就地修改 vs 创建新数组

**选择**：直接修改 `state.Messages` 中各元素的 `Content` 字段

```go
msg.Content = placeholder  // 直接修改原消息
```

**权衡考量**：
- 优点：无需复制整个消息数组，内存效率高
- 缺点：修改是"破坏性"的，如果后续逻辑需要原始内容，将无法恢复

这里的假设是：一旦工具结果被标记为"可清理"，它们在当前对话轮次中就不会再被需要。如果调用者需要保留原始内容，应该在调用中间件之前进行快照。

### 3. 清除 vs 卸载

**选择**：本模块仅实现"清除"策略

这是一个有趣的架构决策。在 `tool_result` 包的统一接口下，实际上存在两种处理过大工具结果的策略：
- **清除**（clear）：删除内容，用占位符替代
- **卸载**（offloading）：将内容写入文件系统，在消息中保留引用

这两种策略并非互斥，而是针对不同场景：
- 清除策略适用于：工具结果确实不再需要，只是占用空间
- 卸载策略适用于：大型结果可能仍有参考价值，只是不能放在内存中

新代码推荐使用组合两者：`NewToolResultMiddleware` 同时注册了清除（作为 BeforeChatModel hook）和卸载（作为 WrapToolCall hook）。

### 4. 排除机制的粒度

**选择**：按工具名称（`ToolName`）进行排除

```go
ExcludeTools []string
```

这意味着如果用户希望某个工具的结果永远不被清除，只需将其名称加入排除列表。这是一种简单但足够用的机制。更细粒度的控制（如基于内容特征、消息时间戳等）目前不支持，这也是一种务实的简化。

---

## 使用指南与最佳实践

### 基础用法

```go
import (
    "context"
    "github.com/cloudwego/eino/adk/middlewares/reduction/clear_tool_result"
    "github.com/cloudwego/eino/adk/middlewares/reduction/tool_result"
    "github.com/cloudwego/eino/adk"
)

// 方式1：使用已废弃的直接创建方式（仅保留以兼容旧代码）
middleware, err := clear_tool_result.NewClearToolResult(ctx, &clear_tool_result.ClearToolResultConfig{
    ToolResultTokenThreshold: 30000,  // 30k token 阈值
    KeepRecentTokens: 50000,          // 保护最近 50k token
    ClearToolResultPlaceholder: "[已清除旧工具结果]",
    ExcludeTools: []string{"get_system_status"},
})

// 方式2：使用新的统一接口（推荐）
middleware, err := tool_result.NewToolResultMiddleware(ctx, &tool_result.ToolResultConfig{
    ClearingTokenThreshold: 30000,
    KeepRecentTokens: 50000,
    ClearToolResultPlaceholder: "[已清除旧工具结果]",
    ExcludeTools: []string{"get_system_status"},
    // 结合卸载策略
    Backend: myBackend,
    OffloadingTokenLimit: 20000,
})
```

### 自定义 Token 计数器

如果需要更精确的 token 估算，可以使用 tiktoken 等库：

```go
import "github.com/samber/tiktoken-go"

tke, _ := tiktoken.New("cl100k_base", "")
counter := func(msg *schema.Message) int {
    return len(tke.Encode(msg.Content, nil, nil))
}

middleware, _ := tool_result.NewToolResultMiddleware(ctx, &tool_result.ToolResultConfig{
    ClearingTokenThreshold: 20000,
    TokenCounter: counter,
})
```

### 调试与监控

由于清除操作是静默进行的，在开发调试时可能需要确认是否生效。可以通过检查消息内容中是否包含占位符来验证：

```go
func countClearedMessages(messages []schema.Message) int {
    placeholder := "[Old tool result content cleared]"
    count := 0
    for _, msg := range messages {
        if msg.Role == schema.Tool && msg.Content == placeholder {
            count++
        }
    }
    return count
}
```

---

## 边界情况与注意事项

### 空消息列表

```go
if len(state.Messages) == 0 {
    return nil
}
```

如果消息列表为空，函数直接返回，不做任何处理。这是一个防御性检查，避免不必要的计算。

### 占位符本身的处理

```go
if msg.Role == schema.Tool && msg.Content != placeholder {
    // 只有内容不是占位符的消息才参与计数和清除
}
```

这是一个重要的细节：如果一条工具结果消息已经被之前的处理替换为占位符，它在后续轮次中将不再参与 token 计数，也不会再次被清除。这避免了"反复清除已清除内容"的问题。

### ToolName 可能为空的边界情况

根据 `schema.Message` 的定义，`ToolName` 字段是 `omitempty` 的，意味着可能不存在。在 `excluded` 函数中：

```go
func excluded(name string, exclude []string) bool {
    for _, ex := range exclude {
        if name == ex {  // 空字符串不会匹配任何非空排除项
            return true
        }
    }
    return false
}
```

如果工具名称为空字符串，它不会匹配任何排除项，因此可能被清除。对于没有名称的工具结果，这是合理的行为——它们通常是可以安全清除的。

### 与其他中间件的交互顺序

当多个 `BeforeChatModel` 中间件同时存在时，执行顺序很重要。建议将工具结果清理中间件放在靠前的位置，以确保在其他处理开始之前，上下文已经被适当管理：

```go
agent := chatmodel.NewChatModelAgent(ctx, &chatmodel.ChatModelAgentConfig{
    Middlewares: []adk.AgentMiddleware{
        clearToolResultMiddleware,  // 尽早清理
        anotherMiddleware,
    },
})
```

---

## 与其他模块的对比

| 特性 | clear_tool_result | large_tool_result_offloading | 组合 (NewToolResultMiddleware) |
|------|-------------------|------------------------------|-------------------------------|
| 策略类型 | 清除 | 卸载到文件系统 | 两者结合 |
| 数据持久化 | 否，原内容丢失 | 是，写入文件 | 是，部分卸载 |
| 配置复杂度 | 低 | 中 | 高 |
| 适用场景 | 结果可丢弃 | 结果可能需要参考 | 混合场景 |

---

## 总结

`clear_tool_result_policy` 模块体现了在有限资源下进行智能管理的思想。它的核心价值不在于复杂算法，而在于提供了一个实用的框架，帮助开发者在"保留历史信息"和"管理上下文大小"之间找到平衡。通过阈值触发和保护窗口的组合，它确保了即使在资源紧张的情况下，模型仍然能访问最近对话的关键上下文。

对于新项目的建议是：直接使用 `NewToolResultMiddleware`（来自 `tool_result` 包），它提供了更完整的问题解决方案——既包含了清除策略，也包含了大型结果的卸载能力，是一个更完整的事后处理方案。