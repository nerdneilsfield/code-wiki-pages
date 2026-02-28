# task_tool_test_agent_stub 模块技术深度解析

## 模块概述

`task_tool_test_agent_stub` 模块是 ADK 框架中 Deep Agent 预置代理的测试基础设施，位于 `adk/prebuilt/deep/task_tool_test.go` 文件中。该模块的核心功能是为 **TaskTool**（任务工具）组件提供轻量级的测试替身（test stub），使得开发者能够在无需构建完整真实 Agent 实现的情况下验证 TaskTool 的核心逻辑。

想象一下这样的场景：你正在开发一个调度中心，这个调度中心需要根据不同的任务类型分发请求给相应的专家处理。在真实上线前，你需要测试调度逻辑是否正确——但你不可能为每个专家都招聘一个真实的人来测试。`myAgent` 结构体就像是这些专家的"模拟替身"，它们的行为完全可控，返回确定性的结果，非常适合单元测试和集成测试。

## 架构角色定位

### 在系统中的位置

```
adk_prebuilt_agents
    └── deep_agent_and_task_tooling
            ├── task_tool_definition        # TaskTool 核心实现
            ├── task_tool_test_agent_stub   # ← 当前模块（测试替身）
            ├── deep_agent_configuration    # Deep Agent 配置
            └── deep_agent_test_harnesses   # 测试线束
```

该模块处于 `deep_agent_and_task_tooling` 功能组的末端，专门为 TaskTool 的测试提供支持。TaskTool 是 Deep Agent 架构中的关键组件，它允许主 Agent 根据用户请求动态选择并调用合适的子 Agent（SubAgent），实现任务的委派和协同处理。

### 核心职责

1. **提供最小化 Agent 接口实现**：创建一个符合 `adk.Agent` 接口的最小化结构体，仅包含测试所需的最少逻辑
2. **支持多子Agent测试场景**：允许创建多个独立配置的 Agent 实例，模拟 TaskTool 管理多个子 Agent 的场景
3. **验证 TaskTool 核心流程**：覆盖 TaskTool 的工具描述生成（Info 方法）和调用分发（InvokableRun 方法）两个核心路径

## 核心组件详解

### myAgent 结构体

```go
type myAgent struct {
    name string
    desc string
}
```

**设计意图**：`myAgent` 是一个极简的 Agent 测试替身，仅包含两个字段——`name`（名称）和 `desc`（描述）。这种设计遵循了测试替身模式的核心原则：用最少的实现满足接口契约，避免引入不必要的复杂性。

**字段说明**：
- `name`：子 Agent 的标识符，TaskTool 根据这个名称来路由请求
- `desc`：子 Agent 的描述信息，用于生成 TaskTool 的工具描述文档

### 方法实现分析

#### Name 方法

```go
func (m *myAgent) Name(ctx context.Context) string {
    return m.name
}
```

这是 `adk.Agent` 接口要求的方法之一。在 TaskTool 的实现中（参见 [task_tool_definition](adk-prebuilt-deep-task-tool-definition.md)），子 Agent 的名称被用作路由键。当用户调用 TaskTool 并指定 `subagent_type` 参数时，TaskTool 会在内部映射表中查找对应的 Agent 并转发请求。这个方法的存在使得测试可以精确控制路由行为。

#### Description 方法

```go
func (m *myAgent) Description(ctx context.Context) string {
    return m.desc
}
```

同样实现了 `adk.Agent` 接口。这个描述信息会被 `defaultTaskToolDescription` 函数收集，用于动态生成 TaskTool 的工具描述。查看 task_tool.go 中的实现：

```go
func defaultTaskToolDescription(ctx context.Context, subAgents []adk.Agent) (string, error) {
    subAgentsDescBuilder := strings.Builder{}
    for _, a := range subAgents {
        name := a.Name(ctx)
        desc := a.Description(ctx)
        subAgentsDescBuilder.WriteString(fmt.Sprintf("- %s: %s\n", name, desc))
    }
    // ... 生成完整的工具描述
}
```

这意味着测试中设置的 `desc` 值会直接影响 TaskTool 描述文档的内容，测试用例通过验证描述中是否包含特定字符串来确认描述生成逻辑的正确性。

#### Run 方法

```go
func (m *myAgent) Run(ctx context.Context, input *adk.AgentInput, options ...adk.AgentRunOption) *adk.AsyncIterator[*adk.AgentEvent] {
    iter, gen := adk.NewAsyncIteratorPair[*adk.AgentEvent]()
    gen.Send(adk.EventFromMessage(schema.UserMessage(m.desc), nil, schema.User, ""))
    gen.Close()
    return iter
}
```

这是三个方法中最复杂的一个，也是理解整个测试设计的关键。让我逐步解析：

1. **使用 AsyncIteratorPair 创建异步迭代器对**：这是 ADK 框架中处理异步事件流的标准模式。`NewAsyncIteratorPair` 返回一个迭代器和一个生成器，它们共享同一个底层无界通道。这种模式类似于 Go 语言的 channel，但提供了更友好的 API。

2. **生成确定性的响应事件**：测试替身总是返回包含其 `desc` 字段内容的用户消息事件。这是一种**行为仿真**——将 Agent 的"身份描述"作为响应返回，使得测试可以轻易验证请求是否被路由到了正确的 Agent。

3. **立即关闭生成器**：因为这是一个同步且确定性的测试实现，不需要流式输出，所以立即调用 `gen.Close()` 关闭通道。这确保迭代器在下次调用 `Next()` 时返回 `(nil, false)`，表示流已结束。

### TestTaskTool 测试用例

```go
func TestTaskTool(t *testing.T) {
    a1 := &myAgent{name: "1", desc: "desc of my agent 1"}
    a2 := &myAgent{name: "2", desc: "desc of my agent 2"}
    ctx := context.Background()
    tt, err := newTaskTool(
        ctx,
        nil,
        []adk.Agent{a1, a2},
        true,
        nil,
        "",
        adk.ToolsConfig{},
        10,
        nil,
    )
    // ... 验证逻辑
}
```

**测试覆盖的两个核心场景**：

1. **工具信息描述生成（Info 方法）**：
   - 创建包含两个子 Agent 的 TaskTool
   - 调用 `tt.Info(ctx)` 获取工具描述
   - 断言描述中包含子 Agent 的描述信息
   
   这个测试验证了动态描述生成逻辑是否正确收集了所有子 Agent 的信息。

2. **任务路由分发（InvokableRun 方法）**：
   - 分别用不同的 `subagent_type` 参数调用 `InvokableRun`
   - 验证请求被正确路由到对应的 Agent
   - 确认响应内容与被选中 Agent 的描述一致
   
   这是 TaskTool 最核心的功能——根据用户指定的子 Agent 类型，将请求分发到正确的处理者。

**参数解析**：
- `withoutGeneralSubAgent = true`：禁用了通用子 Agent（general-purpose），只保留测试中显式创建的两个子 Agent
- `nil` 位置的参数：分别对应 `taskToolDescriptionGenerator`（使用默认描述生成器）、`Model`（无模型配置）、`Instruction`（空指令）、`middlewares`（无中间件）

## 数据流分析

### TaskTool 创建时的数据流

```
newTaskTool() 调用
    │
    ├── 遍历 subAgents 列表
    │       │
    │       └── 对每个 Agent 调用 adk.NewAgentTool(ctx, agent)
    │               │
    │               └── 转换为 tool.InvokableTool 接口
    │
    └── 构建 subAgents 映射表 (map[name]tool.InvokableTool)
```

在 `task_tool.go` 中可以看到这个转换过程：

```go
for _, a := range subAgents {
    name := a.Name(ctx)
    it, err := assertAgentTool(adk.NewAgentTool(ctx, a))
    if err != nil {
        return nil, err
    }
    t.subAgents[name] = it
}
```

这里的 `adk.NewAgentTool` 是关键——它将任何实现 `adk.Agent` 接口的对象包装成 `tool.BaseTool`，使得 Agent 可以被当作工具来调用。

### TaskTool 调用时的数据流

```
调用方请求
    │
    ├── InvokableRun(argumentsJSON)
    │       │
    │       └── 解析 JSON: {"subagent_type": "1", "description": "..."}
    │               │
    │               └── 查找 subAgents["1"]
    │                       │
    │                       └── 调用该 Agent 的 InvokableRun
    │                               │
    │                               └── 返回 Agent.Run() 的结果
```

这个设计实现了**代理模式（Proxy Pattern）**：TaskTool 作为一个智能代理，根据请求中的 `subagent_type` 字段动态选择合适的子 Agent 进行处理。

## 设计决策与权衡

### 1. 轻量级 vs 功能完整

**选择**：采用极简的测试替身，不实现完整的 Agent 能力

**考量**：TaskTool 测试只需要验证路由逻辑，不需要完整的 LLM 调用、工具使用、多轮对话等复杂功能。如果使用真实 Agent 实现，测试将变得：
- 缓慢（每次测试都需要调用模型）
- 不稳定（模型输出不可预测）
- 难以调试（问题可能在模型层面而非 TaskTool 逻辑）

这种权衡在测试分层中很常见——单元测试应该关注被测组件的逻辑，而非其依赖项的行为。

### 2. 确定性输出

**选择**：myAgent 始终返回包含其描述的消息作为响应

**考量**：测试的可重复性是单元测试的核心原则。通过让每个 myAgent 返回其 `desc` 字段，测试可以精确验证：
- 请求是否路由到了预期的 Agent（通过检查响应来源）
- 响应内容是否符合预期

这种设计类似于**标记注入**技术——在测试数据中嵌入可验证的标记，运行时检查这些标记以确认正确的执行路径。

### 3. 同步 vs 异步处理

**选择**：Run 方法立即返回并关闭生成器，不使用真正的异步流

**考量**：虽然 `adk.Agent` 接口要求返回异步迭代器，但测试场景下不需要真正的异步行为。这种"伪异步"实现：
- 保持了接口兼容性
- 简化了测试逻辑
- 避免了异步测试的复杂性（如 goroutine 泄漏检测、时序问题等）

### 4. 硬编码通道容量

**选择**：使用 `internal.NewUnboundedChan[T]()` 创建无界通道

**考量**：这确保了同步发送不会阻塞——即使生成器在迭代器消费之前发送所有数据也不会出现问题。在测试场景中，这种容错设计可以避免因时序导致的偶发失败。

## 使用指南与扩展

### 如何编写基于 myAgent 的测试

如果你需要扩展测试覆盖，可以参考以下模式：

```go
// 创建具有特定行为的测试 Agent
customAgent := &myAgent{
    name: "custom",
    desc: "I am a custom agent for specific tasks",
}

// 创建 TaskTool 时传入
tt, err := newTaskTool(ctx, nil, []adk.Agent{customAgent}, true, nil, "", adk.ToolsConfig{}, 10, nil)

// 验证自定义行为
result, err := tt.InvokableRun(ctx, `{"subagent_type":"custom","description":"test input"}`)
```

### 注意事项

1. **不要在生产代码中使用 myAgent**：这是一个纯测试用途的类型，没有任何生产环境的优化和错误处理。

2. **名称唯一性**：确保同一个 TaskTool 中的各个 myAgent 具有唯一的名称，否则在 `subAgents` 映射表中会发生键冲突（后者覆盖前者）。

3. **描述内容验证**：由于描述会被用于生成 TaskTool 的工具文档，应避免在描述中使用可能干扰解析的特殊字符。

## 相关模块参考

- [task_tool_definition](deep-agent-and-task-tooling-task-tool-definition.md)：TaskTool 的核心实现，了解其如何管理子 Agent 映射和请求分发
- [deep_agent_configuration_and_todo_schema](adk_prebuilt_agents-deep_agent_configuration_and_todo_schema.md)：Deep Agent 的完整配置，了解 SubAgents 如何被整合到完整 Agent 中
- [adk_interface](adk-interface.md)：Agent 接口的完整定义，包括 Run、Name、Description 三个核心方法
- [adk_agent_tool](adk-agent-tool.md)：了解 Agent 如何被转换为可调用的工具

## 总结

`task_tool_test_agent_stub` 模块是 ADK 框架测试基础设施的一个缩影——它用最少的代码实现了最大的测试价值。通过提供一个符合接口契约的轻量级替身，开发者可以在不依赖外部系统（如 LLM）的情况下验证核心业务逻辑。这种设计思想贯穿整个 ADK 框架：清晰的接口定义、依赖注入、测试分层。对于新加入团队的开发者而言，理解这种测试替身模式有助于更好地维护现有测试，并在需要时编写新的测试用例。