# Schema Message 模块技术深度解析

## 1. 模块概览

`schema_message` 模块是整个系统的核心数据结构模块，主要负责定义和处理对话消息的表示、模板渲染以及流式消息拼接等功能。它是连接用户、模型、工具等组件之间的通用数据交换格式的基础。

## 2. 核心问题解决方案

### 2.1 问题背景

在构建 LLM（大语言模型）应用时，我们需要一个统一的数据结构来表示：
- 用户输入（文本、多媒体）
- 模型输出（文本、工具调用、多媒体）
- 工具执行结果
- 对话历史管理
- 消息模板渲染

### 2.2 解决方案

该模块提供了一套完整的类型系统，支持：
1. 多模态内容表示（文本、图像、音频、视频、文件）
2. 工具调用和工具结果表示
3. 流式输出拼接
4. 消息模板渲染（支持 FString、GoTemplate、Jinja2）
5. 对话历史占位符

## 3. 核心数据结构

### 3.1 Message 结构体

`Message` 是模块的核心结构体，用于表示对话中的一条消息：

```go
type Message struct {
    Role RoleType `json:"role"`
    Content string `json:"content"`
    // 已弃用的 MultiContent
    UserInputMultiContent []MessageInputPart `json:"user_input_multi_content,omitempty"`
    AssistantGenMultiContent []MessageOutputPart `json:"assistant_output_multi_content,omitempty"`
    Name string `json:"name,omitempty"`
    ToolCalls []ToolCall `json:"tool_calls,omitempty"`
    ToolCallID string `json:"tool_call_id,omitempty"`
    ToolName string `json:"tool_name,omitempty"`
    ResponseMeta *ResponseMeta `json:"response_meta,omitempty"`
    ReasoningContent string `json:"reasoning_content,omitempty"`
    Extra map[string]any `json:"extra,omitempty"`
}
```

**设计意图**：
- `Role`：区分消息的发送者（用户、助手、系统、工具）
- `Content`：简单文本内容
- `UserInputMultiContent`/`AssistantGenMultiContent`：分别用于用户输入和模型输出的多模态内容
- `ToolCalls`/`ToolCallID`/`ToolName`：工具调用相关
- `ResponseMeta`：响应元数据（完成原因、token 使用情况等）
- `ReasoningContent`：模型的思考过程
- `Extra`：自定义扩展字段

### 3.2 多模态内容表示

模块提供了完整的多模态内容表示：

- `MessageInputPart`：用户输入的多模态内容部分
- `MessageOutputPart`：模型输出的多模态内容部分
- `ToolOutputPart`：工具输出的多模态内容部分
- `MessagePartCommon`：多模态内容的公共抽象部分

**设计意图**：
- 分离用户输入和模型输出的多模态内容，因为它们的结构略有不同
- 支持 URL 和 Base64 两种方式表示多媒体内容
- 提供 MIME 类型支持
- 支持扩展字段

### 3.3 工具调用相关

- `ToolCall`：表示模型生成的工具调用
- `ToolResult`：表示工具执行的结构化多模态输出
- `FunctionCall`：表示具体的函数调用

**设计意图**：
- `ToolCall` 包含索引、ID、类型和函数调用信息
- `ToolResult` 支持多模态输出
- 提供 `ToMessageInputParts` 方法将工具结果转换为模型输入

### 3.4 消息模板

- `MessagesTemplate` 接口：定义消息模板的渲染方法
- `messagesPlaceholder`：消息占位符实现
- `FormatType`：支持的模板格式类型

**设计意图**：
- 支持三种常见的模板格式：FString（Python 风格）、GoTemplate、Jinja2
- 提供消息占位符功能，方便动态插入对话历史
- 禁用 Jinja2 中的危险关键字（include、extends、import、from）以确保安全性

## 4. 核心功能

### 4.1 流式消息拼接

#### 4.1.1 ConcatMessages

```go
func ConcatMessages(msgs []*Message) (*Message, error)
```

**功能**：将多个同角色、同名的消息拼接成一个消息

**拼接规则**：
- 文本内容直接拼接
- 思考内容直接拼接
- 工具调用按索引合并
- 多模态内容合并
- Extra 字段合并
- ResponseMeta 合并（保留最后一个有效的完成原因，取最大的 token 使用量）

**使用场景**：
- 处理模型的流式输出
- 将多个流式消息块合并成一个完整的消息

#### 4.1.2 ConcatMessageArray

```go
func ConcatMessageArray(mas [][]*Message) ([]*Message, error)
```

**功能**：将多个消息数组按索引对齐后拼接

**拼接规则**：
- 每个索引位置的消息单独拼接
- 要求所有输入数组长度相同

**使用场景**：
- 处理多个并行的流式消息数组

#### 4.1.3 ConcatToolResults

```go
func ConcatToolResults(chunks []*ToolResult) (*ToolResult, error)
```

**功能**：将多个工具结果块拼接成一个完整的工具结果

**拼接规则**：
- 文本部分：连续的文本部分合并
- 非文本部分：保持原样，且同一类型的非文本部分不能出现在多个块中

**使用场景**：
- 处理工具的流式输出

### 4.2 消息模板渲染

#### 4.2.1 MessagesTemplate.Format

```go
type MessagesTemplate interface {
    Format(ctx context.Context, vs map[string]any, formatType FormatType) ([]*Message, error)
}
```

**功能**：渲染消息模板

**支持的格式类型**：
- FString：Python 风格的格式化字符串
- GoTemplate：Go 标准库的模板
- Jinja2：Jinja2 模板（禁用了危险关键字）

**使用场景**：
- 动态生成提示词
- 插入对话历史
- 格式化用户输入

### 4.3 工具函数

#### 4.3.1 便捷消息创建函数

- `SystemMessage(content string) *Message`
- `UserMessage(content string) *Message`
- `AssistantMessage(content string, toolCalls []ToolCall) *Message`
- `ToolMessage(content string, toolCallID string, opts ...ToolMessageOption) *Message`

#### 4.3.2 工具结果转换

- `ToolResult.ToMessageInputParts() ([]MessageInputPart, error)`：将工具结果转换为模型输入

## 5. 数据流程

### 5.1 流式消息拼接流程

```
多个流式消息块
    ↓
ConcatMessages / ConcatMessageArray / ConcatToolResults
    ↓
拼接文本内容、思考内容、工具调用、多模态内容、Extra、ResponseMeta
    ↓
完整的消息 / 工具结果
```

### 5.2 消息模板渲染流程

```
消息模板 + 参数
    ↓
根据 FormatType 选择渲染器
    ↓
渲染文本内容、多模态内容
    ↓
渲染后的消息
```

## 6. 设计决策与权衡

### 6.1 多模态内容的分离设计

**决策**：将用户输入的多模态内容和模型输出的多模态内容分离为 `UserInputMultiContent` 和 `AssistantGenMultiContent`

**原因**：
- 用户输入和模型输出的多模态内容结构略有不同
- 避免混淆输入和输出
- 便于类型安全

### 6.2 禁用 Jinja2 危险关键字

**决策**：禁用 Jinja2 中的 include、extends、import、from 关键字

**原因**：
- 防止模板注入攻击
- 提高安全性
- 限制模板的功能范围，使其更适合提示词场景

### 6.3 流式拼接的严格性

**决策**：要求拼接的消息必须具有相同的角色和名称

**原因**：
- 确保拼接的逻辑正确性
- 避免意外合并不同角色的消息

### 6.4 工具结果的非文本部分唯一性

**决策**：同一类型的非文本部分不能出现在多个工具结果块中

**原因**：
- 简化拼接逻辑
- 避免歧义

## 7. 使用指南

### 7.1 基本使用

#### 创建消息：

```go
// 用户文本消息
userMsg := schema.UserMessage("你好，世界！")

// 系统消息
systemMsg := schema.SystemMessage("你是一个助手。")

// 助手消息（带工具调用）
assistantMsg := schema.AssistantMessage("我来帮你查询天气。", []schema.ToolCall{...})

// 工具消息
toolMsg := schema.ToolMessage("天气晴朗，温度 25°C", "call_123", schema.WithToolName("get_weather"))
```

#### 多模态消息：

```go
// 用户多模态消息
userMsg := &schema.Message{
    Role: schema.User,
    UserInputMultiContent: []schema.MessageInputPart{
        {Type: schema.ChatMessagePartTypeText, Text: "这张图片里有什么？"},
        {Type: schema.ChatMessagePartTypeImageURL, Image: &schema.MessageInputImage{
            MessagePartCommon: schema.MessagePartCommon{
                URL: toPtr("https://example.com/cat.jpg"),
            },
            Detail: schema.ImageURLDetailHigh,
        }},
    },
}
```

### 7.2 消息模板

```go
// 使用 FString 格式化
msg := schema.UserMessage("你好，{name}！")
msgs, err := msg.Format(ctx, map[string]any{"name": "世界"}, schema.FString)

// 使用消息占位符
placeholder := schema.MessagesPlaceholder("history", false)
params := map[string]any{
    "history": []*schema.Message{...},
}
msgs, err := placeholder.Format(ctx, params, schema.FString)
```

### 7.3 流式拼接

```go
// 拼接消息数组
msgArrays := [][]*schema.Message{...}
concatedMsgs, err := schema.ConcatMessageArray(msgArrays)

// 拼接工具结果
toolResults := []*schema.ToolResult{...}
concatedToolResult, err := schema.ConcatToolResults(toolResults)
```

## 8. 注意事项

### 8.1 已弃用的字段

- `MultiContent` 字段已弃用，使用 `UserInputMultiContent` 和 `AssistantGenMultiContent` 替代
- `ChatMessageImageURL`、`ChatMessageAudioURL`、`ChatMessageVideoURL`、`ChatMessageFileURL`、`ChatMessagePart` 已弃用

### 8.2 类型安全

- 确保拼接的消息具有相同的角色和名称
- 确保工具结果的非文本部分类型唯一

### 8.3 模板安全

- 使用 Jinja2 时注意已禁用的关键字
- 不要在模板中使用外部输入的模板内容

### 8.4 多模态内容

- URL 和 Base64Data 二选一
- 注意 MIME 类型的正确性
