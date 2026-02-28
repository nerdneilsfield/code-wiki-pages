# retrieval_trace_and_scoring_types 模块技术文档

## 模块概述

`retrieval_trace_and_scoring_types` 是 OpenViking 检索系统的核心数据类型定义模块。在一个知识管理系统中，当用户发起搜索请求时，系统需要在海量资源（记忆、资源、技能）中找到最相关的内容，但这个过程涉及多个复杂的决策步骤：目录定位、向量相似度计算、重新排序、候选筛选、收敛判断。**如果只返回最终结果，开发者将无法理解系统为什么做出这些选择，也无法调试检索质量的问题。**

本模块正是为了解决「检索过程的可观测性」而设计的。它定义了完整的数据结构来描述：
1. **检索追踪（ThinkingTrace）**：记录从用户输入到最终结果之间的每一步决策
2. **分数分布（ScoreDistribution）**：统计 embedding 和 rerank 阶段各候选资源的得分情况
3. **查询结果（FindResult）**：封装最终返回给调用者的完整结果集

这个模块是连接检索逻辑与上层 UI/CLI 的桥梁，使得检索过程可以被可视化、回溯和调试。

---

## 架构角色与数据流

### 架构位置

```
┌─────────────────────────────────────────────────────────────┐
│                     BaseClient.search()                      │
│                     (返回 FindResult)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              FindResult (最终检索结果)                        │
│  ┌─────────────┬─────────────┬─────────────┐                │
│  │  memories   │ resources   │   skills    │                │
│  └─────────────┴─────────────┴─────────────┘                │
│  ┌─────────────────────────────────────────┐                │
│  │  query_plan: QueryPlan                  │                │
│  │  query_results: List[QueryResult]       │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              QueryResult (单轮查询结果)                       │
│  - matched_contexts: List[MatchedContext]                   │
│  - searched_directories: List[str]                          │
│  - thinking_trace: ThinkingTrace  ◄── 核心追踪数据          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              ThinkingTrace (检索过程追踪)                    │
│  - 使用 queue.Queue 保证线程安全                             │
│  - 存储 TraceEvent 的有序序列                                │
│  - 支持按 query_id 过滤（多查询场景）                        │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │Search    │   │Score     │   │Selection │
        │Directory │   │(Embedding│   │(Candidate│
        │Events    │   │+Rerank)  │   │+Converge)│
        └──────────┘   └──────────┘   └──────────┘
```

从数据流角度看，调用链是这样的：

1. **调用入口**：`BaseClient.search()` 方法接收用户查询
2. **查询规划**：系统首先通过 LLM 分析查询意图，生成 `QueryPlan`（包含多个 `TypedQuery`）
3. **分阶段检索**：每个 `TypedQuery` 独立执行，过程中产生 `TraceEvent` 存入 `ThinkingTrace`
4. **结果聚合**：所有 `QueryResult` 汇总为 `FindResult`，按 `ContextType`（memory/resource/skill）分类

### 上游依赖

- **`BaseClient.search()`**：调用此模块定义的 `FindResult` 作为返回值类型
- **检索引擎**：需要将 `ThinkingTrace` 作为参数，在检索过程中调用 `add_event()` 记录事件

### 下游依赖

- **CLI/TUI**：当用户使用 `--trace` 或可视化模式时，从 `ThinkingTrace` 读取事件渲染搜索过程
- **调试工具**：开发者通过 `get_statistics()` 获取检索过程的汇总指标

---

## 核心类型详解

### 1. TraceEventType — 检索阶段枚举

```python
class TraceEventType(str, Enum):
    # 递归搜索阶段
    SEARCH_DIRECTORY_START = "search_directory_start"
    SEARCH_DIRECTORY_RESULT = "search_directory_result"

    # 打分阶段
    EMBEDDING_SCORES = "embedding_scores"
    RERANK_SCORES = "rerank_scores"

    # 筛选阶段
    CANDIDATE_SELECTED = "candidate_selected"
    CANDIDATE_EXCLUDED = "candidate_excluded"
    DIRECTORY_QUEUED = "directory_queued"

    # 收敛判断
    CONVERGENCE_CHECK = "convergence_check"
    SEARCH_CONVERGED = "search_converged"

    # 汇总
    SEARCH_SUMMARY = "search_summary"
```

**设计意图**：这个枚举定义了检索过程的完整生命周期。继承 `str, Enum` 的好处是双重兼容性——既可以用 `event_type == TraceEventType.EMBEDDING_SCORES` 进行类型安全比较，也可以直接与字符串 `"embedding_scores"` 比较，这在与外部系统（如日志、序列化）交互时非常方便。

**阶段划分逻辑**：
- **Search Directory**：系统确定要搜索哪些目录（LLM 定位 + 递归遍历）
- **Score**：对候选资源进行 embedding 向量相似度计算，可能还有 rerank 阶段
- **Select**：根据阈值筛选最终入选的候选，可能因分数不够被排除
- **Convergence**：判断是否需要继续搜索更多目录

### 2. ThinkingTrace — 线程安全的追踪容器

```python
@dataclass
class ThinkingTrace:
    start_time: float = field(default_factory=time.time)
    _events: queue.Queue = field(default_factory=queue.Queue, init=False, repr=False)
```

**为什么使用 queue.Queue 而非 list？**

这是一个关键的设计决策。`ThinkingTrace` 必须在多线程环境下工作——当多个查询并发执行时，每个查询需要独立记录自己的事件，而 Python 的 list 不是线程安全的。如果在多线程场景下使用 list 直接 append，可能导致数据竞争或事件顺序错乱。

`queue.Queue` 的内部实现使用了锁，能够保证：
1. **原子性**：`put()` 和 `get()` 操作是原子的
2. **顺序性**：事件按插入顺序存储（虽然不是严格 FIFO，但 Queue 提供了类似的保证）

然而，这里有一个微妙之处：`get_events()` 方法并没有调用 `queue.get()`，而是直接访问 `self._events.queue`（即内部的 deque）。这是有意为之的设计，避免了阻塞：

```python
def get_events(self, query_id: Optional[str] = None) -> List[TraceEvent]:
    # 获取所有事件的快照（非阻塞）
    all_events = list(self._events.queue)
    ...
```

**潜在风险**：这种方式在极端并发场景下可能看到不一致的快照，但对于调试/可视化场景，这种「尽力而为」的快照已经足够。

### 3. ScoreDistribution — 分数统计容器

```python
@dataclass
class ScoreDistribution:
    scores: List[tuple]  # [(uri, score), ...]
    min_score: float = 0.0
    max_score: float = 0.0
    mean_score: float = 0.0
    threshold: float = 0.0
```

**设计意图**：这个类用于记录和可视化打分阶段的详细信息。在 RAG（检索增强生成）系统中，理解分数分布对于调试检索质量至关重要——如果所有候选的分数都很接近，说明检索粒度不够；如果分数呈两极分布，可能存在噪声。

`from_scores()` 工厂方法自动计算统计信息：
- `min_score`：最低分，用于判断是否有「漏网之鱼」
- `max_score`：最高分，用于判断 top-1 的置信度
- `mean_score`：平均分，用于判断整体质量
- `above_threshold`：高于阈值的候选数量

**使用场景**：当需要展示「为什么选择这 5 个资源而不是那 10 个」时，分数分布是关键的解释依据。

### 4. FindResult — 客户端可见的最终结果

```python
@dataclass
class FindResult:
    memories: List[MatchedContext]
    resources: List[MatchedContext]
    skills: List[MatchedContext]
    query_plan: Optional[QueryPlan] = None
    query_results: Optional[List[QueryResult]] = None
    total: int = 0
```

**关键设计**：

1. **三分类存储**：结果按 `ContextType` 分为三类，这是 OpenViking 知识管理模型的核心抽象
   - `memory`：会话历史中提取的记忆
   - `resource`：用户添加的文档、代码等资源
   - `skill`：系统技能（可执行的能力）

2. **可迭代性**：
   ```python
   def __iter__(self):
       yield from self.memories
       yield from self.resources
       yield from self.skills
   ```
   这个设计允许 `for ctx in result:` 遍历所有匹配结果，同时保留分类信息。

3. **反序列化支持**：`from_dict()` 方法支持从 HTTP JSON 响应直接构造，这在 `AsyncHTTPClient` 场景下尤为重要。

---

## 设计决策与权衡

### 决策 1：dataclass vs Pydantic

选择 `dataclass` 而非 `pydantic.BaseModel` 的原因：

| 维度 | dataclass | pydantic |
|------|-----------|----------|
| 依赖 | 标准库 | 额外依赖 |
| 验证 | 需手动或在 `__post_init__` 中 | 自动验证 |
| 序列化 | 需手动 `to_dict()` | 内置 `.model_dump()` |
| 性能 | 更轻量 | 有额外开销 |

考虑到这些类型主要是**数据传输对象（DTO）**，且需要跨模块（openviking_core 可能没有 pydantic 依赖），使用 dataclass 是更务实的选择。验证逻辑可以通过 `__post_init__` 或工厂方法分散处理。

### 决策 2：继承 `str` 的 Enum

```python
class TraceEventType(str, Enum):
    SEARCH_DIRECTORY_START = "search_directory_start"
```

这种模式（StrEnum）在 Python 3.11+ 成为标准（`StrEnum` 是 `str` 和 `Enum` 的自动组合）。这样做的好处：

1. **兼容性**：可以直接与字符串比较 `"search_directory_start" == TraceEventType.SEARCH_DIRECTORY_START`
2. **可读性**：代码中使用枚举名而非裸字符串，减少拼写错误
3. **IDE 支持**：自动补全和类型检查

### 决策 3：相对时间戳

```python
event = TraceEvent(
    event_type=event_type,
    timestamp=time.time() - self.start_time,  # 相对时间
    ...
)
```

追踪事件使用**相对时间戳**（从追踪开始到现在的时间差），而非绝对时间戳。这是经过权衡的选择：

- **优势**：序列化时无需担心时区问题，展示时更清晰（用户关心的是「这个事件发生在第几秒」，而非具体时刻）
- **劣势**：如果需要与外部日志系统关联，需要自行转换

---

## 使用指南与最佳实践

### 场景 1：在检索器中记录追踪事件

```python
from openviking_cli.retrieve.types import ThinkingTrace, TraceEventType

async def search_directory(retriever, trace: ThinkingTrace, directory: str):
    # 记录开始搜索
    trace.add_event(
        TraceEventType.SEARCH_DIRECTORY_START,
        f"Searching directory: {directory}"
    )
    
    # ... 执行搜索逻辑 ...
    
    # 记录结果
    trace.add_event(
        TraceEventType.SEARCH_DIRECTORY_RESULT,
        f"Found {len(results)} candidates",
        data={"count": len(results), "uris": [r.uri for r in results]}
    )
```

### 场景 2：获取检索统计信息

```python
# 从 FindResult 获取追踪统计
result = await client.search("如何实现 OAuth 认证")
stats = result.query_results[0].thinking_trace.get_statistics()

print(f"搜索目录数: {stats['directories_searched']}")
print(f"收集候选数: {stats['candidates_collected']}")
print(f"排除候选数: {stats['candidates_excluded']}")
print(f"收敛轮次: {stats['convergence_rounds']}")
```

### 场景 3：多查询场景下的事件过滤

当一个搜索请求被拆分为多个子查询时（如分别搜索 memory、resource、skill），每个事件可能带有 `query_id`：

```python
# 获取特定查询的追踪
memory_trace = query_result.thinking_trace.get_events(query_id="query_memory")
for event in memory_trace:
    print(f"[{event.timestamp:.2f}s] {event.message}")
```

---

## 边界情况与注意事项

### 1. 空结果处理

`ScoreDistribution.from_scores()` 正确处理空列表：

```python
dist = ScoreDistribution.from_scores([], threshold=0.5)
# 返回: ScoreDistribution(scores=[], min=0.0, max=0.0, mean=0.0, threshold=0.5)
```

此时 `min_score`、`max_score`、`mean_score` 均为 0.0，这是合理的默认值。

### 2. 多线程竞态条件

虽然 `queue.Queue` 保证了单次操作的原子性，但 `get_events()` 返回的是**快照**：

```python
def get_events(self, query_id: Optional[str] = None) -> List[TraceEvent]:
    all_events = list(self._events.queue)  # 快照
    # 如果在快照过程中其他线程正在添加事件，
    # 快照可能不包含最新事件，但不会出错
```

这意味着：追踪数据用于调试/可视化是可以的，但**不要用于严格的审计或计费场景**。

### 3. FindResult 的隐式计算

```python
def __post_init__(self):
    self.total = len(self.memories) + len(self.resources) + len(self.skills)
```

`total` 字段在 `__post_init__` 中计算，这意味着：
- 如果手动修改了 `memories/resources/skills` 列表，`total` 不会自动更新
- 调用方应确保在修改列表后手动更新 `total`，或使用 `__iter__` 重新计算

### 4. 序列化时的精度损失

`to_dict()` 方法对浮点数进行了四舍五入：

```python
return {
    "timestamp": round(self.timestamp, 4),
    "score": round(s, 4),
    "min": round(self.min_score, 4),
}
```

这是有意为之，避免 JSON 序列化时出现 `0.3333333333333333` 这样的长浮点数。对于大多数 UI 展示场景，4 位小数足够精确。

---

## 相关模块参考

- **[client_session_and_transport](./python_client_and_cli_utils-client_session_and_transport.md)**：`BaseClient.search()` 返回 `FindResult`，是本模块类型的主要消费方
- **[configuration_models_and_singleton](./python_client_and_cli_utils-configuration_models_and_singleton.md)**：配置模块，影响检索阈值等参数，间接影响 `ScoreDistribution.threshold`
- **[session_runtime_and_skill_discovery](./core_context_prompts_and_sessions-session_runtime_and_skill_discovery.md)**：`Session` 管理 memory 类型的上下文，与 `ContextType.MEMORY` 相关
- **[ragas_evaluation_core](./retrieval_and_evaluation-ragas_evaluation_core.md)**：RAG 评估模块，可以使用 `ThinkingTrace` 获取检索过程的详细信息用于评估