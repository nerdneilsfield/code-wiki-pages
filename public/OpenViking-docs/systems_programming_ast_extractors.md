# systems_programming_ast_extractors

## 概述

**systems_programming_ast_extractors** 模块是 OpenViking 系统中负责从系统编程语言源代码提取结构化元数据的核心组件。它使用 tree-sitter 解析器从 C/C++、Go 和 Rust 代码中提取类/结构体、函数/方法、导入语句以及文档注释，形成可供向量化和语义搜索使用的代码骨架（CodeSkeleton）。

### 为什么需要这个模块？

当你构建一个代码搜索或代码理解系统时，原始源代码作为字符串几乎没有结构信息。一段 `void process(Data* input)` 的代码片段，机器只知道它是一堆字符，但无法理解它是一个返回 `void` 的函数、接受 `Data*` 类型的参数、名为 `process`。这个模块解决的问题就是：**将原始代码转换为结构化的、机器可理解的表示**，从而支持：

1. **语义搜索** — 想象用户在搜索 "查找所有接受 Data 参数的函数"，系统需要先知道哪些函数接受 Data 参数
2. **代码理解** — LLM 需要结构化信息来理解代码库的组织方式
3. **依赖分析** — 了解模块间的导入关系
4. **文档检索** — 提取文档注释用于知识库构建

如果没有这个模块，上述需求只能通过全文匹配实现，精度和召回率都会很差。

## 架构概览

本模块的架构遵循简单的分层设计。调用方（如 BaseParser）通过调用 `extract(file_name, content)` 方法与提取器交互。`LanguageExtractor` 是抽象基类，定义了统一接口。具体的语言实现（CppExtractor、GoExtractor、RustExtractor）各自使用对应的 tree-sitter 语法包解析代码，并返回包含结构化元数据的 `CodeSkeleton` 对象。

### 思维模型：代码的"X 光机"

想象一下你在医院做体检：X 光机穿透你的身体，在胶片上留下骨骼的轮廓 — 它帮助你快速了解身体的结构，而不需要把你解剖。**这个模块就是代码的"X 光机"**。

- **输入**：一段陌生的源代码（就像一具"肉体"）
- **处理过程**：tree-sitter 解析器像 X 光一样穿透语法表面，识别出声明、定义、调用关系
- **输出**：结构化的"代码骨架"（就像 X 光片上的骨骼）

骨架保留了关键信息：
- 有哪些"骨骼"（类、函数）？
- 它们叫什么名字（命名）？
- 它们之间如何连接（继承、调用）？
- 有什么"病史"（文档注释）？

但它不关心：
- 具体的"肌肉"动作（函数实现逻辑）
- "皮肤"细节（变量名风格、格式化）

这种设计是有意的：骨架信息足以回答"这个模块是做什么的"、"这个函数接受什么参数"这类问题，而无需查看完整的实现代码。

### 核心组件深度解析

#### CppExtractor 的内部机制

`CppExtractor` 是三者中最复杂的，因为 C++ 语言的语法特性最为丰富。其核心 `extract()` 方法遵循以下处理流程：

```python
def extract(self, file_name: str, content: str) -> CodeSkeleton:
    content_bytes = content.encode("utf-8")
    tree = self._parser.parse(content_bytes)
    root = tree.root_node

    # 扁平遍历根节点的直接子节点
    siblings = list(root.children)
    for idx, child in enumerate(siblings):
        if child.type == "preproc_include":
            # 提取 #include 指令
        elif child.type in ("class_specifier", "struct_specifier"):
            # 提取 class 或 struct
        elif child.type == "function_definition":
            # 提取顶层函数
        elif child.type == "namespace_definition":
            # 递归处理命名空间内部
```

**关键设计洞察**：C++ 的类定义可以出现在命名空间内部，所以提取器在处理 `namespace_definition` 时会**递归遍历**其内部的 `declaration_list`。这意味着：

- 一层嵌套的命名空间可以被正确处理
- 更深的嵌套层级会被忽略（这是有意的简化）

**类提取的细节**：`_extract_class` 函数会遍历 `class_specifier` 的子节点，寻找：
- `type_identifier`：类名
- `base_class_clause`：基类列表（冒号后面的部分）
- `field_declaration_list`：类成员（包含方法定义）

对于方法提取，它只处理 `function_definition` 类型的子节点，这排除了数据成员。

#### GoExtractor 的内部机制

Go 的语法比 C++ 简单得多，因此 `GoExtractor` 的逻辑也更直接。其核心特点在于对 import 的处理：

```python
# Go 的 import 有两种语法：
# import "fmt"           # 单行导入
# import (               # 批量导入
#     "os"
#     "fmt"
# )

elif child.type == "import_declaration":
    for sub in child.children:
        if sub.type == "import_spec":
            # 处理单个 import "fmt"
        elif sub.type == "import_spec_list":
            # 处理批量导入
```

**方法声明的特殊处理**：Go 的方法（method）是带有 receiver 的函数。tree-sitter 将其解析为 `method_declaration` 节点，其第一个 `parameter_list` 是 receiver（如 `s *Server`）而非实际参数。提取器通过 `param_list_count` 变量来跳过 receiver：

```python
elif child.type == "parameter_list":
    param_list_count += 1
    if is_method and param_list_count == 1:
        continue  # 跳过 receiver
```

#### RustExtractor 的内部机制

Rust 提取器处理三种主要的代码组织结构：

1. **item 级别定义**：`struct_item`、`trait_item`、`enum_item`、`function_item`
2. **impl 块**：`impl_item`（包含方法的实现）
3. **导入声明**：`use_declaration`

**impl 块的处理**是 Rust 独有的挑战。在 Rust 中，你可以这样写：

```rust
impl Foo {
    fn method1(&self) {}
    fn method2(&self) {}
}
```

提取器将其映射为：

```python
def _extract_impl(node, content_bytes: bytes) -> ClassSkeleton:
    name = ""
    methods: List[FunctionSig] = []
    for child in node.children:
        if child.type == "type_identifier" and not name:
            name = _node_text(child, content_bytes)
        elif child.type == "declaration_list":
            # 遍历 impl 块内部的方法
            for idx, sub in enumerate(siblings):
                if sub.type == "function_item":
                    methods.append(_extract_function(sub, ...))
    return ClassSkeleton(name=f"impl {name}", ...)
```

注意这里的技巧：`impl Foo` 被命名为 `"impl Foo"`，以区别于可能同时存在的 `struct Foo` 定义。

### 架构图

```
调用方 (BaseParser / CustomParser)
    │
    ▼
LanguageExtractor（抽象基类）
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  ▼
CppExtractor      GoExtractor       RustExtractor
    │                  │                  │
    └──────────────────┼──────────────────┘
                       ▼
              tree-sitter 解析器
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   tree-sitter-   tree-sitter-  tree-sitter-
      cpp            go            rust
```

### 核心组件

| 组件 | 职责 | 关键方法 |
|------|------|----------|
| `LanguageExtractor` | 抽象基类，定义提取器接口 | `extract(file_name, content)` |
| `CppExtractor` | C/C++ 代码提取器 | `extract()` → `CodeSkeleton` |
| `GoExtractor` | Go 代码提取器 | `extract()` → `CodeSkeleton` |
| `RustExtractor` | Rust 代码提取器 | `extract()` → `CodeSkeleton` |

### 数据流

**数据从输入到输出的完整路径：**

```
源代码文件 → encode("utf-8") → tree-sitter Parser → AST Tree 
→ 遍历节点 → 提取元数据 → CodeSkeleton → 下游使用
```

具体步骤：
1. **输入**：文件名 + 源代码字符串
2. **编码转换**：将源代码编码为 UTF-8 字节流
3. **解析阶段**：使用 tree-sitter 将源代码解析为 AST（抽象语法树）
4. **遍历阶段**：遍历 AST 节点，识别目标节点类型（import、class、function 等）
5. **提取阶段**：从目标节点中提取元数据（名称、参数、返回类型、文档注释）
6. **输出**：`CodeSkeleton` 对象，包含结构化元数据

## 设计决策与权衡

### 为什么选择 tree-sitter？

**选项 A：使用语言官方解析器**（如 clang、rustc、go/ast）

- **优点**：解析结果最准确，语义信息最完整
- **缺点**：每种语言需要独立的集成方案，API 差异大，维护成本高；有些语言官方不提供库级别的 AST 访问

**选项 B：使用正则表达式**

- **优点**：无依赖，实现简单
- **缺点**：无法处理嵌套结构、注释嵌套、字符串中的相似模式；误报率极高

**选项 C：使用 tree-sitter**

- **优点**：统一的 API（所有语言都是 `Parser.parse()` → `Tree` → `Node`），增量解析支持，跨语言一致性好
- **缺点**：tree-sitter 生成的是**语法树**而非**语义树**（如 C++ 中 `vector<int>` 和 `vector<string>` 在 tree-sitter 中都只是 `template_method`），需要额外的启发式规则处理语义信息

**最终选择**：tree-sitter。这是一个务实的权衡 — 放弃部分语义精度，换取跨语言的统一接口和实现简洁性。对于代码骨架提取场景，这个权衡是合理的。

### 为什么每种语言独立一个类？

看这个模块的结构，你可能会问：为什么不使用策略模式，一个类通过配置切换语言？

**当前设计**：每个语言一个独立的类（`CppExtractor`、`GoExtractor`、`RustExtractor`），各自包含自己的解析逻辑和启发式规则。

**替代方案**：单一 `LanguageExtractor` 类，通过传入语言参数切换。

**选择理由**：
1. **语言差异太大** — C++ 有命名空间、类/结构体二义性、模板；Go 有接口和 method declarations；Rust 有 trait 和 impl 块。每种语言的 AST 节点类型完全不同，强行统一会增加大量 if-else 分支。
2. **独立演进** — 添加新语言（如 Java）不会影响现有语言提取器的稳定性。
3. **Lazy Loading** — 每个提取器在 `__init__` 时才导入 tree-sitter-{lang}，避免启动时加载所有语言绑定。

### 文档注释提取的设计

三种语言的文档注释提取逻辑略有不同：

- **C++**：提取 `/** ... */` 块注释（Doxygen 风格）
- **Go**：提取连续的 `//` 行注释
- **Rust**：提取 `///` 行注释（doc comment）

这是一个**有意为之的设计差异**，因为每种语言的文档约定不同。另一种选择是标准化为统一格式，但这会丢失语言特定的文档风格信息，对于代码理解场景可能是有价值的上下文。

## 子模块说明

本模块包含以下子模块，每个子模块有独立文档：

### 1. cpp_extractor（C++ 提取器）

专门处理 C 和 C++ 代码。关键特性：

- 支持 `class_specifier` 和 `struct_specifier`
- 处理命名空间（`namespace_definition`）内的声明
- 提取函数定义（`function_definition`）
- 收集 `#include` 指令

详细文档：[cpp_extractor](./systems_programming_ast_extractors-cpp_extractor.md)

### 2. go_extractor（Go 提取器）

专门处理 Go 代码。关键特性：

- 支持 `function_declaration` 和 `method_declaration`
- 提取 `struct_type` 和 `interface_type`
- 处理 `import_declaration`（支持单行和批量导入）

详细文档：[go_extractor](./go_extractor.md)

### 3. rust_extractor（Rust 提取器）

专门处理 Rust 代码。关键特性：

- 支持 `struct_item`、`trait_item`、`enum_item`
- 处理 `impl_item`（将 impl 块视为类）
- 提取 `function_item`（fn 定义）
- 收集 `use_declaration`（导入）

详细文档：[rust_extractor](./systems-programming-ast-extractors-rust-extractor.md)

## 与其他模块的关系

### 上游依赖

本模块依赖以下模块：

| 模块 | 依赖关系 | 说明 |
|------|----------|------|
| [base_parser](./parser_abstractions_and_extension_points.md#base_parser_abstract_class) | 定义接口 | 提供 `BaseParser` 抽象类，本模块的提取器被包装在其中 |
| [language_extractor_base](./parser_abstractions_and_extension_points.md#language_extractor_base) | 继承基类 | `LanguageExtractor` 抽象基类定义统一接口 |
| [skeleton](./code_language_ast_extractors.md#code-skeleton-数据结构) | 数据模型 | 提供 `CodeSkeleton`、`ClassSkeleton`、`FunctionSig` 数据结构 |

### 下游使用

本模块被以下模块使用：

| 模块 | 使用方式 |
|------|----------|
| [resource_and_document_taxonomy](./resource_and_document_taxonomy.md) | 在文档类型识别中使用这些提取器解析代码文件 |
| [content_extraction_schema_and_strategies](./content_extraction_schema_and_strategies.md) | 将提取的代码骨架用于内容索引和检索 |

## 新贡献者注意事项

### 1. tree-sitter 节点类型不是语义类型

tree-sitter 解析出来的是**语法树**节点，不是**语义树**节点。这意味着：

```cpp
// C++ 代码
template<typename T>
class Foo { };
```

在 tree-sitter 中，`Foo` 是一个 `type_identifier`，但它实际上是一个类。如果你的提取逻辑期望 "类" 一定对应 `class_specifier`，那你就无法处理模板类。

**解决方案**：提取器中大量使用了 `for child in node.children` 遍历和类型检查，这是为了处理语法树节点的嵌套结构。

### 2. 注释提取依赖节点位置

三个提取器都使用 `_preceding_doc` 函数，它通过检查**前一个兄弟节点**来判断是否有文档注释。这意味着：

- 注释必须**紧邻**目标声明，中间不能有空白行或其他声明
- 多行注释必须是目标声明的**直接前驱**

如果代码风格是：

```cpp
// Some comment

void function() { }  // 空白行分隔，注释不会被提取
```

那么 `function` 的 docstring 会是空字符串。

### 3. 每种语言的 import 格式不同

| 语言 | 提取的 import 类型 | 示例 |
|------|-------------------|------|
| C/C++ | `#include` 路径 | `"stdio.h"`, `"<vector>"` |
| Go | import 路径 | `"fmt"`, `"os/path"` |
| Rust | `use` 声明 | `std::collections::HashMap` |

这意味着下游模块在处理 import 信息时需要考虑语言差异。

### 4. 错误处理策略

这些提取器在遇到无法解析的代码时采用 **静默忽略** 策略：

```python
# CppExtractor 中的典型模式
for child in node.children:
    if child.type in ("class_specifier", "struct_specifier"):
        classes.append(_extract_class(child, content_bytes, docstring=doc))
    # 不在 else 分支抛出异常
```

如果某个节点类型无法识别，提取器会跳过它而不是抛出异常。这是有意为之的设计 — 即使部分解析失败，也应该返回部分结果，而不是完全失败。

### 5. 扩展新的语言

如果需要添加新的语言提取器（如 Java），参考以下步骤：

1. 在 `languages/` 目录下创建新文件（如 `java.py`）
2. 继承 `LanguageExtractor` 基类
3. 在 `__init__` 中加载 tree-sitter-java
4. 实现 `extract()` 方法，参考现有提取器的模式
5. 注册到 BaseParser 的文件类型映射中

## 常见问题

**Q: 为什么 C++ 提取器也处理 .h 文件？**
A: tree-sitter-cpp 能够解析 C 头文件语法。对于需要区分 C 和 C++ 的场景，可以在调用前根据文件扩展名选择不同的提取器。

**Q: 提取器如何处理宏定义？**
A: 当前设计**忽略宏定义**。宏在预处理器阶段展开，不属于 AST 的一部分。如果需要宏信息，需要使用专门的 C 预处理器解析器。

**Q: 如何处理编码问题？**
A: 提取器假设输入是 UTF-8 编码。如果遇到其他编码，在调用提取器前进行编码转换。

---

*相关文档：*
- *[base_parser](./parser_abstractions_and_extension_points.md#base_parser_abstract_class)* — 解析器抽象基类
- *[language_extractor_base](./parser_abstractions_and_extension_points.md#language_extractor_base)* — 提取器基类接口
- *[cpp_extractor](./systems_programming_ast_extractors-cpp_extractor.md)* — C++ 提取器详解
- *[go_extractor](./go_extractor.md)* — Go 提取器详解  
- *[rust_extractor](./systems-programming-ast-extractors-rust-extractor.md)* — Rust 提取器详解