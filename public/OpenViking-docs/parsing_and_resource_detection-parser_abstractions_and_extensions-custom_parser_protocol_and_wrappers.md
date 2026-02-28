# custom_parser_protocol_and_wrappers

## 概述

`custom_parser_protocol_and_wrappers` 模块是 OpenViking 解析框架的可扩展性核心。它解决的问题非常实际：当系统内置的解析器（PDF、Markdown、HTML 等）无法满足需求时，如何让用户无缝接入自己开发的解析器来处理自定义文件格式。

想象一个场景：你的团队使用一种名为 `.xyz` 的专有文档格式，市场上没有现成的解析器支持它。你有两个选择：一是修改核心代码硬编码支持（破坏开闭原则），二是通过这个模块提供的扩展机制来注册自定义解析器。`custom_parser_protocol_and_wrappers` 就是为第二种场景设计的——它像一座桥梁，让外部解析器能够融入系统的解析管线，而无需了解系统内部复杂的接口细节。

## 架构设计

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ParserRegistry                                │
│  (全局单例，维护 parser 名称 → 实例 的映射，以及扩展名 → 解析器 的路由)   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
         ┌──────────────────┐ ┌──────────┐ ┌─────────────────┐
         │   内置 Parser    │ │Custom    │ │  Callback       │
         │  (PDF/MD/HTML)  │ │Parser    │ │  Parser         │
         └──────────────────┘ │Wrapper   │ │  Wrapper        │
                               └──────────┘ └─────────────────┘
                                    │               │
                                    ▼               ▼
                    ┌─────────────────────┐  ┌──────────────┐
                    │CustomParserProtocol │  │ async func   │
                    │ (Protocol 接口)      │  │ (简单回调)    │
                    └─────────────────────┘  └──────────────┘
```

### 核心组件职责

**CustomParserProtocol** 是整个模块的设计核心。它不是抽象基类（ABC），而是一个 `runtime_checkable` 的 Protocol（结构化子类型协议）。这意味着任何对象只要实现了协议中定义的方法，就可以在运行时被识别为符合协议，而无需显式继承某个类。这种设计给了使用者极大的自由度——你的自定义解析器可以是纯 Python 类、带有第三方依赖的包装器，甚至是基于其他框架的对象。

**CustomParserWrapper** 的角色是适配器（Adapter）。它将实现了 `CustomParserProtocol` 的外部解析器包装成符合 `BaseParser` 接口的对象。`BaseParser` 是系统内所有解析器的抽象基类，定义了 `parse()`、`parse_content()`、`supported_extensions` 等标准接口。Wrapper 的存在使得自定义解析器能够被 `ParserRegistry` 统一管理和调度，就像内置解析器一样工作。

**CallbackParserWrapper** 是为简单场景设计的轻量级方案。当你只需要处理一种新文件格式，不需要实现完整的协议接口时，可以直接传入一个异步函数。Wrapper 会将这个函数封装成符合解析器接口的对象。这种设计降低了扩展成本——用户无需定义类、实现属性和方法，只需要写一个 async 函数即可。

### 数据流向

当用户注册并使用一个自定义解析器时，数据流向是这样的：

1. **注册阶段**：用户调用 `ParserRegistry.register_custom(my_parser)` 或 `ParserRegistry.register_callback(".xyz", my_func)`。注册过程中，Wrapper 被创建并添加到 registry 的内部字典中，同时扩展名映射被更新。

2. **路由阶段**：当调用 `registry.parse("/path/to/file.xyz")` 时，registry 根据文件扩展名 `.xyz` 查找到对应的 Wrapper 实例。

3. **执行阶段**：Wrapper 的 `parse()` 方法被调用，它再委托给内部的 `custom_parser.parse()` 或 `parse_fn()` 执行实际解析逻辑。

4. **结果返回**：自定义解析器返回 `ParseResult`（包含 `ResourceNode` 树结构），这个结果与内置解析器返回的完全一致，后续处理逻辑无需感知差异。

## 设计决策与权衡

### Protocol vs 抽象基类

选择 `Protocol` 而非 `ABC` 是一个经过深思熟虑的决策。抽象基类要求显式继承，这会在你的类层次结构中引入不相关的依赖。而 Protocol 采用结构化子类型（structural subtyping），也就是所谓的"鸭子类型"——"如果它走起来像鸭子，叫起来像鸭子，那就是鸭子"。你的解析器类可以完全独立于 OpenViking 的代码体系，只需要恰好实现了相同的方法签名即可。

`@runtime_checkable` 装饰器进一步增强了这个灵活性，它允许在运行时使用 `isinstance(parser, CustomParserProtocol)` 进行类型检查，这在注册时的验证环节非常有用。

### 双层扩展机制

模块提供了两条扩展路径：Protocol 方式和 Callback 方式。这是一种典型的"渐进式复杂度"设计。

对于长期维护的自定义解析器，推荐使用 Protocol 方式。它要求你实现 `supported_extensions` 属性、`can_handle()` 方法和 `parse()` 方法，这些契约确保了你的解析器具备完整的识别和解析能力。

对于一次性场景或快速原型，Callback 方式更合适。它只需要一个扩展名和一个异步函数，学习成本最低。

系统设计者在这里做了一个权衡：不提供一个"简化版 Protocol"（比如只要求实现 parse 方法），而是让用户在两个明确的选项中选择。这避免了抽象层次的混乱。

### parse_content 的有意缺失

值得注意的是，`CustomParserWrapper.parse_content()` 会抛出 `NotImplementedError`。这并非疏漏，而是有意为之。大多数自定义解析器针对特定文件格式设计，依赖文件系统路径来定位资源（读取配置、加载依赖库等）。让每个自定义解析器都支持纯内容解析会显著增加实现复杂度。系统选择在这里"故意不支持"，引导用户按预期方式使用。

如果你确实需要内容解析功能，可以在自定义解析器中自行实现 `parse_content()`，Wrapper 会透明地传递调用。

### 扩展名匹配的细微差异

在 `CallbackParserWrapper` 中，扩展名比较是大小写不敏感的（`str(path).lower().endswith(self.extension.lower())`），而在 `CustomParserWrapper` 的 `can_parse()` 方法中，直接调用 `custom_parser.can_handle()`，没有强制统一。这种不一致性可能会让用户困惑。设计意图可能是：Protocol 方式给予自定义解析器完全的自主权，而 Callback 方式需要 Wrapper 来保障一致性。

## 使用指南

### 方式一：实现 Protocol 接口

```python
from pathlib import Path
from typing import Union, List
from openviking.parse.custom import CustomParserProtocol
from openviking.parse.base import ParseResult, ResourceNode, NodeType, create_parse_result

class XYZParser:
    @property
    def supported_extensions(self) -> List[str]:
        return [".xyz", ".abc"]
    
    def can_handle(self, source: Union[str, Path]) -> bool:
        return str(source).lower().endswith((".xyz", ".abc"))
    
    async def parse(self, source: Union[str, Path], **kwargs) -> ParseResult:
        content = Path(source).read_text(encoding="utf-8")
        # 自定义解析逻辑...
        root = ResourceNode(
            type=NodeType.ROOT,
            title="XYZ Document",
            meta={"format": "xyz"}
        )
        return create_parse_result(
            root=root,
            source_path=str(source),
            source_format="xyz",
            parser_name="XYZParser",
        )

# 注册到全局 registry
from openviking.parse import get_registry
registry = get_registry()
registry.register_custom(XYZParser(), name="xyz")
```

### 方式二：使用回调函数

```python
from pathlib import Path
from openviking.parse import get_registry, create_parse_result
from openviking.parse.base import ResourceNode, NodeType

async def parse_xyz(source, **kwargs):
    content = Path(source).read_text()
    root = ResourceNode(type=NodeType.ROOT, title="From callback")
    return create_parse_result(
        root=root,
        source_path=str(source),
        source_format="xyz",
        parser_name="callback_xyz",
    )

registry = get_registry()
registry.register_callback(".xyz", parse_xyz, name="callback_xyz")
```

## 注意事项与陷阱

**运行时类型检查的局限**：`isinstance(obj, CustomParserProtocol)` 只检查方法签名是否存在，不检查返回类型或参数类型的正确性。这意味着一个返回错误类型的方法可能在运行时才会暴露问题。在集成自定义解析器时，务必进行充分的单元测试。

**扩展名冲突**：如果你注册一个自定义解析器处理的扩展名与内置解析器重复（比如 `.txt`），新注册会覆盖原有解析器。这可能是预期行为，但务必明确意识到。

**异步上下文要求**：`parse()` 方法是异步的，你的自定义解析器也必须支持异步操作。如果你的底层解析库是同步的，可以使用 `asyncio.to_thread()` 包装。

**错误处理**：当自定义解析器的 `can_handle()` 返回 false 时，`CustomParserWrapper.parse()` 会抛出 `ValueError`。这个错误会在 registry 层面被传播，可能导致解析流程中断。确保你的 `can_handle()` 实现准确且高效。

**与 BaseParser 的差异**：Wrapper 实现了 `BaseParser` 的大部分接口，但并非完全一致。比如 `CustomParserWrapper.can_parse()` 实际上调用的是 `custom_parser.can_handle()`，逻辑可能与基类的基于扩展名的判断不同。在调试时需要留意这个差异。

## 依赖关系

这个模块位于解析框架的扩展点位置：

- **被依赖**：被 `ParserRegistry` 依赖（`registry.py` 导入并使用这些Wrapper），通过 `__init__.py` 暴露给外部用户
- **依赖**：依赖 `openviking.parse.base` 中的 `ParseResult` 和 `ResourceNode`，以及 `typing_extensions` 中的 Protocol

与系统其他部分的连接点主要是 `ParserRegistry`——所有自定义解析器都通过 registry 的 `register_custom()` 和 `register_callback()` 方法接入系统。