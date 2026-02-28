# collection_schemas 模块技术深度解析

## 概述

`collection_schemas` 模块是 OpenViking 存储层的" schema 定義者"和"向量化入口"。它做了两件紧密关联的事情：其一，定义了向量数据库中"context collection"的结构——这个集合存储了系统的所有上下文数据（资源、记忆、技能）；其二，提供了将原始文本转换为向量并写入数据库的处理器。把它想象成一座桥梁的桥头堡：一端连接着消息队列中等待处理的原始文本，另一端连接着持久化的向量数据库，而桥体本身就是 embedding 模型。

这个设计解决了一个核心问题：在 AI 系统中，上下文数据需要被语义化地检索。文本直接存储无法支持语义相似度搜索，必须转换为向量。而转换过程涉及到 HTTP 调用（调用外部 embedding 服务）和数据库写入，这两个操作都是潜在的阻塞点。模块通过 `asyncio.to_thread` 将阻塞调用卸载到线程池，保持事件循环的响应性。

---

## 架构位置与数据流

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   外部数据源         │     │   collection_schemas │     │   向量数据库         │
│ (文件/记忆/技能)     │────▶│   TextEmbeddingHandler│────▶│ VikingVectorIndexBackend │
└─────────────────────┘     └──────────────────────┘     └─────────────────────┘
                                    │
                                    ▼
                            ┌──────────────────────┐
                            │   EmbeddingMsg       │
                            │ (queue message)      │
                            └──────────────────────┘
```

从数据流的角度来看，模块处于**消息消费者**和**存储提供者**的双重角色：

1. **上游**：消息队列（通过 `NamedQueue` 的 `DequeueHandlerBase` 机制）推送 `EmbeddingMsg` 对象，其中 `message` 字段是待向量化的文本，`context_data` 包含 URI、元数据等信息
2. **核心处理**：`TextEmbeddingHandler.on_dequeue()` 接收消息，调用 embedding 模型生成向量，将向量附加到 context_data
3. **下游**：`VikingVectorIndexBackend.upsert()` 将完整数据写入向量数据库

---

## 核心组件解析

### 1. CollectionSchemas — 统一上下文集合的 schema 定义

`CollectionSchemas` 是一个静态方法容器，它定义了"context collection"的数据模型。这个集合是整个系统的"记忆仓库"——所有被索引的资源、用户记忆、技能都以统一格式存储在其中。

**Schema 设计的关键字段**：

| 字段 | 类型 | 用途 |
|------|------|------|
| `id` | string (主键) | 记录唯一标识，由 `account_id:uri` 的 MD5 哈希生成 |
| `uri` | path | 资源的统一资源标识符 |
| `context_type` | string | 区分上下文大类：`resource`（资源）、`memory`（记忆）、`skill`（技能） |
| `level` | int64 | **分层摘要的核心机制**：L0=摘要、L1=概览、L2=详情 |
| `vector` | vector | 密集向量，用于语义相似度搜索 |
| `sparse_vector` | sparse_vector | 稀疏向量，支持混合检索 |
| `parent_uri` | path | 树形层级关系的父节点引用 |

**设计洞察 — 为什么需要 context_type？**

系统需要区分不同来源的上下文：用户的记忆（`memory`）与代码仓库中的文件（`resource`）以及预定义的技能（`skill`）有不同的生命周期和访问权限规则。通过 `context_type` 字段，查询时可以轻易过滤："只搜索记忆"或"只搜索技能"。这是 **multi-tenant 语义搜索** 的基础设施。

**设计洞察 — 为什么需要 level（L0/L1/L2）？**

这是 OpenViking 的**分层摘要（Hierarchical Summarization）**策略。当用户询问"这个项目是做什么的"时，检索 L0（摘要）级别的内容；当询问具体实现细节时，检索 L2（内容）级别。这种设计让系统在回答不同粒度的问题时都能找到最恰当的上下文，避免大海捞针，也避免信息过载。

### 2. init_context_collection — 集合初始化入口

这是一个典型的"幂等初始化"函数：若集合已存在则返回 `False`，否则创建并返回 `True`。它依赖于 `OpenVikingConfig` 获取两个关键参数：

- `config.storage.vectordb.name` — 集合名称
- `config.embedding.dimension` — 向量维度（决定 schema 中 vector 字段的 Dim 参数）

这种设计将**配置与初始化解耦**——schema 的维度取决于运行时配置，而非硬编码。这允许同一个二进制文件连接不同维度的 embedding 模型。

### 3. TextEmbeddingHandler — 异步向量化处理器

这是模块中最复杂也是最重要的组件。它继承自 `DequeueHandlerBase`，是消息队列的消费者。

**核心工作流程**：

```
接收 EmbeddingMsg
    │
    ▼
提取 message (str) 和 context_data
    │
    ▼
调用 embedder.embed() 生成向量 ──▶ asyncio.to_thread (避免阻塞)
    │
    ▼
验证向量维度
    │
    ▼
生成记录 ID: md5(account_id:uri)
    │
    ▼
vikingdb.upsert() 写入数据库
    │
    ▼
report_success() / report_error() 回调
```

**关键设计决策 — 为什么用 asyncio.to_thread？**

Embedding 模型通常通过 HTTP 调用外部服务（如 OpenAI、Jina、VikingDB 等）。`await self._embedder.embed(...)` 本身是 async 的，但其内部实现是同步的 HTTP 请求。如果直接在事件循环中执行，数百毫秒的网络延迟会阻塞整个事件循环，导致其他协程无法推进。

`asyncio.to_thread()` 将这个阻塞调用卸载到线程池，释放事件循环来处理其他任务（如处理下一条消息）。这是 Python 中处理混合 I/O 和 CPU 密集型工作的标准模式。

**关键设计决策 — 为什么用 MD5 生成 ID？**

```python
id_seed = f"{account_id}:{uri}"
inserted_data["id"] = hashlib.md5(id_seed.encode("utf-8")).hexdigest()
```

这确保了**同一 URI 在同一账户下永远映射到同一个 ID**。这是"至少一次"（at-least-once）语义的处理基础：即使消息被重复消费，也不会在数据库中产生重复记录，而是更新已有记录。

**关键设计决策 — 关闭期间的 graceful degradation**：

```python
except CollectionNotFoundError as db_err:
    if getattr(self._vikingdb, "is_closing", False):
        logger.debug(f"Skip embedding write during shutdown: {db_err}")
        self.report_success()  # 不重试，避免进程无法退出
        return None
```

当系统关闭时，队列中的 worker 可能刚好处理一条消息，此时向量数据库连接已关闭。代码检测到这种状态后，**将错误视为成功**（report_success），让 worker 正常结束，避免进程hang在退出阶段。

---

## 依赖分析

### 我依赖谁（传入依赖）

| 依赖模块 | 用途 |
|----------|------|
| `openviking_cli.utils.config.open_viking_config.OpenVikingConfig` | 获取向量维度、集合名称、embedder 配置 |
| `openviking.models.embedder.base.EmbedResult` | Embedder 返回的结果类型，包含 dense_vector 和 sparse_vector |
| `openviking.storage.queuefs.embedding_msg.EmbeddingMsg` | 队列消息的数据结构 |
| `openviking.storage.queuefs.named_queue.DequeueHandlerBase` | 消息处理器的抽象基类 |
| `openviking.storage.viking_vector_index_backend.VikingVectorIndexBackend` | 向量数据库的写入接口 |

### 谁依赖我（传出依赖）

- **VikingVectorIndexBackend** — 使用 schema 定义来创建集合
- **消息队列系统** — 使用 `TextEmbeddingHandler` 作为 embedding 任务的消费者
- **存储层初始化** — `init_context_collection` 在系统启动时被调用

---

## 设计权衡与 Trade-offs

### 1. 统一 schema vs 多集合策略

系统选择了**单一集合**（"context collection"）来存储所有类型的上下文数据，而非为 resource、memory、skill 分别创建独立集合。

**优势**：
- 跨类型检索简单（一次查询即可覆盖所有类型）
- 集合管理简单（只需维护一个集合的元数据）
- 资源利用高效（向量索引只需构建一次）

**代价**：
- `context_type` 字段必须作为查询过滤条件，略微增加查询开销
- 不同类型的数据共享同一套 scalar indexes，无法针对特定类型优化
- schema 演进时需要考虑所有类型的兼容性

### 2. 同步 Embedding 调用 vs 异步队列

选择让 embedding 调用**在 handler 内部同步执行**（通过 `asyncio.to_thread`），而非使用独立的 worker 进程。

**优势**：
- 简单：不需要额外的进程间通信机制
- 资源共享：handler 可以复用同一个 embedder 实例

**代价**：
- 每个 embedding 请求占用一个线程
- 如果 embedding 服务响应慢，会堆积待处理消息
- 对于超大规模场景，可能需要考虑独立的 embedding 服务

### 3. MD5 ID 生成 vs  UUID

使用 `md5(account_id:uri)` 而非随机 UUID。

**优势**：
- **幂等性**：相同数据多次处理的确定性结果
- **可预测性**：给定 account_id 和 uri，可以预先计算 ID（对测试和调试有用）
- **紧凑性**：32 字符十六进制 vs UUID 的 36 字符

**代价**：
- MD5 存在理论上的碰撞风险（但在 "account_id:uri" 这个空间中可忽略）
- 无法支持同一 URI 的多个版本（如果要支持版本化，需要加入版本号）

---

## 使用指南与扩展点

### 如何添加新的 context_type？

1. 在 `CollectionSchemas.context_collection()` 的 `ScalarIndex` 列表中添加新类型（如果需要索引查询）
2. 在 `VikingVectorIndexBackend.ALLOWED_CONTEXT_TYPES` 中注册新类型
3. 在业务逻辑中（通常是 context 推导规则）添加新类型的 URI 映射逻辑

### 如何更换 Embedder 实现？

`TextEmbeddingHandler` 通过 `config.embedding.get_embedder()` 动态获取 embedder。只要新 embedder 实现 `embed(text) -> EmbedResult` 接口，即可无缝替换。这包括：

- 本地模型（sentence-transformers）
- 云服务（OpenAI、Jina、VikingDB）
- 混合模型（同时输出 dense 和 sparse 向量）

### 如何处理 embedding 失败？

handler 的错误处理分为三层：

1. **消息解析失败**：`except Exception` 捕获，回调 `report_error`，消息被标记为失败
2. **向量维度不匹配**：记录 error，回调 `report_error`，返回 `None`（消息被丢弃）
3. **数据库写入失败**：根据错误类型决定是否重试；如果是 `is_closing` 状态，则视为成功

---

## 潜在问题与注意事项

### 1. 向量维度一致性

Schema 中的 `vector` 字段维度由配置 `config.embedding.dimension` 决定。如果运行时更换了不同维度的 embedding 模型而未重建集合，写入时会触发维度不匹配错误。这是一个**运行时配置与 schema 的隐式耦合**，需要在部署流程中显式管理。

### 2. Sparse Vector 的可选性

代码中处理了 `sparse_vector` 可能不存在的情况，但 schema 定义将其标记为必选字段。如果 embedding 配置只返回 dense vector，schema 允许写入 `null` 值，但查询时的混合检索策略需要考虑这种情况。

### 3. 消息重复处理

虽然 MD5 ID 保证了写入的幂等性，但 `report_success()` 被调用前如果进程崩溃，消息可能被重新消费。这符合消息队列的"至少一次"语义。如果需要"恰好一次"语义，需要在业务层引入事务性或去重机制。

### 4. 关闭时的竞态条件

`is_closing` 检查是一个 **time-of-check to time-of-use (TOCTOU)** 问题：检查时可能为 False，检查后、写入前变为 True。但这种竞态在系统关闭场景下是可以接受的——最坏结果是写入失败后重试，而关闭期间的重试没有意义。

---

## 相关模块

- [openviking-storage-viking_vector_index_backend](./openviking-storage-viking_vector_index_backend.md) — 向量数据库后端适配器
- [openviking-storage-expr](./openviking-storage-expr.md) — 查询表达式的范围定义
- [openviking-models-embedder-base](./openviking-models-embedder-base.md) — Embedder 抽象接口
- [openviking-cli-utils-config-open_viking_config](./openviking-cli-utils-config-open_viking_config.md) — OpenViking 配置管理