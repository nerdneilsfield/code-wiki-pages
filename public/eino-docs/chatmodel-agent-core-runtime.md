# ChatModel Agent 核心运行时模块 (chatmodel_agent_core_runtime)

## 概述

`chatmodel_agent_core_runtime` 模块是 EINO ADK 框架中最核心的组件之一，它实现了一个基于大语言模型（ChatModel）的自主智能体（Agent）。这个模块解决的问题是：**如何让一个 LLM 能够自主决策、调用工具、与外部系统交互，并以流式方式输出思考过程和结果**。

想象一下传统程序的特点：确定性输入 → 确定性输出。而这个模块要实现的是：不确定性输入 → LLM 自主推理 → 决策行动 → 反馈循环 → 最终结果。这种"推理-行动"（ReAct）模式是现代 AI Agent 的基础范式。

该模块的核心价值在于它提供了一个完整的、 生产级别的 Agent 运行时，包含：ReAct 循环执行引擎、工具调用与结果处理、中断与恢复机制、状态持久化（Checkpoint）、中间件扩展能力、以及流式事件输出。它不是简单地将 LLM 包装一下，而是完整实现了一个自主智能体所需的所有基础设施。

---

## 架构与核心抽象

### 核心抽象概念

要理解这个模块，首先要建立几个关键抽象：

**1. Agent（智能体）**：一个具有自主决策能力的实体，它接收输入（用户消息），通过 LLM 进行推理，决定是否需要调用工具，执行工具后获取结果，将结果反馈给 LLM 继续推理，直到产生最终答案或达到迭代上限。

**2. ReAct 循环**：这是该模块的执行核心。"ReAct" 代表 Reasoning（推理）+ Acting（行动）。它的执行流程是：LLM 生成内容 → 判断是否需要工具调用 → 如果需要，执行工具 → 将工具结果作为上下文反馈给 LLM → 重复这个过程直到不再需要工具调用。

**3. Middleware（中间件）**：模块提供的扩展机制，允许开发者在关键节点注入自定义逻辑。这类似于 Web 框架中的中间件概念，可以在请求前后、工具调用前后等位置添加自定义处理。

**4. Event Stream（事件流）**：Agent 的执行过程会产生多种事件（LLM 输出、工具调用、工具结果、中断等），这些事件通过异步迭代器（AsyncIterator）流式输出给调用者。

**5. Checkpoint（检查点）**：用于持久化 Agent 状态，使其能够被中断后恢复执行。这对于长时间运行的任务或需要用户交互的任务至关重要。

### 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Runner (调用入口)                             │
│                    adk/runner.go - 生命周期管理                       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ChatModelAgent (核心运行时)                        │
│                   adk/chatmodel.go - 本模块                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  buildRunFunc() → 构建执行图                                    │   │
│  │  ├── 无工具模式: Chain(GenModelInput → ChatModel)              │   │
│  │  └── 有工具模式: Chain(GenModelInput → ReAct Graph)            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ReAct Graph (ReAct 循环)                        │
│                    adk/react.go - 推理行动循环                        │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐          │
│  │  LLM    │───▶│ 工具调用 │───▶│ 执行工具 │───▶│ 结果处理 │          │
│  │  推理   │    │  决策   │    │  获取结果│    │  反馈   │          │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘          │
│       ▲                                                            │
│       └────────────────────────────────────────────────────────────┘
│                         循环直到完成                                   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Checkpoint Store (状态持久化)                      │
│              compose/checkpoint.go - 中断恢复支持                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 核心组件详解

### ChatModelAgent

`ChatModelAgent` 是整个模块的核心结构体，它实现了 `Agent` 接口（定义在 `adk/interface.go` 中）。理解这个结构体，就理解了模块的一半。

```go
type ChatModelAgent struct {
    name        string           // Agent 名称，必须唯一
    description string           // Agent 描述，用于 Agent 间的任务分发
    instruction string           // 系统提示词
    
    model       model.ToolCallingChatModel  // LLM 核心
    toolsConfig ToolsConfig                 // 工具配置
    
    genModelInput GenModelInput  // 输入转换函数
    
    exit tool.BaseTool           // 退出工具（可选）
    
    maxIterations int            // 最大迭代次数，防止无限循环
    
    beforeChatModels, afterChatModels []func(context.Context, *ChatModelAgentState) error  // 生命周期钩子
    
    modelRetryConfig *ModelRetryConfig  // 重试配置
    
    subAgents   []Agent        // 子 Agent 列表
    parentAgent Agent          // 父 Agent 引用
    
    // 内部运行状态
    once   sync.Once           // 确保 run 只构建一次
    run    runFunc             // 实际执行函数
    frozen uint32              // 冻结标志，运行后不可修改
}
```

**设计意图**：这个结构体采用"构建时"与"运行时"分离的设计。`NewChatModelAgent` 负责创建 Agent 实例并配置所有参数，而 `buildRunFunc` 则在首次运行时动态构建执行逻辑。这种设计的优势是：配置检查在创建时完成，而复杂的执行图构建延迟到实际需要时才进行（惰性计算）。

### ChatModelAgentConfig

`ChatModelAgentConfig` 是创建 Agent 时的配置结构，它定义了 Agent 的所有行为特征：

```go
type ChatModelAgentConfig struct {
    Name string              // 必须，Agent 唯一标识
    Description string       // 必须，用于 Agent 间的协作发现
    Instruction string       // 系统提示词，支持 F-String 占位符
    Model model.ToolCallingChatModel  // 必须，LLM 实例
    
    ToolsConfig ToolsConfig  // 工具配置
    GenModelInput GenModelInput  // 可选，输入格式化函数
    
    Exit tool.BaseTool       // 可选，退出工具
    OutputKey string         // 可选，输出存入 Session 的键名
    
    MaxIterations int        // 默认 20，防止无限循环
    Middlewares []AgentMiddleware  // 中间件列表
    ModelRetryConfig *ModelRetryConfig  // 重试配置
}
```

**关键设计决策**：`Instruction` 支持 F-String 占位符（例如 `"当前时间是 {Time}"`），这是通过默认的 `GenModelInput` 函数实现的。当 `SessionValues` 存在时，会自动使用 `prompt.FromMessages` 进行模板渲染。这个设计让开发者可以用统一的方式传递运行时信息（时间、用户等）给 Agent，无需自定义 `GenModelInput`。

### ToolsConfig

`ToolsConfig` 定义了 Agent 的工具能力，这是一个相当复杂的配置：

```go
type ToolsConfig struct {
    compose.ToolsNodeConfig  // 继承自 compose 框架的工具节点配置
    
    // ReturnDirectly: 触发立即返回的工具映射
    // 当配置的工具被调用时，Agent 会立即返回结果，不再继续推理循环
    // 这对于"退出"、"转让"等控制流工具非常有用
    ReturnDirectly map[string]bool
    
    // EmitInternalEvents: 是否将内部 Agent 工具的事件向上抛出
    // 当 Agent 作为工具被其他 Agent 调用时，此标志控制是否将内部事件
    // 流式输出给外层调用者。注意：这些事件不会记录到父 Agent 的 session 中
    EmitInternalEvents bool
}
```

**设计意图**：`ReturnDirectly` 是一个强大的控制流机制。想象一个场景：Agent 有多个工具（搜索、计算、退出），当用户要求"退出"时，我们希望立即返回而不是继续执行搜索或计算。通过将"exit"工具标记为 `ReturnDirectly: true`，Agent 会在该工具执行完成后立即返回，忽略其他可能的工具调用。

### AgentMiddleware

`AgentMiddleware` 提供了扩展 Agent 行为的能力，这借鉴了 Web 中间件的思路：

```go
type AgentMiddleware struct {
    // AdditionalInstruction: 追加的系统提示词
    AdditionalInstruction string
    
    // AdditionalTools: 追加的工具
    AdditionalTools []tool.BaseTool
    
    // BeforeChatModel: LLM 调用前钩子
    BeforeChatModel func(context.Context, *ChatModelAgentState) error
    
    // AfterChatModel: LLM 调用后钩子
    AfterChatModel func(context.Context, *ChatModelAgentState) error
    
    // WrapToolCall: 工具调用包装器
    WrapToolCall compose.ToolMiddleware
}
```

**使用场景**：中间件非常适合实现横切关注点。例如：
- 记录日志：在 `BeforeChatModel` 和 `AfterChatModel` 中记录每次 LLM 调用的输入输出
- 添加上下文：在 `BeforeChatModel` 中向 state 添加额外的上下文信息
- 工具调用监控：在 `WrapToolCall` 中添加调用计数或超时控制

### 回调处理器 (cbHandler / noToolsCbHandler)

回调处理器是模块与外部事件系统通信的桥梁。它们实现了对 `compose` 框架回调接口的响应：

```go
type cbHandler struct {
    *AsyncGenerator[*AgentEvent]  // 事件生成器，用于输出事件
    agentName string
    
    enableStreaming bool
    store *bridgeStore            // 检查点存储
    returnDirectlyToolEvent atomic.Value  // 暂存立即返回的事件
    
    ctx context.Context
    addr Address                  // 当前执行地址，用于过滤回调
    
    modelRetryConfigs *ModelRetryConfig
}
```

**核心职责**：`cbHandler` 监听三个层面的事件：
1. **ChatModel 层**：监听 LLM 调用的结束，将输出转换为 `AgentEvent` 输出
2. **ToolsNode 层**：监听工具执行的结束，处理工具结果，触发 `ReturnDirectly` 逻辑
3. **Graph 层**：监听错误和中断，将中断信息转换为标准的 `AgentEvent`

**地址过滤机制**：模块使用 `isAddressAtDepth` 函数来过滤回调事件。这是由于一个 Agent 运行时可能包含多个嵌套的子图（子 Agent、工具节点等），回调会从所有层级触发。通过地址深度匹配，可以确保只有当前 Agent 层级的回调被处理。

---

## 数据流分析

### 完整执行流程

理解模块最好的方式是跟踪一个请求从入口到出口的完整路径：

```
用户消息
    │
    ▼
Runner.Run()
    │
    ▼
ChatModelAgent.Run()
    │
    ├── 1. buildRunFunc() 构建执行图（仅首次调用）
    │       │
    │       ├── 检查工具配置
    │       ├── 如果有子 Agent，注入 transfer_to_agent 工具
    │       ├── 如果有 exit 工具，注入并标记为 ReturnDirectly
    │       │
    │       └── 构建执行链：
    │               无工具: Chain(Input → LLM)
    │               有工具: Chain(Input → ReAct Graph)
    │
    ├── 2. 创建 AsyncIterator/AsyncGenerator 对
    │
    └── 3. 启动 goroutine 执行 run()
            │
            ▼
        ReAct 循环（如有工具）
            │
            ├── LLM 生成 → 判断是否需要工具调用
            │
            ├── 如需工具调用：
            │       │
            │       ├── 执行工具
            │       │
            │       ├── 回调处理：
            │       │       cbHandler.onToolsNodeEnd()
            │       │           │
            │       │           ├── 发送工具结果事件
            │       │           │
            │       │           └── 检查 ReturnDirectly
            │       │               如为 true，标记状态，准备退出
            │       │
            │       └── 将结果反馈给 LLM
            │
            ├── 如不需工具调用或已标记 ReturnDirectly：
            │       │
            │       └── 返回最终结果
            │
            └── 达到 maxIterations 或出错 → 终止
                │
                ▼
            generator.Close() → 关闭事件流
```

### 事件输出机制

模块通过 `AsyncGenerator` 以流式方式输出事件。关键类型是 `AgentEvent`：

```go
type AgentEvent struct {
    AgentName string      // 事件来源 Agent 名称
    RunPath []RunStep     // 执行路径，用于嵌套 Agent
    
    Output *AgentOutput   // 输出内容
        // ├── MessageOutput: 消息输出（支持流式）
        // └── CustomizedOutput: 自定义输出
    
    Action *AgentAction   // 动作（中断、退出、转让等）
    Err error             // 错误信息
}
```

**事件类型**：输出事件可以是以下几种：
- **MessageOutput**：LLM 的回复（`schema.Assistant` 角色）或工具结果（`schema.Tool` 角色）
- **Action**：
  - `Exit`: Agent 正常退出
  - `TransferToAgent`: 转让给其他 Agent
  - `Interrupted`: 中断，等待用户输入
  - `BreakLoop`: 跳出循环
- **Err**: 执行过程中的错误

### Checkpoint 与恢复

模块支持中断和恢复，这是通过 `bridgeStore` 实现的：

```go
// ChatModelAgent.Run() 中
store := newBridgeStore()  // 新建检查点存储

// ChatModelAgent.Resume() 中
store := newResumeBridgeStore(stateByte)  // 从已有状态恢复
```

**Checkpoint 序列化**：模块使用 `gobSerializer`（基于 Go 的 `encoding/gob`）进行状态序列化。序列化的内容包括：
- Agent 的消息历史
- 当前迭代次数
- 工具调用状态
- 中间件状态

**中断处理**：当执行过程中发生中断（用户主动中断或工具返回中断信号），`cbHandler.onGraphError` 会捕获 `compose.ExtractInterruptInfo(err)`，提取中断上下文，检查点数据，然后生成 `CompositeInterrupt` 事件发送给调用者。

---

## 设计决策与权衡

### 1. 惰性构建执行图

**决策**：`buildRunFunc` 使用 `sync.Once` 确保执行图只构建一次，且在首次 `Run` 时才构建。

**权衡**：
- **优点**：配置错误会在首次运行时暴露，而不是创建 Agent 时；允许动态配置（如子 Agent 在运行前设置）
- **缺点**：首次调用有额外开销；如果配置错误，运行时才会发现

### 2. 地址深度过滤回调

**决策**：使用 `isAddressAtDepth` 过滤回调事件，确保只有当前 Agent 层的事件被处理。

**权衡**：
- **优点**：支持嵌套 Agent，每个 Agent 独立处理自己的事件；避免事件混乱
- **缺点**：增加了回调处理的复杂性；需要仔细管理地址层级

### 3. ReturnDirectly 机制

**决策**：将特定工具标记为"立即返回"，Agent 调用后立即结束而不继续推理。

**权衡**：
- **优点**：简单直接地实现控制流（退出、转让）；无需自定义工具逻辑
- **缺点**：如果多个 ReturnDirectly 工具同时调用，只有第一个生效；这可能是一个隐式陷阱

### 4. EmitInternalEvents 设计

**决策**：当 Agent 作为工具被其他 Agent 调用时，可以选择是否将内部事件向上传递。

**权衡**：
- **优点**：允许外层 Agent/用户实时看到嵌套 Agent 的思考过程；提供更好的可观测性
- **缺点**：这些事件不会记录到父 Agent 的 session 中，可能导致状态不一致；事件作用域边界需要仔细理解

### 5. 模型重试的流式兼容

**决策**：在流式输出场景下，错误通过 `schema.WithErrWrapper` 包装进流中，而不是作为独立事件。

**权衡**：
- **优点**：流式输出不会被中断；错误信息与正常输出一起传递给调用者
- **缺点**：调用者需要理解流式错误的处理方式；增加了使用复杂性

---

## 使用指南

### 基本使用

```go
// 创建 Agent
agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:        "assistant",
    Description: "一个有用的助手",
    Instruction: "你是一个有帮助的助手。",
    Model:       myChatModel,  // 实现 model.ToolCallingChatModel 接口
    Tools:       []tool.BaseTool{myTool1, myTool2},
    MaxIterations: 20,
})

// 运行 Agent
iter := agent.Run(ctx, &adk.AgentInput{
    Messages: []adk.Message{
        schema.UserMessage("请帮我查询天气"),
    },
    EnableStreaming: true,
})

// 迭代事件
for {
    event, ok := iter.Next()
    if !ok {
        break
    }
    // 处理事件
    if event.Output != nil && event.Output.MessageOutput != nil {
        // 处理消息输出
    }
    if event.Action != nil {
        // 处理动作（退出、转让、中断等）
    }
    if event.Err != nil {
        // 处理错误
    }
}
```

### 使用中间件

```go
agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    // ... 其他配置
    Middlewares: []adk.AgentMiddleware{
        {
            AdditionalInstruction: "你是一个专业的数学助手。",
            BeforeChatModel: func(ctx context.Context, state *adk.ChatModelAgentState) error {
                // 在 LLM 调用前记录日志
                log.Printf("LLM 调用前消息数: %d", len(state.Messages))
                return nil
            },
            AfterChatModel: func(ctx context.Context, state *adk.ChatModelAgentState) error {
                // 在 LLM 调用后记录日志
                lastMsg := state.Messages[len(state.Messages)-1]
                log.Printf("LLM 调用后最后消息: %s", lastMsg.GetContent())
                return nil
            },
        },
    },
})
```

### 中断与恢复

```go
// 正常运行
iter := agent.Run(ctx, &adk.AgentInput{
    Messages: []adk.Message{schema.UserMessage("帮我写一个很长的故事")},
    EnableStreaming: true,
})

// 假设在某个时刻用户中断了
var interruptedState []byte
for {
    event, ok := iter.Next()
    if !ok {
        break
    }
    if event.Action != nil && event.Action.Interrupted != nil {
        // 获取中断状态用于恢复
        ci, ok := event.Action.Interrupted.InterruptContexts
        if ok {
            // 保存状态供后续恢复
            interruptedState = /* 从 checkpoint store 获取 */ 
        }
        break
    }
}

// 恢复执行
resumeInfo := &adk.ResumeInfo{
    EnableStreaming: true,
    InterruptState:  interruptedState,
    ResumeData: &adk.ChatModelAgentResumeData{
        HistoryModifier: func(ctx context.Context, history []adk.Message) []adk.Message {
            // 可以修改历史消息
            return history
        },
    },
}

resumeIter := agent.Resume(ctx, resumeInfo)
```

---

## 注意事项与陷阱

### 1. MaxIterations 限制

Agent 有一个 `MaxIterations` 默认为 20 的迭代上限。这是保护机制，防止 Agent 陷入无限循环（LLM 持续调用工具而不产生最终结果）。如果达到上限，会返回 `ErrExceedMaxIterations` 错误。

**建议**：根据实际场景调整这个值。如果你的 Agent 需要多轮工具调用才能完成复杂任务，可能需要增加这个值。

### 2. ReturnDirectly 只会触发第一个

当多个工具被标记为 `ReturnDirectly` 且同时被调用时，只有第一个执行的工具会触发立即返回。这可能与直觉相悖。

```go
ToolsConfig: adk.ToolsConfig{
    ReturnDirectly: map[string]bool{
        "exit":           true,
        "transfer_agent": true,  // 这两个都标记了，但只会触发第一个
    },
}
```

### 3. MessageStream 必须手动关闭

如果 `EnableStreaming` 为 true，产生的 `MessageStream` 需要手动关闭或使用 `SetAutomaticClose()`。这是因为流式数据需要被完全消费或显式关闭。

```go
if event.Output.MessageOutput.IsStreaming {
    event.Output.MessageOutput.MessageStream.SetAutomaticClose()
}
```

### 4. 中间件的执行顺序

`BeforeChatModel` 按配置顺序执行，`AfterChatModel` 按配置顺序的**倒序**执行（类似 defer）。这样可以方便地进行嵌套逻辑的处理。

### 5. EmitInternalEvents 的作用域边界

当 Agent 作为工具被嵌套调用时：
- `Exit`、`TransferToAgent`、`BreakLoop` 动作**不会**传播到外层
- `Interrupted` 会通过 `CompositeInterrupt` 传播，允许跨边界恢复
- 事件只会输出给最终用户，**不会**记录到父 Agent 的 session 中

### 6. GenModelInput 与 F-String

默认的 `GenModelInput` 会在检测到 SessionValues 时自动使用 F-String 格式化。如果你的提示词包含字面量的大括号（例如 JSON），需要提供自定义的 `GenModelInput`：

```go
GenModelInput: func(ctx context.Context, instruction string, input *adk.AgentInput) ([]adk.Message, error) {
    // 自行处理，不进行格式化
    msgs := []adk.Message{schema.SystemMessage(instruction)}
    msgs = append(msgs, input.Messages...)
    return msgs, nil
}
```

---

## 依赖关系

### 上游依赖

- **compose 框架** (`compose/graph.go`, `compose/chain.go` 等): 提供执行图、状态管理、检查点等基础设施
- **model 组件** (`components/model`): LLM 调用接口
- **tool 组件** (`components/tool`): 工具定义和调用接口
- **schema** (`schema/message.go`): 消息、工具调用等数据结构
- **callbacks** (`callbacks/handler_builder.go`): 事件回调系统

### 下游调用

- **Runner** (`adk/runner.go`): 通常通过 Runner 调用 Agent，管理完整的生命周期
- **agent_tool** (`adk/agent_tool.go`): 将 Agent 包装为工具，供其他 Agent 调用
- **flow** (`adk/flow.go`): 工作流编排，可能包含多个 Agent

---

## 相关文档

- [React 运行时状态与工具结果流](react-runtime-state-and-tool-result-flow.md) - ReAct 循环的详细实现
- [ChatModel 重试运行时](chatmodel-retry-runtime.md) - 模型重试机制
- [Agent 工具适配器](agent-tool-adapter.md) - 将 Agent 作为工具使用
- [中断与恢复桥接](interrupt-resume-bridge.md) - 中断处理机制
- [Flow Agent 编排](flow-agent-orchestration.md) - 多 Agent 协作
- [Runner 执行与恢复](runner-execution-and-resume.md) - Runner 完整生命周期