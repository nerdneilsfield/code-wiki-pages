# context_typing_and_levels 模块技术深度解析

## 概述

`context_typing_and_levels` 模块是 OpenViking 系统的核心类型定义模块，它为整个系统提供了统一的上下文抽象。这个模块解决的问题看似简单——只是定义几个枚举类型和一个 Context 类——但实际上它承载了整个系统的类型安全、多级索引和多租户隔离的基础。

试想一下：一个 AI 代理系统需要管理技能（Skill）、记忆（Memory）和资源（Resource）三种完全不同的上下文实体，同时还需要支持不同粒度的向量检索（从目录摘要到文件内容），并且要在同一个系统中为不同租户提供隔离。如果你只是用简单的字符串来区分这些概念，代码很快就会变得不可维护。这个模块通过类型化的枚举和统一的 Context 数据结构，为这些复杂需求提供了一个干净的抽象层。

---

## 核心组件架构

### 类型枚举定义

#### ResourceContentType

```python
class ResourceContentType(str, Enum):
    """Resource content type"""
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    BINARY = "binary"
```

这个枚举目前定义了资源的内容类型，采用了 `str` 和 `Enum` 的多重继承设计。选择这种设计的原因是：这些值需要参与字符串比较（例如 `if content_type == ResourceContentType.TEXT`），同时又需要枚举的类型安全性和 IDE 自动补全。你会发现代码中很多地方直接使用字符串值进行比较，而不是通过枚举成员，这正是 `str, Enum` 模式的便利之处。

值得注意的是，虽然定义了 IMAGE、VIDEO、AUDIO 等类型，但当前实现中的 `Vectorize` 类只支持文本向量化和注释掉的占位符。这表明多模态支持还在规划中，当前的设计已经为此预留了扩展空间。

#### ContextType

```python
class ContextType(str, Enum):
    """Context type"""
    SKILL = "skill"
    MEMORY = "memory"
    RESOURCE = "resource"
```

这个枚举区分了 OpenViking 中的三大类上下文实体：
- **SKILL**：可复用的技能定义，存储在 `viking://agent/*/skills` 路径下
- **MEMORY**：从会话中提取的长期记忆，包括 profile、preferences、entities、events、cases、patterns 六种类别
- **RESOURCE**：其他所有资源，如工作空间文件、配置文件等

这种分类直接对应了系统中的目录结构和存储布局。`Context` 类会根据 URI 自动推导 context_type，这将在后面详细介绍。

#### ContextLevel —— 分层索引的核心

```python
class ContextLevel(int, Enum):
    """Context level (L0/L1/L2) for vector indexing"""
    ABSTRACT = 0  # L0: abstract
    OVERVIEW = 1  # L1: overview
    DETAIL = 2    # L2: detail/content
```

这是整个模块中最关键的设计决策之一。`ContextLevel` 枚举实现了 L0/L1/L2 三级向量索引系统，这个设计的核心洞察是：**向量检索的效果高度依赖于查询与文档的粒度匹配**。

试想一个场景：用户询问"我的 Python 项目结构是什么样的？"，这是一个关于项目整体的抽象问题，最适合用 L0（目录摘要）来匹配。但如果是问"这个函数具体做了什么？"，那就需要 L2（文件内容）来提供精确答案。L1（目录概览）则介于两者之间，提供中等粒度的匹配。

这种设计带来的实际效果是：
- L0 索引让系统能够快速定位相关目录
- L1 索引让系统理解目录的整体内容
- L2 索引让系统能够精确定位到文件级别的细节

在存储层面，这些级别通过 `level` 字段存储在向量数据库中（参见 `collection_schemas.py` 中的 schema 定义）。URI 命名规则也反映了这种层次：
- L0: `{目录}/.abstract.md`
- L1: `{目录}/.overview.md`
- L2: `{文件路径}`

### Vectorize 类

```python
class Vectorize:
    text: str = ""
    
    def __init__(self, text: str = ""):
        self.text = text
```

这个类的设计非常简洁，但寓意深刻。它是一个"向量化准备"类，负责保存待向量化的文本内容。选择将向量化逻辑与 Context 分离，有几个考量：

1. **单一职责**：Context 负责数据结构和业务逻辑，向量化准备是另一个关注点
2. **延迟计算**：向量嵌入是昂贵的操作，Vectorize 对象可以在需要时才计算
3. **多模态扩展**：注释中预留了 image、video、audio 字段，为未来多模态支持做准备

### Context 类 —— 统一上下文模型

`Context` 类是整个模块的核心，它用一个统一的数据结构表示所有类型的上下文实体：

```python
class Context:
    def __init__(
        self,
        uri: str,
        parent_uri: Optional[str] = None,
        is_leaf: bool = False,
        abstract: str = "",
        context_type: Optional[str] = None,
        category: Optional[str] = None,
        created_at: Optional[datetime] = None,
        updated_at: Optional[datetime] = None,
        active_count: int = 0,
        related_uri: Optional[List[str]] = None,
        meta: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
        user: Optional[UserIdentifier] = None,
        account_id: Optional[str] = None,
        owner_space: Optional[str] = None,
        id: Optional[str] = None,
    ):
        # ...
```

这个类的设计有几个关键设计决策值得深入理解：

**URI 驱动的类型推导**：Context 类不要求调用者显式指定 `context_type` 和 `category`，而是通过 URI 的子字符串匹配自动推导：

```python
def _derive_context_type(self) -> str:
    """Derive context type from URI using substring matching."""
    if "/skills" in self.uri:
        return "skill"
    elif "/memories" in self.uri:
        return "memory"
    else:
        return "resource"

def _derive_category(self) -> str:
    """Derive category from URI using substring matching."""
    if "/patterns" in self.uri:
        return "patterns"
    elif "/cases" in self.uri:
        return "cases"
    # ... 更多类别
    return ""
```

这种设计的**优势**是降低了调用方的负担，不需要记忆每种资源应该用什么类型。**代价**是 URI 必须遵循约定的命名规范，而且字符串匹配有一定的性能开销（虽然在这个场景下可以忽略不计）。

**owner_space 的多租户隔离**：通过 URI 前缀和 user 信息自动推导所属空间：

```python
def _derive_owner_space(self, user: Optional[UserIdentifier]) -> str:
    """Best-effort owner space derived from URI and user."""
    if not user:
        return ""
    if self.uri.startswith("viking://agent/"):
        return user.agent_space_name()
    if self.uri.startswith("viking://user/") or self.uri.startswith("viking://session/"):
        return user.user_space_name()
    return ""
```

这确保了不同用户的资源在存储和检索时被正确隔离。`agent_space_name()` 通过 `md5(user_id + agent_id)[:12]` 生成，这既保证了唯一性，又不会产生过长的标识符。

**active_count 的使用追踪**：每个 Context 都有一个 `active_count` 字段，在会话中使用时会递增。这个字段被用于检索系统中的"热度"评分，让系统能够优先返回近期使用过的上下文。

---

## 数据流分析

### 入口点：谁创建 Context 对象？

**1. Session.commit() → 记忆提取**

当一个会话提交时（`session/session.py`），记忆提取器会从消息中提取长期记忆，并创建 Context 对象：

```python
# session/session.py - commit()
memories = run_async(
    self._session_compressor.extract_long_term_memories(
        messages=messages_to_archive,
        user=self.user,
        session_id=self.session_id,
        ctx=self.ctx,
    )
)
# memories 是 CandidateMemory，会被转换为 Context
```

**2. MemoryExtractor 创建记忆**

`memory_extractor.py` 中的 `MemoryExtractor` 类负责从会话消息中提取六类记忆（profile、preferences、entities、events、cases、patterns），提取结果会被转换为 Context 对象存储到向量数据库中。

**3. MemoryDeduplicator 去重处理**

`memory_deduplicator.py` 中的 `MemoryDeduplicator` 会检索现有的相似 Context 对象，并决定是创建新记忆还是合并到现有记忆中。

### 存储层：Context 如何持久化？

Context 对象通过 `to_dict()` 方法序列化为字典，然后存储到向量数据库（VikingDB）：

```python
def to_dict(self) -> Dict[str, Any]:
    """Convert context to dictionary format for storage."""
    # ... 字段映射
    data = {
        "id": self.id,
        "uri": self.uri,
        "context_type": self.context_type,
        "level": self.level,  # 隐式，未在 to_dict 中体现
        # ... 其他字段
    }
```

存储 schema（在 `collection_schemas.py` 中定义）包含关键字段：
- `context_type`：区分 skill/memory/resource
- `level`：区分 L0/L1/L2 三级索引
- `owner_space`：多租户隔离
- `active_count`：使用热度

### 检索层：如何利用 Context 的层级？

`hierarchical_retriever.py` 中的检索逻辑会利用这些层级：

```python
# 1. 首先通过全局向量搜索找到相关的根目录（L0/L1）
global_results = await self._global_vector_search(...)

# 2. 然后从这些目录向下递归搜索，匹配不同层级的内容
candidates = await self._recursive_search(
    starting_points=starting_points,
    # ...
)
```

检索系统会根据查询的粒度自动选择匹配哪个层级的 Context。例如：
- 抽象问题 → 匹配 L0
- 概览类问题 → 匹配 L1
- 细节问题 → 匹配 L2

---

## 设计决策与权衡

### 1. 字符串枚举 vs 纯字符串

`ContextType` 和 `ResourceContentType` 采用了 `str, Enum` 的多重继承模式。这不是标准的 Python Enum 用法，但在这个场景下有几个微妙的好处：

- **字符串兼容性**：可以直接和字符串比较 `context_type == "skill"`
- **类型安全**：又可以使用枚举 `ContextType.SKILL`，获得 IDE 补全和类型检查
- **值统一**：避免同一个概念有多种字符串写法（如 "skill" vs "skills"）

**权衡**：这种模式在序列化时需要特别处理，因为 Enum 的 `value` 属性才是实际的字符串。

### 2. URI 派生 vs 显式参数

Context 类的 `context_type`、`category` 和 `owner_space` 都是从 URI 和 user 派生而非显式传入。这种设计：

**优点**：
- 调用方不需要了解类型派生规则
- 保证了一致性：同一个 URI 总是推导出相同类型
- 简化了调用方代码

**缺点**：
- URI 必须遵循命名约定
- 字符串匹配逻辑分布在类的多个方法中
- 调试时需要追踪推导逻辑

### 3. active_count 的设计

`active_count` 字段用于追踪每个 Context 被使用的次数，这个设计服务于检索系统的热度排序：

```python
def update_activity(self):
    """Update activity statistics."""
    self.active_count += 1
    self.updated_at = datetime.now(timezone.utc)
```

**权衡**：这是一个乐观设计，假设并发更新不会太频繁。在高并发场景下，可能会考虑使用原子操作或异步队列来更新这个计数器。

### 4. 预留的多模态扩展

`Vectorize` 类目前只支持文本，但预留了 image、video、audio 字段：

```python
class Vectorize:
    text: str = ""
    # image: str = ""
    # video: str = ""
    # audio: str = ""
```

这反映了**渐进式增强**的设计理念：先支持最核心的场景（文本向量化和检索），再逐步扩展到多模态。这种方式的优点是不需要一开始就设计完整的多模态架构，缺点是后续迁移可能需要修改接口。

---

## 依赖关系

### 上游依赖（谁调用这个模块）

1. **`session/session.py`**：使用 Context 记录会话中使用过的资源（Usage）
2. **`session/memory_extractor.py`**：提取的记忆被封装为 CandidateMemory，后续转换为 Context
3. **`session/memory_deduplicator.py`**：使用 Context 表示现有记忆，进行去重决策
4. **`core/__init__.py`**：导出模块的公共接口

### 下游依赖（这个模块调用谁）

1. **`openviking_cli.session.user_id.UserIdentifier`**：用于派生 owner_space
2. **`openviking.utils.time_utils`**：用于时间格式化（`format_iso8601`）
3. **向量数据库存储层**：通过 `to_dict()` 输出的字典结构被 `collection_schemas.py` 定义

---

## 使用注意事项与陷阱

### 1. URI 命名约定必须遵守

Context 的类型推导完全依赖于 URI 中的关键字匹配。如果你创建了一个 URI 为 `viking://user/test/resources` 的 Context，系统会把它归类为 `resource`，因为 `/skills` 和 `/memories` 都不在 URI 中。如果你想让它成为 skill，必须使用 `/skills` 路径。

### 2. level 字段的隐式处理

当前 Context 类中没有直接的 `level` 属性。L0/L1/L2 的区分是通过 URI 命名约定隐式实现的：
- `{dir}/.abstract.md` → L0
- `{dir}/.overview.md` → L1
- `{文件路径}` → L2

这意味着在创建 Context 时，你需要根据 URI 约定正确命名，否则检索系统可能无法正确匹配层级。

### 3. UserIdentifier 的必要性

在多租户系统中，创建 Context 时传入 `user` 参数是非常重要的。没有 user 信息，`owner_space` 将无法正确推导，可能导致租户隔离失效。

### 4. 序列化/反序列化注意事项

`from_dict()` 和 `to_dict()` 是对称的，但需要注意：
- 时间字段在序列化时转为 ISO8601 字符串，反序列化时转回 datetime 对象
- user 字段可能被序列化为 dict，也可能是 UserIdentifier 对象
- vector 字段在 from_dict 时可能为 None（尚未计算向量）

### 5. 并发更新 active_count

如果多个会话同时使用同一个 Context（常见于共享的 skill），`active_count` 的更新不是原子的。在高并发场景下，需要考虑使用数据库的原子递增操作（如 `incr`）。

---

## 相关模块参考

- **[session_runtime](session_runtime.md)**：Session 的完整生命周期管理，包括 Context 的使用追踪
- **[session_memory_deduplication](core_context_prompts_and_sessions-session_memory_deduplication.md)**：记忆去重逻辑，它使用 Context 对象进行相似度比较
- **[content_extraction_schema_and_strategies](python_client_and_cli_utils-content_extraction_schema_and_strategies.md)**：内容提取的类型定义，与 ResourceContentType 互补
- **[storage_schema_and_query_ranges](storage_schema_and_query_ranges.md)**：向量存储的 schema 定义，明确了 level 字段的用途