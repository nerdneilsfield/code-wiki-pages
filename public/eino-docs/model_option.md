# model_option 子模块

> 本文档详细解释 `model_interfaces_and_options` 模块中的选项模式部分，包括 `Options` 结构体、`Option` 类型以及相关的构建器和提取器函数。

## 1. 问题背景：Go 语言的参数设计困境

在 Go 语言中，函数参数传递有几种常见方式：

### 1.1 传统方式的局限性

```go
// 方式一：必填参数（简单但不够灵活）
func NewModel(apiKey string) *Model { ... }

// 方式二：配置结构体（常见但有缺陷）
type Config struct {
    Temperature float32  // 0 是默认值还是用户设置的？
    MaxTokens   int      // 0 是默认值还是用户设置的？
}
func NewModel(apiKey string, cfg Config) *Model { ... }
```

**问题在于：** 值类型的零值无法区分"用户没设置"和"用户明确设置为零"。

例如，如果 `Temperature` 的零值是 0.0，这意味着：
- 用户没传温度 → 使用模型默认值
- 用户明确要求温度为 0.0 → 完全确定性输出

这两种语义完全不同，但用值类型无法区分。

### 1.2 选项模式的引入

函数式选项模式（Functional Options Pattern）完美解决了这个问题：

```go
// 方式三：函数式选项（推荐）
type Option struct {
    apply func(opts *Options)
}

func WithTemperature(t float32) Option {
    return Option{
        apply: func(opts *Options) {
            opts.Temperature = &t  // 使用指针
        },
    }
}

func NewModel(apiKey string, opts ...Option) *Model {
    cfg := &Options{}  // 默认值
    for _, opt := range opts {
        opt.apply(cfg)  // 应用每个选项
    }
    return &Model{config: cfg}
}
```

## 2. 核心组件详解

### 2.1 Options 结构体

```go
type Options struct {
    Temperature     *float32       // 温度：控制随机性
    MaxTokens      *int           // 最大 token 数
    Model          *string        // 模型名称
    TopP           *float32       // Top-P：控制多样性
    Stop           []string       // 停止词
    Tools          []*schema.ToolInfo  // 可用工具列表
    ToolChoice     *schema.ToolChoice  // 工具选择策略
    AllowedToolNames []string     // 允许调用的工具名
}
```

**每个字段的语义：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `Temperature` | `*float32` | 采样温度，范围 0-2。0 更确定性，2 更随机。**注意是指针** |
| `MaxTokens` | `*int` | 生成的最大 token 数。**注意是指针** |
| `Model` | `*string` | 指定使用的模型名称 |
| `TopP` | `*float32` | Nucleus 采样阈值，与 Temperature 互斥 |
| `Stop` | `[]string` | 遇到这些词时停止生成 |
| `Tools` | `[]*schema.ToolInfo` | 模型可以调用的工具列表 |
| `ToolChoice` | `*schema.ToolChoice` | 强制/禁止/允许工具调用 |
| `AllowedToolNames` | `[]string` | 白名单：只允许调用这些工具 |

**为什么都是指针？**

再强调一次：**指针是为了区分"未设置"和"零值"**。

```go
// 场景 1：用户没设置温度
opts := model.GetCommonOptions(nil)
// opts.Temperature == nil → 使用模型默认值

// 场景 2：用户设置温度为 0
opts := model.GetCommonOptions(nil, model.WithTemperature(0.0))
// opts.Temperature != nil && *opts.Temperature == 0.0 → 强制确定性输出
```

### 2.2 Option 类型

```go
type Option struct {
    apply              func(opts *Options)
    implSpecificOptFn any  // 厂商特定选项
}
```

**双通道设计：**

`Option` 结构体有两个字段，分别处理两种配置需求：

1. **`apply` 字段** - 处理通用配置
   - 所有模型都支持的参数（Temperature、MaxTokens 等）
   - 通过 `GetCommonOptions` 提取

2. **`implSpecificOptFn` 字段** - 处理厂商特定配置
   - 只有特定模型才有的参数
   - 通过 `GetImplSpecificOptions[T]` 提取

这种设计实现了**"接口统一 + 实现独立"**的目标：

```go
// 通用配置：所有模型都用
WithTemperature(0.7)         // → apply 通道

// 厂商特定配置：只有特定模型用
WithTopP(0.95)               // → apply 通道（通用了）
WithCustomParam("xxx")        // → implSpecificOptFn 通道（厂商私有）
```

### 2.3 选项构建器

框架提供了一系列预定义的选项构建器：

```go
// 温度
func WithTemperature(temperature float32) Option

// 最大 token 数
func WithMaxTokens(maxTokens int) Option

// 模型名称
func WithModel(name string) Option

// Top-P
func WithTopP(topP float32) Option

// 停止词
func WithStop(stop []string) Option

// 工具列表
func WithTools(tools []*schema.ToolInfo) Option

// 工具选择策略
func WithToolChoice(toolChoice schema.ToolChoice, allowedToolNames ...string) Option
```

**使用示例：**

```go
opts := []model.Option{
    model.WithTemperature(0.7),
    model.WithMaxTokens(2000),
    model.WithModel("gpt-4"),
    model.WithTopP(0.9),
    model.WithTools(myTools),
    model.WithToolChoice(schema.ToolChoiceAllowed, "web_search", "calculator"),
}
```

### 2.4 选项提取器

#### GetCommonOptions

```go
func GetCommonOptions(base *Options, opts ...Option) *Options
```

提取所有通用配置：

```go
// 使用默认配置
opts := model.GetCommonOptions(nil, 
    model.WithTemperature(0.7),
)

// 或者基于已有的配置
baseOpts := &model.Options{
    Temperature: ptr(0.5),
    MaxTokens:   ptr(1000),
}
opts := model.GetCommonOptions(baseOpts, 
    model.WithTemperature(0.7),  // 覆盖温度
    // MaxTokens 保持为 1000
)
```

#### GetImplSpecificOptions

```go
func GetImplSpecificOptions[T any](base *T, opts ...Option) *T
```

提取厂商特定配置：

```go
// 定义厂商特定的配置结构
type MyModelOptions struct {
    APIVersion string
    Timeout    int
    CustomField string
}

// 创建厂商特定的选项
func WithAPIVersion(v string) model.Option {
    return model.WrapImplSpecificOptFn[MyModelOptions](func(o *MyModelOptions) {
        o.APIVersion = v
    })
}

// 提取时
myOpts := model.GetImplSpecificOptions(&MyModelOptions{}, 
    WithAPIVersion("v2"),
    WithCustomField("value"),
)
```

## 3. 深度设计分析

### 3.1 WithTools 的 nil 处理

这是一个容易被忽视的细节：

```go
func WithTools(tools []*schema.ToolInfo) Option {
    if tools == nil {
        tools = []*schema.ToolInfo{}  // 转换为空切片
    }
    return Option{
        apply: func(opts *Options) {
            opts.Tools = tools
        },
    }
}
```

**为什么需要这个处理？**

在 Go 中，`nil` 切片和空切片 `[]T{}` 在语义上略有不同：

```go
var s1 []string  // nil 切片
s2 := []string{} // 空切片

// range 时行为相同
for _, v := range s1 { /* 不会执行 */ }
for _, v := range s2 { /* 不会执行 */ }

// 但 json 序列化时不同
json.Marshal(s1) // "null"
json.Marshal(s2) // "[]"
```

将 `nil` 转换为空切片，确保了在序列化等场景下的一致性行为。

### 3.2 WithToolChoice 的设计

```go
func WithToolChoice(toolChoice schema.ToolChoice, allowedToolNames ...string) Option {
    return Option{
        apply: func(opts *Options) {
            opts.ToolChoice = &toolChoice
            opts.AllowedToolNames = allowedToolNames
        },
    }
}
```

这个函数同时设置了两个字段：
- `ToolChoice`：控制是否强制/禁止/允许工具调用
- `AllowedToolNames`：白名单机制，限制可调用的工具范围

这对应了 OpenAI API 的 `tool_choice` 和 `allowed_tools` 参数。

### 3.3 双重提取的实现机制

`Option` 结构体的两个字段使得同一个 `Option` 切片可以同时包含通用和特定配置：

```go
// 一个选项切片可以混合通用和特定配置
allOpts := []model.Option{
    model.WithTemperature(0.7),          // 通用
    model.WithMaxTokens(1000),          // 通用
    WithMyModelSpecificOption(),        // 厂商特定
}

// 分别提取
commonOpts := model.GetCommonOptions(nil, allOpts...)
specificOpts := model.GetImplSpecificOptions(&MyModelOpts{}, allOpts...)
```

实现原理：

```go
// 提取通用选项时，只执行 apply 字段
for i := range opts {
    opt := opts[i]
    if opt.apply != nil {
        opt.apply(base)  // 只处理通用配置
    }
}

// 提取特定选项时，只执行 implSpecificOptFn 字段
for i := range opts {
    opt := opts[i]
    if opt.implSpecificOptFn != nil {
        optFn, ok := opt.implSpecificOptFn.(func(*T))
        if ok {
            optFn(base)  // 只处理特定配置
        }
    }
}
```

## 4. 实际使用示例

### 4.1 基础用法

```go
// 方式一：链式调用
result, err := model.Generate(ctx, messages,
    model.WithTemperature(0.7),
    model.WithMaxTokens(2000),
)

// 方式二：先构建选项，再传递
opts := []model.Option{
    model.WithTemperature(0.7),
    model.WithMaxTokens(2000),
    model.WithModel("gpt-4"),
}
result, err := model.Generate(ctx, messages, opts...)
```

### 4.2 覆盖默认配置

```go
// 定义默认值
defaultOpts := &model.Options{
    Temperature: ptr(float32(0.5)),
    MaxTokens:   ptr(1000),
    Model:       ptr("gpt-3.5-turbo"),
}

// 覆盖部分默认值
opts := model.GetCommonOptions(defaultOpts,
    model.WithTemperature(0.9),  // 覆盖为 0.9
    // MaxTokens 和 Model 保持默认值
)
```

### 4.3 厂商特定配置

假设你实现了一个自定义模型，需要传递一些特殊参数：

```go
// 定义特定配置
type CustomModelOptions struct {
    APIEndpoint string
    RetryCount  int
    CustomHeader map[string]string
}

// 创建特定选项
func WithCustomAPIEndpoint(endpoint string) model.Option {
    return model.WrapImplSpecificOptFn[CustomModelOptions](func(c *CustomModelOptions) {
        c.APIEndpoint = endpoint
    })
}

// 使用
model.Generate(ctx, msgs,
    model.WithTemperature(0.7),           // 通用
    WithCustomAPIEndpoint("https://..."), // 特定
)
```

## 5. 新贡献者注意事项

### 5.1 添加新通用选项

如果你要添加一个新的通用选项（如 `FrequencyPenalty`），步骤如下：

```go
// 1. 在 Options 结构体中添加字段
type Options struct {
    // ...existing fields...
    FrequencyPenalty *float32
}

// 2. 添加构建器函数
func WithFrequencyPenalty(p float32) Option {
    return Option{
        apply: func(opts *Options) {
            opts.FrequencyPenalty = &p
        },
    }
}
```

### 5.2 选项的覆盖顺序

选项按顺序应用，**后面的会覆盖前面的**：

```go
opts := model.GetCommonOptions(nil,
    model.WithTemperature(0.5),  // 先设置
    model.WithTemperature(0.9),  // 后设置，覆盖
)
// 结果：Temperature = 0.9
```

### 5.3 避免常见错误

**错误：忘记处理 nil 情况**

```go
// ❌ 错误：假设 opts 永远不是 nil
func BadExample(opts *Options) {
    opts.Temperature = ptr(float32(0.5))  // 如果 opts 是 nil，这里 panic
}

// ✅ 正确：先检查或提供默认值
func GoodExample(opts *Options) {
    if opts == nil {
        opts = &Options{}
    }
    opts.Temperature = ptr(float32(0.5))
}
```

**错误：使用值类型**

```go
// ❌ 错误：使用值类型，无法区分"未设置"
type BadOptions struct {
    Temperature float32
}

// ✅ 正确：使用指针类型
type GoodOptions struct {
    Temperature *float32
}
```

### 5.4 测试建议

选项模式的测试重点是**覆盖场景**：

```go
func TestOptions(t *testing.T) {
    // 测试：nil 输入
    opts := model.GetCommonOptions(nil)
    assert.Nil(t, opts.Temperature)
    
    // 测试：设置值
    opts = model.GetCommonOptions(nil, model.WithTemperature(0.7))
    assert.NotNil(t, opts.Temperature)
    assert.Equal(t, float32(0.7), *opts.Temperature)
    
    // 测试：覆盖
    opts = model.GetCommonOptions(
        &model.Options{Temperature: ptr(float32(0.5))},
        model.WithTemperature(0.7),
    )
    assert.Equal(t, float32(0.7), *opts.Temperature)
    
    // 测试：WithTools 的 nil 处理
    opts = model.GetCommonOptions(nil, model.WithTools(nil))
    assert.NotNil(t, opts.Tools)  // 应该是空切片，而非 nil
    assert.Empty(t, opts.Tools)
}
```