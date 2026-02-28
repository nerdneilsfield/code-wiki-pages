# collection_schemas 模块技术深度解析

## 模块概述

`collection_schemas` 模块是 OpenViking 存储层的"schema 定义中心"——它定义了向量数据库中统一上下文集合的数据结构蓝图，并提供异步队列处理器将文本转换为向量后写入数据库。

**解决的问题**：在分布式 RAG（检索增强生成）系统中，文本内容的语义搜索依赖于将文本转换为向量。然而，文本处理、向量化、存储分散在不同模块中，缺乏统一的 schema 定义会导致数据写入失败、检索结果混乱。这个模块通过集中定义集合的字段结构，并实现一个异步管道来处理文本→向量的转换和持久化，使得整个向量存储系统可以可靠地运行。

## 架构角色与数据流

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐    ┌────────────────┐
│   数据源        │    │   EmbeddingMsg   │    │  TextEmbedding      │    │  VikingVector  │
│ (文件/记忆/技能)│───▶│ (队列消息格式)    │───▶│ Handler (异步处理)   │───▶│ IndexBackend   │
└─────────────────┘    └──────────────────┘    └─────────────────────┘    └────────────────┘
                               │                       │                         │
                               │                       ▼                         │
                               │              ┌────────────────┐                │
                               │              │  embedder.embed│                │
                               │              │ (文本→向量)    │                │
                               │              └────────────────┘                │
                               │                                                    │
                               └────────────────────────────────────────────────┘
                                                (写入向量数据)
```

### 核心组件职责

1. **CollectionSchemas** —— 静态 schema 工厂，定义"统一上下文集合"的字段结构
2. **init_context_collection** —— 集合初始化函数，负责在存储后端创建实际的集合
3. **TextEmbeddingHandler** —— 异步队列消费者，核心 pipeline：消费消息 → 调用 embedder → 写入向量库

## 核心设计决策

### 1. 统一"context"集合 vs 多集合

**选择**：所有资源（文件、记忆、技能）都存入同一个 "context" 集合。

**理由**：这种设计支持跨类型的语义检索。当用户询问"我之前学过什么 Python 技能？"时，系统可以在同一集合中搜索记忆和技能，无需提前知道目标类型。schema 中的 `context_type` 字段（resource/memory/skill）用于区分不同来源。

** tradeoff**：单一集合意味着所有数据共享相同的向量维度，配置灵活性降低，但对于 OpenViking 的用例来说 embeddings 模型的维度是固定的（由配置决定），这个 tradeoff 是可以接受的。

### 2. 混合向量支持（Dense + Sparse）

**选择**：schema 同时包含 `vector`（dense）和 `sparse_vector`（sparse）两个字段。

**理由**：混合检索可以兼得两种向量的优势——dense 向量捕捉语义相似性，sparse 向量（类似 BM25）在精确关键词匹配上表现更好。`TextEmbeddingHandler` 会根据 embedder 的返回结果同时写入两种向量。

### 3. 层级抽象（L0/L1/L2）

**选择**：schema 中包含 `level` 字段来区分 L0（摘要）、L1（概览）、L2（详情）。

**理由**：这是 Hierarchical Retrieval（分层检索）的基础设施。系统可以为同一个 URI 生成不同层级的向量表示，检索时可以先返回高层级结果（L0/L1），如果需要更多细节再回退到 L2。这类似于搜索引擎的 snippets vs 完整页面。

### 4. 异步处理中使用 `asyncio.to_thread`

**选择**：`embedder.embed()` 是一个同步阻塞的 HTTP 调用，但代码使用 `await asyncio.to_thread()` 来避免阻塞事件循环。

**理由**：虽然 embedder 调用本身是同步的（调用第三方 API），但在异步上下文中直接调用会阻塞整个事件循环，导致其他队列消息无法被处理。`asyncio.to_thread()` 将其放到线程池中执行，实现了真正的并发——当一个消息正在等待 HTTP 响应时，事件循环可以继续处理队列中的其他消息。

```python
result: EmbedResult = await asyncio.to_thread(
    self._embedder.embed, embedding_msg.message
)
```

### 5. 基于 URI 的去重策略

**选择**：使用 `hashlib.md5(f"{account_id}:{uri}".encode()).hexdigest()` 作为记录 ID。

**理由**：确保同一账户下的同一 URI 只会有一条向量记录，实现"upsert"语义（更新或插入）。当同一文件被重新处理时，新向量会覆盖旧向量，而不是创建重复记录。

## CollectionSchemas 详解

```python
class CollectionSchemas:
    @staticmethod
    def context_collection(name: str, vector_dim: int) -> Dict[str, Any]:
```

这个类本质上是一个**静态 schema 工厂**。它的设计模式类似于"配置即代码"——schema 不是写在配置文件里，而是作为代码中的数据结构，这样可以在 Python 层面进行类型检查和 IDE 提示。

### 字段分类

| 字段类别 | 字段 | 用途 |
|---------|------|------|
| **主键** | `id` | 唯一标识，基于 account_id:uri 生成 |
| **定位** | `uri`, `parent_uri` | 文件系统的层级结构 |
| **类型** | `type`, `context_type` | 区分资源类型和上下文大类 |
| **向量** | `vector`, `sparse_vector` | 语义搜索的核心数据 |
| **时间** | `created_at`, `updated_at` | 时序分析和缓存失效 |
| **层级** | `level` | L0/L1/L2 分层检索 |
| **内容** | `name`, `description`, `abstract`, `tags` | 文本描述和元数据 |
| **多租户** | `account_id`, `owner_space` | 租户隔离 |

### 未使用的 `type` 字段

代码注释中明确说明 `type` 字段"当前版本未使用，保留用于未来扩展"。这是**预留字段**模式——现在虽然不使用，但在 schema 中预留了位置，未来可以支持表示资源的具体类型（如 file、directory、image、video、repository 等），无需迁移数据库 schema。

## TextEmbeddingHandler 详解

这是模块中最复杂的组件，理解它的关键是把握**异步队列消费者**的角色定位。

### 初始化流程

```python
def __init__(self, vikingdb: VikingVectorIndexBackend):
    self._vikingdb = vikingdb
    self._embedder = None
    config = get_openviking_config()
    self._collection_name = config.storage.vectordb.name
    self._vector_dim = config.embedding.dimension
    self._initialize_embedder(config)
```

**关键点**：
- embedder 是延迟初始化的（lazy initialization），这允许在运行时动态配置 embedding 模型
- `vector_dim` 从配置中读取，确保生成的向量维度与 schema 定义一致

### on_dequeue 处理流程

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         TextEmbeddingHandler.on_dequeue                  │
├──────────────────────────────────────────────────────────────────────────┤
│  1. 解析 EmbeddingMsg                                                    │
│       │                                                                  │
│       ▼                                                                  │
│  2. 检查消息类型 ──是否为字符串?                                         │
│       │                           │                                      │
│       │                           ▼                                      │
│       │                    跳过非字符串消息                              │
│       │                           │                                      │
│       ▼                           ▼                                      │
│  3. 生成向量 (调用 embedder.embed)                                       │
│       │                                                                  │
│       ▼                                                                  │
│  4. 维度校验 ──向量长度 != 配置维度?                                     │
│       │                           │                                      │
│       │                           ▼                                      │
│       │                    报告错误, 返回 None                          │
│       │                                                                  │
│       ▼                                                                  │
│  5. 生成 ID ──md5(account_id:uri)                                       │
│       │                                                                  │
│       ▼                                                                  │
│  6. 写入向量数据库 (vikingdb.upsert)                                     │
│       │                                                                  │
│       ▼                                                                  │
│  7. 报告成功/失败 ──调用 callback                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 错误处理策略

1. **维度不匹配**：向量生成后立即校验，如果维度不对，记录错误并报告失败，不尝试写入
2. **写入失败**（CollectionNotFoundError）：如果是正常关闭期间（`is_closing=True`），则跳过写入并报告成功，避免僵尸数据；其他情况报告错误
3. **未知异常**：记录完整堆栈跟踪，报告错误

### shutdown 处理

```python
if getattr(self._vikingdb, "is_closing", False):
    logger.debug(f"Skip embedding write during shutdown: {db_err}")
    self.report_success()
    return None
```

这是一个**优雅关闭**（graceful shutdown）的体现。当系统正在关闭时，队列中可能还有已出队但未处理的消息。此时不写入向量数据库是合理的——因为关闭过程中数据库连接可能不稳定，写入可能失败，而这条消息的语义是"需要被处理"，如果处理失败，队列系统通常会有重试机制。在关闭期间跳过写入，可以让系统快速完成关闭流程。

## 依赖分析

### 上游依赖（谁调用这个模块）

1. **存储初始化流程**：`init_context_collection` 被存储层的初始化代码调用（在系统启动时创建集合）
2. **队列系统**：`TextEmbeddingHandler` 作为 `DequeueHandlerBase` 的实现，被队列系统实例化并注册为消息处理器

### 下游依赖（这个模块调用什么）

1. **VikingVectorIndexBackend**：写入向量数据
2. **EmbeddingConfig.get_embedder()**：获取 embedder 实例
3. **EmbeddingMsg**：消息格式定义
4. **DequeueHandlerBase**：队列处理基类

### 数据契约

**输入（EmbeddingMsg）**：
- `message`: str 类型，要向量化文本
- `context_data`: Dict，包含 uri、account_id、level 等元数据

**输出（写入向量库的数据）**：
```python
{
    "id": "md5(account_id:uri)",    # 主键
    "uri": "...",                    # 文件路径
    "context_type": "...",           # resource/memory/skill
    "vector": [...],                 # dense 向量
    "sparse_vector": {...},          # sparse 向量（可选）
    "level": 2,                      # L0/L1/L2
    "account_id": "...",
    # ... 其他元数据字段
}
```

## 扩展点与配置

### 如何添加新字段

1. 在 `CollectionSchemas.context_collection()` 的 `Fields` 列表中添加字段定义
2. 如果需要支持该字段的过滤查询，在 `ScalarIndex` 列表中添加字段名
3. 在 `TextEmbeddingHandler.on_dequeue` 中确保该字段被正确传递到 `inserted_data`

### 如何更换 Embedding 模型

修改 `OpenVikingConfig.embedding` 配置：
- `provider`: openai/volcengine/vikingdb/jina
- `model`: 模型名称
- `dimension`: 向量维度（必须与 schema 定义一致）

### 如何支持新的 context_type

1. 在 `VikingVectorIndexBackend.ALLOWED_CONTEXT_TYPES` 中添加新类型
2. 在 schema 的 `context_type` 字段文档中更新枚举值说明
3. 在数据入口处（生成 EmbeddingMsg 的地方）确保传入正确的类型

## 潜在问题与注意事项

### 1. 向量维度一致性

**问题**：如果运行时配置的 embedding 维度与初始化集合时使用的维度不一致，会导致向量写入失败。

**预防**：在 `init_context_collection` 中使用配置中的 `vector_dim` 参数，确保 schema 定义与运行时配置一致。

### 2. ID 冲突风险

**问题**：使用 `md5(account_id:uri)` 作为 ID，理论上存在哈希碰撞风险（虽然概率极低）。

**缓解**：对于生产级系统，可以考虑使用更可靠的 ID 生成策略（如 UUID + 唯一性检查），但对于当前规模，md5 是足够且高效的选择。

### 3. Sparse 向量的处理

**问题**：schema 定义了 `sparse_vector` 字段，但 embedder 可能不支持 sparse 向量。

**处理**：`TextEmbeddingHandler` 中检查 `result.sparse_vector` 是否存在，只有存在时才写入。这是**可选字段**的正确处理方式。

### 4. 字符串消息类型过滤

**问题**：`EmbeddingMsg.message` 可以是 `str` 或 `List[Dict]`，但当前 handler 只处理字符串类型。

**原因**：这是设计选择——当前 pipeline 主要处理文本文件的向量化，非字符串类型（如图像）由其他 observer（如 VLMObserver）处理。这符合**单一职责**原则。

### 5. 关闭期间的写入跳过

**问题**：在 `is_closing=True` 时写入被跳过，但消息会被标记为成功，可能导致数据丢失。

**权衡**：这是优雅关闭的 tradeoff——快速关闭 vs 数据完整性。对于 embedding 这种可以重新生成的数据，这个 tradeoff 是可以接受的。如果需要更强的一致性保证，应该在重启后通过队列重试来处理。

## 相关文档

- [向量存储后端](../vectordb_domain_models_and_service_schemas/viking_vector_index_backend.md) —— VikingVectorIndexBackend 详细实现
- [表达式 DSL](./storage-schema-and-query-ranges-expr.md) —— FilterExpr 类型定义
- [Embedding 配置](../python_client_and_cli_utils/configuration_models_and_singleton.md) —— EmbeddingConfig 和 embedder 配置
- [向量索引配置](../vectordb_domain_models_and_service_schemas/schema_validation_and_constants.md) —— 字段类型和验证规则