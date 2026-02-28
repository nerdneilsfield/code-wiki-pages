# document_loader_contracts_and_options-option 子模块

## 概述

本子模块是整个模块的**心脏**——它实现了前文提到的"双通道选项模式"。如果你读过主模块文档，你会知道这个设计解决了"如何在保持接口统一的同时让每个加载器有独特配置"的难题。

**核心职责**：
- 定义统一的选项封装类型（`LoaderOption`、`TransformerOption`）
- 提供类型安全的选项提取函数
- 承载通用配置（ParserOptions）

---

## 核心组件详解

### LoaderOption —— 双通道选项封装

```go
type LoaderOption struct {
    apply func(opts *LoaderOptions)
    implSpecificOptFn any
}
```

**为什么这样设计？**

这个结构体包含两个"通道"：

| 通道 | 字段 | 用途 | 框架控制 |
|------|------|------|----------|
| **通用通道** | `apply` | 框架定义的公共选项 | ✅ 完全控制 |
| **特定通道** | `implSpecificOptFn` | 各加载器自己的选项 | ❌ 由加载器定义 |

**设计原理**：

1. **`apply` 字段**：这是一个闭包函数。当创建通用选项时（如 `WithParserOptions`），我们不是直接修改 `LoaderOptions`，而是返回一个"修改器"函数。这个函数稍后会被调用来实际应用选项。

   这样做的好处是：**延迟执行** + **惰性求值**。选项可以在调用链中传递，直到真正需要时才应用。

2. **`implSpecificOptFn` 字段**：这是**类型擦除**的应用。我们把 `func(*T)` 类型的函数存储为 `any`（Go 1.18+ 的空接口），在运行时通过类型断言恢复为具体的函数类型。

   ```go
   // 存储时：类型被擦除
   implSpecificOptFn: func(o *MyOptions) { o.Foo = "bar" }
   
   // 取出时：类型被恢复
   s, ok := implSpecificOptFn.(func(*MyOptions))  // ok == true
   ```

### LoaderOptions —— 通用配置容器

```go
type LoaderOptions struct {
    ParserOptions []parser.Option
}
```

**当前设计**：

目前 `LoaderOptions` 只包含 `ParserOptions`，这是因为解析是加载过程的一个通用步骤——无论加载 PDF 还是 DOCX，最终都需要解析为 `schema.Document`。

**扩展性**：

如果未来需要添加更多通用选项，可以直接扩展这个结构体：

```go
type LoaderOptions struct {
    ParserOptions []parser.Option
    // 新增：通用选项
    Timeout time.Duration
    Retry   int
}
```

这不会破坏现有加载器的实现，因为 `GetLoaderCommonOptions` 会自动处理新增的字段。

---

## 关键函数解析

### WrapLoaderImplSpecificOptFn —— 包装实现特定选项

```go
func WrapLoaderImplSpecificOptFn[T any](optFn func(*T)) LoaderOption
```

**使用场景**：加载器作者定义自己的选项函数后，需要将其包装为统一的 `LoaderOption` 类型。

**泛型设计**：

使用泛型 `[T any]` 是这个设计的精华所在。它确保：
- 编译时类型安全：只能传入 `func(*T)` 类型的函数
- 运行时类型恢复：提取时能正确断言回 `func(*T)`

**示例**：

```go
// 加载器作者定义
type PDFLoaderOptions struct {
    PageRange string
    OCRLang   string
}

func WithPageRange(pr string) LoaderOption {
    return WrapLoaderImplSpecificOptFn(func(o *PDFLoaderOptions) {
        o.PageRange = pr
    })
}
```

### GetLoaderImplSpecificOptions —— 提取实现特定选项

```go
func GetLoaderImplSpecificOptions[T any](base *T, opts ...LoaderOption) *T
```

**参数说明**：

| 参数 | 作用 | 典型用法 |
|------|------|----------|
| `base *T` | 提供默认值 | `&PDFLoaderOptions{OCRLang: "en"}` |
| `opts ...LoaderOption` | 用户传递的选项 | `WithPageRange("1-10")` |

**返回值**：

返回合并了 `base` 默认值和用户选项的 `*T`。

**内部逻辑**：

```go
func GetLoaderImplSpecificOptions[T any](base *T, opts ...LoaderOption) *T {
    if base == nil {
        base = new(T)  // 如果没传 base，创建一个新的
    }
    
    for _, opt := range opts {
        if opt.implSpecificOptFn != nil {
            // 类型断言：只有匹配的类型才能成功
            if s, ok := opt.implSpecificOptFn.(func(*T)); ok {
                s(base)  // 应用选项
            }
            // 类型不匹配？静默忽略——这是设计决策
        }
    }
    
    return base
}
```

**静默失败的设计**：

注意，如果类型不匹配，选项会被**静默忽略**，不会 panic。这是经过考量的：
- Go 没有编译期泛型约束来保证类型匹配
- 运行时错误会导致整个请求失败，影响太大
- 静默忽略让调试变得困难，但避免了级联失败

**最佳实践**：加载器作者应该在自己的包里提供选项构造函数，用户不会、也不应该手动构造 `LoaderOption`。

### GetLoaderCommonOptions —— 提取通用选项

```go
func GetLoaderCommonOptions(base *LoaderOptions, opts ...LoaderOption) *LoaderOptions
```

与 `GetLoaderImplSpecificOptions` 类似，但它处理通用选项通道（`apply` 字段）：

```go
func GetLoaderCommonOptions(base *LoaderOptions, opts ...LoaderOption) *LoaderOptions {
    if base == nil {
        base = &LoaderOptions{}
    }
    
    for _, opt := range opts {
        if opt.apply != nil {
            opt.apply(base)  // 调用闭包应用选项
        }
    }
    
    return base
}
```

### WithParserOptions —— 通用选项示例

```go
func WithParserOptions(opts ...parser.Option) LoaderOption
```

这是框架提供的唯一通用选项函数。它将解析器选项附加到加载请求中：

```go
// 使用示例
loader.Load(ctx, src, 
    WithParserOptions(parser.WithURI(src.URI)),
    myLoaderSpecificOption(),  // 加载器自己的选项
)
```

---

## TransformerOption

`TransformerOption` 与 `LoaderOption` 的设计完全一致，只是应用于不同的接口：

```go
type TransformerOption struct {
    implSpecificOptFn any
}
```

注意 `TransformerOption` 没有 `apply` 字段——因为目前 Transformer 还没有定义通用选项。这反映了当前的设计假设：**转换器通常不需要通用配置，每个转换器都是独特的**。

如果将来需要为 Transformer 添加通用选项，可以随时添加：

```go
type TransformerOption struct {
    apply func(opts *TransformerOptions)
    implSpecificOptFn any
}
```

---

## 模式总结：双通道函数式选项

```
用户调用: loader.Load(ctx, src, opt1, opt2, opt3)

                          ┌─────────────────────────────────────┐
                          │            LoaderOption             │
         ┌────────────────┼─────────────────────────────────────┤
         │                │                                     │
    opt1 │                │ opt2                                │ opt3
         │                │                                     │
         ▼                ▼                                     ▼
┌─────────────┐   ┌──────────────────┐              ┌──────────────────┐
│  apply 通道  │   │ implSpecific 通道│              │ implSpecific 通道│
│ (通用选项)    │   │  (PDFLoaderOpts) │              │ (WebLoaderOpts)  │
└─────────────┘   └──────────────────┘              └──────────────────┘
         │                                                    │
         ▼                                                    ▼
┌─────────────────────┐                           ┌─────────────────────┐
│ GetLoaderCommonOptions │  ◄─────────────────────►  GetLoaderImplSpecificOptions
│   返回 LoaderOptions │                           │   返回 PDFLoaderOptions
└─────────────────────┘                           └─────────────────────┘
```

这种设计让：
- **框架**能够定义和管理通用选项
- **加载器实现**能够自由定义自己的配置
- **调用方**使用统一的 API

---

## 注意事项

### 1. 不要混用选项来源

```go
// ❌ 可能导致混淆
type PDFLoaderOptions struct {
    Timeout time.Duration  // 这个字段也存在于通用选项吗？
}

// ✅ 明确分离：加载器特定选项应该只包含加载器需要的
type PDFLoaderOptions struct {
    PageRange string  // PDF 特有
    OCRLang   string  // PDF 特有
}
```

### 2. 默认值要放在 base 参数中

```go
// ✅ 正确：默认值在 base 中提供
opts := GetLoaderImplSpecificOptions(&MyOptions{
    Timeout: 30 * time.Second,
    Retry:   3,
}, opts...)

// ❌ 错误：如果用户传了选项，默认值可能丢失
opts := GetLoaderImplSpecificOptions(nil, opts...)
```

### 3. 加载器包应该导出选项构造函数

```go
package mypdf

// ✅ 好：用户直接使用加载器提供的函数
loader.Load(ctx, src, mypdf.WithPageRange("1-10"))

// ❌ 差：让用户自己构造 LoaderOption
loader.Load(ctx, src, document.WrapLoaderImplSpecificOptFn[MyOptions](...))
```

---

## 小结

这个子模块通过精心设计的**双通道选项模式**，解决了 Go 语言在类型安全与灵活性之间的张力：

1. **通用通道**（`apply`）让框架可以定义公共配置
2. **特定通道**（`implSpecificOptFn`）让每个加载器可以有独特配置
3. **泛型**确保编译时类型安全
4. **类型擦除**实现运行时灵活性

这是 Eino 框架中**最值得学习的 Go 设计模式**之一，它展示了如何在强类型语言中实现可扩展的插件架构。