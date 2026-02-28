# 自定义解析器协议与适配器

## 概述

`custom_parser_protocol_and_wrappers` 模块是 OpenViking 解析系统的**扩展点**。试想一下：系统内置支持 PDF、Markdown、HTML 等常见格式，但用户可能需要解析领域特定的专有文件格式（比如 `.xyz` 工程文件、`.matlab` 脚本、或者某种遗留系统的配置文件）。这个模块解决的问题就是：**如何在不修改核心解析系统的情况下，让外部代码以统一的方式接入新的解析能力？**

该模块提供了两种扩展路径：一种是**协议驱动**（Protocol-based），适合需要复杂状态的完整解析器；另一种是**回调驱动**（Callback-based），适合轻量级的一次性解析逻辑。二者最终都被适配成 `BaseParser` 接口，无缝融入 [ParserRegistry](parsing_and_resource_detection-parser_abstractions_and_extension_points-parser_registry.md) 的选择与调度体系。

---

## 架构角色与数据流

### 组件定位

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ParserRegistry                              │
│  (全局单例，负责解析器注册、选择、调度)                              │
└─────────────────────┬───────────────────────┬──────────────────────┘
                      │                       │
          ┌───────────┴───────────┐  ┌───────┴────────┐
          │   内置解析器           │  │  自定义扩展     │
          │   (PDF/MD/HTML...)    │  │  (本模块提供)  │
          └───────────────────────┘  └───────┬────────┘
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      │                      │                      │
          ┌───────────┴───────────┐  ┌───────┴────────┐  ┌─────────┴────────┐
          │  CustomParserWrapper  │  │ CallbackParser │  │  CustomParser    │
          │  (协议适配器)          │  │ Wrapper        │  │  Protocol        │
          │                       │  │ (回调适配器)   │  │  (接口定义)       │
          └───────────────────────┘  └────────────────┘  └──────────────────┘
```

### 核心数据流

**路径一：协议驱动扩展**

1. 用户实现 `CustomParserProtocol` 接口的类（`can_handle()`、`parse()`、`supported_extensions`）
2. 调用 `registry.register_custom(handler, extensions, name)` 注册
3. 内部创建 `CustomParserWrapper` 将协议对象适配为 `BaseParser`
4. 当解析文件时，Registry 根据扩展名找到对应包装器，调用其 `parse()` 方法

**路径二：回调驱动扩展**

1. 用户定义一个异步函数 `async def my_parser(source, **kwargs) -> ParseResult`
2. 调用 `registry.register_callback(".xyz", my_parser, name)` 注册
3. 内部创建 `CallbackParserWrapper` 将函数包装为 `BaseParser`
4. 后续使用方式与路径一相同

---

## 核心组件详解

### 1. CustomParserProtocol —— 接口契约

```python
@runtime_checkable
class CustomParserProtocol(Protocol):
    def can_handle(self, source: Union[str, Path]) -> bool: ...
    async def parse(self, source: Union[str, Path], **kwargs) -> ParseResult: ...
    @property
    def supported_extensions(self) -> List[str]: ...
```

**设计意图**：这是一个 **Protocol**（来自 `typing_extensions`），而非抽象基类。使用 `Protocol` 的关键优势是**结构化类型检查**——任何对象只要具备这三个方法/属性，就可以在运行时被识别为符合协议，而无需显式继承。

**为什么不用 ABC**？如果使用 `BaseParser` 的抽象基类，任何自定义解析器都必须继承它，引入不必要的继承耦合。Protocol 允许"鸭子类型"式的接入——你的类可能已经服务于其他目的，只需要实现这三个方法就能接入解析系统。

**`runtime_checkable` 的作用**：允许在运行时用 `isinstance(obj, CustomParserProtocol)` 进行动态检查，`CustomParserWrapper.__init__` 正是利用这一点做类型验证。

**核心契约**：

- `can_handle()`：决定该解析器是否"感兴趣"处理某个文件。这是比单纯依赖扩展名更灵活的机制——比如一个解析器可以基于文件魔数（magic bytes）甚至文件内容来做判断。
- `parse()`：核心解析逻辑，返回标准化的 `ParseResult`。
- `supported_extensions`：声明支持的扩展名列表，用于 Registry 构建扩展名→解析器的映射表。

### 2. CustomParserWrapper —— 协议到基类的适配器

```python
class CustomParserWrapper:
    def __init__(self, custom_parser: CustomParserProtocol, extensions: Optional[List[str]] = None):
        if not isinstance(custom_parser, CustomParserProtocol):
            raise TypeError(...)
        self.custom_parser = custom_parser
        self._extensions = extensions or custom_parser.supported_extensions
```

**设计模式**：这是经典的 **Adapter（适配器）模式**。它将不符合 `BaseParser` 接口的外部对象，包装成符合接口的"合规"对象。

**为什么需要这个包装器？**

- `BaseParser` 定义了 `parse()` 和 `parse_content()` 两个抽象方法，以及 `supported_extensions` 属性和 `can_parse()` 方法
- `CustomParserProtocol` 定义的是 `can_handle()`（而非 `can_parse()`）和 `parse()`（语义相同但可能不支持 `parse_content`）
- 包装器负责翻译这些差异：`_extensions` 映射到 `supported_extensions`，`can_handle()` 映射到 `can_parse()`，`parse_content()` 默认抛出 `NotImplementedError`（因为大多数自定义解析器是基于文件路径的）

**一个微妙的设计点**：`extensions` 参数允许**覆盖**解析器自身的扩展名声明。这在什么场景有用？当你的自定义解析器可以处理多种格式，但你只想按需注册其中一部分时；或者当你需要为同一扩展名注册多个解析器（通过不同名称）时。

### 3. CallbackParserWrapper —— 函数到基类的适配器

```python
class CallbackParserWrapper:
    def __init__(self, extension: str, parse_fn: Callable[..., ParseResult], name: Optional[str] = None):
        self.extension = extension
        self.parse_fn = parse_fn
        self.name = name or f"callback_{extension}"
```

**设计意图**：这是**命令模式**的轻量级实现。想象你只是想写一个快速的一次性解析逻辑，不需要封装成一个完整的类实例——回调包装器让你直接把函数注册为解析器。

**与 CustomParserWrapper 的对比**：

| 维度 | CustomParserWrapper | CallbackParserWrapper |
|------|---------------------|----------------------|
| 适用场景 | 需要维护状态、配置、资源的复杂解析器 | 简单的一次性解析逻辑 |
| 状态管理 | 实例自身携带 | 无状态，仅依赖闭包或全局函数 |
| 扩展名 | 支持多个扩展名 | 单一扩展名 |
| can_handle 逻辑 | 委托给自定义对象 | 简单的前缀匹配（`str(path).lower().endswith(self.extension)`) |

**为什么区分这两者？** 这是**简单性 vs 功能性**的经典 tradeoff。如果你只需要处理 `.xyz` 文件并返回固定结构的 ParseResult，创建一个完整的类并实现 Protocol 是过度设计。回调包装器降低了接入门槛。

---

## 依赖分析

### 上游依赖（该模块引用了什么）

| 依赖模块 | 用途 |
|----------|------|
| `openviking.parse.base` | `ParseResult`（返回值类型）, `ResourceNode`, `NodeType`, `create_parse_result`（辅助函数） |
| `typing_extensions.Protocol`, `runtime_checkable` | 实现运行时可检查的 Protocol 接口 |
| `pathlib.Path`, `typing` | 标准库基础类型 |

### 下游依赖（什么模块调用该模块）

| 依赖模块 | 调用方式 |
|----------|----------|
| `openviking.parse.registry.ParserRegistry` | `register_custom()` 创建 `CustomParserWrapper`；`register_callback()` 创建 `CallbackParserWrapper` |
| 终端用户代码 | 直接实例化包装器，或通过 Registry 间接使用 |

### 数据契约

**输入**：用户提供的解析器对象或回调函数

**输出**：符合 `BaseParser` 接口的包装器实例

关键约束：

- 自定义解析器的 `parse()` 必须返回 `ParseResult`（非 None）
- `ParseResult.root` 必须是有效的 `ResourceNode`（非 None）
- 所有自定义解析器共享同一个约束：文件路径优先，内容字符串解析可能不支持

---

## 设计决策与 tradeoff

### 1. Protocol vs 抽象基类（ABC）

**决策**：选择 Protocol + runtime_checkable

**权衡分析**：

- **优点**：零耦合——你的自定义解析器可以是任何类，无需继承 hierarchies；运行时检查比静态类型检查更灵活
- **缺点**：静态类型检查器无法在编译期验证接口完整性（虽然 `runtime_checkable` 允许 `isinstance` 检查，但它不会在类型推导中带来额外保障）

**适用场景判断**：如果你需要编译期安全网，倾向于用 ABC；如果你追求接入灵活性和运行时动态检查，Protocol 更合适。当前设计选择 Protocol，反映了"优先灵活接入"的设计哲学。

### 2. 两个扩展点而非一个

**决策**：同时提供协议模式和回调模式

**权衡分析**：

- **优点**：覆盖轻量到重量级的各种需求；回调模式降低入门门槛，协议模式提供完整控制
- **缺点**：两套 API 增加认知负荷；需要维护两份适配逻辑

**设计洞察**：这不是过度设计，而是**渐进式复杂度**的体现。系统预期用户从简单的回调开始，逐步过渡到需要状态/资源管理的协议模式。

### 3. parse_content 的 NotImplementedError 策略

**决策**：两个包装器默认都不支持 `parse_content()`，直接抛 NotImplementedError

**权衡分析**：

- **优点**：明确语义——自定义解析器默认只处理文件路径；避免静默失败或错误行为
- **缺点**：调用方需要检查能力（虽然 Registry 的公共接口统一走 `parse()`，但 `parse_content()` 作为 BaseParser 方法可能被直接调用）

**替代方案**：可以在 Protocol 中定义 `supports_content_parsing` 属性，由包装器检查后决定是否调用。现有设计更简洁，但限制了灵活性。

---

## 使用指南

### 场景一：协议模式 —— 实现一个完整的自定义解析器

```python
from pathlib import Path
from typing import Union, List
from openviking.parse.custom import CustomParserProtocol
from openviking.parse.base import ParseResult, ResourceNode, NodeType, create_parse_result

class XYZParser:
    """解析 .xyz 专有格式的解析器"""
    
    @property
    def supported_extensions(self) -> List[str]:
        return [".xyz", ".xyzs"]
    
    def can_handle(self, source: Union[str, Path]) -> bool:
        source_str = str(source)
        # 支持扩展名 + 特定魔数检测
        if source_str.endswith((".xyz", ".xyzs")):
            return True
        # 或者是内容检测
        try:
            with open(source, 'rb') as f:
                return f.read(4) == b'XYZS'
        except:
            return False
    
    async def parse(self, source: Union[str, Path], **kwargs) -> ParseResult:
        content = Path(source).read_text(encoding='utf-8')
        # 自定义解析逻辑...
        root = ResourceNode(type=NodeType.ROOT, title="XYZ Document")
        root.add_child(ResourceNode(type=NodeType.SECTION, title="Section 1", level=1))
        
        return create_parse_result(
            root=root,
            source_path=str(source),
            source_format="xyz",
            parser_name="XYZParser",
        )

# 注册
from openviking.parse.registry import get_registry
registry = get_registry()
registry.register_custom(XYZParser(), name="xyz")
```

### 场景二：回调模式 —— 快速一次性解析

```python
from pathlib import Path
from openviking.parse.registry import get_registry
from openviking.parse.base import ParseResult, ResourceNode, NodeType, create_parse_result

async def quick_parse(source, **kwargs) -> ParseResult:
    """极简解析器：直接读取文件作为纯文本"""
    content = Path(source).read_text()
    return create_parse_result(
        root=ResourceNode(type=NodeType.ROOT, title=Path(source).stem),
        source_path=str(source),
        source_format="text",
        parser_name="quick",
    )

registry = get_registry()
registry.register_callback(".quick", quick_parse)
```

---

## 边缘情况与陷阱

### 1. 扩展名冲突

当多个解析器声明支持同一扩展名时，**后注册的覆盖先注册的**。Registry 的设计是简单的字典映射：`extension_map[ext.lower()] = name`。

**建议**：如果需要多解析器处理同一扩展名，考虑在 `can_handle()` 中实现更精细的判断逻辑。

### 2. 异步 vs 同步

Protocol 要求 `parse()` 是 `async` 方法。如果你的解析逻辑是 CPU 密集型的同步代码，需要用 `asyncio.to_thread()` 包装：

```python
async def parse(self, source, **kwargs):
    return await asyncio.to_thread(self._sync_parse, source)
```

### 3. can_handle vs can_parse 的语义差异

- `CustomParserProtocol.can_handle()`：解析器自主判断是否处理（可以检查扩展名、魔数、甚至内容）
- `BaseParser.can_parse()`：基于扩展名的简单匹配

包装器将 `can_handle()` 结果直接映射给 `can_parse()`，这意味着自定义解析器的 `can_handle()` 会被用于注册时的扩展名映射。**确保 `can_handle()` 的判断与 `supported_extensions` 一致**，否则可能导致"注册了但找不到"的问题。

### 4. parse_content 不支持

两个包装器的 `parse_content()` 都默认抛出 `NotImplementedError`。如果你的解析器需要支持内容字符串解析，需要在自定义解析器层面提供额外方法，或者直接扩展包装器类。

### 5. 类型检查的局限性

`runtime_checkable` Protocol 允许 `isinstance()` 检查，但**不保证方法签名正确**。如果你的 `parse()` 方法签名与协议要求不符（例如返回 `None` 或不是 `awaitable`），运行时才会暴露错误。使用静态类型检查工具（如 mypy）可以部分缓解。

---

## 延伸阅读

- [ParserRegistry 文档](parsing_and_resource_detection-parser_abstractions_and_extension_points-parser_registry.md) —— 解析器的注册与调度中心
- [BaseParser 抽象基类](parsing_and_resource_detection-parser_abstractions_and_extension_points-base_parser_abstract_class.md) —— 所有解析器的接口基类
- [ParseResult 与 ResourceNode](parsing_and_resource_detection-resource_and_document_taxonomy_base_types.md) —— 解析结果的数据结构
- [语言 AST 提取器](parsing_and_resource_detection-code_language_ast_extractors.md) —— 代码类解析器的实现参考