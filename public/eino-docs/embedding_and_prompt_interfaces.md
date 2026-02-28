# embedding_and_prompt_interfaces 模块深度解析

## 1. 模块概述

`embedding_and_prompt_interfaces` 模块定义了两个核心接口：`Embedder`（文本嵌入器）和 `ChatTemplate`（聊天模板），它们是构建 AI 应用的基础设施。这个模块的核心使命是将 "如何做"（具体实现）与 "做什么"（功能契约）解耦，让上层应用能够以统一的方式调用不同的底层服务。

想象一下，如果你正在构建一个 RAG（检索增强生成）系统，你可能需要：
- 将用户查询和文档片段转换为向量（嵌入）
- 将查询、检索到的文档和系统提示组装成模型能理解的对话格式

这个模块就是为这些操作定义标准"插座"的地方——任何符合接口规范的实现都能轻松插拔，而不需要修改上层业务逻辑。

## 2. 核心组件详解

### 2.1 Embedder 接口

```go
type Embedder interface {
    EmbedStrings(ctx context.Context, texts []string, opts ...Option) ([][]float64, error)
}
```

**设计意图**：
`Embedder` 接口抽象了文本到向量的转换过程。它的设计体现了几个关键考虑：

- **批量处理优先**：接受 `[]string` 而不是单个 `string`，这是因为大多数嵌入服务（OpenAI、Cohere 等）都支持批量处理，能显著降低延迟和成本。
- **上下文传递**：显式传递 `context.Context`，允许取消操作、传递请求元数据（如追踪 ID）和设置超时。
- **选项模式**：使用 `opts ...Option` 来灵活配置，而不是在接口中添加更多参数，保持了接口的稳定性。

**参数解析**：
- `ctx`：上下文，用于控制请求生命周期
- `texts`：要嵌入的文本列表
- `opts`：可选配置，当前支持指定模型名称

**返回值**：
- `[][]float64`：嵌入向量列表，每个输入文本对应一个 `[]float64` 向量
- `error`：处理过程中发生的错误

### 2.2 ChatTemplate 接口

```go
type ChatTemplate interface {
    Format(ctx context.Context, vs map[string]any, opts ...Option) ([]*schema.Message, error)
}
```

**设计意图**：
`ChatTemplate` 接口解决了 "如何将变量填充到提示模板中生成对话历史" 的问题。它的核心价值在于：

- **模板与逻辑分离**：提示模板可以是静态配置（如 YAML 文件），而格式化逻辑是通用的
- **统一的消息格式**：所有模型调用都使用 `schema.Message` 类型，简化了模型切换
- **上下文感知**：同样支持 `context.Context`，为将来的模板缓存、A/B 测试等功能预留了空间

**参数解析**：
- `ctx`：上下文
- `vs`：变量映射，键是模板中的占位符名，值是要填充的数据
- `opts`：可选配置（当前主要用于实现特定扩展）

**返回值**：
- `[]*schema.Message`：格式化后的消息列表，可以直接传递给聊天模型
- `error`：格式化过程中的错误（如缺少必需变量、模板语法错误）

## 3. 架构角色与数据流

### 3.1 在整个系统中的位置

`embedding_and_prompt_interfaces` 模块处于 **组件接口层**，它向上为业务逻辑（如 [Flow Retrievers](flow_retrievers.md)、[ADK ChatModel Agent](adk_chatmodel_agent.md)）提供服务，向下则由具体实现（如 OpenAI 嵌入器、HuggingFace 本地嵌入、自定义提示模板引擎）来实现。

### 3.2 典型数据流

#### 嵌入流程：
```
用户查询 → RAG 系统 → Embedder.EmbedStrings() → 向量数据库检索
                                    ↑
                           具体嵌入实现 (OpenAI/Cohere/...)
```

#### 提示模板流程：
```
模板定义 + 变量 → ChatTemplate.Format() → []*schema.Message → 模型调用
                          ↑
                   DefaultChatTemplate 或自定义实现
```

## 4. 设计决策与权衡

### 4.1 接口最小化原则

这两个接口都只定义了一个方法，这是有意为之的设计：

**选择**：每个接口只包含一个核心方法
**原因**：
- 降低实现门槛：开发者只需实现一个方法就能创建兼容的组件
- 提高可测试性：单方法接口更容易 mock（见 [Mock Utilities](mock_utilities.md)）
- 保持灵活性：未来如果需要扩展功能，可以通过新接口组合，而不是修改现有接口

**权衡**：
- 缺点：对于复杂场景可能需要定义额外的辅助接口
- 优点：接口稳定性极高，不会因为新功能添加而破坏现有实现

### 4.2 选项模式 vs 固定参数

两个接口都使用了 `opts ...Option` 模式：

**选择**：选项模式而非结构化参数
**原因**：
- 向后兼容：添加新选项不会破坏现有调用
- 可选参数自然表达：不需要传递大量 `nil` 或默认值
- 实现特定扩展：通过 `implSpecificOptFn` 支持特定实现的特殊功能

**相关实现**：
```go
// embedding/option.go
type Option struct {
    apply func(opts *Options)
    implSpecificOptFn any  // 实现特定的选项
}
```

### 4.3 批量嵌入 vs 单次嵌入

**选择**：接口只提供批量方法 `EmbedStrings`
**原因**：
- 性能优化：大多数嵌入 API 都有批量优化，延迟和成本更低
- 简化接口：不需要同时维护 `EmbedString` 和 `EmbedStrings`

**权衡**：
- 对于单次嵌入场景，调用方需要包装成单元素切片
- 但这是一个很小的代价，换来了整体性能的提升

## 5. 依赖关系

### 5.1 被依赖的模块

- **[Schema Core Types](schema_core_types.md)**：两个接口都依赖 `schema` 包中的类型
  - `ChatTemplate` 直接返回 `[]*schema.Message`
  - 两个接口的 `Option` 类型设计与 `schema` 包中的选项模式保持一致

### 5.2 依赖此模块的模块

- **[Flow Retrievers](flow_retrievers.md)**：使用 `Embedder` 来生成查询和文档的嵌入向量
- **[ADK ChatModel Agent](adk_chatmodel_agent.md)**：使用 `ChatTemplate` 来格式化提示
- **[Compose Graph Engine](compose_graph_engine.md)**：可以将这两个接口的实现作为图中的节点
- **[Mock Utilities](mock_utilities.md)**：提供这两个接口的 mock 实现用于测试

## 6. 使用指南与最佳实践

### 6.1 实现 Embedder 接口

```go
type MyEmbedder struct {
    client *MyAPIClient
}

func (e *MyEmbedder) EmbedStrings(ctx context.Context, texts []string, opts ...Option) ([][]float64, error) {
    // 1. 解析选项
    options := &Options{}
    for _, opt := range opts {
        opt.apply(options)
    }
    
    // 2. 准备请求
    model := "default-model"
    if options.Model != nil {
        model = *options.Model
    }
    
    // 3. 调用实际 API（注意处理 ctx 的超时和取消）
    return e.client.BatchEmbed(ctx, model, texts)
}
```

### 6.2 使用 ChatTemplate

```go
// 使用默认实现
template := prompt.NewDefaultChatTemplate(
    []schema.MessagesTemplate{
        schema.SystemMessage("你是一个{role}"),
        schema.UserMessage("问题：{question}\n上下文：{context}"),
    },
    schema.FormatTypeDefault,
)

// 格式化
messages, err := template.Format(ctx, map[string]any{
    "role":     "代码助手",
    "question": "如何优化这个循环？",
    "context":  "for i := 0; i < len(data); i++ { ... }",
})
```

## 7. 注意事项与常见陷阱

### 7.1 Embedder 的注意事项

1. **向量维度一致性**：确保同一 `Embedder` 实例返回的向量维度始终一致，否则向量数据库查询会失败
2. **空文本处理**：明确如何处理空字符串输入——是返回零向量、报错，还是跳过？
3. **上下文超时**：务必尊重 `ctx.Done()`，避免在调用方已取消的情况下继续执行
4. **错误语义**：区分暂时性错误（可重试）和永久性错误（如 API 密钥无效）

### 7.2 ChatTemplate 的注意事项

1. **变量类型安全**：`vs map[string]any` 是类型不安全的，建议在自定义模板中添加类型检查
2. **消息顺序**：确保模板生成的消息顺序正确（系统消息 → 用户消息 → 助手消息…）
3. **特殊字符转义**：如果模板包含 JSON、代码等内容，注意正确转义特殊字符
4. **默认值处理**：为可选变量提供合理默认值，而不是直接报错

## 8. 扩展点

这个模块设计了明确的扩展点：

1. **自定义 Embedder**：实现 `Embedder` 接口以支持新的嵌入服务（如本地模型、企业内部服务）
2. **自定义 ChatTemplate**：实现 `ChatTemplate` 接口以支持不同的模板语法（如 Jinja2、Go template）
3. **自定义 Option**：通过选项模式添加新的配置项，而不修改接口

## 9. 总结

`embedding_and_prompt_interfaces` 模块虽然代码量很小，但它是整个框架的关键抽象层。它通过简洁的接口定义，将 "文本嵌入" 和 "提示格式化" 这两个核心操作标准化，使得：

- 上层应用可以专注于业务逻辑，而不关心底层实现
- 不同的服务提供商可以轻松集成到框架中
- 测试变得简单（通过 mock 接口）

这种 "以接口为中心" 的设计是整个框架保持灵活性和可扩展性的关键。
