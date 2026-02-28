# tool_metadata_schema 模块技术深度解析

## 概述

`tool_metadata_schema` 模块（在代码中实际位于 `schema` 包的 `tool.go` 文件）是整个系统中定义工具元数据契约的核心基础设施。它解决了一个看似简单但实则关键的问题：**如何用一种既对人类友好又能被机器严格验证的方式描述工具的参数结构**，同时支持多种描述方式以适应不同的使用场景。

想象一下，你正在构建一个 AI 助手系统，这个系统需要调用各种工具（比如查询数据库、发送邮件、执行代码等）。每个工具都有自己的参数要求——有的需要简单的字符串，有的需要复杂的嵌套对象。如果没有一个统一的方式来描述这些参数，AI 模型就不知道如何生成正确的工具调用，工具提供者也不知道如何清晰地表达自己的需求。这个模块就是为了解决这个问题而存在的。

## 核心问题

在深入代码之前，让我们先理解这个模块要解决的核心问题：

1. **双重表达需求**：工具开发者需要一种简单直观的方式来描述参数（不想写复杂的 JSON Schema），但 AI 模型通常需要标准的 JSON Schema 格式才能理解
2. **灵活性与严格性的平衡**：有些场景需要完整的 JSON Schema 表达能力（比如复杂的验证规则），而大多数场景只需要基本的类型描述
3. **统一接口**：无论使用哪种描述方式，系统的其他部分都需要通过统一的接口来获取参数信息

## 核心组件解析

### DataType 类型

```go
type DataType string
```

`DataType` 定义了工具参数支持的数据类型，它直接映射到 JSON Schema 的类型系统。这是一个典型的**类型别名模式**，通过将字符串类型封装为特定类型，既保留了字符串的灵活性，又获得了编译时的类型安全。

支持的类型包括：
- `Object`：对象类型，包含子属性
- `Number`：数字类型（浮点数）
- `Integer`：整数类型
- `String`：字符串类型
- `Array`：数组类型
- `Null`：空值类型
- `Boolean`：布尔类型

### ToolChoice 类型

```go
type ToolChoice string
```

`ToolChoice` 控制模型如何选择调用工具。这是一个**策略枚举模式**，通过三个预定义的值来表达不同的工具调用策略：

- `ToolChoiceForbidden`：禁止模型调用任何工具
- `ToolChoiceAllowed`：允许模型自主选择是否调用工具
- `ToolChoiceForced`：强制模型必须调用工具

这种设计比使用布尔值更具表达力，因为它清晰地表达了三种不同的策略，而不仅仅是"是"或"否"。

### ParameterInfo 结构体

```go
type ParameterInfo struct {
    Type      DataType
    ElemInfo  *ParameterInfo
    SubParams map[string]*ParameterInfo
    Desc      string
    Enum      []string
    Required  bool
}
```

`ParameterInfo` 是模块中最核心的抽象之一，它用一种**树形结构**来描述参数的类型信息。这是一个典型的**复合模式**实现，允许构建任意深度的嵌套参数结构。

让我们拆解每个字段的作用：

- **Type**：参数的基本类型，是整个结构的"骨架"
- **ElemInfo**：仅在 Type 为 Array 时使用，描述数组元素的类型信息
- **SubParams**：仅在 Type 为 Object 时使用，描述对象的子参数
- **Desc**：参数的描述文本，用于告诉模型这个参数的作用
- **Enum**：仅在 Type 为 String 时使用，限制字符串的可选值
- **Required**：标识参数是否为必填项

这种设计的巧妙之处在于，它用一个统一的结构就能表达从简单到复杂的所有参数类型，而不需要为每种类型创建单独的结构体。

### ParamsOneOf 结构体

```go
type ParamsOneOf struct {
    params     map[string]*ParameterInfo
    jsonschema *jsonschema.Schema
}
```

`ParamsOneOf` 是这个模块的**设计亮点**，它实现了一个** discriminated union（可区分联合）模式**，但通过 Go 的结构体和方法来模拟。

设计意图很明确：**提供两种参数描述方式，但确保同一时间只使用一种**。用户可以选择：

1. **简单方式**：使用 `map[string]*ParameterInfo`，适合大多数常见场景
2. **高级方式**：使用 `*jsonschema.Schema`，适合需要复杂验证规则的场景

这种设计解决了"灵活性与简单性的矛盾"——简单场景用简单方式，复杂场景用高级方式，两者互不干扰。

### ToolInfo 结构体

```go
type ToolInfo struct {
    Name        string
    Desc        string
    Extra       map[string]any
    *ParamsOneOf
}
```

`ToolInfo` 是工具的完整元数据描述，它组合了工具的基本信息和参数信息。注意这里使用了**嵌入结构体**的方式，使得 `ToolInfo` 可以直接访问 `ParamsOneOf` 的方法，这是 Go 中实现"继承-like"行为的常用方式。

## 核心方法解析

### ToJSONSchema 方法

```go
func (p *ParamsOneOf) ToJSONSchema() (*jsonschema.Schema, error)
```

这是模块中最重要的方法，它实现了**从简单描述到标准格式的转换**。让我们看看它的工作原理：

1. **检查 nil**：如果 `ParamsOneOf` 本身是 nil，返回 nil，表示工具不需要参数
2. **检查 params**：如果使用了简单方式（`params` 字段非空），将其转换为 JSON Schema
3. **检查 jsonschema**：如果使用了高级方式，直接返回原始的 JSON Schema

这种设计确保了无论用户选择哪种描述方式，系统的其他部分都能通过 `ToJSONSchema()` 方法获得统一的 JSON Schema 格式。

### paramInfoToJSONSchema 函数

```go
func paramInfoToJSONSchema(paramInfo *ParameterInfo) *jsonschema.Schema
```

这是一个递归函数，它将 `ParameterInfo` 树转换为 JSON Schema 树。这个函数体现了**递归下降**的思想，沿着 `ParameterInfo` 的结构逐层转换：

1. 处理基本类型信息（Type、Description）
2. 如果是枚举类型，处理 Enum 字段
3. 如果是数组类型，递归处理 ElemInfo
4. 如果是对象类型，递归处理 SubParams

值得注意的是，在处理对象类型时，代码对键进行了排序：

```go
keys := make([]string, 0, len(paramInfo.SubParams))
for k := range paramInfo.SubParams {
    keys = append(keys, k)
}
sort.Strings(keys)
```

这是一个**确定性输出**的设计决策——确保每次转换都产生相同顺序的 JSON Schema，这对于测试、缓存和调试都非常重要。

## 数据流向

让我们追踪一个工具元数据从定义到被模型使用的完整流程：

1. **工具提供者**创建 `ToolInfo`，选择使用 `ParameterInfo` 或直接使用 JSON Schema
2. **系统组件**调用 `ToJSONSchema()` 方法，将参数描述转换为标准格式
3. **转换后的 JSON Schema**被传递给 AI 模型，模型根据这个 schema 生成工具调用
4. **工具调用参数**被验证（通常在其他模块中），确保符合 schema 要求
5. **验证通过的参数**被传递给实际的工具执行函数

## 设计决策与权衡

### 1. 两种描述方式的选择

**决策**：提供 `ParameterInfo` 和 `JSON Schema` 两种描述方式  
**权衡**：
- ✅ 简单场景简单处理，复杂场景有足够表达力
- ❌ 增加了模块的复杂度，需要维护两种描述方式的转换逻辑
- ❌ 存在"两种方式都用了"的潜在错误风险（尽管当前代码通过优先使用 `params` 来处理）

**为什么这样设计**：团队在实践中发现，80% 的工具只需要简单的类型描述，而 20% 的工具需要复杂的 JSON Schema 特性。这种设计让 80% 的场景变得简单，同时不牺牲 20% 场景的表达力。

### 2. 使用递归转换而非代码生成

**决策**：使用递归函数 `paramInfoToJSONSchema` 进行转换  
**权衡**：
- ✅ 代码简洁，易于理解和维护
- ✅ 支持任意深度的嵌套结构
- ❌ 对于极深的嵌套结构，可能存在栈溢出风险（尽管在实际工具参数中很少见）

**为什么这样设计**：工具参数的嵌套深度通常是有限的，递归实现的简洁性远远超过了潜在的风险。

### 3. 确定性排序

**决策**：在转换过程中对参数键进行排序  
**权衡**：
- ✅ 输出稳定，便于测试和调试
- ✅ 可以安全地对结果进行缓存
- ❌ 有轻微的性能开销

**为什么这样设计**：在 AI 系统中，稳定性通常比轻微的性能开销更重要。稳定的输出让测试更可靠，让调试更容易。

### 4. 嵌入 vs 组合

**决策**：在 `ToolInfo` 中嵌入 `ParamsOneOf`  
**权衡**：
- ✅ 提供了便利的方法访问（`toolInfo.ToJSONSchema()`）
- ❌ 稍微模糊了"工具信息"和"参数信息"的边界

**为什么这样设计**：这是 Go 中常见的设计模式，通过嵌入来提供"语法糖"，让 API 更友好。

## 使用指南

### 基本使用：简单参数描述

```go
toolInfo := &schema.ToolInfo{
    Name: "search_database",
    Desc: "Search the database for records matching the query",
    ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
        "query": {
            Type:     schema.String,
            Desc:     "The search query string",
            Required: true,
        },
        "limit": {
            Type:     schema.Integer,
            Desc:     "Maximum number of results to return",
            Required: false,
        },
    }),
}
```

### 高级使用：直接使用 JSON Schema

```go
import "github.com/eino-contrib/jsonschema"

js := &jsonschema.Schema{
    Type: "object",
    Properties: orderedmap.New[string, *jsonschema.Schema](),
    Required: []string{"query"},
}
js.Properties.Set("query", &jsonschema.Schema{
    Type:        "string",
    Description: "The search query string",
    MinLength:   jsonschema.Int(1),
})
js.Properties.Set("limit", &jsonschema.Schema{
    Type:        "integer",
    Description: "Maximum number of results to return",
    Minimum:     jsonschema.Number(1),
    Maximum:     jsonschema.Number(100),
})

toolInfo := &schema.ToolInfo{
    Name:        "search_database",
    Desc:        "Search the database for records matching the query",
    ParamsOneOf: schema.NewParamsOneOfByJSONSchema(js),
}
```

### 嵌套参数描述

```go
toolInfo := &schema.ToolInfo{
    Name: "create_user",
    Desc: "Create a new user in the system",
    ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
        "user": {
            Type:     schema.Object,
            Required: true,
            SubParams: map[string]*schema.ParameterInfo{
                "name": {
                    Type:     schema.String,
                    Required: true,
                    Desc:     "Full name of the user",
                },
                "email": {
                    Type:     schema.String,
                    Required: true,
                    Desc:     "Email address of the user",
                },
                "tags": {
                    Type:     schema.Array,
                    Required: false,
                    Desc:     "Tags associated with the user",
                    ElemInfo: &schema.ParameterInfo{
                        Type: schema.String,
                    },
                },
            },
        },
    }),
}
```

## 边缘情况与注意事项

### 1. 两种方式同时使用

虽然 `ParamsOneOf` 的设计意图是"只使用一种方式"，但代码中没有强制禁止同时设置两个字段。当前的实现是优先使用 `params` 字段，如果 `params` 非空就忽略 `jsonschema` 字段。

**建议**：始终只使用一种方式，避免混淆。

### 2. 类型不匹配

`ParameterInfo` 中的字段有使用条件：
- `ElemInfo` 只在 `Type` 为 `Array` 时有意义
- `SubParams` 只在 `Type` 为 `Object` 时有意义
- `Enum` 只在 `Type` 为 `String` 时有意义

当前代码没有验证这些条件，而是直接将所有字段转换到 JSON Schema 中。这可能导致生成的 JSON Schema 不符合预期。

**建议**：在创建 `ParameterInfo` 时，确保只设置与类型相关的字段。

### 3. nil 处理

`ToJSONSchema()` 方法在 `ParamsOneOf` 为 nil 时返回 nil，这表示工具不需要参数。这是一个重要的约定，系统的其他部分依赖这个约定来判断工具是否需要参数。

**建议**：如果工具不需要参数，将 `ParamsOneOf` 字段设置为 nil，而不是创建一个空的 `ParamsOneOf`。

### 4. 循环引用

`ParameterInfo` 的结构允许创建循环引用（比如对象 A 包含对象 B，对象 B 又包含对象 A）。当前的递归转换函数没有检测循环引用，这会导致无限递归和栈溢出。

**建议**：避免在 `ParameterInfo` 中创建循环引用。如果需要表示递归结构，使用直接的 JSON Schema 方式，JSON Schema 有专门的机制处理循环引用。

## 依赖关系

这个模块依赖两个外部库：
- `github.com/eino-contrib/jsonschema`：提供 JSON Schema 的数据结构
- `github.com/wk8/go-ordered-map/v2`：提供有序 map 实现，用于保持 JSON Schema 属性的顺序

## 总结

`tool_metadata_schema` 模块是一个看似简单但设计精巧的基础设施模块。它通过 `ParameterInfo` 提供了简单直观的参数描述方式，通过 `ParamsOneOf` 提供了灵活的选择，通过 `ToJSONSchema()` 提供了统一的转换接口。

这个模块的设计体现了几个重要的原则：
1. **简单场景简单化，复杂场景有可能**：通过两种描述方式满足不同需求
2. **统一接口**：无论使用哪种描述方式，都通过相同的方法获取结果
3. **确定性输出**：对键进行排序，确保输出稳定
4. **递归设计**：用简洁的代码处理复杂的嵌套结构

作为新加入团队的工程师，理解这个模块的设计思想和使用方式，将帮助你更好地理解整个系统的工具调用机制。
