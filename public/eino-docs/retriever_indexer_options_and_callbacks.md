# Retriever & Indexer Options and Callbacks (检索器与索引器配置与回调)

这个模块为检索器（Retriever）和索引器（Indexer）组件提供了统一的配置选项和回调机制，是连接上层应用与具体实现之间的"桥梁"和"契约"。

## 1. 模块概览

在构建检索增强生成（RAG）系统中，检索和索引是两个核心操作：
- **索引（Indexing）**：将文档转换为向量并存储到检索系统
- **检索（Retrieval）**：根据查询从检索系统中找到相关文档

这个模块的作用类似于餐厅的"点菜系统"：它不直接烹饪食物（实现具体的检索/索引逻辑），而是提供标准化的方式来传递"烹饪要求"（配置选项）和记录"烹饪过程"（回调信息）。

## 2. 核心组件

### 2.1 配置选项系统

本模块采用函数式选项模式（Functional Options Pattern），这是一种在 Go 语言中处理可选参数的优雅解决方案。

#### 检索器选项（Retriever Options）

检索器选项允许你配置检索行为，就像在搜索引擎中设置搜索参数一样。

**核心组件：
- `Option：单个配置选项
- `Options`：所有配置的集合
- `With*` 系列函数：用于构建选项的工厂函数

**主要配置项：**
- `Index`：检索的索引名称
- `SubIndex`：检索的子索引名称
- `TopK`：返回的最相关文档数量
- `ScoreThreshold`：文档相似度的最低分数要求
- `Embedding`：用于将查询转换为向量的嵌入器
- `DSLInfo`：特定实现的 DSL 信息（仅适用于 Viking）

#### 索引器选项（Indexer Options）

索引器选项用于配置文档索引行为。

**核心组件：**
- `Option`：单个配置选项
- `Options`：所有配置的集合
- `With*` 系列函数：用于构建选项的工厂函数

**主要配置项：**
- `SubIndexes`：要索引的子索引列表
- `Embedding`：用于将文档转换为向量的嵌入器

### 2.2 回调系统

回调系统提供了一种在检索和索引过程中捕获输入输出信息的机制，类似于飞机上的"黑匣子"记录器。

#### 检索器回调

**CallbackInput**：
- `Query`：检索查询
- `TopK`：返回文档数量
- `Filter`：过滤条件
- `ScoreThreshold`：分数阈值
- `Extra`：额外信息

**CallbackOutput**：
- `Docs`：检索到的文档
- `Extra`：额外信息

#### 索引器回调

**CallbackInput**：
- `Docs`：要索引的文档
- `Extra`：额外信息

**CallbackOutput**：
- `IDs`：索引后的文档 ID
- `Extra`：额外信息

## 3. 设计决策

### 3.1 函数式选项模式

本模块采用函数式选项模式，这是一个经过深思熟虑的设计选择：

**为什么选择函数式选项模式：**

1. **向后兼容性**：添加新选项不会破坏现有代码
2. **可读性**：`WithTopK(10)` 比传递一堆 `nil` 参数更清晰
3. **默认值处理**：可以安全地忽略不需要配置的选项
4. **实现特定选项**：通过 `WrapImplSpecificOptFn` 支持特定实现的选项

**替代方案对比：**
- 结构体字面量：不够灵活，添加新字段会破坏兼容性
- 配置构建器：更冗长，需要更多代码

### 3.2 通用选项与实现特定选项分离

模块明确区分了通用选项和实现特定选项：

**通用选项**：所有检索器/索引器都支持的选项
**实现特定选项**：仅特定实现支持的选项

这种分离使得：
- 通用代码可以依赖通用选项
- 特定实现可以有自己的特殊配置
- 两者互不干扰，保持松耦合

### 3.3 类型安全的回调转换

回调系统提供了类型安全的转换函数：

```go
// 从通用回调输入转换为检索器特定回调输入
func ConvCallbackInput(src callbacks.CallbackInput) *CallbackInput
```

这种设计允许：
- 回调系统处理通用类型
- 具体组件可以使用自己的特定类型
- 提供了类型转换的安全网

## 4. 数据流程

### 4.1 检索流程

```
用户查询 → 创建检索器 → 应用配置选项 → 执行检索 → 触发回调 → 返回文档
     ↓              ↓                  ↓          ↓          ↓          ↓
  Query       WithTopK(10)       向量搜索  CallbackInput  CallbackOutput  Docs
```

### 4.2 索引流程

```
文档列表 → 创建索引器 → 应用配置选项 → 执行索引 → 触发回调 → 返回文档ID
     ↓              ↓                  ↓          ↓          ↓          ↓
   Docs      WithEmbedding(emb)   向量存储  CallbackInput  CallbackOutput  IDs
```

## 5. 使用示例

### 5.1 检索器配置

```go
// 创建检索器选项
opts := []retriever.Option{
    retriever.WithTopK(10),
    retriever.WithScoreThreshold(0.7),
    retriever.WithEmbedding(embedder),
}

// 提取通用选项
baseOpts := retriever.GetCommonOptions(nil, opts...)

// 提取特定实现选项
type MyRetrieverOpts struct {
    CustomField string
}
myOpts := retriever.GetImplSpecificOptions(&MyRetrieverOpts{
    CustomField: "default"}, opts...)
```

### 5.2 索引器配置

```go
// 创建索引器选项
opts := []indexer.Option{
    indexer.WithSubIndexes([]string{"sub1", "sub2"}),
    indexer.WithEmbedding(embedder),
}

// 提取选项
opts := indexer.GetCommonOptions(nil, opts...)
```

### 5.3 回调使用

```go
// 在回调处理器中使用
func (h *MyRetrieverHandler) OnEnd(ctx context.Context, info *callbacks.RunInfo, input callbacks.CallbackInput, output callbacks.CallbackOutput) {
    // 转换为检索器特定的输入输出
    ri := retriever.ConvCallbackInput(input)
    ro := retriever.ConvCallbackOutput(output)
    
    if ri != nil && ro != nil {
        log.Printf("检索查询: %s, 返回文档数: %d", ri.Query, len(ro.Docs))
    }
}
```

## 6. 注意事项

### 6.1 选项应用顺序

选项按照提供的顺序应用，后提供的选项会覆盖先提供的选项：

```go
// 最终 TopK 会是 20，而不是 10
opts := []retriever.Option{
    retriever.WithTopK(10),
    retriever.WithTopK(20),
}
```

### 6.2 实现特定选项的类型安全

使用 `GetImplSpecificOptions` 时要确保类型匹配，否则不会报错但也不会应用选项：

```go
// 这样不会报错，但选项不会被应用
type WrongType struct{}
opts := retriever.GetImplSpecificOptions(&WrongType{}, opts...)
```

### 6.3 回调输入输出的 nil 检查

使用 `ConvCallbackInput` 和 `ConvCallbackOutput` 可能返回 nil，一定要进行检查：

```go
ri := retriever.ConvCallbackInput(input)
if ri == nil {
    // 处理转换失败的情况
}
```

### 6.4 与其他模块的关系

- 依赖 [Schema Core Types](schema_core_types.md) 中的 `Document` 类型
- 与 [Callbacks System](callbacks_system.md) 紧密协作
- 被 [Flow Retrievers](flow_retrievers.md) 和 [Flow Indexers](flow_indexers.md) 使用
