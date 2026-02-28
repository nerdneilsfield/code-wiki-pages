# Parent Document Retriever 技术深度解析

## 一句话概括

Parent Document Retriever 是一个**检索结果转换器**——它先通过底层检索器找到碎片化的子文档，然后从子文档元数据中提取父文档引用，最终返回完整的原始文档。这种设计让系统既能享受细粒度分块带来的检索精度，又能为 LLM 提供完整的上下文信息。

想象一个图书馆的检索系统：读者搜索关键词时，系统先定位到具体的书页（子文档），但返回给读者的永远是完整的书籍（父文档）而非零散的书页。这就是 Parent Document Retriever 的核心价值。

---

## 问题背景：为什么需要这个模块？

### 检索增强生成（RAG）的经典矛盾

在构建 RAG 系统时，我们面临一个根本性的张力：

**检索精度要求细粒度分块**：为了准确匹配用户查询，我们需要将长文档切分成较小的语义单元（chunks）。小块的嵌入向量更能精确表达特定概念，减少噪声干扰。

**生成质量要求完整上下文**：但 LLM 需要足够的上下文才能生成准确、连贯的回答。只给 LLM 一个孤立的段落往往导致理解偏差或信息不完整。

### 朴素方案的局限性

最直接的解决方案是存储文档时保留父子关系，查询时直接检索父文档。但这种方法的问题在于：

1. **粒度失控**：父文档可能过长，超出 LLM 的上下文窗口限制
2. **精度下降**：大块文档的嵌入向量会稀释关键信息的权重
3. **存储冗余**：同一父文档的多个子块各自存储完整的父文档内容，造成空间浪费

### 设计洞察：分离检索粒度与返回粒度

Parent Document Retriever 的核心设计洞察是：**检索阶段和返回阶段可以采用不同的粒度**。系统在检索时使用细粒度分块以获得高精度，但在返回时组装回完整的父文档以保证上下文完整性。

---

## 架构与数据流

```mermaid
flowchart LR
    A[用户查询 Query] --> B[parentRetriever.Retrieve]
    B --> C[底层 Retriever<br/>检索子文档]
    C --> D[子文档列表<br/>Sub-documents]
    D --> E[提取 ParentID<br/>从 Metadata]
    E --> F[去重 Parent IDs]
    F --> G[OrigDocGetter<br/>批量获取父文档]
    G --> H[完整父文档列表<br/>Parent Documents]
    
    style B fill:#f9f,stroke:#333
    style E fill:#bbf,stroke:#333
    style G fill:#bbf,stroke:#333
```

### 组件职责

| 组件 | 角色 | 职责 |
|------|------|------|
| `parentRetriever` | 检索 orchestrator | 协调子文档检索和父文档获取的完整流程 |
| `Retriever` (配置注入) | 子文档检索器 | 负责根据查询找到匹配的子文档块，可以是向量检索、全文检索或混合检索 |
| `OrigDocGetter` (配置注入) | 父文档获取器 | 根据父文档 ID 列表批量获取完整文档，通常对接文档存储或数据库 |
| `ParentIDKey` | 元数据约定 | 指定子文档元数据中存储父文档引用的字段名，构成子文档与父文档之间的链接纽带 |

---

## 核心实现解析

### Config 配置结构

```go
type Config struct {
    // Retriever 是底层的子文档检索器，比如 Milvus、Elasticsearch 等
    Retriever retriever.Retriever
    
    // ParentIDKey 是子文档元数据中表示父文档 ID 的字段名
    // 例如 "parent_id"，对应 metadata: {"parent_id": "doc_123"}
    ParentIDKey string
    
    // OrigDocGetter 是根据父文档 ID 获取完整文档的函数
    // 输入：父文档 ID 列表，输出：对应的完整文档列表
    OrigDocGetter func(ctx context.Context, ids []string) ([]*schema.Document, error)
}
```

**设计意图**：通过依赖注入的方式，Parent Document Retriever 与具体的检索实现和存储实现解耦。它不关心你是用 Milvus 还是 Elasticsearch，也不关心父文档存在 MySQL 还是 MongoDB——它只关注"如何找到父文档引用"和"如何获取父文档"这两个抽象操作。

### Retrieve 方法：两阶段检索流程

```go
func (p *parentRetriever) Retrieve(ctx context.Context, query string, opts ...retriever.Option) ([]*schema.Document, error) {
    // 阶段一：检索子文档
    subDocs, err := p.retriever.Retrieve(ctx, query, opts...)
    if err != nil {
        return nil, err
    }
    
    // 阶段二：提取并去重 Parent IDs
    ids := make([]string, 0, len(subDocs))
    for _, subDoc := range subDocs {
        if k, ok := subDoc.MetaData[p.parentIDKey]; ok {
            if s, okk := k.(string); okk && !inList(s, ids) {
                ids = append(ids, s)
            }
        }
    }
    
    // 阶段三：批量获取父文档
    return p.origDocGetter(ctx, ids)
}
```

**关键设计决策**：

1. **ID 去重**（`inList` 检查）：多个子文档可能属于同一个父文档（例如一页中的多个段落），通过去重避免重复获取相同的父文档，减少存储层的查询压力。

2. **宽松的错误处理**：如果子文档的元数据中没有 `ParentIDKey`，该文档会被静默跳过（`if k, ok := ...; ok`）。这是一种防御性设计——它假设检索结果中可能混入不带父文档引用的文档（比如未分块的原始文档），这些文档会被自然过滤掉。

3. **类型安全断言**：`k.(string)` 断言确保 ID 是字符串类型。如果元数据中存储了非字符串类型（如 int），该文档会被跳过。这是模块与调用者之间的隐式契约：父文档 ID 必须是字符串。

---

## 依赖关系与调用链

### 上游依赖（谁调用它）

Parent Document Retriever 通常被以下场景调用：

- **ADK ChatModel Agent**：在 RAG 流程中作为检索组件，为 Agent 提供上下文
- **Compose Graph**：作为 Graph 中的一个节点，参与复杂的多步骤检索流程
- **直接使用**：业务代码中直接构造 `NewRetriever` 并调用 `Retrieve`

### 下游依赖（它调用谁）

| 依赖 | 关系类型 | 说明 |
|------|----------|------|
| `retriever.Retriever` | 组合（必需） | 通过 `Config.Retriever` 注入，负责实际的子文档检索 |
| `OrigDocGetter` 函数 | 回调（必需） | 通过 `Config.OrigDocGetter` 注入，负责父文档的批量获取 |
| `schema.Document` | 数据契约 | 输入输出都是 `[]*schema.Document`，依赖其 `MetaData map[string]any` 字段 |

### 与 [schema_document](schema_document.md) 的关系

Parent Document Retriever 重度依赖 `schema.Document` 的元数据机制。它期望子文档的 `MetaData` 中包含特定键（`ParentIDKey`）来存储父文档的引用。如果子文档的元数据结构与预期不符（比如使用不同的键名或数据类型），检索会失败或返回空结果。

---

## 设计权衡与决策分析

### 1. 去重策略：简单的线性扫描

**现状**：使用 `inList` 函数进行 O(n²) 的线性扫描去重。

```go
func inList(elem string, list []string) bool {
    for _, v := range list {
        if v == elem {
            return true
        }
    }
    return false
}
```

**权衡分析**：
- **选择**：简单线性扫描而非 map/set 结构
- **理由**：通常情况下，单次检索返回的子文档数量有限（Top-K 通常在 5-20 之间），O(n²) 的常数因子极小，简单的线性扫描避免了内存分配和哈希计算的开销
- **风险**：如果底层检索器返回大量子文档（如 Top-1000），去重会成为性能瓶颈

**建议**：在大多数 RAG 场景下，当前的简单策略是合理的。如果遇到性能问题，可以考虑改用 map 进行 O(n) 去重。

### 2. 错误处理：严格 vs 宽松

**现状**：对配置参数进行严格校验（`Retriever` 和 `OrigDocGetter` 必须非空），但对运行时数据采取宽松处理（无 ParentIDKey 的子文档被静默跳过）。

**权衡分析**：
- **配置严格**：在构造阶段就失败，避免运行时出现难以调试的 nil pointer 错误
- **运行时宽松**：允许混合数据（部分子文档带父引用，部分不带），增强系统的容错性
- **潜在问题**：如果 `ParentIDKey` 配置错误（如拼写错误），所有子文档都会被跳过，最终返回空结果。这种失败是静默的，可能难以排查。

### 3. 批量获取：隐式的 N+1 问题

**现状**：`OrigDocGetter` 接收 ID 列表，但具体如何实现批量获取由调用者决定。

**设计意图**：将批量策略的决策权交给调用者。调用者可以实现：
- 简单的循环单条查询（简单但低效）
- 数据库的 `IN` 查询（高效）
- 带缓存的批量查询（高并发优化）

**风险提醒**：如果 `OrigDocGetter` 的实现是逐个 ID 查询（而非真正的批量查询），会产生 N+1 查询问题。这是使用者需要注意的陷阱。

### 4. 无状态设计

`parentRetriever` 结构体只包含配置和依赖，不包含任何运行时状态。这使得：
- **线程安全**：同一个实例可以被多个 goroutine 并发调用
- **可复用性**：无需为每次检索创建新实例
- **简单性**：无需考虑状态同步或资源清理

---

## 使用示例与最佳实践

### 基础用法

```go
import (
    "context"
    "github.com/cloudwego/eino/flow/retriever/parent"
    "github.com/cloudwego/eino/components/retriever"
)

func main() {
    // 假设已有底层检索器（如 Milvus）
    baseRetriever := createMilvusRetriever()
    
    // 假设已有文档存储
    docStore := createDocumentStore()
    
    // 创建 Parent Document Retriever
    pr, err := parent.NewRetriever(context.Background(), &parent.Config{
        Retriever:   baseRetriever,
        ParentIDKey: "source_doc_id",  // 子文档元数据中的父文档 ID 字段
        OrigDocGetter: func(ctx context.Context, ids []string) ([]*schema.Document, error) {
            // 从存储中批量获取父文档
            return docStore.BatchGet(ctx, ids)
        },
    })
    if err != nil {
        panic(err)
    }
    
    // 使用检索器
    docs, err := pr.Retrieve(ctx, "用户查询", retriever.WithTopK(10))
    // docs 现在是完整的父文档，而非碎片化的子文档
}
```

### 子文档索引时的元数据设置

为了让 Parent Document Retriever 正常工作，在索引子文档时必须正确设置元数据：

```go
// 假设原始父文档
parentDoc := &schema.Document{
    ID:      "doc_123",
    Content: "完整的文档内容...",
}

// 分块后的子文档
chunks := splitIntoChunks(parentDoc.Content)
for i, chunk := range chunks {
    subDoc := &schema.Document{
        ID:      fmt.Sprintf("%s_chunk_%d", parentDoc.ID, i),
        Content: chunk,
        MetaData: map[string]any{
            "source_doc_id": parentDoc.ID,  // 必须与 ParentIDKey 匹配！
            "chunk_index":   i,
        },
    }
    // 索引 subDoc 到向量数据库...
}
```

**关键提醒**：`MetaData` 中的键名必须与 `Config.ParentIDKey` 完全一致，包括大小写。

---

## 边缘情况与注意事项

### 1. 元数据键名不匹配（最常见错误）

**症状**：`Retrieve` 返回空列表，但底层检索器明显找到了子文档。

**原因**：索引时使用的键名（如 `"parent_id"`）与 `ParentIDKey` 配置（如 `"source_doc_id"`）不一致。

**排查建议**：打印子文档的 `MetaData` 检查实际键名。

### 2. ID 类型不匹配

**症状**：所有子文档都被跳过，返回空列表。

**原因**：元数据中的父文档 ID 不是字符串类型（如存成了 `int` 或 `ObjectID`），而代码中做了 `k.(string)` 断言。

**解决方案**：确保索引时以字符串形式存储 ID，或在 `OrigDocGetter` 中进行类型转换。

### 3. 父文档不存在

**现状**：如果 `OrigDocGetter` 返回的文档数量少于请求的 ID 数量（某些父文档已被删除），模块不会报错，只会返回找到的文档。

**影响**：可能导致上下文信息不完整，但系统保持稳定运行。

**建议**：在 `OrigDocGetter` 实现中添加日志或监控，追踪缺失的父文档。

### 4. 循环依赖风险

**陷阱**：不要在 `OrigDocGetter` 中再次调用 `parentRetriever.Retrieve`，这会导致无限递归。

### 5. 上下文超时

`Retrieve` 方法涉及两次外部调用（子文档检索 + 父文档获取），超时风险叠加。建议：
- 为 `OrigDocGetter` 的实现设置合理的超时
- 使用带超时的 context 调用 `Retrieve`

---

## 扩展与定制

### 添加结果缓存

如果需要缓存父文档以避免重复查询存储层，可以在 `OrigDocGetter` 中实现：

```go
OrigDocGetter: func(ctx context.Context, ids []string) ([]*schema.Document, error) {
    // 先查缓存
    cachedDocs := cache.MGet(ids)
    missingIDs := findMissing(ids, cachedDocs)
    
    // 再查存储
    if len(missingIDs) > 0 {
        fetchedDocs, err := docStore.BatchGet(ctx, missingIDs)
        if err != nil {
            return nil, err
        }
        // 回填缓存
        cache.MSet(fetchedDocs)
        cachedDocs = append(cachedDocs, fetchedDocs...)
    }
    
    return cachedDocs, nil
}
```

### 自定义去重逻辑

如果需要根据业务逻辑去重（如按文档版本号保留最新），可以包装 `OrigDocGetter`：

```go
OrigDocGetter: func(ctx context.Context, ids []string) ([]*schema.Document, error) {
    docs, err := docStore.BatchGet(ctx, ids)
    if err != nil {
        return nil, err
    }
    // 自定义去重：保留每个 source 的最新版本
    return deduplicateByVersion(docs), nil
}
```

---

## 相关模块

- [schema_document](schema_document.md)：`Document` 结构体和元数据系统
- [schema_message](schema_message.md)：检索结果最终会被组装成消息提供给 LLM
- [flow_retriever_multiquery](flow_retriever_multiquery.md)：另一种高级检索策略，可以与此模块组合使用
- [flow_retriever_router](flow_retriever_router.md)：路由检索器，可以在多个检索策略间做选择
- [flow_indexer_parent](flow_indexer_parent.md)：父文档索引器，通常与此检索器配套使用

---

## 总结

Parent Document Retriever 是一个典型的**分层检索架构**的实现。它通过组合两个简单的操作（子文档检索 + 父文档获取）解决了 RAG 系统中"精度与完整性不可兼得"的经典矛盾。

对于新加入团队的开发者，理解这个模块的关键在于：

1. **它不是"更智能"的检索器**，而是**检索结果的转换器**
2. **它对元数据结构有隐式契约**（`ParentIDKey` 必须是字符串），违反契约会导致静默失败
3. **它的性能特征取决于 `OrigDocGetter` 的实现**，简单的循环查询可能成为瓶颈
4. **它是无状态的**，可以安全地在高并发场景下复用