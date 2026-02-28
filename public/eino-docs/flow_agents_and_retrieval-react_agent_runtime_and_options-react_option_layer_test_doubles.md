# React Option Layer Test Doubles 技术深潜

## 1. 为什么存在这个模块？

在开发 React Agent 运行时的过程中，我们需要一种可靠的方式来测试 Agent 的选项系统、消息流和中间件行为，而不依赖于真实的外部服务或复杂的实现。这个模块提供了一套专门为测试 React Agent 选项层设计的测试替身（Test Doubles）和测试工具。

### 问题背景

想象一下：你正在开发一个复杂的 Agent 系统，它有多个可配置选项（如工具选项、模型选项、消息未来等），这些选项会影响 Agent 的行为。你需要验证：
1. 工具选项是否正确传递给了工具
2. 模型选项是否被模型正确接收
3. 消息未来是否能正确捕获完整的消息历史
4. 中间件是否能正确修改工具调用结果

直接使用真实的工具和模型会带来几个问题：
- 测试速度慢（依赖外部服务）
- 测试不稳定（外部服务可能不可用）
- 难以模拟特定场景（如错误、特定响应）
- 难以验证内部状态和交互

### 设计洞察

这个模块采用了测试替身模式，通过提供可控的、可断言的工具和模型实现，让我们能够：
1. **精确控制测试输入和输出**
2. **验证内部交互是否符合预期**
3. **隔离被测组件**
4. **快速、稳定地运行测试**

## 2. 核心概念与心智模型

### 主要抽象

这个模块围绕几个核心测试替身构建：

1. **dummyBaseTool** - 最基础的工具实现，仅提供必要的方法骨架
2. **assertTool** - 可断言的工具，能验证是否接收到了特定的选项
3. **simpleToolForMiddlewareTest** - 用于中间件测试的工具，支持可配置的输入输出
4. **toolOpt** - 简单的工具选项结构，用于测试选项传递

### 心智模型

把这个模块想象成一个"测试实验室"：
- **dummyBaseTool** 是实验室里的"空白样本" - 它能工作，但没有特殊行为
- **assertTool** 是"检测设备" - 它能告诉你实验条件（选项）是否正确
- **simpleToolForMiddlewareTest** 是"可变样本" - 你可以精确控制它的输入和输出
- **toolOpt** 是"实验变量" - 你可以改变它来观察系统的反应

### 数据流概览

当测试运行时，数据流程通常是：
```
测试代码 → Agent选项 → React Agent → 测试工具/模型 → 断言验证
```

## 3. 组件深度解析

### dummyBaseTool

这是一个最小化的 `tool.BaseTool` 实现，用于测试场景中只需要一个"存在"的工具，而不需要特定行为的情况。

```go
type dummyBaseTool struct{}

func (d *dummyBaseTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
    return &schema.ToolInfo{Name: "dummy"}, nil
}

func (d *dummyBaseTool) InvokableRun(ctx context.Context, _ string, _ ...tool.Option) (string, error) {
    return "dummy-response", nil
}
```

**设计意图**：提供一个无副作用、可预测的工具实现，用于填充工具列表或验证基本的工具调用流程。它不做任何复杂的事情，只是返回固定的响应。

### assertTool

这是一个更复杂的测试工具，专门用于验证工具选项是否正确传递。

```go
type assertTool struct {
    toolOptVal      string
    receivedToolOpt bool
}
type toolOpt struct{ val string }

func (a *assertTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
    return &schema.ToolInfo{Name: "assert_tool"}, nil
}
func (a *assertTool) InvokableRun(ctx context.Context, argumentsInJSON string, opts ...tool.Option) (string, error) {
    opt := tool.GetImplSpecificOptions(&toolOpt{}, opts...)
    if opt.val == a.toolOptVal {
        a.receivedToolOpt = true
    }
    return "tool-response", nil
}
```

**内部机制**：
- 它维护一个预期的工具选项值 `toolOptVal`
- 在 `InvokableRun` 方法中，它检查接收到的选项是否与预期值匹配
- 如果匹配，设置 `receivedToolOpt` 标志为 true

**设计意图**：这是一个"测试间谍"（Test Spy），用于验证 Agent 是否正确地将工具选项传递给了工具。通过检查 `receivedToolOpt` 标志，测试可以确认选项传递机制是否正常工作。

### simpleToolForMiddlewareTest

这个工具专门用于测试工具中间件的行为，支持同步和异步两种调用模式。

```go
type simpleToolForMiddlewareTest struct {
    name   string
    result string
}

func (s *simpleToolForMiddlewareTest) Info(_ context.Context) (*schema.ToolInfo, error) {
    return &schema.ToolInfo{
        Name: s.name,
        Desc: "simple tool for middleware test",
        ParamsOneOf: schema.NewParamsOneOfByParams(
            map[string]*schema.ParameterInfo{
                "input": {
                    Desc:     "input",
                    Required: true,
                    Type:     schema.String,
                },
            }),
    }, nil
}

func (s *simpleToolForMiddlewareTest) InvokableRun(_ context.Context, _ string, _ ...tool.Option) (string, error) {
    return s.result, nil
}

func (s *simpleToolForMiddlewareTest) StreamableRun(_ context.Context, _ string, _ ...tool.Option) (*schema.StreamReader[string], error) {
    return schema.StreamReaderFromArray([]string{s.result}), nil
}
```

**设计意图**：
- 提供可配置的工具名称和结果，使测试更加灵活
- 同时实现 `InvokableRun` 和 `StreamableRun`，支持测试同步和异步两种场景
- 定义了明确的参数结构，使工具调用更加真实

这个工具在 `TestMessageFuture_ToolResultMiddleware_EmitsFinalResult` 测试中发挥了关键作用，用于验证中间件是否能正确修改工具结果。

## 4. 依赖分析

### 输入依赖

这个测试模块依赖于几个关键组件：
1. **React Agent** - 被测系统，通过 `NewAgent` 创建
2. **Tool Contract** - 定义工具接口的契约，测试替身实现这些接口
3. **Schema** - 定义消息和工具信息的数据结构
4. **Compose** - 提供中间件和工具节点配置
5. **Mock Model** - 模拟的聊天模型，用于测试不依赖真实模型

### 输出依赖

测试代码使用 `github.com/stretchr/testify/assert` 进行断言，这是一个常见的 Go 测试断言库。

### 数据流

在典型的测试场景中，数据流如下：
1. 测试设置创建测试替身工具和模拟模型
2. 创建 Agent 时配置这些测试替身
3. 调用 Agent 的 Generate 或 Stream 方法
4. Agent 内部调用测试工具和模拟模型
5. 测试替身记录交互和状态
6. 测试代码通过断言验证行为是否符合预期

## 5. 设计决策与权衡

### 决策1：专注于测试选项层，而不是完整的 Agent 行为

**选择**：这个模块的测试替身专门设计用于测试选项传递和消息流，而不是完整的 Agent 推理能力。

**原因**：
- 分离关注点：选项层的测试不需要复杂的推理逻辑
- 提高测试速度：避免了处理真实模型的复杂性
- 增强测试可靠性：不依赖外部服务

**权衡**：
- 优点：测试快速、可靠、专注
- 缺点：不能替代端到端测试，需要与其他测试配合使用

### 决策2：提供多种测试替身，各有专长

**选择**：不是创建一个"万能"的测试工具，而是提供多个专门的测试替身。

**原因**：
- 单一职责：每个测试替身只做一件事，但做得很好
- 易于理解：测试代码更加清晰，意图更明确
- 灵活性：可以根据测试需要组合使用不同的测试替身

**权衡**：
- 优点：代码清晰、职责明确、易于维护
- 缺点：需要管理多个测试替身类，可能会有一些重复代码

### 决策3：测试替身实现完整的接口，但只关注必要的行为

**选择**：测试替身实现了完整的 `tool.BaseTool` 接口，但对于不关心的方法，只提供最小化的实现。

**原因**：
- 接口兼容性：确保测试替身可以在任何需要 `tool.BaseTool` 的地方使用
- 简化实现：不需要为不关心的方法编写复杂逻辑
- 聚焦测试：只实现与当前测试相关的功能

**权衡**：
- 优点：实现简单，接口兼容
- 缺点：如果测试范围扩大，可能需要扩展测试替身的实现

## 6. 使用示例与最佳实践

### 验证工具选项传递

使用 `assertTool` 验证 Agent 是否正确传递工具选项：

```go
// 准备工具和选项
toolOptVal := "tool-opt-value"
to := tool.WrapImplSpecificOptFn(func(o *toolOpt) { o.val = toolOptVal })
at := &assertTool{toolOptVal: toolOptVal}

// 创建 Agent 并调用
agentOpt := WithToolOptions(to)
a, err := NewAgent(ctx, &AgentConfig{...})
_, err = a.Generate(ctx, []*schema.Message{...}, agentOpt)

// 验证选项是否被正确接收
assert.True(t, at.receivedToolOpt, "tool option should be received by tool")
```

### 测试中间件对工具结果的修改

使用 `simpleToolForMiddlewareTest` 测试中间件：

```go
// 准备工具和中间件
originalResult := "original_result"
modifiedResult := "modified_by_middleware"
testTool := &simpleToolForMiddlewareTest{name: "test_tool", result: originalResult}

resultModifyingMiddleware := compose.ToolMiddleware{
    Invokable: func(next compose.InvokableToolEndpoint) compose.InvokableToolEndpoint {
        return func(ctx context.Context, input *compose.ToolInput) (*compose.ToolOutput, error) {
            output, err := next(ctx, input)
            if err != nil {
                return nil, err
            }
            output.Result = modifiedResult  // 修改结果
            return output, nil
        }
    },
}

// 创建 Agent 并配置中间件
a, err := NewAgent(ctx, &AgentConfig{
    ToolsConfig: compose.ToolsNodeConfig{
        Tools:               []tool.BaseTool{testTool},
        ToolCallMiddlewares: []compose.ToolMiddleware{resultModifyingMiddleware},
    },
})

// 验证中间件是否生效
// 检查消息未来中的工具结果是否为 modifiedResult
```

## 7. 边缘情况与注意事项

### 注意事项1：测试替身的状态管理

一些测试替身（如 `assertTool`）是有状态的，这意味着：
- 不要在多个测试之间共享同一个测试替身实例
- 如果在同一个测试中多次调用工具，状态可能会被覆盖

**最佳实践**：为每个测试用例创建新的测试替身实例。

### 注意事项2：消息未来的行为取决于调用模式

`MessageFuture` 的行为取决于你使用的是 `Generate` 还是 `Stream` 方法：
- 使用 `Generate` 时，通过 `GetMessages()` 获取完整消息
- 使用 `Stream` 时，通过 `GetMessageStreams()` 获取消息流

**常见陷阱**：在使用 `Stream` 方法后尝试调用 `GetMessages()`，会导致没有消息返回。

### 注意事项3：中间件测试需要同时覆盖同步和异步情况

工具中间件可能会以同步或异步方式调用，因此测试时需要：
- 同时测试 `Invokable` 和 `Streamable` 中间件
- 使用 `simpleToolForMiddlewareTest` 这样同时支持两种模式的测试工具

## 8. 相关模块参考

- [React Agent Core Runtime](flow_agents_and_retrieval-react_agent_runtime_and_options-react_agent_core_runtime.md) - React Agent 的核心运行时实现
- [React Option Streaming and Callback Contracts](flow_agents_and_retrieval-react_agent_runtime_and_options-react_option_streaming_and_callback_contracts.md) - 选项、流和回调的契约定义
- [React Agent Test Tool Fixtures](flow_agents_and_retrieval-react_agent_runtime_and_options-react_agent_test_tool_fixtures.md) - 更多 React Agent 测试工具
