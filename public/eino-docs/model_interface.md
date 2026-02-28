# model_interface 子模块

> 本文档详细解释 `model_interfaces_and_options` 模块中的接口定义部分，包括 `BaseChatModel`、`ToolCallingChatModel` 和已废弃的 `ChatModel` 接口。

## 1. 接口设计理念

在软件架构中，接口是**契约**——它定义了"做什么"而不是"怎么做"。对于 LLM 组件来说，这个模块要回答的核心问题是：

> **"无论底层是 GPT-4 还是 Claude，也无论是本地部署还是云端 API，上层代码都应该用统一的方式调用模型。"**

这种设计思路遵循了**依赖倒置原则（Dependency Inversion Principle）**：高层模块（Agent、Chain）不应该依赖低层模块（具体模型实现），而应该依赖抽象接口。

## 2. 核心接口详解

### 2.1 BaseChatModel —— 基础对话接口

```go
type BaseChatModel interface {
    Generate(ctx context.Context, input []*schema.Message, opts ...Option) (*schema.Message, error)
    Stream(ctx context.Context, input []*schema.Message, opts ...Option) (*schema.StreamReader[*schema.Message], error)
}
```

**设计意图：**

`BaseChatModel` 是整个模块的基石，它定义了任何聊天模型都必须具备的**两种输出模式**：

| 方法 | 适用场景 | 返回值 |
|------|----------|--------|
| `Generate` | 一次性完整输出 | `*schema.Message` - 完整的对话响应 |
| `Stream` | 流式输出 | `*schema.StreamReader[*schema.Message]` - 流式响应读取器 |

**参数说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `ctx` | `context.Context` | 请求上下文，用于超时控制、取消等 |
| `input` | `[]*schema.Message` | 输入消息列表，通常包含系统提示、历史对话和最新用户输入 |
| `opts` | `...Option` | 可变参数，支持零个或多个函数式选项 |

**返回值的语义：**

- 成功时返回包含模型回复的 `*schema.Message`
- 失败时返回 `error`，具体的错误类型由实现定义

**思考点：** 为什么 input 是切片而非单条消息？

因为对话上下文需要包含历史消息。典型的 input 结构如下：

```go
input := []*schema.Message{
    schema.SystemMessage("你是一个有帮助的助手"),  // 系统提示
    schema.UserMessage("请帮我总结这篇文章"),        // 历史对话
    schema.AssistantMessage("好的，请提供文章内容"), // AI 回复
    schema.UserMessage("文章内容是..."),            // 最新输入
}
```

### 2.2 ToolCallingChatModel —— 工具调用接口

```go
type ToolCallingChatModel interface {
    BaseChatModel
    WithTools(tools []*schema.ToolInfo) (ToolCallingChatModel, error)
}
```

**设计意图：**

现代 LLM 的核心能力之一是**函数调用（Function Calling）**或**工具调用（Tool Calling）**——让模型能够主动调用外部函数来完成特定任务，比如查询数据库、调用第三方 API、执行计算等。

`ToolCallingChatModel` 扩展了 `BaseChatModel`，增加了工具绑定的能力。

**为什么用 `WithTools` 而不是 `BindTools`？**

这是本模块最重要的设计决策之一。让我们对比两种方式：

```go
// ❌ 已废弃的方式：BindTools（可变状态）
type OldChatModel interface {
    BaseChatModel
    BindTools(tools []*schema.ToolInfo) error  // 修改实例状态
}

// ✅ 推荐的方式：WithTools（不可变）
type ToolCallingChatModel interface {
    BaseChatModel
    WithTools(tools []*schema.ToolInfo) (ToolCallingChatModel, error)  // 返回新实例
}
```

**并发安全问题分析：**

```
场景：多个 goroutine 同时使用同一个模型实例

使用 BindTools 的问题：
┌─────────────────────────────────────────────────────────────┐
│  Goroutine A                    Goroutine B                 │
│  ───────────                    ───────────                 │
│  model.BindTools([tool_A])                                    │
│       ↓                                                        │
│  [正在进行绑定...]              model.Generate(ctx, msgs)    │
│       ↓                      使用 [tool_B]（旧状态！）        │
│  model.tools = [tool_A]                                       │
│  [覆盖为 tool_A]           ← 结果：B 使用了错误的工具集      │
└─────────────────────────────────────────────────────────────┘

使用 WithTools 的解决：
┌─────────────────────────────────────────────────────────────┐
│  Goroutine A                    Goroutine B                 │
│  ───────────                    ───────────                 │
│  modelA := model.WithTools([tool_A])  modelB := model.WithTools([tool_B]) │
│       ↓                              ↓                       │
│  modelA.Generate(...)          modelB.Generate(...)         │
│       ↓                              ↓                       │
│  [独立的工具集]                [独立的工具集]                │
│       ↓                              ↓                       │
│  ✅ 安全！                     ✅ 安全！                     │
└─────────────────────────────────────────────────────────────┘
```

**WithTools 的语义：**

1. **不修改原实例**：调用 `model.WithTools(...)` 不会改变原始 `model` 对象
2. **返回新实例**：返回一个绑定了工具的新 `ToolCallingChatModel` 实例
3. **错误处理**：如果工具绑定失败（例如参数格式错误），返回 error

```go
// 使用示例
model, _ := openai.NewChatModel(...)
modelWithTools, _ := model.WithTools(myTools)

response, err := modelWithTools.Generate(ctx, messages)
// response 现在可以包含工具调用请求
```

### 2.3 ChatModel —— 已废弃接口

```go
// Deprecated: Please use ToolCallingChatModel interface instead
type ChatModel interface {
    BaseChatModel
    BindTools(tools []*schema.ToolInfo) error
}
```

**为什么废弃？**

`ChatModel` 接口使用 `BindTools` 方法，这存在以下问题：

1. **非原子性**：在 `BindTools` 执行过程中调用 `Generate`，会导致使用不一致的工具集
2. **竞态条件**：多线程并发调用时存在数据竞争
3. **状态污染**：同一个实例在不同时刻可能处于不同的工具配置状态

**迁移指南：**

如果你还在使用 `ChatModel` 接口，请尽快迁移到 `ToolCallingChatModel`：

```go
// ❌ 旧代码（已废弃）
type MyModel struct { ... }
func (m *MyModel) BindTools(tools []*schema.ToolInfo) error { ... }

// ✅ 新代码
type MyModel struct { ... }
func (m *MyModel) WithTools(tools []*schema.ToolInfo) (ToolCallingChatModel, error) { ... }
```

## 3. 接口的实现约定

如果你要实现一个新的模型适配器（例如接入新的 LLM 提供商），需要遵循以下约定：

### 3.1 必须实现的方法

```go
// 必须实现 BaseChatModel 的两个方法
func (m *MyModel) Generate(ctx context.Context, input []*schema.Message, opts ...Option) (*schema.Message, error)
func (m *MyModel) Stream(ctx context.Context, input []*schema.Message, opts ...Option) (*schema.StreamReader[*schema.Message], error)

// 如果支持工具调用，还需要实现
func (m *MyModel) WithTools(tools []*schema.ToolInfo) (ToolCallingChatModel, error)
```

### 3.2 选项的处理

在实现 `Generate` 或 `Stream` 时，需要解析传入的选项：

```go
func (m *MyModel) Generate(ctx context.Context, input []*schema.Message, opts ...Option) (*schema.Message, error) {
    // 1. 提取通用选项
    commonOpts := model.GetCommonOptions(nil, opts...)
    
    // 2. 提取厂商特定选项（如果有）
    myOpts := model.GetImplSpecificOptions(&MyModelOptions{}, opts...)
    
    // 3. 应用选项到请求
    req := &Request{
        Model:       commonOpts.Model,
        Temperature: commonOpts.Temperature,
        MaxTokens:   commonOpts.MaxTokens,
        // ... 其他参数
    }
    
    // 4. 调用底层 API
    return m.doGenerate(ctx, input, req)
}
```

### 3.3 错误处理约定

- 返回 `context.DeadlineExceeded` 表示超时
- 返回 `context.Canceled` 表示取消
- 其他错误使用标准的 Go error 包装

## 4. 依赖分析

### 4.1 被谁依赖

这个接口被框架中几乎所有需要调用 LLM 的模块使用：

| 上游模块 | 使用方式 |
|----------|----------|
| `adk/chatmodel.go` | Agent 配置时注入模型 |
| `compose/chain.go` | Chain 节点调用模型 |
| `adk/retry_chatmodel.go` | 包装模型实现重试逻辑 |

### 4.1 依赖谁

接口本身不依赖具体实现，但依赖以下类型：

| 依赖类型 | 来源 | 用途 |
|----------|------|------|
| `schema.Message` | schema 包 | 输入输出消息格式 |
| `schema.ToolInfo` | schema 包 | 工具定义 |
| `schema.StreamReader` | schema 包 | 流式响应读取 |
| `Option` | model 包 | 配置选项 |

## 5. 实际使用示例

### 5.1 在 Agent 中使用

```go
// 创建 Agent 时注入模型
agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:        "my_agent",
    Description: "A helpful assistant",
    Model:       myModel,  // 任何实现了 ToolCallingChatModel 的实例
    // ...
})
```

### 5.2 在 Chain 中使用

```go
// 构建一个简单的 LLM Chain
chain := compose.NewChain[string, string]().
    AppendChatTemplate(template).
    AppendChatModel(myModel).  // 任何实现了 BaseChatModel 的实例
    AppendOutputParser(parser)

compiled, _ := chain.Compile(ctx)
result, _ := compiled.Invoke(ctx, "hello")
```

### 5.3 动态切换工具

```go
// 场景：根据用户意图动态选择工具集

func handleRequest(ctx context.Context, model ToolCallingChatModel, intent string) {
    var tools []*schema.ToolInfo
    
    switch intent {
    case "search":
        tools = []*schema.ToolInfo{webSearchTool, webBrowseTool}
    case "calculate":
        tools = []*schema.ToolInfo{calculatorTool}
    default:
        tools = nil
    }
    
    // 创建带有特定工具的模型实例
    modelWithTools, err := model.WithTools(tools)
    if err != nil {
        // 处理错误
    }
    
    response, _ := modelWithTools.Generate(ctx, messages)
    // ...
}
```

## 6. 新贡献者注意事项

### 6.1 不要修改接口签名

接口是契约。一旦发布，修改接口签名会导致所有现有实现不兼容。如果你需要添加新方法，考虑：

1. 创建新接口（保持向后兼容）
2. 使用组合接口

### 6.2 Mock 生成

代码中包含 `go:generate` 指令用于生成 Mock：

```go
//go:generate mockgen -destination ../../internal/mock/components/model/ChatModel_mock.go --package model -source interface.go
```

修改接口后，记得运行 `go generate` 更新 Mock。

### 6.3 单元测试技巧

测试模型实现时，使用 `model.GetCommonOptions` 解析选项：

```go
func TestMyModelGenerate(t *testing.T) {
    model := NewMyModel(...)
    
    result, err := model.Generate(ctx, messages,
        model.WithTemperature(0.7),
        model.WithMaxTokens(100),
    )
    
    // 验证结果
    assert.NoError(t, err)
    assert.NotNil(t, result)
}
```