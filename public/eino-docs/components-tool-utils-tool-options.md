
# tool-options 模块技术深度解析

## 1. 概述

tool-options 模块是 components/tool/utils 包下的核心组件，它负责为工具函数适配器提供灵活的配置机制。该模块解决了一个关键问题：如何让开发者在将普通 Go 函数转换为 AI 可用的工具时，能够自定义参数解析、输出序列化以及 Schema 生成的行为，而不需要修改适配器的核心代码。

### 核心价值

想象一下你正在构建一个 AI 代理框架，需要让 AI 能够调用各种 Go 函数。最简单的做法是强制所有函数都使用固定的 JSON 序列化方式和 Schema 生成规则，但这会严重限制开发者的灵活性。tool-options 模块就像一个配置开关面板，让开发者可以在保持适配器核心逻辑不变的情况下，根据自己的需求定制这些关键行为。

## 2. 架构设计

### 核心数据结构

toolOptions 是整个模块的核心，它封装了三个关键的自定义点：

```go
type toolOptions struct {
    um         UnmarshalArguments
    m          MarshalOutput
    scModifier SchemaModifierFn
}
```

这种设计采用了函数式选项模式，这是 Go 语言中一种优雅的配置方式。

### 数据流向

1. 配置阶段：用户通过 WithXxx 函数创建选项
2. 收集阶段：getToolOptions 函数收集并应用这些选项
3. 使用阶段：工具适配器在运行时使用这些配置来处理参数和输出

## 3. 核心组件详解

### 3.1 选项定义

#### Option 类型
```go
type Option func(o *toolOptions)
```

这是一个函数类型，它接收一个 *toolOptions 指针并对其进行修改。

#### 核心选项函数

##### WithUnmarshalArguments
```go
func WithUnmarshalArguments(um UnmarshalArguments) Option
```

设计意图：允许用户自定义如何将 AI 生成的 JSON 参数字符串转换为 Go 函数的输入类型。

##### WithMarshalOutput
```go
func WithMarshalOutput(m MarshalOutput) Option
```

设计意图：允许用户自定义如何将 Go 函数的输出转换为 AI 能理解的字符串格式。

##### WithSchemaModifier
```go
func WithSchemaModifier(modifier SchemaModifierFn) Option
```

设计意图：允许用户自定义如何从 Go 结构体生成 JSON Schema，特别是处理自定义的 struct tag。

### 3.2 配置收集器

#### getToolOptions 函数
```go
func getToolOptions(opt ...Option) *toolOptions
```

设计意图：收集并应用所有选项，返回一个配置好的 toolOptions 对象。

## 4. 设计决策与权衡

### 4.1 为什么选择函数式选项模式？

选择：使用函数式选项模式而不是配置结构体。

原因：
1. 向后兼容性：添加新选项不需要修改现有代码
2. 灵活性：选项可以以任意顺序组合
3. 可读性：WithXxx 的命名方式让代码更清晰

### 4.2 为什么使用 nil 表示默认行为？

选择：在 toolOptions 中使用 nil 表示使用默认实现。

原因：
1. 懒加载：只有在需要时才创建默认实现
2. 零值安全：Go 的零值机制自然支持这种模式

## 5. 注意事项与常见陷阱

### 5.1 类型安全

陷阱：在 UnmarshalArguments 中返回错误的类型，这会在运行时导致类型断言失败。

### 5.2 SchemaModifier 的调用次数

陷阱：假设 SchemaModifierFn 只会被调用一次。实际上，它会被调用多次：对于结构体的每个字段，对于数组字段和数组元素，最后一次用于根结构体。

## 6. 总结

tool-options 模块是一个小而强大的组件，它通过函数式选项模式为工具适配器提供了灵活的配置机制。它的设计体现了开闭原则、关注点分离等重要的软件工程原则。
