# Go 语言 AST 提取器 (go_extractor)

## 模块概述

`go_extractor` 模块是 OpenViking 解析系统的核心组件之一，负责从 Go 源代码文件中提取结构化信息。想象一下：如果把一个 Go 源文件比作一栋建筑，这个模块的工作就像是生成一份"建筑蓝图"——它不关心砖墙的具体颜色或家具的摆放，而是提取关键的结构信息：有哪些房间（结构体/接口）、每个房间的入口在哪里（函数签名）、建筑使用了哪些建筑材料（import 依赖）。

这种"骨架提取"的能力对于代码检索、语义搜索和代码理解至关重要。当用户搜索"使用 了 go-redis 的 HTTP 处理器"时，系统需要快速定位到正确的文件和函数，而不是逐文件执行全文搜索。`GoExtractor` 正是这个流程的第一步：它将原始 Go 代码转换为机器可处理的结构化数据。

---

## 架构定位与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              解析请求入口                                      │
│                        (用户上传 Go 源文件 / 搜索请求)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ASTExtractor (extractor.py) — 语言检测 + 调度中心                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  1. 根据文件扩展名 (.go) 映射到语言 key: "go"                        │   │
│  │  2. 从注册表查找: ("openviking.parse...go", "GoExtractor", {})     │   │
│  │  3. 延迟加载并缓存 GoExtractor 实例                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  GoExtractor.extract(file_name, content) → CodeSkeleton                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  tree-sitter-go 解析 ──► AST 遍历 ──► 结构化提取                      │   │
│  │                                                                     │   │
│  │  输出:                                                              │   │
│  │    - imports: ["fmt", "net/http", "github.com/redis/go-redis"]    │   │
│  │    - classes: [ClassSkeleton(name="User", docstring="...")]       │   │
│  │    - functions: [FunctionSig(name="Handle", params="...", ...)]   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  CodeSkeleton.to_text(verbose=False) ──► 骨架文本                           │
│                                                                             │
│  # main.go [Go]                                                           │
│  imports: fmt, net/http, github.com/redis/go-redis                         │
│                                                                             │
│  class User                                                               │
│    """用户模型"""                                                         │
│    + GetID() string                                                       │
│                                                                             │
│  def Handle(w http.ResponseWriter, r *http.Request)                        │
│    """HTTP 处理器"""                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  下游消费者                                                                │
│  ┌──────────────────┬──────────────────┬──────────────────┐               │
│  │ 向量存储 (Embedding) │  代码搜索索引    │ LLM 上下文构建    │               │
│  └──────────────────┴──────────────────┴──────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 模块责任

`GoExtractor` 位于 `parsing_and_resource_detection` 下的 `systems_programming_ast_extractors` 分支，是系统编程语言 AST 提取器家族的一员（还有 `CppExtractor`、`RustExtractor` 等）。它的核心职责非常明确：

1. **接收**: 原始 Go 源代码文件内容和文件名
2. **解析**: 使用 tree-sitter-go 构建 AST
3. **提取**: 遍历 AST，提取 imports、classes（struct/interface）、functions/methods
4. **输出**: 返回结构化的 `CodeSkeleton` 对象

---

## 核心组件详解

### GoExtractor 类

```python
class GoExtractor(LanguageExtractor):
    def __init__(self):
        import tree_sitter_go as tsgo
        from tree_sitter import Language, Parser

        self._language = Language(tsgo.language())
        self._parser = Parser(self._language)

    def extract(self, file_name: str, content: str) -> CodeSkeleton:
        # 核心提取逻辑
        ...
```

**设计意图**: 

这个类的设计遵循了**模板方法模式**的变体。所有语言提取器都继承自 `LanguageExtractor` 基类并实现 `extract` 方法，保证了接口一致性。但每个提取器内部的 AST 遍历逻辑因语言语法差异而不同——Go 有 `import_declaration`、`type_declaration`，而 Rust 有 `use_declaration`、`struct_item`。

**lazy initialization（延迟初始化）**: 提取器实例在 `ASTExtractor` 中被缓存，但只在首次需要时才创建。这是因为 tree-sitter 解析器的初始化涉及绑定加载，比较重量级。

### 辅助函数

#### `_node_text(node, content_bytes) -> str`

```python
def _node_text(node, content_bytes: bytes) -> str:
    return content_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
```

**为什么需要这个函数**: tree-sitter 的 AST 节点只提供字节偏移量（`start_byte` / `end_byte`），不直接提供文本内容。这个小函数负责将偏移量转换为实际的源代码字符串。

**tradeoff**: 使用 `errors="replace"` 意味着遇到 UTF-8 解码错误时会插入替换字符而不是抛出异常。这是一种务实的选择——大多数代码文件是有效的 UTF-8，但边界情况下（如二进制文件误判为源码）不应该导致整个解析失败。

#### `_preceding_doc(siblings, idx, content_bytes) -> str`

```python
def _preceding_doc(siblings: list, idx: int, content_bytes: bytes) -> str:
    """Collect consecutive // comment lines immediately before siblings[idx]."""
    lines = []
    i = idx - 1
    while i >= 0 and siblings[i].type == "comment":
        raw = _node_text(siblings[i], content_bytes).strip()
        if raw.startswith("//"):
            raw = raw[2:].strip()
        lines.insert(0, raw)
        i -= 1
    return "\n".join(lines).strip()
```

**设计洞察**: 这个函数体现了 Go 语言代码风格的约定——Go 程序员习惯在函数/类型前放置行注释（`//` 注释）作为文档。提取器通过向前遍历兄弟节点来捕获这些注释。

注意它处理的是**行注释**（`//`），而非块注释（`/* */`）。这是 Go 社区的惯例，虽然 Go 也支持块注释，但官方文档约定优先使用行注释。

#### `_extract_function(node, content_bytes, docstring) -> FunctionSig`

```python
def _extract_function(node, content_bytes: bytes, docstring: str = "") -> FunctionSig:
    name = ""
    params = ""
    return_type = ""
    is_method = node.type == "method_declaration"
    param_list_count = 0

    for child in node.children:
        if child.type == "identifier" and not name:
            name = _node_text(child, content_bytes)
        elif child.type == "field_identifier" and not name:
            name = _node_text(child, content_bytes)
        elif child.type == "parameter_list":
            param_list_count += 1
            if is_method and param_list_count == 1:
                continue  # first parameter_list is receiver (s *Server), not params
            if not params:
                raw = _node_text(child, content_bytes).strip()
                if raw.startswith("(") and raw.endswith(")"):
                    raw = raw[1:-1]
                params = raw.strip()
        elif child.type == "type_identifier":
            return_type = _node_text(child, content_bytes)

    return FunctionSig(name=name, params=params, return_type=return_type, docstring=docstring)
```

**关键设计决策**: 这个函数区分了普通函数（`function_declaration`）和方法（`method_declaration`）。在 Go 中，方法声明有一个接收者（receiver）作为第一个参数列表，例如：

```go
func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
    // ...
}
```

这里的 `(s *Server)` 是接收者，不是函数参数。代码通过 `param_list_count == 1` 时跳过第一个参数列表来正确处理这种情况。

#### `_extract_struct(node, content_bytes, docstring) -> ClassSkeleton`

```python
def _extract_struct(node, content_bytes: bytes, docstring: str = "") -> ClassSkeleton:
    name = ""
    for child in node.children:
        if child.type == "type_identifier":
            name = _node_text(child, content_bytes)
            break
    return ClassSkeleton(name=name, bases=[], docstring=docstring, methods=[])
```

**注意**: Go 没有传统的类继承（没有 `bases` 概念），所以 `ClassSkeleton.bases` 始终为空列表。这里将 Go 的 `struct` 和 `interface` 都映射为"类"——这是一种简化的抽象，因为在提取"骨架"的目的上，它们都是用户定义的类型。

---

## 依赖关系分析

### 上游：谁调用这个模块？

| 调用者 | 调用方式 | 期望的契约 |
|--------|----------|------------|
| `ASTExtractor` (extractor.py) | `extractor.extract(file_name, content)` | 返回 `CodeSkeleton` 对象；失败时抛出异常 |
| 下游 consumers | `CodeSkeleton.to_text(verbose=)` | 返回可读的骨架文本字符串 |

### 下游：这个模块依赖谁？

| 依赖项 | 作用 | 依赖方式 |
|--------|------|----------|
| `LanguageExtractor` (基类) | 定义接口契约 `extract(file_name, content) -> CodeSkeleton` | 继承 |
| `tree-sitter-go` | Go 语言语法解析 | 动态 import |
| `tree-sitter` (Language, Parser) | 通用 AST 解析框架 | 动态 import |
| `CodeSkeleton`, `ClassSkeleton`, `FunctionSig` | 数据结构 | 从 `skeleton.py` 导入 |

### 数据契约

**输入**:
- `file_name`: str — 文件名（用于语言检测和骨架输出）
- `content`: str — 完整的 Go 源代码

**输出**: `CodeSkeleton`
```python
CodeSkeleton(
    file_name=str,           # 输入的文件名
    language="Go",           # 固定值
    module_doc="",           # 当前未实现（Go 没有模块级文档注释）
    imports=List[str],       # 所有 import 路径
    classes=List[ClassSkeleton],  # struct 和 interface
    functions=List[FunctionSig]   # 顶级函数和方法
)
```

---

## 设计决策与权衡

### 1. 为什么使用 tree-sitter 而不是正则表达式？

**备选方案**: 使用正则表达式提取函数签名和 import

**选择 tree-sitter 的理由**:
- **语法感知**: 正则表达式只能处理正则语言，而编程语言的语法是上下文无关的。例如，`func (s *Server) Handle()` 和 `func Handle()` 看起来相似但结构不同，正则很难区分。
- **错误容忍**: 即使代码有语法错误，tree-sitter 也能构建部分 AST 并继续提取——只要关键节点存在。
- **可维护性**: 增加新的提取目标（如 Go 1.18 的泛型）时，只需修改遍历逻辑，不需重写脆弱的正则。

**代价**: 需要为每种语言维护一个 tree-sitter grammar 绑定，增加了依赖复杂度。

### 2. 为什么不提取方法的完整信息？

当前实现中，`ClassSkeleton.methods` 始终为空列表。这意味着提取的类只有名称和文档，没有方法列表。

**原因**: 这是一种**渐进式简化**。在 `CodeSkeleton.to_text()` 的实现中，方法信息是可选的。对于代码骨架和 embedding 场景，函数级别的粒度通常足够。更完整的方法提取需要更复杂的 AST 遍历（需要进入 `func` 声明内部），这会增加复杂度。

**Tradeoff**: 当前设计选择了**简单性和性能**，牺牲了一些信息完整性。如果未来需要更完整的类信息，这是可扩展的点。

### 3. Docstring 的单行约定

```python
# skeleton.py 中
def _doc(raw: str, indent: str) -> List[str]:
    first = raw.split("\n")[0].strip()  # 只取第一行
    if not verbose:
        return [f'{indent}"""{first}"""']
```

**设计意图**: 当 `verbose=False`（用于 embedding）时，只保留 docstring 的第一行。这是因为：
1. embedding 模型的上下文窗口有限
2. 第一行通常是高层次的摘要（如 "Handle HTTP requests"）
3. 完整的文档对于搜索相关性判断不是必需的

这是一个典型的**信息密度 vs 完整性**权衡。

### 4. 模块级单例 vs 实例化

```python
# extractor.py
_extractor: Optional[ASTExtractor] = None

def get_extractor() -> ASTExtractor:
    global _extractor
    if _extractor is None:
        _extractor = ASTExtractor()
    return _extractor
```

`ASTExtractor` 使用模块级单例，但 `GoExtractor` 本身不设单例——而是在 `ASTExtractor` 中缓存。这是一种**两级缓存策略**：语言检测器是单例，每个语言提取器实例按需创建并缓存。

**优点**: 
- 避免重复初始化 tree-sitter 解析器（重量级操作）
- 支持不同的提取器配置（虽然当前都用默认配置）

---

## 使用指南与扩展

### 基本用法

```python
from openviking.parse.parsers.code.ast.extractor import get_extractor

extractor = get_extractor()

# 提取骨架文本
skeleton_text = extractor.extract_skeleton("handler.go", go_source_code)
print(skeleton_text)

# 输出:
# # handler.go [Go]
# imports: fmt, net/http, github.com/redis/go-redis
#
# class User
#   """用户模型"""
#
# def Handle(w http.ResponseWriter, r *http.Request)
#   """HTTP 请求处理器"""
```

### 扩展：如果要添加新语言

1. 在 `_EXT_MAP` 添加扩展名映射
2. 在 `_EXTRACTOR_REGISTRY` 注册提取器类
3. 实现新的 `LanguageExtractor` 子类

```python
# 示例：添加 Zig 支持
_EXT_MAP[".zig"] = "zig"
_EXTRACTOR_REGISTRY["zig"] = (
    "openviking.parse.parsers.code.ast.languages.zig", 
    "ZigExtractor", 
    {}
)
```

### 关键配置

目前 `GoExtractor` 没有可配置参数。解析器使用默认配置，这足以应对绝大多数 Go 代码。如果未来需要处理特殊场景（如自定义 Go 方言），可以通过扩展 `__init__` 参数来实现。

---

## 边界情况与注意事项

### 1. 语法错误不会导致完全失败

tree-sitter 即使在代码有语法错误时也能构建部分 AST。`GoExtractor` 的遍历逻辑会跳过不完整的节点，但可能产生不完整的骨架。例如：

```go
func Handle(w http.ResponseWriter  // 缺少右括号
```

这个函数可能不会被提取（因为参数列表不完整），但不会导致整个文件解析崩溃。

### 2. 泛型支持（Go 1.18+）

当前实现**不处理**泛型。Go 1.18 引入了类型参数，例如：

```go
func Map[T any](slice []T, fn func(T) T) []T
```

`param_list` 会包含类型参数，但提取逻辑不会解析它们——`params` 字段会包含原始的 `[T any]` 文本。这可能导致 embedding 质量略有下降，但不会崩溃。

### 3. 注释 vs 文档

提取器只捕获行注释（`// comment`），不处理：
- 块注释（`/* ... */`）除非它们恰好是单行的
- 包级文档注释（文件开头的 `// Package xxx`）

如果要改进文档提取，需要在根节点级别额外处理包声明。

### 4. 性能特性

- **首次调用**: 需要加载 tree-sitter-go 绑定（约 10-50ms，取决于系统）
- **后续调用**: 解析 1000 行的 Go 文件约需 1-5ms
- **内存**: 每个 Parser 实例约占用 1-2MB

由于 `ASTExtractor` 缓存了解析器实例，重复调用的性能很好。

---

## 相关模块

- [base_parser_abstract_class](parsing_and_resource_detection-base_parser_abstract_class.md) — 所有文档解析器的基类
- [language_extractor_base](parsing_and_resource_detection-language_extractor_base.md) — AST 提取器的接口定义
- [cpp_extractor](parsing_and_resource_detection-systems_programming_ast_extractors-cpp_extractor.md) — C++ 提取器（对比参考）
- [rust_extractor](parsing_and_resource_detection-systems_programming_ast_extractors-rust_extractor.md) — Rust 提取器（对比参考）
- [extractor](parsing_and_resource_detection-extractor.md) — AST 提取器的调度中心