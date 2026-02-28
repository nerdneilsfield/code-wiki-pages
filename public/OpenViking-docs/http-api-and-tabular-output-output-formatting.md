# output_formatting 模块技术深度解析

## 概述：问题空间与设计意图

`output_formatting` 模块是 OpenViking CLI 的输出格式化层，负责将服务器返回的结构化数据转换为人类可读的终端输出。想象一下：一个 CLI 工具需要与远端 REST API 交互，服务器返回的是统一的 JSON 响应，但用户在终端看到的不应该是原始 JSON（尤其在查询资源列表、搜索结果或系统状态时），而应该是经过适当格式化、排列整齐的表格文本。

这个模块要解决的核心问题是：**服务器返回的 JSON 结构是统一的、扁平的，但用户需要看到的输出形式是多样的**——一个资源列表应该显示为表格，一个资源详情应该显示为键值对，一个系统状态应该显示为带有健康指示器的层次结构。传统的做法是在每个命令处理器中分别编写格式化逻辑，但这会导致重复代码和风格不一致。

`output_formatting` 模块的设计洞察是：**数据结构的形状决定了其最佳呈现形式**。通过分析 JSON 值的结构特征（是数组还是对象？数组元素是原始类型还是对象？对象包含哪些字段？），模块可以自动选择最合适的渲染策略。这就像一个智能的"自动格式化器"，根据输入数据的特征选择最优的输出布局。

## 架构与数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLI Commands                                │
│  (observer.rs, search.rs, resources.rs, etc.)                      │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    output_success<T>                                │
│  输入: 泛型 T: Serialize                                            │
│        format: OutputFormat (Table | Json)                         │
│        compact: bool                                                │
│                                                                     │
│  决策点: 检查 format 是 Json还是Table                               │
│          ↓                        ↓                                 │
│  ┌─────────────────┐    ┌──────────────────────┐                   │
│  │ JSON 输出路径   │    │ print_table() 表格输出 │                   │
│  │ - compact模式   │    │                      │                   │
│  │   包装{ok:true} │    │ 核心格式化规则引擎     │                   │
│  │ - pretty模式    │    │                      │                   │
│  │   直接美化打印  │    │                      │                   │
│  └─────────────────┘    └──────────────────────┘                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      print_table() 核心逻辑                         │
│                                                                     │
│  第一步: serde_json::to_value() 将任意可序列化数据转为Value         │
│                                                                     │
│  第二步: 模式匹配 - 识别六种数据形态                                  │
│  ┌────────┬─────────────────────────────────────┐                  │
│  │ Rule 1 │ list[dict] → 多行表格               │                  │
│  │ Rule 2 │ 多个list[dict] → 扁平化+type列      │                  │
│  │ Rule 3a│ 单个list[primitive] → 每项一行      │                  │
│  │ Rule 3b│ 单个list[dict] → 直接渲染表格       │                  │
│  │ Rule 4 │ 纯dict(无线性列表) → 单行水平表      │                  │
│  │ Rule 5 │ ComponentStatus → 特殊健康显示      │                  │
│  │ Rule 6 │ SystemStatus → 层次化系统状态       │                  │
│  └────────┴─────────────────────────────────────┘                  │
│                                                                     │
│  第三步: format_array_to_table()                                    │
│         - 列信息收集(列宽、数字列识别、URI列识别)                    │
│         - 表头生成                                                  │
│         - 数据行渲染                                                │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      终端输出 (stdout/stderr)                       │
└─────────────────────────────────────────────────────────────────────┘
```

从数据流角度来看，这个模块扮演的是**变换器（Transformer）**的角色：它接收命令处理器传来的任意可序列化数据，加上格式和紧湊模式的配置参数，输出最终的终端文本。它不持有状态，不管理资源，只是一个纯函数式的转换层。

## 核心组件深度解析

### OutputFormat 枚举

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputFormat {
    Table,
    Json,
}
```

这个枚举极其简洁，只有两个变体。设计意图很明确：**CLI 用户不需要选择困难**——要么输出适合人类阅读的表格，要么输出适合程序解析的 JSON。`From<&str>` 实现允许从命令行参数（`--output json` 或 `--output table`）直接转换，默认值是 `Table`，这体现了"人类优先"的设计理念。

### output_success 函数

```rust
pub fn output_success<T: Serialize>(result: T, format: OutputFormat, compact: bool)
```

这是模块的**主要入口点**，所有命令的成功输出都通过它路由。关键设计决策：

1. **泛型 `<T: Serialize>`**：使用 `serde::Serialize` trait bound 使得函数可以接受任何可以序列化的数据类型。这带来极大的灵活性——无论是简单的 `String`、复杂的 `struct`、还是 `Vec<MyStruct>`，都可以传入而无需修改调用方代码。

2. **compact 参数的双重语义**：在 JSON 模式下，compact 控制是否用 `{ok: true, result: ...}` 包装；在 Table 模式下，compact 控制是否过滤空列。这种设计减少了 CLI 参数数量，但带来的代价是语义有一点模糊——"compact" 在不同上下文中含义略有不同。

3. **错误处理策略**：JSON 序列化失败时，函数会回退到直接输出原始 JSON 字符串。这种"优雅降级"确保了即使格式化失败，用户至少能看到原始数据，而不是一无所获。

### output_error 函数

```rust
pub fn output_error(code: &str, message: &str, format: OutputFormat, compact: bool)
```

错误输出的设计有一个微妙的不对称：**只有在 JSON + compact 模式下才会输出结构化错误**，其他情况都退化为简单的 `eprintln!("ERROR[{}]: {}", code, message)`。这可能是一个历史遗留设计——原本可能计划让错误输出也支持表格格式，但目前只实现了 JSON 路径。

### print_table 函数：核心规则引擎

这是模块最复杂的函数，大约 200 行代码实现了六条格式化规则。理解这个函数的关键是把握其**模式匹配逻辑**：

**规则 1：list[dict] → 多行表格**

当输入是一个对象数组，且每个元素都是对象时，直接渲染为标准表格。列自动从所有对象的键的并集中提取。这是搜索结果、资源列表的常见格式。

```rust
// 例如搜索结果
[
  {"uri": "viking://docs/readme", "score": 0.95},
  {"uri": "viking://docs/api", "score": 0.87}
]
// 渲染为:
// uri                      score
// viking://docs/readme     0.95
// viking://docs/api        0.87
```

**规则 2：多个 list[dict] → 扁平化+type 列**

当对象包含多个数组字段（且数组元素都是对象）时，将它们合并为一个数组，并添加 `type` 列标识来源。这用于需要展示多种类型资源混合的场景。

```rust
// 例如:
// {"files": [...], "directories": [...]}
// 渲染为添加 type 列:
// name      type
// src       file
// tests     directory
```

**规则 3a：单 list[primitive] → 每项一行**

当对象只有一个数组字段且元素是原始类型（字符串、数字、布尔）时，将数组元素转为单列表格。

**规则 3b：单 list[dict] → 直接渲染**

与规则 1 类似，但处理的是"对象中嵌套的单个数组"而非"顶层数组"。

**规则 4：纯 dict → 单行水平表**

没有数组字段的普通对象，显示为键值对列表，每个键值对占一行。这用于资源详情、配置信息等场景。

**规则 5：ComponentStatus 特殊格式**

当对象包含 `name`、`is_healthy`、`status` 三个字段时，使用特殊格式渲染健康状态。

**规则 6：SystemStatus 层次格式**

当对象包含 `components` 和 `is_healthy` 时，渲染为系统级别的层次状态报告。

### ColumnInfo 结构体

```rust
struct ColumnInfo {
    max_width: usize,    // 最大列宽（上限120）
    is_numeric: bool,    // 是否为数字列（用于右对齐）
    is_uri_column: bool, // 是否为URI列（永不截断）
}
```

这个结构体存储的是**列的元数据**，用于后续的格式化决策。`max_width` 限制为 120 是一个**经验值**，平衡了信息完整性和终端可视性。`is_uri_column` 的设计很有意思——URI 通常很长，但截断它们会让用户无法复制完整的链接，所以 URI 列有"豁免权"。

### format_array_to_table 函数

这是实际执行表格渲染的函数，分为两遍（two-pass）：

**第一遍：列分析**
- 遍历所有行，收集所有列名
- 计算每列的最大内容宽度
- 判断是否为数字列（所有值都可解析为 f64）
- 判断是否为 URI 列（列名恰好是 "uri"）

**第二遍：表格渲染**
- 生成表头行
- 逐行渲染数据，对内容进行截断或填充
- 数字列右对齐，其他列左对齐

这种两遍设计的优点是：先收集元数据，再执行渲染，可以确保表格整体对齐。缺点是需要额外的内存和遍历开销，但对于 CLI 输出的数据量（通常几十到几百行），这个开销可以忽略不计。

### 辅助函数

- **`format_value`**: 将 JSON Value 转为字符串，处理 null、bool、number 的显示
- **`pad_cell`**: 根据列宽和对其方向填充空格
- **`is_numeric_value`**: 判断一个 JSON 值是否可以视为数字（Number 类型或可解析为 f64 的字符串）
- **`truncate_string`**: 截断字符串，支持 Unicode 宽度感知

## 依赖分析与契约

### 上游调用方

`output_formatting` 被多个命令模块调用：

- `commands/observer.rs` - 系统状态查询
- `commands/search.rs` - 搜索结果展示
- `commands/resources.rs` - 资源列表和详情
- `commands/session.rs` - 会话管理
- `commands/filesystem.rs` - 文件系统操作

每个调用方都遵循相同的模式：
```rust
let response: serde_json::Value = client.get("/api/v1/...", &[]).await?;
output_success(&response, output_format, compact);
```

### 下游依赖

模块依赖以下外部 crate：

| 依赖 | 用途 |
|------|------|
| `serde::Serialize` | 泛型序列化 trait |
| `serde_json` | JSON 解析和 Value 类型 |
| `unicode-width` | Unicode 字符宽度计算（中文字符宽度为 2）|

### 数据契约

**输入契约**：
- 传入的数据必须是 `serde::Serialize` 的
- 通常传入 `serde_json::Value`（从 HTTP 响应反序列化）

**输出契约**：
- 成功时输出到 `stdout`（`println!`）
- 错误时输出到 `stderr`（`eprintln!`）
- 无返回值（Unit 类型）

## 设计决策与权衡

### 决策 1：规则驱动 vs 配置驱动

模块选择了**硬编码规则**而非**用户可配置**的方案。每种 JSON 结构对应哪种输出格式，都是代码中固定好的。这是一种**约定优于配置**的实践——用户无需学习复杂的配置项，模块会自动做出合理的选择。

**权衡**：灵活性受限，但学习成本和使用成本都降低了。对于 CLI 工具这个场景，固定的规则集合通常足够。

### 决策 2：JSON 作为中间表示

模块先将所有输入序列化为 `serde_json::Value`，再分析其结构并渲染。这种设计有一个隐含假设：**输入数据可以被序列化为 JSON**。如果输入数据包含无法序列化的类型，会触发回退逻辑。

**权衡**：增加了一次序列化开销，但换来了统一的处理入口。考虑到 CLI 数据量通常很小，这个开销可以接受。

### 决策 3：Unicode 宽度感知

使用了 `unicode-width` crate 来计算字符显示宽度，而非简单的 `str::len()`。这对于中文、日文等 CJK 字符至关重要——一个中文字符虽然只占 1 个字节，但终端显示需要 2 个字符宽度。

**权衡**：增加了一个外部依赖，但确保了多语言环境下的正确对齐。

### 决策 4：compact 模式的双重语义

`compact` 参数在 JSON 模式和 Table 模式下的行为不同：
- JSON: 决定是否包装 `{ok: true, result: ...}`
- Table: 决定是否过滤空列

**权衡**：减少了 CLI 参数数量，但代码可读性略受影响。新贡献者可能需要阅读代码才能理解 `compact` 的确切行为。

## 常见模式与扩展

### 基本用法

```rust
use crate::output::{output_success, OutputFormat};

// 从 API 获取数据
let response: serde_json::Value = client.get("/api/v1/resources", &[]).await?;

// 输出（用户通过 --output table/json --compact true/fly 控制）
output_success(&response, OutputFormat::Table, false);
```

### 自定义输出格式

如果需要在模块中添加新的格式化规则，在 `print_table` 函数中添加新的模式匹配分支即可。例如，要支持某种特殊的状态类型渲染：

```rust
// 在 print_table 的对象处理分支中添加
if obj.contains_key("custom_field") {
    // 自定义渲染逻辑
}
```

### 扩展格式选项

如果需要支持新的输出格式（如 CSV、YAML），可以：

1. 在 `OutputFormat` 枚举中添加新变体
2. 在 `output_success` 中添加新的处理分支
3. 为每种新格式实现相应的渲染函数

## 边界情况与陷阱

### 陷阱 1：空数组的默认行为

当输入为空数组 `[]` 时，模块输出 `(empty)` 而非空表格。这是一个**有意的设计**，用占位符让用户知道"这里本来应该有数据，只是现在为空"。

### 陷阱 2：混合类型数组

如果数组包含不同类型的元素（如字符串和对象混合），模块会退化为简单的一行一个元素的格式，而非尝试创建表格。这是合理的——混合类型的数组没有统一的列结构。

### 陷阱 3：JSON 序列化失败时的回退

当 `serde_json::to_value` 失败时（输入无法序列化为 JSON），模块会回退到直接用 `serde_json::to_string` 输出原始数据。这意味着**即使格式化失败，用户也能看到某些输出**，而不是一无所获。

### 陷阱 4：列宽上限

`MAX_COL_WIDTH = 256` 和表格渲染时的 `max_width` 上限 120 意味着超长内容会被截断。对于大多数 CLI 场景这是合理的，但如果你需要查看完整的长文本内容，可能需要直接使用 `--output json` 模式。

### 陷阱 5：URI 列名硬编码

判断是否为 URI 列的唯一方式是检查列名是否恰好为 `"uri"`。如果你有其他类型的长链接需要类似处理（如 `"url"`、`"href"`），它们会被普通截断。

## 测试覆盖

模块包含三个测试用例：

```rust
#[test]
fn test_object_formatting_with_alignment() { ... }

#[test]
fn test_object_with_long_uri() { ... }

#[test]
fn test_empty_object() { ... }
```

这些测试验证了基本功能不会 panic，但**不验证输出内容的精确性**。对于输出格式化模块，这可能是可以接受的——精确的文本对比测试脆弱且难以维护。不过，如果你修改了格式化逻辑，建议手动验证输出样式是否符合预期。

## 参考文档

- [CLI 主程序与命令结构](rust_cli_interface.md) - 了解命令如何调用输出模块
- [HTTP 客户端](http_client.md) - 了解数据如何从服务器获取
- [错误处理模块](cli_bootstrap_and_runtime_context.md) - 了解错误如何传播和处理