# task_tool_definition 模块技术深度解析

## 模块概述

`task_tool_definition` 模块是 CloudWeGo EINO 框架中 Deep Agent 的核心组件之一，负责实现**子 agent 分派机制**。在复杂的 AI Agent 系统中，主 agent 往往需要将复杂任务委托给专业化的子 agent 来处理，这些子 agent 各司其职——有的擅长代码搜索，有的精于数据分析，有的则负责文件操作。本模块解决的问题是：如何让主 agent 能够以统一的方式调用这些专业化的子 agent，同时保持接口的简洁性和扩展性。

想象一下现实生活中的场景：一家科技公司的 CEO（主 agent）需要完成一个复杂项目，她不会亲自去写每一行代码、测试每一个功能、部署每一个服务，而是将任务分派给 CTO（代码 agent）、QA 负责人（测试 agent）、运维负责人（部署 agent）。`task_tool_definition` 模块正是实现了这种"分而治之"的管理模式——它充当了一个任务分发中心的角色，接收主 agent 的请求，根据请求类型路由到对应的子 agent，并返回结果。

## 核心抽象与设计意图

### 任务工具的定位

本模块定义了一个名为 `taskTool` 的结构体，它实现了 `tool.InvokableTool` 接口。本质上，这是一个**工具形式的 agent 路由器**。与传统的函数工具不同，这个工具的"函数"行为是动态的——它不执行固定的计算逻辑，而是根据传入的 `subagent_type` 参数，将请求委托给注册在其中的某个子 agent。

这种设计遵循了**依赖倒置原则**：主 agent 不需要知道具体有哪些子 agent 以及它们的实现细节，只需要知道存在一个"任务工具"，可以接受 `subagent_type` 和 `description` 两个参数即可。这种松耦合设计使得添加新的子 agent 类型变得极为简单——只需创建新的 agent 实例并注册到 taskTool 中，无需修改主 agent 的任何逻辑。

### 关键数据结构

```go
type taskTool struct {
    subAgents     map[string]tool.InvokableTool  // 子 agent 注册表，键为 agent 名称
    subAgentSlice []adk.Agent                    // 子 agent 切片，用于生成工具描述
    descGen       func(ctx context.Context, subAgents []adk.Agent) (string, error)  // 描述生成器
}
```

这个结构体的设计体现了几个关键决策：首先，使用 map 存储子 agent 实现了 O(1) 时间复杂度的查找，这在 agent 调用频繁的场景下非常重要；其次，保留 `subAgentSlice` 是为了支持工具描述的动态生成，因为 map 的迭代顺序不确定，不适合用于生成稳定的描述文本；第三，描述生成器函数 `descGen` 是可替换的，这为自定义工具描述提供了扩展点。

```go
type taskToolArgument struct {
    SubagentType string `json:"subagent_type"`  // 指定要调用的子 agent 类型
    Description  string `json:"description"`    // 给子 agent 的具体任务描述
}
```

`taskToolArgument` 定义了调用任务工具时的参数结构。选择 `subagent_type` 和 `description` 两个字段而非更复杂的结构，体现了**最小接口原则**——主 agent 只需要告诉任务工具两件事：找哪个 agent 帮忙，以及具体要做什么。

## 核心组件详解

### newTaskTool 函数

```go
func newTaskTool(
    ctx context.Context,
    taskToolDescriptionGenerator func(ctx context.Context, subAgents []adk.Agent) (string, error),
    subAgents []adk.Agent,
    withoutGeneralSubAgent bool,
    Model model.ToolCallingChatModel,
    Instruction string,
    ToolsConfig adk.ToolsConfig,
    MaxIteration int,
    middlewares []adk.AgentMiddleware,
) (tool.InvokableTool, error)
```

这个函数是创建任务工具的工厂函数。它的职责不仅仅是构造 `taskTool` 实例，还包括初始化内置的"通用子 agent"。当 `withoutGeneralSubAgent` 为 false 时（默认值），函数会创建一个名为 `general-purpose` 的通用子 agent，这是一个配置完整的 `ChatModelAgent`，拥有主 agent 同款的模型、工具配置和指令，只是最大迭代次数被限制以防止无限循环。

这个设计体现了一个重要洞察：在实际使用中，用户定义的专用子 agent 可能无法覆盖所有任务场景。例如，一个专门用于代码搜索的 agent 无法处理"帮我写一首诗"这样的请求。通用子 agent 作为一个"万金油"角色，确保了系统的完备性——任何无法匹配到专用子 agent 的请求都会被路由到通用子 agent。

### Info 方法与动态描述生成

```go
func (t *taskTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
    desc, err := t.descGen(ctx, t.subAgentSlice)
    if err != nil {
        return nil, err
    }
    return &schema.ToolInfo{
        Name: taskToolName,  // 固定为 "task"
        Desc: desc,
        ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
            "subagent_type": { Type: schema.String },
            "description":   { Type: schema.String },
        }),
    }, nil
}
```

`Info` 方法是工具与模型交互的关键入口。当模型需要了解"这个工具是做什么的"时，会调用此方法获取工具的元信息。返回值中的 `Desc` 字段尤为重要——它告诉模型有哪些子 agent 可用以及各自的专长。默认的描述生成器 `defaultTaskToolDescription` 会遍历所有子 agent，提取其名称和描述，格式化为类似这样的文本：

```
Available agent types and the tools they have access to:
- code_search: agent for searching and reading code files
- file_editor: agent for creating and modifying files
- general-purpose: general-purpose agent for researching complex questions
```

这种描述生成方式确保了工具描述与实际注册的子 agent 保持同步——当你在配置中添加或移除子 agent 时，工具描述会自动更新，模型能够感知到这些变化。

### InvokableRun 方法与路由逻辑

```go
func (t *taskTool) InvokableRun(ctx context.Context, argumentsInJSON string, opts ...tool.Option) (string, error) {
    input := &taskToolArgument{}
    err := json.Unmarshal([]byte(argumentsInJSON), input)
    if err != nil {
        return "", fmt.Errorf("failed to unmarshal task tool input json: %w", err)
    }
    a, ok := t.subAgents[input.SubagentType]
    if !ok {
        return "", fmt.Errorf("subagent type %s not found", input.SubagentType)
    }

    params, err := sonic.MarshalString(map[string]string{
        "request": input.Description,
    })
    if err != nil {
        return "", err
    }

    return a.InvokableRun(ctx, params, opts...)
}
```

这是任务工具的核心执行逻辑。当模型决定调用任务工具时，会触发此方法。方法首先解析 JSON 参数，然后通过 map 查找对应的子 agent。如果找不到对应类型，会返回明确的错误信息而非静默失败——这是为了帮助调试，因为模型可能会尝试调用不存在的子 agent 类型。

找到子 agent 后，方法将 `description` 字段封装为 `request` 参数，调用子 agent 的 `InvokableRun` 方法。这里有一个隐含的契约：所有子 agent 都被包装为 `tool.InvokableTool`，且它们的输入参数都期望是包含 `request` 字段的 JSON。这个设计简化了子 agent 的实现——它们只需要处理一种输入格式即可。

### newTaskToolMiddleware 函数

```go
func newTaskToolMiddleware(...) (adk.AgentMiddleware, error) {
    t, err := newTaskTool(...)
    if err != nil {
        return adk.AgentMiddleware{}, err
    }
    return adk.AgentMiddleware{
        AdditionalInstruction: taskPrompt,
        AdditionalTools:       []tool.BaseTool{t},
    }, nil
}
```

这个函数将任务工具封装为 `AgentMiddleware`。`AgentMiddleware` 是 EINO 框架中的中间件抽象，可以在 agent 执行前后注入自定义逻辑。这里使用了中间件的两个特性：`AdditionalInstruction` 用于注入关于任务工具使用规范的提示词（来自 prompt.go 中的 `taskPrompt`），`AdditionalTools` 用于添加任务工具到 agent 的可用工具列表。

这种设计实现了**关注点分离**：任务工具的实现（taskTool 结构体）与如何将工具接入 agent（Middleware 模式）被清晰地区分开来。Middleware 模式还意味着可以在不修改核心逻辑的情况下添加多个工具——未来如果需要添加其他工具，只需创建新的 Middleware 并组合即可。

## 数据流分析

### 整体架构

从数据流的角度看，Deep Agent 的架构如下：

```
用户请求 → DeepAgent (主 Agent)
              ↓
         Task Tool Middleware
              ↓
         Task Tool (taskTool 实例)
              ↓
    ┌──────────┼──────────┐
    ↓          ↓          ↓
 CodeAgent  FileAgent  GeneralAgent
    ↓          ↓          ↓
 结果聚合 ← 子Agent执行 ←
```

当用户向 Deep Agent 发送请求时，主 agent（基于 ChatModelAgent）会进行推理。如果推理过程中需要调用工具，且模型决定使用"task"工具（因为 prompt 中已经注入了关于 task 工具的使用说明），则会触发以下调用链：

1. 模型输出包含调用 "task" 工具的意图，参数为 `{"subagent_type": "code_search", "description": "查找所有使用 UserService 的文件"}`
2. Agent 运行时调用 `taskTool.InvokableRun()`
3. `InvokableRun` 解析参数，从 map 中找到 "code_search" 对应的 agent
4. 将请求封装为 `{"request": "查找所有使用 UserService 的文件"}` 并调用子 agent
5. 子 agent 执行完毕后返回结果字符串
6. 主 agent 获得结果，继续推理并返回最终响应

### 与其他模块的关系

根据模块树结构，本模块位于 `adk_prebuilt_agents` -> `deep_agent_and_task_tooling` 之下。它的直接依赖方是 `deep.go` 中的 `New` 函数，该函数创建 Deep Agent 时会调用 `newTaskToolMiddleware`。间接地，任何使用 Deep Agent 的上层应用都会间接受到本模块的影响。

从调用链来看，本模块依赖以下核心抽象：
- `adk.Agent` - 子 agent 的接口定义
- `tool.InvokableTool` - 工具的可执行接口
- `model.ToolCallingChatModel` - 用于创建通用子 agent 的模型
- `schema.ToolInfo` - 工具元信息的 schema 定义

## 设计决策与权衡

### 选择 map 而非其他数据结构

代码使用 `map[string]tool.InvokableTool` 存储子 agent，这是一个时间空间权衡的结果。map 提供了 O(1) 的查找效率，对于频繁调用的工具来说至关重要。替代方案如切片+线性查找会在子 agent 数量增加时导致性能下降，而平衡二叉树或跳表虽然也支持 O(log n) 查找，但实现更复杂且常数因子更高。

代价是 map 不保证迭代顺序，这在生成工具描述时是个问题——每次生成的描述可能不同，可能导致模型的推理不稳定。解决方案是额外保留一个 `subAgentSlice` 字段用于描述生成，这是一种常见的"用空间换确定性"的设计模式。

### 通用子 agent 的必要性

代码默认创建一个"general-purpose"子 agent，即使没有显式配置任何子 agent。这个设计决策背后的理由是：专用子 agent 的集合无论如何都不可能覆盖所有可能的请求类型。想象用户让 agent"帮我查一下最新的 AI 研究论文"——如果没有匹配的专用子 agent，系统会陷入困境。通用子 agent 作为一个"后盾"，确保系统始终能够处理请求。

代价是这会增加系统的复杂度和资源消耗——每次创建 Deep Agent 都会额外创建一个通用子 agent 实例。对于明确知道自己不需要通用 agent 的用户，代码提供了 `WithoutGeneralSubAgent` 配置选项来禁用此行为。

### 同步调用模型

当前的 `InvokableRun` 是同步阻塞的——调用方会等待子 agent 完全执行完毕后才获得结果。这在大多数场景下是合理的，因为主 agent 需要子 agent 的结果才能继续推理。但对于可以并行执行的独立任务，这种模型无法充分利用并发能力。

一个可能的改进方向是支持异步调用：主 agent 可以同时启动多个子 agent，等待所有结果后再进行聚合。但当前设计选择保持简单——如果需要并行，用户可以在 prompt 中明确要求模型分批调用任务工具（prompt 中确实提到了"Launch multiple agents concurrently whenever possible"）。

## 使用指南与最佳实践

### 基本使用方式

```go
// 创建子 agent
codeAgent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:        "code_search",
    Description: "agent for searching and reading code files",
    // ... 其他配置
})

// 创建 Deep Agent（会自动创建任务工具）
deepAgent, err := deep.New(ctx, &deep.Config{
    Name:        "my-deep-agent",
    ChatModel:   myModel,
    SubAgents:   []adk.Agent{codeAgent},
    // 不需要手动添加任务工具，deep.New 会自动处理
})
```

### 自定义工具描述

如果默认的工具描述格式不满足需求，可以提供自定义的描述生成器：

```go
deepAgent, err := deep.New(ctx, &deep.Config{
    // ...
    TaskToolDescriptionGenerator: func(ctx context.Context, agents []adk.Agent) (string, error) {
        // 自定义描述生成逻辑
        return "Custom description for task tool...", nil
    },
})
```

### 禁用通用子 agent

```go
deepAgent, err := deep.New(ctx, &deep.Config{
    // ...
    WithoutGeneralSubAgent: true,  // 禁用通用子 agent
    SubAgents:              []adk.Agent{codeAgent, fileAgent},
})
```

## 注意事项与潜在陷阱

### 子 agent 命名冲突

由于子 agent 通过 map 的键（agent 名称）进行路由，**不允许出现同名的子 agent**。如果创建两个同名的 agent，后创建的一个会覆盖前面的，这在调试时可能会导致意外行为。建议在配置子 agent 时使用有意义的、唯一的名称。

### 描述生成器的错误处理

`Info` 方法调用 `descGen` 时可能返回错误（例如子 agent 的描述字段为空导致格式化失败）。调用方需要正确处理这种错误，否则可能导致工具信息获取失败。在生产环境中，建议确保所有子 agent 都有非空的名称和描述。

### 输入参数验证

当前实现对输入参数的处理相对简单：如果 JSON 解析失败会返回错误，如果找不到对应的 subagent_type 也会返回错误。这意味着**模型需要准确地知道可用的子 agent 类型**。如果模型猜测了一个不存在的类型，用户会看到 "subagent type xxx not found" 这样的错误信息。优化方向可能包括：在工具描述中更明确地列出可用类型，或在找不到类型时提供更友好的错误提示（比如建议最接近的可用类型）。

### 资源清理

由于子 agent 可能是长期运行的实体，当主 agent 关闭时，需要确保子 agent 的资源也被正确释放。当前实现没有显式的资源清理逻辑，这依赖于 Go 的垃圾回收机制。对于生产环境中的长期运行服务，建议监控子 agent 的资源使用情况，避免资源泄漏。

## 相关模块参考

- [deep.go](deep.md) - Deep Agent 的主入口，展示了如何组合任务工具与其他组件
- [deep-agent-configuration-and-todo-schema](deep-agent-configuration-and-todo-schema.md) - Deep Agent 的配置结构与 TODO 管理
- [agent_contracts_and_context](agent_contracts_and_context.md) - Agent 核心接口与上下文管理
- [tool_contracts_and_options](tool_contracts_and_options.md) - 工具接口定义与配置选项