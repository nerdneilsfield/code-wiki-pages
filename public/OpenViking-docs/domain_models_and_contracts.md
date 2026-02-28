# domain_models_and_contracts 模块

> **阅读提示**：本文档面向刚加入团队的高级工程师。你可以直接阅读代码，但本文档的目的是解释设计意图、架构角色以及那些"不那么显而易见"的选择背后的原因。

## 一句话概括

这个模块定义了**向量数据库系统的核心抽象层**——它像是一座建筑的框架结构，定义了 Project（项目）、Collection（集合）、Index（索引）这些关键实体的"契约"（接口），而具体的实现则分布在其他模块中。理解了这个模块，你就理解了整个系统是如何从顶层（Project）层层向下（Collection → Index）组织的。

---

## 问题空间：为什么需要这些抽象？

在设计一个向量数据库系统时，我们面临几个核心问题：

1. **多后端支持**：系统需要支持本地存储、远程 HTTP 服务、火山引擎 VikingDB 等多种后端。如果每个后端都暴露自己的 API，上层业务代码将充满 `if-else` 的条件分支。

2. **资源生命周期管理**：向量索引、集合、底层存储都是稀缺资源。创建后必须显式释放，否则会导致内存泄漏或文件句柄耗尽。

3. **统一的数据操作语义**：不论底层是内存索引还是分布式服务，"插入数据"、"相似性搜索"、"删除数据"这些操作的语义应该是一致的。

4. **层次化的组织结构**：如何组织成千上万个向量集合？答案是按项目（Project）分组，每个项目包含多个集合（Collection），每个集合可以有多个索引（Index）。

这个模块正是为了解决这些问题而设计的——它通过**接口抽象 + 包装器模式**提供了一套统一的契约。

---

## 架构概览

### 核心组件与层次结构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Project (项目层)                             │
│   IProject / Project                                                │
│   职责：管理多个 Collection，提供命名空间隔离                         │
├─────────────────────────────────────────────────────────────────────┤
│                       Collection (集合层)                            │
│   ICollection / Collection                                          │
│   职责：管理数据（upsert/fetch/delete）、管理 Index、支持多种搜索方式 │
├─────────────────────────────────────────────────────────────────────┤
│                         Index (索引层)                               │
│   IIndex / Index                                                    │
│   职责：向量相似性搜索、标量字段过滤、聚合操作                         │
├─────────────────────────────────────────────────────────────────────┤
│                     Metadata Dictionary (元数据层)                   │
│   IDict / Dict                                                      │
│   职责：存储集合/索引的配置和元信息                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 数据流动路径

```
用户请求
    │
    ▼
┌─────────────────┐
│  Project       │ ← "我要操作哪个项目的哪个集合？"
└────────┬────────┘
         │ get_collection()
         ▼
┌─────────────────┐
│  Collection    │ ← "我要插入/搜索/删除数据"
└────────┬────────┘
         │ upsert_data() / search_by_vector() / ...
         ▼
┌─────────────────┐
│  Index         │ ← "在向量空间中找最相似的 Top-K 条记录"
└────────┬────────┘
         │ search()
         ▼
┌─────────────────┐
│  Store (存储层) │ ← 实际的向量数据和标量字段存储
└─────────────────┘
```

### 搜索能力矩阵

Collection 层封装了丰富的搜索接口，这是该模块的核心价值之一：

| 搜索方式 | 适用场景 | 底层实现 |
|---------|---------|---------|
| `search_by_vector` | 标准的向量相似性搜索（支持稠密 + 稀疏混合） | Index.search() |
| `search_by_keywords` | 文本关键词搜索（自动向量化） | Vectorizer → search_by_vector |
| `search_by_multimodal` | 多模态搜索（文本+图片+视频） | VectorizerAdapter → search_by_vector |
| `search_by_id` | 根据已有文档ID找相似文档 | fetch → search_by_vector |
| `search_by_random` | 随机采样/探索性查询 | 随机向量 → search_by_vector |
| `search_by_scalar` | 按标量字段排序（时间、评分等） | 标量索引 + 排序 |

---

## 核心设计决策

### 1. 接口抽象 + 包装器模式

**决策**：每个核心实体都有一对「接口 + 包装器」，例如 `ICollection` + `Collection`、`IIndex` + `Index`。

**为什么这样选择**：

- **接口（ABC）**：定义了"必须做什么"，但不关心"怎么做"。这使得可以同时存在 `LocalCollection`（内存实现）、`VolcEngineCollection`（云服务实现）、`VikingDBCollection`（另一种云服务实现）。
  
- **包装器类**：封装了接口实现，提供了额外的能力：
  - **资源生命周期管理**：在析构函数 `__del__` 中自动调用 `close()`
  - **状态检查**：每次操作前检查 `self.__collection is None`，防止对已关闭资源的操作
  - **类型安全**：构造函数中的 `assert isinstance()` 确保只接受正确的实现

** tradeoff 分析**：

| 方面 | 优势 | 代价 |
|-----|------|------|
| 接口抽象 | 后端可替换、业务代码与实现解耦 | 多了一层间接调用，轻微性能损耗 |
| 包装器模式 | 统一生命周期管理、安全性增强 | 需要维护两套代码（接口 + 包装器） |

**替代方案思考**：如果不用包装器，直接让业务代码调用接口实现会怎样？——答案是：业务代码需要显式管理资源，且每次操作前都要做 `if collection.closed` 检查，容易遗漏。

### 2. 层次化的命名空间

**决策**：Project → Collection → Index 的三层嵌套结构。

**为什么这样选择**：

- **Project**：提供多租户隔离或环境隔离（例如：dev 环境、prod 环境）
- **Collection**：类似于关系数据库的"表"，是数据组织的基本单位
- **Index**：是 Collection 内的"视图"，支持不同的向量配置（不同的向量化模型、不同的距离度量）

这与 Milvus 的 "Collection → Partition" 结构类似，但用 Index 替代了 Partition，因为 Index 更准确地描述了其"索引"的本质。

### 3. 搜索结果的统一返回格式

**决策**：`SearchResult` 是一个简单的数据结构，包含 `List[SearchItemResult]`，每个 item 包含 `id`、`fields`、`score`。

**为什么这样选择**：

- 不同的搜索方式（向量搜索、标量排序、随机采样）返回的数据结构是统一的
- `score` 字段的设计很巧妙：向量搜索时是相似度分数，标量排序时是字段值，随机搜索时无意义但仍保留字段（保持接口一致）

### 4. DeltaRecord 的设计

**决策**：索引操作使用 `DeltaRecord` 而非直接操作完整数据。

```python
@dataclass
class DeltaRecord:
    type: int           # UPSERT = 0 或 DELETE = 1
    label: int          # 主键（向量化后的 ID）
    vector: List[float] # 稠密向量
    sparse_raw_terms: List[str]   # 稀疏向量的词项
    sparse_values: List[float]    # 稀疏向量的权重
    fields: str         # 标量字段（JSON 序列化）
    old_fields: str     # 更新前的字段（用于增量更新追踪）
```

**为什么这样设计**：

- **增量更新**：当 Collection 中有一条数据更新时，不需要重新处理所有索引，只需将变更的 delta 同步到相关索引
- **支持软删除**：删除操作只需记录 `type=DELETE`，索引中标记为"墓碑"（tombstone），避免并发读取问题

---

## 子模块概览

| 子模块 | 核心职责 | 关键类型 |
|-------|---------|---------|
| [collection_contracts_and_results](./vectordb-domain-models-and-service_schemas-collection_contracts_and_results.md) | Collection 的接口定义与搜索结果封装 | `ICollection`, `Collection`, `SearchResult`, `AggregateResult` |
| [index_domain_models_and_interfaces](./vectordb-domain-models-and-service_schemas-domain_models_and_contracts-index_domain_models_and_interfaces.md) | 索引的抽象接口与包装器 | `IIndex`, `Index`, `DeltaRecord` |
| [metadata_dictionary_models](./vectordb-domain-models-and-service-schemas-domain-models-and-contracts-metadata-dictionary-models.md) | 元数据字典的抽象接口 | `IDict`, `Dict` |
| [project_domain_models_and_interfaces](./vectordb-domain-models-and-service-schemas-domain-models-and-contracts-project-domain-models-and-interfaces.md) | 项目的抽象接口与包装器 | `IProject`, `Project` |

---

## 与其他模块的关联

### 上游：服务层（API 契约）

[service_api_models_collection_and_index_management](../service_api_models_collection_and_index_management.md) 定义了 HTTP API 请求/响应的数据模型（如 `CollectionCreateRequest`、`IndexCreateRequest`）。这些模型经过验证后会调用本模块的接口：

```
HTTP 请求 → FastAPI → Service 层 → Project/Collection/Index 接口
```

### 下游：存储与向量化

- **[storage_core_and_runtime_primitives](../storage_core_and_runtime_primitives.md)**：提供了底层的存储抽象（`StoreManager`、`IKVStore`），Collection 内部委托这些组件完成实际的数据持久化
- **[vectorization_and_storage_adapters](../vectorization_and_storage_adapters.md)**：提供了 `VectorizerFactory` 和各种 `CollectionAdapter`，Collection 在执行 `search_by_keywords` 和 `search_by_multimodal` 时会调用向量化器

### 依赖关系可视化

```
                    ┌──────────────────────────────┐
                    │  service_api_models (API层)   │
                    └──────────────┬───────────────┘
                                   │ 调用
                    ┌──────────────▼───────────────┐
                    │  domain_models_and_contracts │ ← 当前模块
                    │  (IProject, ICollection,      │
                    │   IIndex, IDict)             │
                    └──────────────┬───────────────┘
                                   │ 委托
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────┐      ┌─────────────────────┐    ┌─────────────────┐
│ storage_core  │      │ vectorization_and_  │    │ (其他实现模块)   │
│ _and_runtime  │      │ storage_adapters    │    │ - volcengine_   │
│ _primitives   │      │ (Vectorizer,        │    │   collection    │
│ (StoreManager)│      │  CollectionAdapter) │    │ - vikingdb_     │
└───────────────┘      └─────────────────────┘    │   collection    │
                                                  │ - http_collection│
                                                  └─────────────────┘
```

---

## 新贡献者需要特别注意的点

### 1. 资源泄漏风险

**警示**：虽然包装器在 `__del__` 中会自动调用 `close()`，但这依赖于 Python 的垃圾回收机制，在以下场景可能导致问题：

- **长期运行的服务**：如果依赖 GC 来释放资源，文件句柄、数据库连接可能耗尽
- **异常路径**：如果在 `close()` 之前抛出异常导致对象悬空，资源可能未正确释放

**最佳实践**：

```python
# 推荐：显式管理生命周期
project = LocalProject(path="./data")
try:
    collection = project.get_collection("my_collection")
    results = collection.search_by_vector(...)
finally:
    project.close()  # 显式释放资源
```

### 2. 搜索结果的 offset 实现

**陷阱**：`search_by_vector` 等方法的 `offset` 参数实现方式可能出乎意料。

看 `LocalCollection.search_by_vector` 的实现：

```python
# 请求更多结果来处理 offset
actual_limit = limit + offset
label_list, scores_list = index.search(..., actual_limit, ...)

# 在应用层切片
if offset > 0:
    label_list = label_list[offset:]
    scores_list = scores_list[offset:]
```

这意味着：**offset 越大，底层搜索的 Top-K 就越大**，性能开销也随之增加。在分页场景中，深分页（large offset）会有性能问题。

### 3. 索引与 Collection 的生命周期耦合

**发现**：在 `LocalCollection` 中，索引（`IIndex`）被保存在 `ThreadSafeDictManager` 中。当 Collection 关闭时，所有索引会自动关闭：

```python
def close(self):
    # 关闭所有索引
    def close_index(name, index):
        index.close()
    self.indexes.iterate(close_index)
    self.indexes.clear()
    self.store_mgr = None
```

这意味着：**不能单独关闭或持久化某个索引**——它完全绑定在 Collection 的生命周期上。

### 4. 搜索方式的适用场景

| 搜索方式 | 性能特性 | 适用场景 |
|---------|---------|---------|
| `search_by_vector` | 最优（原生向量索引） | 生产环境首选 |
| `search_by_keywords` | 需要额外一次向量化调用 | 文本搜索入口 |
| `search_by_multimodal` | 可能需要多次向量化 | 多模态检索 |
| `search_by_random` | 每次生成随机向量，开销中等 | 随机采样、调试 |
| `search_by_scalar` | 依赖标量索引存在性 | 排序、范围查询 |

### 5. 聚合操作的当前限制

**注意**：`aggregate_data` 目前**只支持 `count` 操作**：

```python
def aggregate_data(
    self,
    index_name: str,
    op: str = "count",  # 目前只能是 "count"
    field: Optional[str] = None,
    ...
) -> AggregateResult:
```

如果传入其他 `op` 值（如 `sum`、`avg`），底层会忽略或返回空结果。

---

## 总结

这个模块的核心价值在于：

1. **统一的契约**：无论底层是本地存储还是云服务，API 语义一致
2. **清晰的分层**：Project → Collection → Index 的层次结构易于理解和维护
3. **丰富的搜索能力**：6 种搜索方式覆盖了大多数向量检索场景
4. **资源安全**：包装器模式确保资源正确释放

理解了这个模块，你就掌握了整个向量数据库系统的"骨架"。接下来可以深入：

- [collection_contracts_and_results](./vectordb-domain-models-and-service_schemas-collection_contracts_and_results.md) —— 了解 Collection 的完整接口
- [index_domain_models_and_interfaces](./vectordb-domain-models-and-service_schemas-domain_models_and_contracts-index_domain_models_and_interfaces.md) —— 了解 Index 的向量搜索原语
- [metadata_dictionary_models](./vectordb-domain-models-and-service-schemas-domain-models-and-contracts-metadata-dictionary-models.md) —— 了解元数据字典的设计
- [project_domain_models_and_interfaces](./vectordb-domain-models-and-service-schemas-domain-models-and-contracts-project-domain-models-and-interfaces.md) —— 了解项目的组织方式