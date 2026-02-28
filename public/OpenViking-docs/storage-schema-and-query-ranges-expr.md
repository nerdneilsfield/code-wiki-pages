# openviking.storage.expr 模块技术文档

## 模块定位与设计意图

`openviking.storage.expr` 模块是 OpenViking 向量存储层中负责定义查询过滤表达式的核心组件。 module 的职责边界非常清晰：**它只定义数据类型，不包含任何业务逻辑或状态管理**。这种纯粹的"数据模型"定位是经过深思熟虑的设计选择，原因将在后续章节详细解释。

这个模块解决的问题可以归结为一句话：**如何在 Python 代码中以类型安全、可组合的方式描述向量数据库的查询过滤条件**。

在真实的业务场景中，查询条件往往复杂多变。一个典型的检索需求可能是："找出过去7天内创建的、类型为 'skill' 的、且向量相似度高于 0.8 的资源"。这种条件包含时间范围约束、分类筛选和数值比较，如果用简单的字符串拼接来构建查询语句，极易产生错误且难以维护。`expr` 模块通过定义一套表达式抽象系统，将查询条件的构建变成了**组合可组合的乐高积木**——每种基本条件（等于、范围、包含等）是一个积木块，多个积木可以通过 And/Or 组合成更复杂的条件。

## 问题空间分析

### 为什么要用表达式抽象？

考虑一个没有表达式抽象的系统会面临什么问题。假设我们直接使用字典来传递过滤条件，代码可能是这样的：

```python
# 方式一：直接写字典
filter_dict = {
    "op": "and",
    "conds": [
        {"op": "must", "field": "context_type", "conds": ["skill"]},
        {"op": "range", "field": "created_at", "gte": "2024-01-01"}
    ]
}
```

这种方式有几个明显的问题。第一，字段名容易写错（"field" 写成 "fields"），编译器不会报错，只有运行时才能发现。第二，组合逻辑（and/or）散落在字典结构中，不够直观。第三，动态构建条件时需要大量字符串拼接和字典操作，代码冗长且容易出错。

使用表达式抽象后，代码变成了：

```python
# 方式二：使用表达式对象
from openviking.storage.expr import And, Eq, TimeRange

filter_expr = And(conds=[
    Eq(field="context_type", value="skill"),
    TimeRange(field="created_at", start="2024-01-01")
])
```

这种方式的优势在于：类型检查器会在编译期捕获字段名错误；And/Eq 等类名本身就是自解释的文档；动态构建时可以像操作普通 Python 对象一样组合表达式。

### 为什么选择不可变数据类？

模块中的所有表达式类型都使用了 `frozen=True` 的 dataclass。这是一个看似简单但影响深远的设计决策。让我解释背后的考量。

在异步系统中，对象经常在不同的协程之间传递。如果表达式是可变的，一个协程修改了表达式可能会影响另一个协程的使用结果，导致难以追踪的 bug。不可变对象天然免疫这类问题，因为创建后就无法被修改。

另一个不那么明显但同样重要的原因是**可缓存性**。当表达式不可变时，可以安全地对其进行哈希和缓存。在一个复杂的检索系统中，相同的查询条件可能被重复使用，不可变的表达式可以直接作为缓存的 key。如果表达式是可变的，这个特性就无法利用。

## 核心数据类型详解

### FilterExpr 联合类型

模块定义了一个 `FilterExpr` 类型别名，作为所有表达式类型的联合：

```python
FilterExpr = Union[And, Or, Eq, In, Range, Contains, TimeRange, RawDSL]
```

这个类型定义是整个模块的入口点。任何接受过滤条件的地方都应该使用 `FilterExpr` 作为参数类型，这样可以确保传入的值一定是合法的表达式对象。

### 逻辑表达式：And 与 Or

```python
@dataclass(frozen=True)
class And:
    conds: List["FilterExpr"]

@dataclass(frozen=True)
class Or:
    conds: List["FilterExpr"]
```

`And` 和 `Or` 是组合表达式，它们接收一个表达式列表作为子条件。`And` 表示所有子条件都必须满足（逻辑与），`Or` 表示任意一个子条件满足即可（逻辑或）。

设计上一个有趣的细节是：这两个类使用了字符串前向引用 `"FilterExpr"`。这是因为 Python 3.7+ 的类型注解延迟求值特性，使得在类定义内部可以引用尚未完全定义的 `FilterExpr` 类型。

### 比较表达式：Eq、In、Range

```python
@dataclass(frozen=True)
class Eq:
    field: str
    value: Any

@dataclass(frozen=True)
class In:
    field: str
    values: List[Any]

@dataclass(frozen=True)
class Range:
    field: str
    gte: Any | None = None
    gt: Any | None = None
    lte: Any | None = None
    lt: Any | None = None
```

`Eq` 表示精确匹配，适合字符串、数字等精确值的比较。`In` 表示值在列表中，适合多值匹配场景。`Range` 是最复杂的比较表达式，支持四种边界条件：

- `gte`：大于等于（greater than or equal）
- `gt`：大于（greater than）
- `lte`：小于等于（less than or equal）
- `lt`：小于（less than）

这种设计允许灵活的范围定义。例如，"年龄在 18 到 60 岁之间" 可以表示为 `Range(field="age", gte=18, lt=60)`。

### 字符串包含：Contains

```python
@dataclass(frozen=True)
class Contains:
    field: str
    substring: str
```

`Contains` 用于字符串字段的子串匹配。这在需要对长文本字段（如 description、abstract）进行模糊搜索时非常有用。注意，这是**精确子串匹配**，不是正则表达式匹配，也不是模糊匹配。

### 时间范围：TimeRange

```python
@dataclass(frozen=True)
class TimeRange:
    field: str
    start: datetime | str | None = None
    end: datetime | str | None = None
```

`TimeRange` 是专门为时间字段设计的表达式类型。它与 `Range` 的区别在于：时间范围通常有"从...开始"或"到...为止"的语义，边界条件更加固定。`TimeRange` 内部将 start 映射为 gte（闭区间），将 end 映射为 lt（开区间），这种映射符合人们对时间范围的直觉认知。

`start` 和 `end` 参数接受 `datetime` 对象或字符串类型。字符串格式依赖于后端对时间格式的支持，通常是 ISO 8601 格式。

### 原始 DSL：RawDSL

```python
@dataclass(frozen=True)
class RawDSL:
    payload: Dict[str, Any]
```

`RawDSL` 是整个模块中最"不抽象"的部分。它的存在是为了解决一个现实问题：不同的向量数据库后端可能支持不同的查询 DSL 语法，而表达式抽象不可能覆盖所有后端特性。当需要使用某个后端特有的查询能力时，可以绕过抽象层，直接传递原始 DSL 字典。

## 表达式编译过程

表达式定义后，需要被编译成后端兼容的格式。这个编译过程发生在 `CollectionAdapter._compile_filter()` 方法中（在 `vectordb_adapters/base.py` 文件里）。理解编译过程有助于理解整个过滤系统的工作方式。

### 编译为字典结构

编译过程将每种表达式类型映射为一个包含 `op` 字段的字典：

| 表达式类型 | 编译结果 |
|-----------|----------|
| `And` | `{"op": "and", "conds": [子条件...]}` |
| `Or` | `{"op": "or", "conds": [子条件...]}` |
| `Eq` | `{"op": "must", "field": 字段名, "conds": [值]}` |
| `In` | `{"op": "must", "field": 字段名, "conds": [值列表]}` |
| `Range` | `{"op": "range", "field": 字段名, "gte": x, "lt": y, ...}` |
| `Contains` | `{"op": "contains", "field": 字段名, "substring": 子串}` |
| `TimeRange` | `{"op": "range", "field": 字段名, "gte": start, "lt": end}` |
| `RawDSL` | 直接返回 `payload` 字典 |

### 优化规则

编译过程中有一些优化逻辑值得注意：

1. **空条件过滤**：`And` 和 `Or` 编译时会过滤掉 `None` 和空字典。如果一个 And 表达式包含的所有子条件都被过滤掉了，结果返回空字典 `{}`，表示"无过滤条件"。

2. **单条件提升**：如果 `And` 或 `Or` 只有一个非空子条件，编译结果直接返回这个子条件，而不是嵌套的 `{"op": "and", "conds": [单个条件]}` 结构。这种"提升"避免了在只有单个条件时产生不必要的结构嵌套。

### 编译示例

```python
from openviking.storage.expr import And, Eq, Range, TimeRange
from openviking.storage.vectordb_adapters.base import CollectionAdapter

# 假设有一个 CollectionAdapter 实例
adapter = SomeCollectionAdapter("test_collection")

# 构建复杂表达式
filter_expr = And(conds=[
    Eq(field="context_type", value="skill"),
    TimeRange(field="created_at", start="2024-01-01"),
    Range(field="active_count", gte=1)
])

# 编译为字典
compiled = adapter._compile_filter(filter_expr)
# 结果:
# {
#     "op": "and",
#     "conds": [
#         {"op": "must", "field": "context_type", "conds": ["skill"]},
#         {"op": "range", "field": "created_at", "gte": "2024-01-01"},
#         {"op": "range", "field": "active_count", "gte": 1}
#     ]
# }
```

## 数据流与依赖关系

### 上游依赖

这个模块本身不依赖其他业务模块，仅依赖 Python 标准库：
- `dataclass`：用于定义不可变数据类型
- `datetime`：TimeRange 的时间类型支持
- `typing`：类型注解支持
- `typing.Any`、`typing.Dict`、`typing.List`、`typing.Union`

### 下游消费者

`expr` 模块被以下组件使用：

1. **CollectionAdapter**（位于 `vectordb_adapters/base.py`）：使用 `FilterExpr` 类型作为 `query()` 和 `delete()` 方法的可选参数，并通过 `_compile_filter()` 方法将表达式编译为后端格式。

2. **VikingVectorIndexBackend**（位于 `viking_vector_index_backend.py`）：可能在内部检索逻辑中使用表达式类型。

3. **检索和评估模块**（位于 `retrieve` 和 `eval` 子包）：构建查询时需要使用这些表达式类型。

### 数据流向

```
业务代码                    CollectionAdapter               向量数据库
    │                            │                              │
    │  创建 FilterExpr          │                              │
    ├──────────────────────────▶│                              │
    │                            │                              │
    │                            │  _compile_filter()           │
    │                            ├─────────────────────────────▶│
    │                            │                              │
    │                            │         返回结果             │
    │                            ◀──────────────────────────────┤
    │                                                      │
    ◀─────────────────────────────────────────────────────┘
```

## 设计权衡分析

### 抽象 vs 灵活的取舍

模块选择了一个相对扁平的表达式层次——只有 And/Or 两种组合方式，没有实现 Not（取反）操作。这是有意的简化。

取反操作在查询语言中语义复杂：是对单个条件取反，还是对整个表达式取反？不成立的边界条件如何处理（如"不等于所有值"）？这些问题的答案取决于具体后端的查询能力。通过暂时不暴露 Not 操作，模块保持了实现的简洁性，同时保留了未来扩展的可能性。

如果确实需要对某个条件取反，当前的 workaround 是：对于 `Eq(field="type", value="skill")`，可以改用 `In(field="type", values=[其他所有可能的值])` 来实现等价的效果。

### 类型注解的未来兼容性

模块使用了 `Any | None` 这种现代 Python 类型注解语法（PEP 604 Union 语法）。这要求使用 Python 3.10+ 或 from `__future__` import annotations。代码中确实在文件顶部使用了 `from __future__ import annotations`，这使得该文件可以在 Python 3.9 环境下运行，同时使用现代语法。

### 可扩展性设计

`RawDSL` 类型的引入为模块提供了未来可扩展性的保障。随着 OpenViking 支持更多的向量数据库后端，如果某个后端需要表达现有抽象无法覆盖的查询条件，可以通过 RawDSL 直接传递原始 DSL 来解决问题，而无需修改表达式系统的核心实现。

## 使用注意事项

### 1. 边界条件的语义

对于 `Range` 表达式，同时设置 `gte` 和 `gt`（或 `lte` 和 `lt`）是合法的，但会产生逻辑上的歧义。例如 `Range(field="age", gte=18, gt=18)` 表示"年龄大于等于18 且大于18"，这实际上等价于"年龄大于18"。编译器的行为是两者都保留，最终由后端决定如何处理。为了代码清晰，建议只使用其中一种。

### 2. TimeRange 的边界语义

`TimeRange(start=x, end=y)` 编译后的语义是：`x <= time < y`。这意味着：
- 起始时间 `x` 被包含在结果中
- 结束时间 `y` 被排除在结果外

这种设计符合 Python 的 slice 语义 `[start:end)`，也符合人们对"从...到..."的直觉理解。如果需要包含结束时间，应该将 end 设置为"下一天的开始"或"end + 1个时间单位"。

### 3. 空条件的处理

`And(conds=[])` 和 `Or(conds=[])` 编译后会返回空字典 `{}`，表示"无条件"。对于 `And`，空条件列表意味着"所有条件都满足"（因为没有条件可以违反），所以返回无过滤。对于 `Or`，空条件列表意味着"没有条件满足"，也返回无过滤。这种表现在大多数场景下是符合直觉的。

### 4. 字典 vs 表达式对象的选择

`_compile_filter()` 方法接受 `FilterExpr` 对象或普通 `dict` 作为输入。选择哪种方式取决于场景：

- **使用表达式对象**：适合动态构建、复杂的条件组合、需要类型安全保证的场景
- **使用普通 dict**：适合简单的、静态的已知条件，或者需要直接复用外部系统传递的字典格式

两者可以混用，`_compile_filter()` 会自动识别和处理。

## 相关文档

- [Collection Adapter 文档](../vectorization_and_storage_adapters/collection_adapters_abstraction_and_backends.md) - 了解表达式如何被编译和使用
- [Collection Schemas 文档](./storage-schema-and-query-ranges-collection-schemas.md) - 了解集合的字段定义
- [检索模块文档](./retrieval-query-orchestration.md) - 了解检索如何与表达式系统交互
- [向量数据库适配器概述](../vectorization_and_storage_adapters/collection_adapters_abstraction_and_backends.md) - 了解不同的后端实现

---

## 总结

`expr` 模块是 OpenViking 存储层中最"小而美"的模块之一——它只定义了 8 个不可变的数据类，却为整个系统提供了构建类型安全、可组合查询条件的能力。

理解这个模块的关键在于把握以下三点：

1. **它是一个数据模型，不包含业务逻辑**：所有的"智能"都在编译方法 `_compile_filter()` 中，而这个方法属于 `CollectionAdapter`。
2. **不可变性是设计核心**：`frozen=True` 的选择不是随意的，它为模块带来了线程安全、可缓存性和可预测性。
3. **组合式设计**：通过 `And`/`Or` 组合基本表达式，可以构建任意复杂的查询条件，这种递归组合的能力是表达式系统的灵魂。