# session_memory_deduplication 模块技术深度解析

## 模块概述

在 OpenViking 这样的 AI 助手中，长期记忆（Long-term Memory）是实现个性化、上下文连续性的核心机制。当用户在会话中产生新的信息时，系统需要从会话内容中提取「记忆候选」（Candidate Memory），然后决定如何处理这些候选：直接创建为新记忆、与已有记忆合并、或者直接跳过。这正是 `session_memory_deduplication` 模块所解决的问题。

**核心问题**：在不做任何去重处理的情况下，每次会话都会产生新的记忆条目，导致记忆库快速膨胀、信息冗余，甚至出现相互矛盾的记忆。简单的字符串匹配无法处理语义相似的表述（例如「我最喜欢的语言是 Python」和「我擅长 Python」），而简单的向量相似度阈值又容易产生误判。

**设计洞察**：本模块采用两阶段决策架构。第一阶段使用向量检索进行高效的预筛选，将候选记忆与同类别（category）的已有记忆进行相似度比对；第二阶段将候选记忆与筛选出的相似记忆一起发送给 LLM，由 LLM 基于语义理解做出最终决策。这种「向量过滤 + LLM 决策」的组合，既保证了效率（避免将所有历史记忆都发送给 LLM），又保证了准确性（让 LLM 理解语义而非仅依赖数值相似度）。

## 架构设计

### 核心组件

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ SessionCompressor │────▶│ MemoryDeduplicator │────▶│   VikingDB     │
│  (调用方)        │     │   (核心逻辑)      │     │ (向量存储)      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │      LLM         │
                        │  (决策大脑)      │
                        └──────────────────┘
```

`SessionCompressor` 是去重模块的主要调用方，它负责从会话消息中提取记忆候选，然后对每个候选调用 `MemoryDeduplicator.deduplicate()` 方法。`MemoryDeduplicator` 内部依赖 `VikingDBManager` 进行向量检索，同时通过配置获取 LLM 客户端进行语义决策。

### 决策类型体系

模块定义了两层决策：

**第一层：候选级决策（DedupDecision）**

| 决策 | 含义 | 适用场景 |
|------|------|----------|
| `CREATE` | 创建为新的独立记忆 | 候选是全新的、有价值的信息 |
| `SKIP` | 不创建，保留现有记忆 | 候选是重复的、不确定的、冗余的 |
| `NONE` | 不创建新记忆，但需要对已有记忆执行操作 | 候选需要与已有记忆合并或替换已有记忆 |

**第二层：已有记忆操作（MemoryActionDecision）**

| 操作 | 含义 | 触发条件 |
|------|------|----------|
| `MERGE` | 将候选与已有记忆合并 | 两者主题相同但细节互补或部分冲突 |
| `DELETE` | 删除已存在的冲突记忆 | 候选完全推翻、覆盖了已有记忆 |

这种双层决策的设计允许细粒度的控制：即使最终决定不创建新记忆（`NONE`），也可以同时决定合并或删除哪些已有记忆。

## 数据流分析

### 记忆提取与去重的完整流程

```
用户会话消息
     │
     ▼
┌──────────────────────────────────────┐
│   MemoryExtractor.extract()          │  ← LLM 从会话中提取记忆候选
│   返回 List[CandidateMemory]         │
└──────────────────────────────────────┘
     │
     ▼ 对每个候选遍历
┌──────────────────────────────────────┐
│   MemoryDeduplicator.deduplicate()   │
│                                        │
│   步骤1: _find_similar_memories()    │  ← 向量预筛选
│   - 生成候选 embedding               │
│   - 在同 category 中检索相似记忆     │
│   - 阈值过滤 (SIMILARITY_THRESHOLD)  │
│                                        │
│   步骤2: _llm_decision()             │  ← LLM 语义决策
│   - 构造 dedup_decision prompt       │
│   - 解析 LLM 返回的 JSON             │
│   - 规范化决策结果                   │
└──────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────┐
│   DedupResult(decision, actions)     │
│                                        │
│   SessionCompressor 根据结果执行:     │
│   - CREATE: 创建新记忆文件            │
│   - MERGE: 调用 _merge_into_existing │
│   - DELETE: 删除已有记忆文件          │
│   - SKIP: 什么都不做                 │
└──────────────────────────────────────┘
```

### 关键依赖关系

**上游依赖（什么调用这个模块）**

- `SessionCompressor.extract_long_term_memories()` 是唯一的调用方。它控制整个记忆提取流程，包括何时调用去重、如何解释去重结果。

**下游依赖（这个模块依赖什么）**

- `VikingDBManager`：用于向量检索（`search_similar_memories`）和获取 embedder
- `CandidateMemory`：从 `memory_extractor` 模块传入的数据结构
- `Context`：已存在记忆的数据结构
- LLM（通过 `get_openviking_config().vlm`）：用于语义决策
- `render_prompt`：渲染 dedup_decision prompt 模板

## 核心组件详解

### MemoryDeduplicator 类

这是模块的核心类，负责所有去重决策逻辑。

**初始化**

```python
def __init__(self, vikingdb: VikingDBManager):
    self.vikingdb = vikingdb
    self.embedder = self.vikingdb.get_embedder()
```

只需要注入 `VikingDBManager`，因为它封装了向量存储和 embedder 的访问。

**关键配置参数**

```python
SIMILARITY_THRESHOLD = 0.0      # 向量相似度阈值
MAX_PROMPT_SIMILAR_MEMORIES = 5 # 发送给 LLM 的相似记忆数量上限
```

选择 `SIMILARITY_THRESHOLD = 0.0` 是一个有意为之的设计：让向量检索返回所有候选（而不是用阈值过滤掉可能的候选），然后将问题留給 LLM 处理。这种「宁可错送也不漏送」的策略在去重场景下是合理的，因为漏掉潜在的相似记忆会导致创建重复记忆，而误送一些不相似记忆给 LLM 只是多消耗一些 token。

`MAX_PROMPT_SIMILAR_MEMORIES = 5` 是对 LLM 上下文的考量：记忆抽象（abstract）通常很短（一句话），5 条记忆的上下文约几百 token，对 LLM 来说完全可以处理。

#### _find_similar_memories：向量预筛选

这个方法执行两件事：为候选生成 embedding，然后在向量数据库中检索相似记忆。

```python
async def _find_similar_memories(self, candidate: CandidateMemory) -> List[Context]:
    # 1. 生成向量
    query_text = f"{candidate.abstract} {candidate.content}"
    embed_result = self.embedder.embed(query_text)
    query_vector = embed_result.dense_vector
    
    # 2. 构建类别 URI 前缀进行范围过滤
    category_uri_prefix = self._category_uri_prefix(candidate.category.value, candidate.user)
    
    # 3. 向量检索
    results = await self.vikingdb.search_similar_memories(
        account_id=account_id,
        owner_space=owner_space,
        category_uri_prefix=category_uri_prefix,
        query_vector=query_vector,
        limit=5,
    )
    
    # 4. 阈值过滤并重建 Context 对象
    similar = []
    for result in results:
        score = float(result.get("_score", 0))
        if score >= self.SIMILARITY_THRESHOLD:
            context = Context.from_dict(result)
            context.meta["_dedup_score"] = score  # 保留给后续使用
            similar.append(context)
    return similar
```

**设计意图**：将向量得分保留在 `meta["_dedup_score"]` 中是为了后续的破坏性操作（如 DELETE）的安全防护。LLM 在决策时可以参考这个分数，但实际的删除操作需要谨慎。

#### _llm_decision：语义决策

这是模块中最「智能」的部分。LLM 需要综合考虑候选记忆的内容、已有记忆的内容，以及业务规则（不要轻易删除、优先合并等），做出最终决策。

```python
async def _llm_decision(self, candidate, similar_memories):
    # 1. 准备 prompt 变量
    existing_formatted = []
    for i, mem in enumerate(similar_memories[:MAX_PROMPT_SIMILAR_MEMORIES]):
        abstract = mem.abstract or mem._abstract_cache or mem.meta.get("abstract")
        facet = self._extract_facet_key(abstract)
        score = mem.meta.get("_dedup_score")
        existing_formatted.append(
            f"{i + 1}. uri={mem.uri}\n   score={score}\n   facet={facet}\n   abstract={abstract}"
        )
    
    # 2. 渲染 prompt
    prompt = render_prompt("compression.dedup_decision", {
        "candidate_content": candidate.content,
        "candidate_abstract": candidate.abstract,
        "candidate_overview": candidate.over_view,
        "existing_memories": "\n".join(existing_formatted),
    })
    
    # 3. 调用 LLM
    response = await vlm.get_completion_async(prompt)
    data = parse_json_from_response(response) or {}
    
    # 4. 解析和规范化
    return self._parse_decision_payload(data, similar_memories, candidate)
```

发送给 LLM 的 prompt（见 `dedup_decision.yaml`）包含了详细的决策指导，核心逻辑包括：

- **skip**：仅当候选完全不提供新信息时使用
- **create**：候选是有价值的独立新记忆，可以附带删除已失效的记忆
- **none**：候选本身不存储，但需要对已有记忆进行操作（合并/删除）

关键约束（hard constraints）：
- 如果决策是 `skip`，不能返回 `list`（因为没有操作对象）
- 如果任何 `list` 项使用 `merge`，决策必须是 `none`
- 如果决策是 `create`，`list` 只能包含 `delete` 项，不能包含 `merge`

#### _parse_decision_payload：LLM 响应的规范化

LLM 可能返回不规范的响应（例如使用索引而非 URI、返回旧格式的 `merge` 决策等），这个方法负责处理各种兼容性问题：

```python
def _parse_decision_payload(self, data, similar_memories, candidate):
    # 1. 解析决策字符串
    decision_str = data.get("decision", "create").lower().strip()
    decision_map = {
        "skip": DedupDecision.SKIP,
        "create": DedupDecision.CREATE,
        "none": DedupDecision.NONE,
        "merge": DedupDecision.NONE,  # 兼容旧格式
    }
    decision = decision_map.get(decision_str, DedupDecision.CREATE)
    
    # 2. 处理 legacy merge 响应
    if decision_str == "merge" and not raw_actions and similar_memories:
        raw_actions = [{"uri": similar_memories[0].uri, "decide": "merge"}]
    
    # 3. 解析每个 action（支持 URI 和索引两种方式）
    # 支持 1-based 索引（更符合人类习惯）和 0-based 索引（某些 LLM 可能返回）
    
    # 4. 处理冲突：如果同一记忆有多个不同 action，丢弃所有
    # 5. 规范化规则
    if decision == DedupDecision.SKIP:
        return decision, reason, []  # skip 不允许有 actions
    
    if decision == DedupDecision.CREATE and has_merge_action:
        decision = DedupDecision.NONE  # create + merge -> none
    
    if decision == DedupDecision.CREATE:
        actions = [a for a in actions if a.decision == MemoryActionDecision.DELETE]
        # create 只能携带 delete
    
    return decision, reason, actions
```

这些规范化规则确保即使 LLM 返回了略微不一致的决策，最终执行的动作也是安全和一致的。

### _extract_facet_key：辅助方法

这个方法从记忆摘要中提取「facet」（方面/主题）键，用于在 prompt 中展示给 LLM，帮助 LLM 快速理解每条记忆的主题：

```python
@staticmethod
def _extract_facet_key(text: str) -> str:
    # 优先使用常见分隔符：：:—-
    for sep in ("：", ":", "-", "—"):
        if sep in normalized:
            return normalized.split(sep, 1)[0].strip().lower()
    
    # 回退：取前 24 个字符作为 facet
    m = re.match(r"^(.{1,24})\s", normalized.lower())
    if m:
        return m.group(1).strip()
    return normalized[:24].lower().strip()
```

例如，摘要「Python: 擅长 Web 开发」会被提取 facet 为「python」。

## 设计决策与权衡

### 1. 向量预筛选 + LLM 决策的两阶段架构

**替代方案**：直接把所有已有记忆发送给 LLM 进行比较。

**当前选择**：先用向量检索筛选出 top-5 相似记忆，再让 LLM 决策。

**理由**：向量检索成本低、速度快，可以快速缩小搜索空间。LLM 调用成本高、延迟大，如果把全部历史记忆都发送给 LLM，既不经济也不现实。5 条记忆是一个经验值，平衡了信息量和成本。

### 2. 保守的默认值策略

当 LLM 不可用时（`vlm is None` 或 `vlm.is_available() == False`），模块默认返回 `DedupDecision.CREATE`。

**理由**：在去重场景下，错误地创建一条重复记忆（数据冗余）比错误地跳过一条有效记忆（信息丢失）的代价更低。创建重复记忆不会导致功能错误，只是存储浪费；而跳过有效记忆可能导致用户的重要信息丢失。

### 3. 决策规范化规则

模块包含多条规范化规则，例如：

- `CREATE + MERGE` → `NONE`
- `SKIP` 必须没有 actions
- `CREATE` 只能有 DELETE actions

**理由**：这些规则防止了 LLM 可能返回的逻辑不一致。例如，LLM 返回「创建新记忆」同时又说「和已有记忆合并」是矛盾的——新记忆和已有记忆不能既是独立的又是要合并的。规范化确保了执行层的确定性。

### 4. 支持索引和 URI 两种方式引用记忆

LLM 的响应可以使用 `uri` 直接引用记忆，也可以使用 `index`（1-based 或 0-based）间接引用。

**理由**：不同的 LLM 或 prompt 版本可能偏好不同的格式。提供多种引用方式提高了系统的鲁棒性。

### 5. Category 空间隔离

记忆分为用户空间（profile、preferences、entities、events）和代理空间（cases、patterns），向量检索时使用 `owner_space` 和 `category_uri_prefix` 确保只在同类别内进行去重。

**理由**：跨类别的比较没有意义。用户偏好（如「喜欢深色模式」）和代理案例（如「如何处理 Python 异常」）是完全不同类型的记忆放在一起比较只会产生误导。

## 使用指南与最佳实践

### 调用流程

```python
# 1. 初始化
compressor = SessionCompressor(vikingdb=vikingdb_manager)

# 2. 调用提取（内部会自动去重）
memories = await compressor.extract_long_term_memories(
    messages=conversation_messages,
    user=user_identifier,
    session_id=session_id,
    ctx=request_context,
)

# 3. 检查统计
# 压缩器会记录 created/merged/deleted/skipped 数量到日志
```

### 与其他模块的关系

- **memory_extractor**：提供 `CandidateMemory` 数据结构，负责从会话中提取候选记忆
- **compressor**：调用去重器的上层编排器，负责执行实际的文件操作（创建/合并/删除）
- **vikingdb_manager**：提供向量检索和 embedder
- **prompt templates**（`compression.dedup_decision.yaml`）：定义 LLM 决策的 prompt

### 配置注意事项

模块本身没有独立的配置项，但依赖以下全局配置：

- `get_openviking_config().vlm`：用于 LLM 调用
- `get_openviking_config().vectordb`：用于向量检索

确保这些配置正确初始化后再使用去重器。

## 边界情况与注意事项

### 1. LLM 响应解析失败

如果 LLM 返回的 JSON 无法解析或格式不对，模块会记录警告并回退到 `CREATE`。

```python
except Exception as e:
    logger.warning(f"LLM dedup decision failed: {e}")
    return DedupDecision.CREATE, f"LLM failed: {e}", []
```

### 2. 向量检索失败

如果向量搜索抛出异常（例如向量服务不可用），模块会记录警告并返回空结果，等价于「没有相似记忆，创建新记忆」。

```python
except Exception as e:
    logger.warning(f"Vector search failed: {e}")
    return []
```

这是fail-safe 策略的另一个体现：宁可创建重复也不丢失信息。

### 3. 冲突的 actions

如果 LLM 对同一记忆返回了多个不同的 action（例如对同一个 URI 先返回 merge 后返回 delete），模块会检测到冲突并丢弃所有相关的 actions，同时记录警告。

```python
if previous and previous != action:
    actions = [a for a in actions if a.memory.uri != memory.uri]
    logger.warning(f"Conflicting actions for memory {memory.uri}, dropping both")
```

### 4. Category 特殊处理

在 `SessionCompressor` 中，PROFILE 类别的记忆有特殊处理：跳过去重，始终合并。

```python
# compressor.py
ALWAYS_MERGE_CATEGORIES = {MemoryCategory.PROFILE}

# 在 extract_long_term_memories 中
if candidate.category in ALWAYS_MERGE_CATEGORIES:
    # 直接创建/合并，不走去重流程
```

这是因为用户 profile 通常需要持续累积（每次获取新信息都更新 profile），去重反而会导致信息丢失。

### 5. 只支持部分 Category 的 MERGE

某些类别（如 events、cases）不支持 MERGE 操作，只能 SKIP 或 CREATE：

```python
MERGE_SUPPORTED_CATEGORIES = {
    MemoryCategory.PREFERENCES,
    MemoryCategory.ENTITIES,
    MemoryCategory.PATTERNS,
}
```

如果 LLM 对这些类别返回了 MERGE 决策，模块会将其视为 SKIP。

## 扩展点与未来方向

### 当前可扩展的地方

1. **SIMILARITY_THRESHOLD**：可以通过继承 `MemoryDeduplicator` 并覆盖这个值来调整预筛选的严格程度
2. **MAX_PROMPT_SIMILAR_MEMORIES`：类似地可以调整发送给 LLM 的记忆数量
3. **自定义决策逻辑**：可以重写 `_llm_decision` 方法，替换为其他决策逻辑（例如规则引擎）

### 潜在的改进方向

1. **批量去重**：目前是对每个候选单独调用 LLM，如果有多个候选，可以考虑批量处理以降低延迟
2. **增量学习**：记录 LLM 的决策历史，用于优化 prompt 或规则
3. **更细粒度的阈值**：当前 threshold 是固定的，可以考虑根据 category 动态调整
4. **冲突检测**：检测已有记忆之间的冲突（不仅仅是候选与已有记忆之间）

## 参考资料

- [memory_extractor 模块](./core_context_prompts_and_sessions-session_memory_extractor.md)：记忆提取模块
- [SessionCompressor](./core_context_prompts_and_sessions-session_compressor.md)：调用去重器的上层编排器
- [压缩类 prompt 模板](./openviking-prompts-templates-compression.md)：dedup_decision、memory_merge 等 prompt 定义
- [VikingDB 向量存储](./storage_viking_vector_index_backend.md)：向量检索后端