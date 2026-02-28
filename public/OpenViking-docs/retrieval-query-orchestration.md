# retrieval_query_orchestration 模块详解

## 概述

`retrieval_query_orchestration` 模块是 OpenViking 系统的"检索大脑"——它负责协调从用户提问到最终答案返回的完整流程。想象一下当你在一个大型图书馆里寻找某本书的某个章节：你要先确定搜索范围（是小说区还是科技区？），然后逐层深入查找（先定位楼层，再定位书架，最后定位具体书籍），找到后还要根据相关性排序，甚至考虑书的热门程度。**这个模块正是用程序实现了这个"先广后深、由粗到精"的检索策略**。

本模块包含两个核心组件：
- **RAGQueryPipeline**：面向评估场景的端到端 RAG 管道，管理"文档添加→语义检索→答案生成"的完整生命周期
- **HierarchicalRetriever**：分层检索器，实现了基于目录结构的递归搜索、分数传播、收敛检测和热度的混合排序

---

## 架构概览

```mermaid
flowchart TD
    subgraph Client_Layer["客户端层"]
        Q[用户查询]
    end

    subgraph Pipeline["RAGQueryPipeline"]
        ADD[add_documents<br/>add_code_repos]
        QRY[query]
    end

    subgraph Retriever["HierarchicalRetriever"]
        GV[全局向量搜索]
        MS[合并起始点]
        RS[递归搜索]
        SC[分数转换<br/>+ Hotness混合]
    end

    subgraph Storage["向量存储层"]
        VS[VikingVectorIndexBackend]
        FS[viking_fs]
    end

    subgraph LLM["LLM 生成层"]
        LLM[VLM/StructuredLLM]
    end

    Q --> QRY
    QRY --> RS
    ADD --> VS
    
    RS --> GV
    GV --> MS
    MS --> RS
    RS --> SC
    SC --> FS
    SC --> LLM
    QRY --> LLM
    
    style Pipeline fill:#e1f5fe
    style Retriever fill:#e8f5e8
```

### 数据流解读

**当用户执行一次查询时，数据经历了以下旅程**：

1. **查询入口**：`RAGQueryPipeline.query()` 接收自然语言问题
2. **向量化**：使用 embedder 将查询转换为稠密向量（dense）和稀疏向量（sparse）
3. **全局搜索**：`HierarchicalRetriever._global_vector_search()` 先在整个租户空间做一次快速扫描，找到最相关的顶层目录
4. **起始点合并**：`_merge_starting_points()` 将用户指定的目录（如果有）与全局搜索结果合并，形成搜索的"种子"
5. **递归搜索**：`_recursive_search()` 从起始点出发，逐层向下探索：
   - 使用优先队列（堆）按分数排序待探索目录
   - 对每个目录搜索其子节点
   - **分数传播**：子节点分数 = α × 原始分数 + (1-α) × 父节点分数
   - **收敛检测**：连续3轮 top-k 结果不变时提前终止，避免无用计算
6. **热度混合**：`_convert_to_matched_contexts()` 将语义相似度与"热度"（访问频率+更新时间）按比例混合
7. **LLM 生成**：如果 `generate_answer=True`，调用 LLM 基于检索到的上下文生成最终答案

---

## 核心设计决策

### 1. 为什么采用"分层"检索而不是直接全库向量搜索？

**权衡**：直接对全量数据做向量相似度搜索最简单，但有两个致命问题：

- **语义漂移**：当查询匹配到某个不相关的深层文档时，它可能排在真正相关但位于浅层的结果前面
- **计算浪费**：每次查询都要遍历全量数据，目录结构被浪费了

**选择**：HierarchicalRetriever 采用了"先定位目录、再深入子节点"的两阶段策略。这类似于搜索引擎的"爬虫"逻辑：先抓取重要页面，再从这些页面出发跟踪链接。实际效果是：
- 全局搜索只返回 `GLOBAL_SEARCH_TOPK=3` 个顶层结果，作为搜索的"起始锚点"
- 递归搜索限制在目录树内，避免"语义漂移"
- 分数传播机制确保了父子关系的相关性传递

### 2. 为什么引入"热度"（Hotness）分数？

**问题**：纯向量相似度排名可能会忽略一个事实——某些文档虽然内容相关，但长期没人访问（可能是过时内容），而另一些文档虽然相似度略低，但被频繁访问（可能是高频使用的高价值内容）。

**解决方案**：代码中引入了 `HOTNESS_ALPHA = 0.2` 的混合权重：

```python
final_score = (1 - alpha) * semantic_score + alpha * h_score
```

热度分数的计算公式综合了两个因素：
- **访问频率**：使用 sigmoid 函数将活跃次数映射到 (0,1)
- **时间衰减**：指数衰减，半衰期默认 30 天

这使得检索结果不仅仅是"语义相关"，还隐式地偏向"热门且最新"的内容。

### 3. 为什么要设计收敛检测？

**观察**：递归搜索是深度优先还是广度优先？如果不加控制，可能会在某个分支无限深入。代码实现了 `MAX_CONVERGENCE_ROUNDS = 3` 的机制：

```python
if current_topk_uris == prev_topk_uris and len(current_topk_uris) >= limit:
    convergence_rounds += 1
    if convergence_rounds >= self.MAX_CONVERGENCE_ROUNDS:
        break
```

这意味着：**当连续3轮检索的 Top-K 结果完全相同时，说明搜索已经"收敛"，继续深入只会重复已有结果，可以提前终止**。这避免了无意义的计算开销。

### 4. RAGQueryPipeline 的懒加载设计

```python
def _get_client(self):
    if self._client is None:
        # 实际初始化...
    return self._client
```

**设计意图**：RAG 评估管道可能不会立即使用 client（在添加文档阶段只需文件系统操作），延迟初始化避免了对配置文件和数据库连接的不必要开销。

---

## 子模块说明

### RAGQueryPipeline

RAG 评估管道的核心类，封装了"文档入库→语义检索→答案生成"的完整流程。主要方法：

| 方法 | 职责 |
|------|------|
| `add_documents()` | 将本地文档目录添加到 OpenViking 索引 |
| `add_code_repos()` | 添加代码仓库（与 add_documents 逻辑相同，语义不同） |
| `query()` | 执行检索，可选是否调用 LLM 生成答案 |
| `close()` | 关闭客户端连接 |

### HierarchicalRetriever

分层检索器，是真正的检索逻辑核心。关键概念：

- **RetrieverMode.THINKING**（默认值）：完整模式，会调用 rerank 客户端对候选结果进行精排序，适合需要高质量结果的场景
- **RetrieverMode.QUICK**：快速模式，跳过 rerank 步骤，直接使用向量相似度得分，适合对延迟敏感的场景
- **分数传播系数** `SCORE_PROPAGATION_ALPHA = 0.5`：子节点最终分数 = α × 当前分数 + (1-α) × 父节点分数，确保父目录的相关性能够传递到子节点
- **目录优势比** `DIRECTORY_DOMINANCE_RATIO = 1.2`：当目录得分没有超过其子节点最高分的 1.2 倍时，优先返回子节点（设计意图：避免返回"空目录"）
- **热度系数** `HOTNESS_ALPHA = 0.2`：最终得分中热度分数的权重，0 表示完全禁用热度排序

---

## 外部依赖与集成

| 依赖模块 | 作用 |
|----------|------|
| `openviking.storage.VikingVectorIndexBackend` | 向量存储后端，提供全局搜索和子节点搜索接口 |
| `openviking.storage.viking_fs` | Viking 文件系统，用于读取关联上下文 |
| `openviking.models.embedder.base` | 向量化模型，提供稠密/稀疏向量生成 |
| `openviking_cli.utils.rerank.RerankClient` | 重排序服务（可选） |
| `openviking_cli.utils.llm.StructuredLLM` | LLM 生成接口 |
| `openviking.server.identity.RequestContext` | 请求上下文，包含用户角色和权限信息 |

---

## 扩展点与注意事项

### 扩展点

1. **重排序集成**：当前 `HierarchicalRetriever` 中 `_rerank_client` 标记为 TODO，实际重排序逻辑会在后续支持
2. **自定义热度计算**：可通过覆盖 `hotness_score()` 函数调整热度算法
3. **阈值配置**：`score_threshold` 和 `score_gte` 参数支持运行时动态调整检索严格度

### 注意事项

1. **scope_dsl 参数**：这是一个高级特性，允许上层传递额外的过滤条件（如权限范围），但需要与向量存储层配合
2. **空结果处理**：当集合不存在时，`retrieve()` 返回空的 `QueryResult` 而不是抛异常
3. **收敛陷阱**：如果 `limit` 设置过小（例如 1），收敛检测可能过早触发，建议 `limit >= 3`
4. **稀疏向量兼容性**：代码同时支持 dense 和 sparse 向量搜索，但 sparse 向量的生成依赖于 embedder 的能力

---

## 相关文档

- [ragas_evaluation_core](./ragas-evaluation-core.md) — RAG 评估框架的核心组件
- [evaluation_recording_and_storage_instrumentation](./evaluation-recording-and-storage-instrumentation.md) — 评估数据的记录与存储
- [model_providers_embeddings_and_vlm](./model-providers-embeddings-and-vlm.md) — 向量化和多模态模型
- [vectorization_and_storage_adapters](./vectorization_and_storage_adapters.md) — 向量存储适配器