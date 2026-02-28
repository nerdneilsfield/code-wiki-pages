# prompt_template_metadata 模块技术深度解析

## 模块概述

`prompt_template_metadata` 模块是 OpenViking 系统中负责**提示词模板管理与渲染**的核心组件。想象一下当你走进一家餐厅，服务员递给你的不是菜单，而是一份"元菜单"——它告诉你有哪些菜品可选、每道菜的配料是什么、你还可以根据自己的口味调整配料。`PromptManager` 就是这个"元菜单"的管理员：它存储提示词模板的定义（元数据）、描述模板中可以被替换的变量、验证你提供的值是否合法、最后用实际值替换掉占位符，生成可以直接送给 LLM 的完整提示词。

在 OpenViking 的架构中，这个模块扮演着**模板引擎**的角色：它位于配置层和 LLM 调用层之间，充当两者的桥梁。一方面，模板以 YAML 文件形式存储在 `templates/` 目录下，按类别组织（vision、compression、retrieval 等）；另一方面，使用方只需要知道 prompt_id（如 `"vision.image_understanding"`），传入变量字典，就能获得渲染好的字符串。这种设计使得提示词与代码解耦——修改提示词不需要改代码，调整 LLM 配置也不需要重新部署。

---

## 架构设计

### 核心组件与数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        调用方 (Session, SkillLoader 等)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    render_prompt() / get_llm_config()                   │
│                         全局便捷函数（单例模式）                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         PromptManager                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │   _cache     │  │   _lock      │  │templates_dir │  │ enable_    │  │
│  │  (Dict)      │  │(RLock)       │  │   (Path)     │  │ caching    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     load_template()                              │   │
│  │   1. 检查缓存 → 2. 解析YAML → 3. Pydantic验证 → 4. 存入缓存     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     render()                                     │   │
│  │   1. 加载模板 → 2. 应用默认值 → 3. 验证变量 → 4. 截断处理       │   │
│  │   5. Jinja2渲染 → 6. 返回字符串                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    YAML 文件 (templates/*.yaml)                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │  vision/         │  │  compression/    │  │  retrieval/      │      │
│  │  - image_        │  │  - structured_   │  │  - ...           │      │
│  │    understanding │  │    summary       │  │                  │      │
│  │  - page_...      │  │  - memory_...    │  │                  │      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 组件职责详解

**PromptMetadata** 是模板的"身份证"。它包含 `id`（唯一标识符，如 `"compression.structured_summary"`）、`name`（人类可读的名称）、`description`（用途说明）、`version`（版本号，用于追踪变更）、`language`（提示词语言）、`category`（所属分类）。这个设计借鉴了软件包管理的思想——每个模板就像一个 npm 包，有名有姓有版本，方便检索和版本控制。

**PromptVariable** 定义了模板中的"接口"。每个变量有 `name`（变量名）、`type`（类型声明，支持 string/int/float/bool）、`description`（用途说明，供调用方参考）、`default`（默认值）、`required`（是否必需）、`max_length`（最大长度限制，用于防止超长输入）。这里的设计意图是**把契约写清楚**：调用方只需要阅读变量定义，就知道应该传什么值、可以不传什么值、传多了会被截断到多长。

**PromptTemplate** 是完整的模板定义，整合了元数据、变量列表、Jinja2 模板字符串、可选的 `output_schema`（期望 LLM 返回的结构）和 `llm_config`（temperature、supports_vision 等 LLM 参数）。这种"自包含"的设计意味着渲染提示词和获取 LLM 配置可以一次性完成，减少了调用方的复杂度。

**PromptManager** 是整个模块的引擎。它的核心职责可以概括为三点：**加载**（从 YAML 文件读取模板）、**缓存**（避免重复解析）、**渲染**（变量替换）。值得注意的是它使用了**线程安全的缓存**设计（`threading.RLock`），这对于在异步环境或 Web 服务中使用的场景至关重要。

---

## 核心设计决策与权衡

### 1. 单例模式 vs 依赖注入

代码中选择了一个全局单例 `_default_manager`，通过 `get_manager()` 获取。这与 `openviking.utils.config.open_viking_config.OpenVikingConfigSingleton` 的模式完全一致，都是"简单优先"的考量——在大多数使用场景下，全局共享一个管理器是最简单的方案。

**权衡分析**：单例模式的好处是调用方不需要管理生命周期，导入模块就能用。坏处是测试困难、难以替换实现、状态在测试间可能泄露。但对于提示词管理器这个无状态（除了缓存）的组件来说，单例的弊端不明显，反而是"即插即用"的便利性占了上风。代码也提供了 `PromptManager()` 构造函数，允许需要"干净状态"的测试场景创建独立实例。

### 2. Pydantic 模型的设计意图

所有的数据类（`PromptMetadata`、`PromptVariable`、`PromptTemplate`）都继承自 `BaseModel`，使用 Pydantic 进行数据验证。这不是"过度设计"，而是有实际用途的：

第一，**类型自动转换**。YAML 加载后，`required` 字段可能是字符串 `"true"` 或布尔值 `true`，Pydantic 会统一处理成 Python 布尔值。

第二，**默认值填充**。`variables: List[PromptVariable] = Field(default_factory=list)` 让空模板也能正常工作，不需要调用方判断 `None`。

第三，**序列化便利**。Pydantic 模型可以直接 `.model_validate()` 从字典创建，也可以 `.model_dump()` 导出为字典，这在调试和持久化时很方便。

### 3. 缓存策略：同步锁 vs 无锁设计

`PromptManager` 使用 `threading.RLock()` 保护缓存读写。这是一个**保守但安全的决定**。

**为什么需要锁？** 在多线程环境中，多个线程可能同时调用 `load_template()`。如果没有锁，两个线程可能同时发现缓存未命中，然后各自解析一遍 YAML（虽然最终结果相同，但浪费了资源），更严重的是可能同时写入 `_cache` 字典导致数据竞争。

**为什么用 RLock 而非 Mutex？** `RLock`（可重入锁）允许同一个线程多次获取锁。考虑嵌套调用的场景：`render()` 调用 `load_template()`，`load_template()` 内部也可能调用其他需要锁的方法。`RLock` 可以避免同一线程自己把自己锁死的尴尬。

**潜在的改进空间**：对于纯粹的"读多写少"场景，可以考虑使用 `functools.lru_cache` 或更细粒度的锁（比如每个 prompt_id 一把锁），但当前设计在吞吐量不是极端高的场景下已经完全够用。

### 4. Jinja2 vs 字符串 replace

模板渲染使用了 `jinja2.Template`，而不是简单的 `str.replace("{{var}}", value)`。这是一个**面向未来的选择**。

Jinja2 支持的条件判断（`{% if %}`）、循环（`{% for %}`）、过滤器（`{{ name | upper }}`）在复杂的提示词中非常有用。比如你想根据某个布尔变量决定是否包含一段_instruction，或者在列表变量上做 map/join 操作，Jinja2 原生支持，而 `replace` 需要手写逻辑。

**代价**是引入了一个额外依赖和轻微的性能开销。但提示词渲染通常不是系统热点（hot path），这个代价可以忽略不计。

### 5. 变量验证的位置：Eager vs Lazy

代码在 `render()` 方法中进行变量验证（`_validate_variables()`），这是一种 **Eager 验证**策略——在真正渲染之前就检查参数是否合法。

**另一种选择**是 Lazy 验证：让 Jinja2 渲染时自然报错。Pydantic 会在模型验证阶段做类型检查，但在渲染阶段如果变量缺失，Jinja2 会抛出 `UndefinedError`。

当前设计的好处是**错误信息更友好**。当缺少必需变量时，抛出的 `ValueError` 会明确指出是哪个 prompt 的哪个变量缺失，而不是让调用方面对 Jinja2 的通用错误。这对于调试和日志追踪非常有帮助。

---

## 依赖分析与数据契约

### 上游依赖（什么调用这个模块）

从代码分析来看，主要的调用方包括：

1. **Session._generate_archive_summary()**（在 `openviking.session.session.Session` 中）：这是最典型的使用场景。当会话需要生成结构化摘要时，它调用 `render_prompt("compression.structured_summary", {"messages": formatted})`，传入消息内容，获取渲染后的提示词，然后发送给 LLM。

2. **潜在的 SkillLoader 集成**：虽然当前 SkillLoader 直接读取文件，但未来可能将提示词模板化，统一通过 `PromptManager` 管理。

调用方与 `PromptManager` 的契约很简单：
- 输入：`prompt_id`（字符串，如 `"vision.image_understanding"`）和 `variables`（字典，可选）
- 输出：渲染后的字符串，或者 `llm_config` 字典
- 异常：`FileNotFoundError`（模板不存在）、`ValueError`（变量缺失或类型错误）、`YAMLError`（YAML 格式错误）

### 下游依赖（这个模块依赖什么）

1. **Jinja2**：用于模板渲染。
2. **PyYAML**：用于从 YAML 文件加载模板定义。
3. **Pydantic**：用于数据建模和验证。
4. **文件系统**：从 `templates_dir` 读取 YAML 文件。

这些都是成熟的、稳定的库，没有"魔法"，依赖管理很清晰。

---

## 使用指南与最佳实践

### 基本用法

```python
from openviking.prompts import render_prompt, get_llm_config

# 渲染一个简单的提示词
prompt = render_prompt(
    "vision.image_understanding",
    {
        "instruction": "Describe the main object in the image",
        "context": "This image is from a product photography session"
    }
)

# 同时获取 LLM 配置（用于决定如何调用模型）
config = get_llm_config("vision.image_understanding")
# config = {"temperature": 0.0, "supports_vision": True}
```

### 自定义模板目录

如果你有自己的提示词集合，可以创建独立的 `PromptManager`：

```python
from pathlib import Path
from openviking.prompts.manager import PromptManager

my_manager = PromptManager(
    templates_dir=Path("/path/to/my/templates"),
    enable_caching=True  # 默认开启
)

prompt = my_manager.render("custom.template_id", {"var": "value"})
```

### 调试与排查

当你遇到模板相关问题时，可以：

```python
from openviking.prompts.manager import get_manager

manager = get_manager()

# 列出所有可用提示词
print(manager.list_prompts())  # ["compression.dedup_decision", "compression.memory_extraction", ...]

# 按分类筛选
print(manager.list_prompts(category="vision"))  # ["vision.image_filtering", ...]

# 获取模板原始定义（不含渲染）
template = manager.load_template("vision.image_understanding")
print(template.model_dump())
```

---

## 边缘情况与注意事项

### 1. 变量截断行为

如果变量声明了 `max_length`，渲染时会对字符串类型的值进行截断：

```yaml
# YAML 定义
variables:
  - name: context
    type: string
    max_length: 500
```

这意味着如果你传入了 1000 字符的 context，它会被无声地截断到前 500 字符。**这是一个设计选择**，目的是防止超长输入导致 LLM 上下文溢出。调用方需要意识到这一点，如果需要精确控制，应该在传入前自行截断。

### 2. 默认值的应用时机

默认值在 `render()` 中**按声明顺序**应用：

```python
# 假设 template.variables = [var1(default="a"), var2(default="b")]
render("some.prompt", {"var1": "x"})  # var2 会被设为 "b"
```

这意味着后面的变量可以使用前面变量的值作为基础（虽然 Jinja2 本身不支持跨变量引用，但这种设计保持了变量定义的声明性）。

### 3. 缓存失效

当前没有提供"部分失效"缓存的 API。如果你想在运行时更新某个模板，需要：

```python
manager = get_manager()
manager.clear_cache()  # 清空所有缓存
# 或者直接操作 _cache（不推荐）
```

对于开发调试场景，可以使用 `clear_cache()`，但在生产环境中，缓存通常不需要手动清除（YAML 文件变化后重启服务即可）。

### 4. 线程安全与异步环境

`PromptManager` 是线程安全的，但需要注意的是：**缓存是进程级的**。在多进程部署（如 Gunicorn + multiple workers）中，每个进程有自己的缓存副本，这通常不是问题，因为模板文件在进程间是共享的。

在异步环境（asyncio）中，`render_prompt()` 是**同步阻塞**的。如果你在 async 函数中调用它，会阻塞事件循环。对于 IO 密集型的模板渲染，这通常不是问题（大部分时间花在 Jinja2 渲染的字符串处理上，而非网络请求）。但如果渲染变成瓶颈，可以考虑：

```python
import asyncio
loop = asyncio.get_event_loop()
prompt = await loop.run_in_executor(None, render_prompt, "prompt.id", variables)
```

### 5. YAML 安全加载

代码使用 `yaml.safe_load()` 而非 `yaml.load()`，这是正确的安全实践。它只允许基本 YAML 标签，不允许执行任意 Python 代码。虽然提示词模板是受信任的源（bundled with the code），但防御性编程的习惯值得保持。

---

## 总结

`prompt_template_metadata` 模块是 OpenViking 系统中一个设计精良的**配置层组件**。它通过 Pydantic 建模实现了强类型契约，通过 Jinja2 提供了灵活的模板能力，通过缓存和锁机制保证了性能和线程安全。

对于新加入团队的开发者，需要记住以下几点：

1. **模板是声明式的**：YAML 文件定义了"契约"，调用方只要遵守契约就能正常工作。
2. **缓存是默认开启的**：修改 YAML 文件后需要清除缓存或重启服务。
3. **验证是前置于渲染的**：错误会在 `render()` 时立即抛出，而不是等到 LLM 调用时才发现问题。
4. **单例是便利性与测试性的权衡**：大多数场景下使用 `render_prompt()` 即可，但测试时可以用 `PromptManager()` 创建隔离实例。

这个模块的设计体现了"简单、明确、可组合"的 Unix 哲学——只做一件事（管理提示词模板），把这件事做好，并提供清晰的接口供其他模块使用。