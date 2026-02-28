# Python AST 提取器

## 概述

`PythonExtractor` 是六种语言提取器中**功能最完整**的一个。它使用 `tree-sitter-python` 解析 Python 源代码，提取以下信息：
- 模块级 docstring
- 所有 import 语句（包括 `from ... import ... 形式）
- 类定义及其方法
- 顶层函数定义

这是唯一能提取**模块级 docstring** 的提取器，也是唯一一个在同一个 `CodeSkeleton` 中同时包含类和顶层函数的提取器（Java 提取器只提取类，C++ 提取器不提取方法）。

## 核心组件

### PythonExtractor

```python
class PythonExtractor(LanguageExtractor):
    def __init__(self):
        import tree_sitter_python as tspython
        from tree_sitter import Language, Parser
        self._language = Language(tspython.language())
        self._parser = Parser(self._language)

    def extract(self, file_name: str, content: str) -> CodeSkeleton:
        # 解析源码，返回结构化骨架
```

**设计意图**：
- `__init__` 中延迟导入 `tree_sitter_python`——这是为了避免在模块加载时就触发 tree-sitter 的编译（如果还没装的话会报错）
- `Parser` 对象在初始化时创建，整个生命周期复用——符合"解析器应该被重用"的最佳实践

### 辅助函数

| 函数 | 职责 |
|------|------|
| `_node_text(node, content_bytes)` | 从 AST 节点提取原始文本（字节切片→字符串） |
| `_first_string_child(body_node, content_bytes)` | 提取函数/类体的第一个字符串字面量作为 docstring |
| `_extract_function(node, content_bytes)` | 从 `function_definition` 节点提取函数签名 |
| `_extract_class(node, content_bytes)` | 从 `class_definition` 节点提取类及其方法 |
| `_extract_imports(node, content_bytes)` | 将 import 语句扁平化为模块/符号路径 |

## 数据流详解

### 1. 解析阶段

```python
content_bytes = content.encode("utf-8")
tree = self._parser.parse(content_bytes)
root = tree.root_node
```

**注意**：这里假设源码是 UTF-8 编码。GBK 等老文件会导致解析结果异常。

### 2. Docstring 提取

Python 特有的灵活之处：docstring 可以是模块级的、类级的、函数级的，且可以是三种引号形式：

```python
# 三引号
"""这是 docstring"""

# 单引号三连
'''这也是 docstring'''

# 普通引号
"这也是"
```

`_first_string_child` 函数处理了所有这些情况：
```python
for q in ('"""', "'''", '"', "'"):
    if raw.startswith(q) and raw.endswith(q) and len(raw) >= 2 * len(q):
        return raw[len(q):-len(q)].strip()
```

### 3. 导入语句的复杂处理

Python 的 import 语法比其他语言复杂得多：

```python
import os                  # 简单 import
import os.path as p        # alias
from os import path        # from import
from os import path as p   # from import + alias
from . import local        # 相对导入
from .foo import bar       # 相对 from import
from os import *           # wildcard
```

`_extract_imports` 函数尝试覆盖所有这些情况，返回扁平化的字符串列表：
```python
# 返回示例
["os", "os.path", "os.path as p", "path", "p", "local", "foo.bar", "*"]
```

**局限**：
- 相对导入的前缀（如 `.`）被保留了，但语义信息（"这是相对导入"）丢失了
- wildcard import 返回 `module.*`，但无法知道具体导入了哪些符号

### 4. 装饰器函数的处理

Python 支持装饰器语法：
```python
@decorator
class Foo:
    pass

@decorator
def bar():
    pass
```

提取器对 `decorated_definition` 做了特殊处理：
```python
elif child.type == "decorated_definition":
    for sub in child.children:
        if sub.type == "class_definition":
            classes.append(_extract_class(sub, content_bytes))
            break
        elif sub.type == "function_definition":
            functions.append(_extract_function(sub, content_bytes))
            break
```

**注意**：装饰器本身的信息被丢弃了。如果需要保留装饰器列表，需要扩展 `ClassSkeleton` 和 `FunctionSig`。

## 输出示例

给定这样的 Python 代码：

```python
"""模块文档字符串"""

import os
from typing import List, Optional


class User:
    """用户类"""
    def __init__(self, name: str):
        self.name = name
    
    def greet(self) -> str:
        """打招呼"""
        return f"Hello, {self.name}"


def process(items: List[str]) -> Optional[str]:
    """处理列表"""
    return items[0] if items else None
```

提取结果（`to_text(verbose=False)`）：

```
# example.py [Python]
module: "模块文档字符串"
imports: os, typing.List, typing.Optional

class User("用户类")
  + __init__(name: str)
  + greet(self) -> str
    """打招呼"""

def process(items: List[str]) -> Optional[str]
  """处理列表"""
```

## 与其他语言提取器的差异

| 特性 | Python | Java | JavaScript | Go | Rust | C++ |
|------|--------|------|------------|-----|------|-----|
| 模块 docstring | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 顶层函数 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 装饰器处理 | ✅ | N/A | N/A | N/A | N/A | N/A |
| wildcard import | ✅ | N/A | N/A | N/A | N/A | N/A |

## 潜在问题与边界情况

### 1. 多行 docstring 只取第一行？

不完全是。`to_text(verbose=False)` 会把多行 docstring 压缩成一行，但 `_first_string_child` 实际上提取的是**整个 docstring**，只是最后输出时被截断了。

如果你需要完整的 docstring，使用 `to_text(verbose=True)`。

### 2. 类型注解 vs 原始类型

```python
def foo(x: List[int]) -> Optional[str]:
    pass
```

`return_type` 会是 `Optional[str]`（字符串），而不是一个结构化的类型对象。这意味着下游无法知道 `Optional` 的参数是 `str`。

这是设计上的取舍——见主文档的"为什么返回原始字符串而不是类型对象"章节。

### 3. 类方法 vs 类属性

当前提取器**不提取类属性**（class attributes）：

```python
class Foo:
    name = "default"  # 这不会被提取
    def method(self): # 这会
        pass
```

如果要支持属性提取，需要在 `_extract_class` 中增加对 `assignment` 节点类型的处理。

### 4. 嵌套类和内部函数

只提取**顶层**的定义。嵌套类不会被提取：

```python
class Outer:
    class Inner:  # 不会被提取
        pass
    
    def inner_func(self):  # 不会被提取
        pass
```

这是因为提取器只遍历 `root.children`，不递归进入嵌套结构。

### 5. 异步函数

```python
async def fetch_data():
    pass
```

`async` 关键字被忽略了。`FunctionSig` 中没有字段表示"这是异步函数"。如果要支持，需要添加 `is_async: bool` 字段。

### 6. 复杂类型注解

```python
def foo(x: Callable[[int, str], List[dict]]) -> Generator[int, None, None]:
    pass
```

这种复杂的泛型类型会作为原始字符串存储，但括号平衡可能有问题。在某些边界情况下，`_compact_params` 可能会产生奇怪的结果。