# FAQ 内容与导入契约模块深度解析

## 1. 模块概览

`faq_content_and_import_contracts` 模块是系统中 FAQ（常见问题解答）功能的核心契约层，它定义了 FAQ 数据的表示、存储、导入和检索的完整数据模型和交互规范。这个模块不包含业务逻辑实现，而是专注于建立统一的数据契约，确保系统各组件在处理 FAQ 数据时有一致的理解和交互方式。

### 核心问题领域

在知识管理系统中，FAQ 数据具有特殊性：
- 需要支持标准问题、相似问题和反例问题的多维度表示
- 需要灵活的答案策略（全部返回或随机返回）
- 需要高效的批量导入和验证机制
- 需要与向量检索系统深度集成
- 需要支持增量更新和全量替换两种导入模式

简单的键值对存储或文档存储无法满足这些复杂需求，因此需要专门的数据契约层来抽象这些概念。

## 2. 核心架构与心智模型

### 2.1 心智模型

可以将这个模块想象成 FAQ 数据的"通用语言字典"——它定义了：
- **FAQ 条目的语法**：数据结构和字段含义
- **FAQ 操作的语义**：导入模式、更新策略、检索方式
- **FAQ 流转的状态**：导入进度、验证结果、失败处理

### 2.2 核心数据流向

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  FAQEntryPayload│     │ FAQBatchUpsertPayload│     │  FAQImportProgress│
│  (创建/更新请求) │────▶│  (批量导入请求)      │────▶│  (导入进度跟踪)   │
└─────────────────┘     └──────────────────────┘     └──────────────────┘
                                                              │
                                                              ▼
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│   FAQEntry      │◀────│   FAQChunkMetadata   │◀────│  FAQImportResult │
│  (前端展示模型)  │     │   (Chunk元数据)      │     │  (导入结果持久化) │
└─────────────────┘     └──────────────────────┘     └──────────────────┘
         │
         ▼
┌─────────────────┐
│ FAQSearchRequest│
│  (检索请求)     │
└─────────────────┘
```

## 3. 核心组件深度解析

### 3.1 FAQChunkMetadata - FAQ 数据的存储表示

`FAQChunkMetadata` 是 FAQ 数据在 Chunk 元数据中的存储结构，它是 FAQ 数据的"源真"表示。

```go
type FAQChunkMetadata struct {
    StandardQuestion  string         `json:"standard_question"`
    SimilarQuestions  []string       `json:"similar_questions,omitempty"`
    NegativeQuestions []string       `json:"negative_questions,omitempty"`
    Answers           []string       `json:"answers,omitempty"`
    AnswerStrategy    AnswerStrategy `json:"answer_strategy,omitempty"`
    Version           int            `json:"version,omitempty"`
    Source            string         `json:"source,omitempty"`
}
```

**设计意图**：
- 将 FAQ 数据嵌入到通用的 Chunk 结构中，复用现有的存储和检索机制
- 通过 `Metadata` 字段实现类型扩展，避免为 FAQ 创建专门的数据表
- `Version` 字段支持乐观锁机制，防止并发更新冲突

**关键方法**：
- `Normalize()`: 清理空白字符、去重，确保数据一致性
- `CalculateFAQContentHash()`: 基于内容计算哈希值，用于快速去重和变更检测

**哈希计算策略**：
```
Hash = SHA256(标准问 | 排序后的相似问 | 排序后的反例 | 排序后的答案)
```

这种设计确保了：
- 相同内容总是产生相同哈希（无论输入顺序）
- 任何内容变更都会导致哈希变化
- 可以高效检测重复条目和内容变更

### 3.2 FAQEntry - FAQ 数据的前端表示

`FAQEntry` 是返回给前端的完整 FAQ 条目结构，它包含了存储层信息、元数据和检索相关信息。

**设计意图**：
- 分离存储模型和展示模型，允许两者独立演进
- 包含检索评分和匹配类型，支持前端个性化展示
- 通过 `MatchedQuestion` 字段告诉用户具体匹配了哪个问题

### 3.3 批量导入机制

#### FAQBatchUpsertPayload - 批量导入请求

```go
type FAQBatchUpsertPayload struct {
    Entries     []FAQEntryPayload `json:"entries"      binding:"required"`
    Mode        string            `json:"mode"         binding:"oneof=append replace"`
    KnowledgeID string            `json:"knowledge_id"`
    TaskID      string            `json:"task_id"` // 可选，不传则自动生成
    DryRun      bool              `json:"dry_run"` // 仅验证，不实际导入
}
```

**两种导入模式**：
- `append`: 增量导入，只添加新条目或更新已有条目
- `replace`: 全量替换，先删除所有现有条目再导入新条目

**DryRun 模式**：
这是一个关键的设计决策——允许用户在实际导入前验证数据。这种设计：
- 避免了错误数据污染知识库
- 提供了提前发现问题的机制
- 支持用户预览导入结果

#### FAQImportProgress - 异步导入进度跟踪

```go
type FAQImportProgress struct {
    TaskID            string              `json:"task_id"`
    Status            FAQImportTaskStatus `json:"status"` // pending/processing/completed/failed
    Progress          int                 `json:"progress"` // 0-100
    Total             int                 `json:"total"`
    Processed         int                 `json:"processed"`
    SuccessCount      int                 `json:"success_count"`
    FailedCount       int                 `json:"failed_count"`
    // ... 更多字段
}
```

**设计意图**：
- 支持大规模 FAQ 导入的异步处理
- 提供实时进度反馈
- 区分失败条目的两种展示方式：直接返回（少量）或 URL 下载（大量）

**状态流转**：
```
pending → processing → completed
              ↓
            failed
```

### 3.4 FAQSearchRequest - 智能检索请求

```go
type FAQSearchRequest struct {
    QueryText            string  `json:"query_text"             binding:"required"`
    VectorThreshold      float64 `json:"vector_threshold"`
    MatchCount           int     `json:"match_count"`
    FirstPriorityTagIDs  []int64 `json:"first_priority_tag_ids"`
    SecondPriorityTagIDs []int64 `json:"second_priority_tag_ids"`
    OnlyRecommended      bool    `json:"only_recommended"`
}
```

**设计意图**：
- 支持双优先级标签过滤，实现灵活的检索范围控制
- 通过 `VectorThreshold` 控制检索精度和召回率的平衡
- `OnlyRecommended` 支持精选 FAQ 的优先展示

### 3.5 批量更新机制

#### FAQEntryFieldsBatchUpdate - 灵活的批量更新

```go
type FAQEntryFieldsBatchUpdate struct {
    ByID      map[int64]FAQEntryFieldsUpdate `json:"by_id,omitempty"`
    ByTag     map[int64]FAQEntryFieldsUpdate `json:"by_tag,omitempty"`
    ExcludeIDs []int64                        `json:"exclude_ids,omitempty"`
}
```

**两种更新模式**：
1. **ByID**: 按条目 ID 精确更新，每个条目可以有不同的更新内容
2. **ByTag**: 按标签批量更新，将相同更新应用到标签下的所有条目

**设计意图**：
- 满足精细化控制和批量操作的双重需求
- `ExcludeIDs` 提供了灵活的例外机制
- 只更新提供的字段，保持其他字段不变（部分更新）

### 3.6 DocumentChunkMetadata - 文档增强元数据

这个结构用于存储 AI 为文档 Chunk 生成的相关问题，体现了系统的智能增强能力。

```go
type DocumentChunkMetadata struct {
    GeneratedQuestions []GeneratedQuestion `json:"generated_questions,omitempty"`
}
```

**设计意图**：
- 将 AI 生成的问题独立索引，提高文档的召回率
- 保持生成问题的原始 ID，便于追踪和管理
- 提供向后兼容的 `GetQuestionStrings()` 方法

## 4. 依赖关系与数据契约

### 4.1 内部依赖

这个模块与以下模块紧密协作：
- [knowledge_and_chunk_api](../sdk_client_library-knowledge_and_chunk_api.md): 提供 Chunk 和 Knowledge 的基础数据结构
- [knowledge_core_model](../sdk_client_library-knowledge_and_chunk_api-knowledge_core_model.md): 知识核心模型定义
- [knowledge_base_faq_import_status_contracts](../frontend_contracts_and_state-api_contracts_for_backend_integrations-knowledge_base_faq_import_status_contracts.md): 前端 FAQ 导入状态契约

### 4.2 关键数据契约

#### Chunk 元数据契约

```go
// FAQMetadata 从 Chunk.Metadata 解析 FAQ 元数据
func (c *Chunk) FAQMetadata() (*FAQChunkMetadata, error)

// SetFAQMetadata 设置 Chunk 的 FAQ 元数据
func (c *Chunk) SetFAQMetadata(meta *FAQChunkMetadata) error
```

这个契约确保了：
- FAQ 数据与 Chunk 结构的解耦
- 类型安全的元数据访问
- 自动的标准化和哈希计算

## 5. 设计决策与权衡

### 5.1 将 FAQ 数据嵌入 Chunk.Metadata

**决策**：不创建专门的 FAQ 数据表，而是将 FAQ 数据嵌入通用的 Chunk 结构中。

**权衡**：
- ✅ **优点**：
  - 复用现有的存储、检索和版本控制机制
  - 统一的知识管理界面
  - 灵活的扩展性
- ❌ **缺点**：
  - 查询 FAQ 特定字段需要解析 JSON
  - 无法直接使用数据库索引优化 FAQ 查询
  - 数据结构变更需要处理兼容性

**为什么这样设计**：
系统的核心是统一知识管理，FAQ 只是知识的一种特殊形式。这种设计保持了架构的一致性，避免了数据 silos。

### 5.2 内容哈希计算策略

**决策**：基于标准化和排序后的内容计算哈希，而不是简单的序列化。

**权衡**：
- ✅ **优点**：
  - 顺序无关的内容比较
  - 自动处理空白和格式差异
  - 可靠的变更检测
- ❌ **缺点**：
  - 计算成本较高（需要排序和标准化）
  - 哈希计算逻辑变更会导致所有哈希失效

**为什么这样设计**：
FAQ 导入中最常见的问题是重复数据和无意义的格式变更。这种设计提供了强大的去重和变更检测能力。

### 5.3 双模式批量更新

**决策**：同时支持 ByID 和 ByTag 两种批量更新模式。

**权衡**：
- ✅ **优点**：
  - 灵活满足不同场景需求
  - 减少 API 调用次数
  - 支持复杂的批量操作
- ❌ **缺点**：
  - 接口复杂度增加
  - 需要处理两种模式的交互逻辑
  - 错误处理更加复杂

**为什么这样设计**：
FAQ 管理中常见的场景是：
1. 精确调整几个条目（ByID）
2. 将某个分类下的所有条目设为启用/禁用（ByTag）
3. 批量更新除了几个特殊条目外的所有条目（ByTag + ExcludeIDs）

### 5.4 失败条目的双模式返回

**决策**：根据失败条目数量，选择直接返回或 URL 下载。

**权衡**：
- ✅ **优点**：
  - 小批量时用户体验好（直接查看）
  - 大批量时性能好（避免响应过大）
  - 灵活适应不同规模的导入
- ❌ **缺点**：
  - 前端需要处理两种不同的响应格式
  - 需要实现文件存储和临时 URL 生成
  - 增加了系统复杂度

**为什么这样设计**：
FAQ 导入的规模差异很大，从几个条目到几万个条目都有可能。这种设计在用户体验和系统性能之间取得了平衡。

## 6. 使用指南与最佳实践

### 6.1 FAQ 导入流程

**标准导入流程**：
```go
// 1. 创建导入请求
payload := &FAQBatchUpsertPayload{
    Entries:     entries,
    Mode:        FAQBatchModeAppend,
    KnowledgeID: knowledgeID,
    DryRun:      true, // 先验证
}

// 2. 执行 DryRun 验证
dryRunResult, err := faqService.BatchUpsert(ctx, payload)
if err != nil {
    // 处理错误
}

// 3. 检查验证结果
if dryRunResult.FailedCount > 0 {
    // 处理失败条目
}

// 4. 执行实际导入
payload.DryRun = false
importResult, err := faqService.BatchUpsert(ctx, payload)
```

### 6.2 常见使用模式

**按标签批量启用条目**：
```go
update := &FAQEntryFieldsBatchUpdate{
    ByTag: map[int64]FAQEntryFieldsUpdate{
        tagID: {IsEnabled: &enabled},
    },
    ExcludeIDs: []int64{123, 456}, // 排除特定条目
}
```

**FAQ 检索**：
```go
request := &FAQSearchRequest{
    QueryText:           "如何重置密码？",
    VectorThreshold:     0.8,
    MatchCount:          5,
    FirstPriorityTagIDs: []int64{userGuideTagID},
}
```

## 7. 注意事项与潜在陷阱

### 7.1 隐式契约

1. **ID 范围限制**：`FAQEntryPayload.ID` 必须小于 100000000（自增起始值）
2. **内容标准化**：所有字符串字段都会被自动标准化（修剪空白、去重）
3. **哈希计算**：哈希基于内容计算，微小的内容变化会导致哈希变化

### 7.2 边缘情况

1. **空数组处理**：标准化后的空数组会被设置为 `nil`，而不是空切片
2. **版本号**：如果 `Version <= 0`，会被自动设置为 1
3. **标签缺失**：没有标签的条目会使用 `UntaggedTagName`（"未分类"）

### 7.3 性能考虑

1. **大规模导入**：对于超过 1000 条目的导入，建议使用异步模式
2. **哈希计算**：`CalculateFAQContentHash` 是 O(n log n) 复杂度（因为排序）
3. **批量更新**：ByTag 模式下，排除 ID 列表过长会影响性能

### 7.4 迁移注意事项

`FAQImportMetadata` 已被标记为 Deprecated，新代码应该使用 `FAQImportProgress` 和 Redis 存储。

## 8. 总结

`faq_content_and_import_contracts` 模块是 FAQ 功能的基石，它通过精心设计的数据契约，平衡了灵活性、一致性和性能。这个模块的设计体现了几个重要的架构原则：

1. **统一抽象**：将 FAQ 嵌入通用的知识表示中
2. **内容导向**：基于内容的哈希和标准化，而不是依赖元数据
3. **用户体验优先**：DryRun 模式、渐进式失败处理、灵活的批量操作
4. **向后兼容**：提供兼容性方法和渐进式迁移路径

理解这个模块的设计思想，对于正确使用和扩展 FAQ 功能至关重要。
