# go_extractor 模块技术深度解析

## 概述：它解决了什么问题？

**go_extractor** 是 OpenViking 项目中专门用于解析 Go 语言源代码的 AST（抽象语法树）提取器。想象一下这样的场景：用户上传了一个包含数十个 Go 源文件的代码仓库，系统需要理解这个代码库的结构——有哪些模块、定义了哪些结构体、导出了哪些函数/方法——以便后续进行语义检索、知识图谱构建或代码理解。

一个朴素的解决方案是直接把源码文本喂给 LLM，但这有三个致命问题：第一，代码文件可能很大（比如一个 Go 文件几千行）， token 成本爆炸；第二，LLM 在处理超大文本时容易遗漏细节，结构化信息提取不完整；第三，每次检索都调用 LLM 太慢且太贵。

**go_extExtractor 的设计洞察在于**：对于 Go 这类编译型语言，代码结构是高度规范化的——函数有明确的签名、结构体有明确的字段、方法有明确的接收者。我们可以用**tree-sitter**这个编译器前端工具精确地解析 AST，然后只提取"骨架"信息：函数签名、类型定义、import 声明。这样做的好处是提取结果极度精简（可能只是原文的 5% 大小），同时保留了最核心的语义信息。后续可以用这个骨架做向量嵌入用于检索，也可以喂给 LLM 做更深入的分析。

---

## 架构角色与数据流

### 在整个系统中的位置

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CodeRepositoryParser                          │
│              (处理 Git 仓库/ZIP 包下载和上传)                       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ASTExtractor                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ _EXT_MAP: .go → "go"                                       │   │
│  │ _EXTRACTOR_REGISTRY: "go" → (go.py, GoExtractor, {})        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
   │ PythonExtractor │  │ GoExtractor   │   │ RustExtractor │
   └─────────────┘    └─────────────┘    └─────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CodeSkeleton                                   │
│  (imports, classes, functions → to_text() → 骨架文本)              │
└─────────────────────────────────────────────────────────────────────┘
```

**go_extractor** 在整个解析流水线中扮演的是 **"语言无关的结构化提取层"** 角色。它的上游是 `ASTExtractor`（路由器），下游是 `CodeSkeleton`（数据容器）。它不关心代码从哪里来、是 Git 仓库还是 ZIP 包，它只负责：给定一个 Go 源文件的内容，输出一个结构化的代码骨架。

### 关键依赖关系

| 依赖类型 | 模块/类 | 作用 |
|---------|---------|------|
| **基类** | `LanguageExtractor` | 定义 `extract(file_name, content) -> CodeSkeleton` 契约 |
| **输出结构** | `CodeSkeleton`, `ClassSkeleton`, `FunctionSig` | 承载提取结果的数据容器 |
| **AST 解析** | `tree_sitter_go`, `tree_sitter.Language`, `tree_sitter.Parser` | 实际的 Go 语法树解析能力 |
| **辅助函数** | `_node_text()`, `_preceding_doc()`, `_extract_function()`, `_extract_struct()` | 递归遍历 AST 节点的工具函数 |

---

## 核心抽象与设计思路

### 1. 继承结构：LanguageExtractor 契约

所有语言提取器都继承自 `LanguageExtractor`：

```python
class LanguageExtractor(ABC):
    @abstractmethod
    def extract(self, file_name: str, content: str) -> CodeSkeleton:
        """Extract code skeleton from source. Raises on unrecoverable error."""
```

这个抽象基类定义了**统一的契约**：不管你是 Python、Go 还是 Rust，接口完全一致。好处是上游 `ASTExtractor` 可以用完全相同的代码调用所有语言提取器，不需要任何分支判断。这是一种**策略模式**的应用——每种语言是一个独立的提取策略。

### 2. 输出结构：CodeSkeleton 三件套

提取结果装在 `CodeSkeleton` 里，它包含三个核心集合：

- **imports**: 所有 import 声明，平铺成字符串列表
- **classes**: Go 的 struct 和 interface（注意 Go 没有 class 关键字，但概念对应）
- **functions**: 顶层函数声明 + 方法声明

每个 `FunctionSig` 包含：函数名、原始参数字符串、返回类型、文档字符串。参数和返回值都是**原始字符串**而非结构化对象——这是有意为之的设计选择。原样保留参数文本（如 `"ctx context.Context, opts ...Option"`）的好处是简单且保留所有细节，缺点是后续如果要结构化解析参数需要额外处理。代码注释里说明了这一点："raw parameter string"。

### 3. 遍历策略：平铺兄弟节点

`GoExtractor.extract()` 方法的核心逻辑是**遍历根节点的直接子节点**：

```python
siblings = list(root.children)
for idx, child in enumerate(siblings):
    if child.type == "import_declaration":
        # 处理 import
    elif child.type in ("function_declaration", "method_declaration"):
        # 处理函数/方法
    elif child.type == "type_declaration":
        # 处理 struct/interface
```

这种**单层遍历**的设计哲学是：Go 的顶层声明（import、function、type）确实是根节点的直接子节点，不需要递归。对于嵌套结构（如函数体内部），我们选择**不提取**——这是权衡的结果：我们只需要骨架信息，不需要函数体内部的实现细节。提取更多意味着更大的骨架、更慢的解析、可能引入更多错误。

---

## 核心组件深度解析

### GoExtractor 类

```python
class GoExtractor(LanguageExtractor):
    def __init__(self):
        import tree_sitter_go as tsgo
        from tree_sitter import Language, Parser
        self._language = Language(tsgo.language())
        self._parser = Parser(self._language)
```

**初始化逻辑**：在构造时加载 tree-sitter-go 绑定并创建 Parser 实例。这是**延迟初始化**的典型应用——Parser 在构造时创建一次，之后每次 `extract()` 调用复用同一个 Parser 实例，避免重复创建的开销。

**extract() 方法流程**：

1. **编码转换**：`content.encode("utf-8")` —— tree-sitter 要求字节输入
2. **解析**：`self._parser.parse(content_bytes)` → 返回语法树
3. **根节点遍历**：对 root.children 做一次线性扫描
4. **分类处理**：根据节点类型分发到不同提取函数
5. **结果组装**：构造并返回 CodeSkeleton

### 四个辅助函数

#### `_node_text(node, content_bytes)` — 节点文本提取

```python
def _node_text(node, content_bytes: bytes) -> str:
    return content_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
```

这是最底层的工具函数：通过 AST 节点的字节偏移量直接切片原文。`errors="replace"` 意味着遇到 UTF-8 解码错误会插入替换字符而不是崩溃——这是一个防御性设计，代码中可能出现非标准字符。

#### `_preceding_doc(siblings, idx, content_bytes)` — 文档字符串提取

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

这个函数展示了 Go 特有的注释提取逻辑：Go 的文档注释是**连续的行注释**（以 `//` 开头），出现在声明之前。它从当前节点往前找连续的 comment 节点，收集起来组成文档字符串。注意它**只处理行注释**（`//`），不处理块注释（`/* ... */`）——这是 Go 社区的约定，块注释通常用于包级注释或禁用代码。

#### `_extract_function(node, content_bytes, docstring)` — 函数/方法提取

这是最复杂的提取函数，需要处理 Go 的几个特殊性：

- **方法 vs 函数**：`node.type == "method_declaration"` 表示方法
- **接收者参数**：方法的第一个 `parameter_list` 是接收者（如 `func (s *Server)`），不是正式参数，需要跳过
- **双 identifier**：Go 函数用 `identifier`，方法用 `field_identifier`，两者都要匹配

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
            name = _node_text(child, content_bytes)  # 方法名
        elif child.type == "parameter_list":
            param_list_count += 1
            if is_method and param_list_count == 1:
                continue  # 跳过接收者
            if not params:
                raw = _node_text(child, content_bytes).strip()
                if raw.startswith("(") and raw.endswith(")"):
                    raw = raw[1:-1]
                params = raw.strip()
        elif child.type == "type_identifier":
            return_type = _node_text(child, content_bytes)
```

#### `_extract_struct(node, content_bytes, docstring)` — 结构体/接口提取

```python
def _extract_struct(node, content_bytes: bytes, docstring: str = "") -> ClassSkeleton:
    name = ""
    for child in node.children:
        if child.type == "type_identifier":
            name = _node_text(child, content_bytes)
            break
    return ClassSkeleton(name=name, bases=[], docstring=docstring, methods=[])
```

注意 Go 的 `ClassSkeleton` 里 `bases` 是空列表——Go 没有类继承，struct 和 interface 都不继承任何类型。这里复用 `ClassSkeleton` 但 `bases` 留空，是一种**妥协设计**：为了保持接口统一，在 Go 的语境下"类"就是 struct/interface。

---

## 设计决策与权衡

### 1. 为什么用 tree-sitter 而不是正则表达式？

有人可能会问：提取函数签名用正则不行吗？`func (\w+)\((.*)\) (.*)` 之类。

**答案**：正则无法处理嵌套结构。考虑这个 Go 函数：

```go
func Process(ctx context.Context, opts ...Option) (Result, error)
```

- 正则需要处理嵌套括号 `(...)`
- 正则无法区分参数列表和返回类型中的括号
- 正则无法处理多行格式、注释、空格变化

tree-sitter 是专门为**精确语法分析**设计的，它理解语言的完整文法，输出结构化的 AST。正则则是"暴力猜测"，在复杂场景下容易失败。

### 2. 为什么只提取顶层声明，不递归到函数体内部？

这是**信息粒度的刻意选择**。

**选项 A**：提取所有内容（函数体、嵌套类型、局部变量）→ 骨架变得和原文一样大，失去了"精简"的优势

**选项 B**：只提取顶层声明 → 骨架精简到原文的 5-10%，保留核心 API 表面积

选项 B 更符合**检索增强（RAG）场景**的需求：我们关心的是"这个文件导出了什么"，而不是"函数内部怎么实现"。如果你需要函数体内容，可以把原文交给 LLM。

### 3. 为什么不结构化参数列表？

`FunctionSig.params` 是原始字符串 `"ctx context.Context, opts ...Option"` 而不是拆成 `[(name="ctx", type="context.Context"), ...]`。

**原因**：简化实现 + 保留完整性。拆解参数列表需要处理：
- 命名前的 `*`, `...`, `[ ]` 等修饰符
- 多返回值 tuple
- 命名的返回值 `(result string, err error)`
- 参数名可能被省略的情况

当前设计把这个复杂性转移给**消费者**：如果需要结构化参数，自己解析这个字符串。`CodeSkeleton.to_text()` 的 `_compact_params()` 函数就是一个简单的消费者示例。

### 4. 错误处理策略：优雅降级

```python
try:
    skeleton = extractor.extract(file_name, content)
    return skeleton.to_text(verbose=verbose)
except Exception as e:
    logger.warning("AST extraction failed for '%s', falling back to LLM: %s", ...)
    return None
```

任何解析异常都不会抛出，而是返回 `None` 上层的 `ASTExtractor` 会捕获这个 `None`，回退到 LLM 提取。这是一个**防御性设计**：代码可能包含语法错误、tree-sitter-go 可能未安装、各种边界情况——我们不想因为一个文件解析失败导致整个仓库处理失败。

---

## 常见陷阱与注意事项

### 1. Go 特有的 node type 名称

tree-sitter-go 使用的 AST 节点类型名称和 Go 语法关键字不完全一致。例如：
- `function_declaration` ≠ `func` 关键字
- `method_declaration` 是方法（带接收者）
- `type_identifier` 用于结构体/接口名称
- `field_identifier` 用于方法名

如果你修改代码，需要对照 tree-sitter-go 的语法文件确认节点类型名称。

### 2. import 的两种形式

Go 有两种 import 语法：

```go
import "fmt"                    // 形式1：单行
import (                         // 形式2：分组
    "os"
    "time"
)
```

代码需要处理这两种情况：单行 import 的节点结构是 `import_declaration` → `import_spec` → `interpreted_string_literal`，分组 import 是 `import_declaration` → `import_spec_list` → `import_spec` → `interpreted_string_literal`。

### 3. 方法接收者被当作第一个参数列表

```go
func (s *Server) Handle(ctx context.Context) error {
```

在 AST 中，这个 `(s *Server)` 和参数 `(ctx context.Context)` 都是 `parameter_list` 节点。代码用 `param_list_count` 区分：第一个 parameter_list 是接收者，跳过它。

### 4. 注释提取的局限性

`_preceding_doc` 只能处理**紧邻声明前的连续行注释**，以下情况会丢失文档：
- 注释和声明之间有空行
- 使用块注释 `/* ... */` 的情况
- 跨多行声明（tree-sitter 可能把第一行和后续行分到不同的节点）

### 5. UTF-8 解码 replace 策略

```python
.decode("utf-8", errors="replace")
```

如果 Go 源文件中包含非 UTF-8 字符（如 GBK 编码的中文注释），不会抛出异常，而是把无法解码的字节替换为 ``。这意味着提取的文档字符串可能包含乱码字符，但至少不会崩溃。

---

## 与其他语言提取器的对比

| 特性 | GoExtractor | CppExtractor | RustExtractor |
|------|-------------|--------------|---------------|
| AST 库 | tree_sitter_go | tree_sitter_cpp | tree_sitter_rust |
| 顶级声明遍历 | ✅ | ✅ | ✅ |
| 命名空间处理 | 不需要 | ✅ (namespace_definition) | 不需要 |
| trait/interface | interface_type | - (只有 class) | trait_item |
| 方法接收者 | 特殊处理 | 隐含在 class 内 | 隐含在 impl 内 |
| import 形式 | 单行+分组 | #include | use declaration |

从对比可以看出，三种提取器遵循相同的基本模式（遍历根节点、按类型分发），但在处理各自语言的特殊语法时有所不同。这是**模板方法模式**的应用：基类定义骨架，子类填充语言特定逻辑。

---

## 使用示例

### 直接使用 GoExtractor

```python
from openviking.parse.parsers.code.ast.languages.go import GoExtractor

extractor = GoExtractor()

go_code = '''
package main

import "fmt"

// Greet returns a greeting message.
func Greet(name string) string {
    return fmt.Sprintf("Hello, %s!", name)
}

// Server represents a server instance.
type Server struct {
    Host string
    Port int
}

// Handle processes requests.
func (s *Server) Handle(req Request) error {
    return nil
}
'''

skeleton = extractor.extract("main.go", go_code)
print(skeleton.to_text())
```

输出：

```
# main.go [Go]
imports: fmt

class Server
  """Server represents a server instance."""
  + Host: string
  + Port: int

def Greet(name string) string
  """Greet returns a greeting message."""

def Handle(req Request) error
```

### 通过 ASTExtractor 间接使用

```python
from openviking.parse.parsers.code.ast.extractor import get_extractor

extractor = get_extractor()
result = extractor.extract_skeleton("main.go", go_code, verbose=True)
# verbose=True 会输出完整文档字符串，否则只输出第一行
```

---

## 参考资料

- [LanguageExtractor 基类定义](parsing_and_resource_detection-parser_abstractions_and_extension_points-language_extractor_base.md)
- [CodeSkeleton 数据结构](parsing_and_resource_detection-code_language_ast_extractors-scripting_language_ast_extractors-python_extractor.md) — 包含 to_text() 的详细说明
- [ASTExtractor 路由器](parsing_and_resource_detection-code_language_ast_extractors-ast_extractor.md) — 了解如何dispatch到具体提取器
- [CppExtractor 对比](parsing_and_resource_detection-code_language_ast_extractors-systems_programming_ast_extractors-cpp_extractor.md)
- [RustExtractor 对比](parsing_and_resource_detection-code_language_ast_extractors-systems_programming_ast_extractors-rust_extractor.md)