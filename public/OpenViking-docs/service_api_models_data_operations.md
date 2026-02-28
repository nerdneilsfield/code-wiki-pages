# service_api_models_data_operations 模块技术深度解析

## 模块概述

`service_api_models_data_operations` 模块是 OpenViking 向量数据库服务层中的**数据平面操作契约定义模块**。它位于 `openviking.storage.vectordb.service.app_models` 包中，定义了向量数据库最核心的三类原子操作：数据写入（upsert）、数据读取（fetch）和数据删除（delete）。

**这个模块解决的问题是**：在向量数据库的分布式架构中，如何为客户端提供一个类型安全、经过验证的 API 契约，使得上层调用者（无论是 REST API、SDK 还是其他服务）能够以统一的方式操作-collection 中的向量数据，同时保持足够的灵活性来适应不同的后端存储实现。

如果你把整个向量数据库系统想象成一个大型图书馆，那么 Collection（集合）就是图书馆中的一个个书架，而数据操作模型就是**借书卡**——它们定义了你可以对书架上的书籍（向量数据）执行哪些操作，以及操作时需要填写哪些信息。

---

## 架构角色与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端调用层                                    │
│  (Python Client / Rust CLI / TUI / External Services)                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FastAPI 服务层 (api_fastapi.py)                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  @data_router.post("/upsert")    →  DataUpsertRequest               │  │
│  │  @data_router.get("/fetch")      →  DataFetchRequest                │  │
│  │  @data_router.post("/delete")    →  DataDeleteRequest               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               本模块 (service_api_models_data_operations)                    │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                │
│  │DataUpsertRequest│  │DataFetchRequest│  │DataDeleteRequest│               │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘                │
└──────────┼───────────────────┼───────────────────┼─────────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   ICollection 接口 (collection/collection.py)               │
│  ┌────────────────────┐  ┌──────────────────┐  ┌────────────────────┐      │
│  │   upsert_data()    │  │   fetch_data()   │  │  delete_data()     │      │
│  └─────────┬──────────┘  └────────┬─────────┘  └─────────┬──────────┘      │
└────────────┼──────────────────────┼──────────────────────┼──────────────────┘
             │                      │                      │
             ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   存储适配器层 (vectordb_adapters/)                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │LocalCollectionAdapter│ │HttpCollectionAdapter│ │VolcengineCollectionAdapter│  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘          │
└───────────┼─────────────────────┼─────────────────────┼─────────────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      底层存储引擎 (store/)                                   │
│              LocalStore / VolcEngineClient / VikingDBClient                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

从数据流的角度来看，一个典型的请求路径是这样的：

1. **客户端**构造一个 `DataUpsertRequest` 对象，包含 collection_name、fields（数据列表）和可选的 ttl
2. **FastAPI 层**接收请求，利用 Pydantic 自动完成 JSON 反序列化和基础验证
3. **业务逻辑层**调用 `ICollection.upsert_data()` 方法，传入原始数据字典列表
4. **Collection 实现层**（如 `LocalCollection`）执行数据验证、向量生成（如果配置了向量化）、索引更新
5. **存储层**将数据持久化到 `StoreManager` 管理的底层存储

---

## 核心组件详解

### DataUpsertRequest

```python
class DataUpsertRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    fields: Any = Field(..., description="Data list")
    ttl: Optional[int] = Field(0, description="Time to live")
```

**设计意图**：`DataUpsertRequest` 是"写入或更新"操作的请求载体。之所以称为 "upsert"（update + insert），是因为它同时支持两种语义：当传入的主键（primary key）已存在时执行更新，不存在时执行插入。这种设计简化了客户端代码，无需关心数据是否已存在。

**字段解析**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| collection_name | str | 是 | - | 目标 collection 的名称 |
| project | str | 否 | "default" | 项目命名空间，用于多租户隔离 |
| fields | Any | 是 | - | **数据列表**，可以是 List[Dict] 或其他可序列化格式 |
| ttl | int | 否 | 0 | 生存时间（秒），0 表示永不过期 |

**关键设计决策**：`fields` 字段使用 `Any` 类型而非严格类型定义，这是一个**有意的灵活性 vs 类型安全权衡**。原因是向量数据库的字段模式是动态的——不同的 collection 可以有不同的字段定义（由 CollectionCreateRequest 的 Fields 参数决定）。如果在这里强制类型，就会破坏动态schema的能力。下游的 `DataProcessor` 和 `CollectionSchemas` 会在实际使用时进行字段验证。

**内部机制**：当请求到达 `LocalCollection.upsert_data()` 时，会依次经历以下处理步骤：

1. **数据验证**：`DataProcessor.validate_and_process()` 根据 collection 的字段定义验证每条记录
2. **向量化**：如果配置了 `VectorizerAdapter`，会自动对文本字段生成 dense/sparse 向量
3. **主键处理**：根据 schema 中的主键定义（可能是自增ID或自定义字段），生成内部 label
4. **索引更新**：新建 `CandidateData` 对象并同步到所有已存在的索引
5. **返回结果**：返回包含生成的主键列表的 `UpsertDataResult`

### DataFetchRequest

```python
class DataFetchRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    ids: Any = Field(..., description="Primary key list")
```

**设计意图**：`DataFetchRequest` 是根据主键列表批量获取数据的请求模型。向量数据库的核心价值在于向量相似搜索，但在实际应用中，用户经常需要根据已知 ID 精确获取某些记录——这类似于关系数据库中的 `SELECT * FROM table WHERE id IN (...)`。

**字段解析**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| collection_name | str | 是 | - | 目标 collection 名称 |
| project | str | 否 | "default" | 项目命名空间 |
| ids | Any | 是 | - | 主键列表，支持多种格式 |

**内部机制**：

1. **ID 转换**：根据 collection 的主键类型（自增 ID 或字符串），将传入的主键转换为内部的 numeric label
2. **数据拉取**：`StoreManager.fetch_cands_data()` 从底层存储获取原始数据
3. **字段恢复**：解析 JSON 格式的 fields，并重新附加向量数据（如果向量化器未配置）
4. **结果组装**：返回 `FetchDataInCollectionResult`，包含成功获取的 items 和不存在的 ids_not_exist

### DataDeleteRequest

```python
class DataDeleteRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    ids: Optional[Any] = Field(None, description="Primary key list")
    del_all: Optional[bool] = Field(False, description="Delete all flag")
```

**设计意图**：`DataDeleteRequest` 提供了两种删除模式：按 ID 删除特定记录，以及清空整个 collection。这是向量数据库的 destructive operation，需要特别小心处理。

**字段解析**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| collection_name | str | 是 | - | 目标 collection 名称 |
| project | str | 否 | "default" | 项目命名空间 |
| ids | Any | 否 | None | 要删除的主键列表 |
| del_all | bool | 否 | False | **危险**：是否删除所有数据 |

**内部机制**：

1. **删除模式判断**：
   - 如果 `del_all=True`：调用 `delete_all_data()`，会清除所有索引并重置存储
   - 否则：只删除 `ids` 中指定的主键
2. **索引同步**：删除操作会同时更新所有相关索引，维护数据一致性
3. **返回值**：返回删除的记录数量（del_all 时返回 `"all"`）

---

## 设计决策与权衡

### 1. 命名风格不一致

**观察**：数据操作模型使用 snake_case（`collection_name`, `project`, `fields`），而 Collection 和 Index 管理模型使用 PascalCase（`CollectionName`, `ProjectName`, `Fields`）。

**原因分析**：这并非设计疏忽，而是反映了两个不同时期的 API 设计风格：
- PascalCase 版本是**原有系统**的遗留风格，与后端 VolcEngine API 对接
- snake_case 版本是**新版 SDK** 适配层采用的风格，更符合 Python 社区惯例

**权衡考量**：保持兼容性意味着必须同时支持两套风格，这在 API 层可以看到 `get_collection_dependency` 和 `get_collection_dependency_snake` 两个依赖注入函数分别处理两种风格。

**对开发者的影响**：如果你在编写新的客户端代码，建议使用 snake_case 版本；如果要与现有系统集成，需要注意路径和参数名的差异。

### 2. Any 类型的广泛使用

**观察**：`fields` 和 `ids` 字段都使用 `Any` 类型，而不是严格的 `List[Dict[str, Any]]` 或 `List[str]`。

**权衡分析**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 严格类型 | 静态检查友好、IDE 支持好 | 失去灵活性、破坏动态 schema 能力 |
| Any 类型 | 最大灵活性、支持多种输入格式 | 失去编译时类型保障、运行时风险高 |

**选择理由**：向量数据库的应用场景变化万千，用户可能通过 JSON 字符串、Python 字典、列表等多种形式传递数据。在 `api_fastapi.py` 中使用 `data_utils.convert_dict()` 进行运行时转换，这种 "宽松输入、严格处理" 的策略在实践中被证明更实用。

### 3. TTL 的单位转换陷阱

**观察**：`DataUpsertRequest.ttl` 的描述是"秒"，但 `LocalCollection.upsert_data()` 内部会将其转换为纳秒存储：

```python
cands_list[i].expire_ns_ts = time.time_ns() + ttl * 1000000000 if ttl > 0 else 0
```

**设计考量**：内部存储使用纳秒是为了与底层 C++ 存储引擎（`native_engine_and_python_bindings` 模块）保持一致，避免浮点数精度问题。但对上层 API 暴露"秒"的概念更符合人类直觉。

**潜在风险**：如果你在调试时发现数据立即过期或永不过期，很可能是单位混淆导致的。默认值 `0` 表示永不过期，这符合直觉；但如果传入负数，会被当作 0 处理（永不过期）。

### 4. del_all 标志的危险性

**观察**：`DataDeleteRequest.del_all` 可以一键清空整个 collection 的所有数据和索引。

**设计权衡**：这是一个**有意但危险**的设计。在某些运维场景下（如清理测试数据、重置 collection），批量删除是必要的能力。提供这个标志可以避免客户端循环调用 delete_data() 导致的性能问题。

**风险缓解**：在实际生产环境中，建议：
1. 对 del_all 操作进行额外的权限校验
2. 考虑增加"软删除"机制，先标记为删除再异步清理
3. 在文档和 API 响应中明确提示这是 destructive operation

---

## 使用指南与最佳实践

### 正确的请求构造方式

```python
from openviking.storage.vectordb.service.app_models import (
    DataUpsertRequest,
    DataFetchRequest,
    DataDeleteRequest
)

# 写入数据
upsert_request = DataUpsertRequest(
    collection_name="my_collection",
    project="default",
    fields=[
        {"id": "doc_1", "text": "Hello world", "vector": [0.1, 0.2, 0.3]},
        {"id": "doc_2", "text": "Vector search", "vector": [0.4, 0.5, 0.6]}
    ],
    ttl=3600  # 1小时后过期
)

# 读取数据
fetch_request = DataFetchRequest(
    collection_name="my_collection",
    ids=["doc_1", "doc_2"]
)

# 删除数据
delete_request = DataDeleteRequest(
    collection_name="my_collection",
    ids=["doc_1"],
    del_all=False  # 删除特定记录
)
```

### 通过 SDK 的便捷封装

如果你使用 `CollectionAdapter`，这些请求模型会被进一步封装为更易用的接口：

```python
from openviking.storage.vectordb_adapters.local_adapter import LocalCollectionAdapter

adapter = LocalCollectionAdapter.from_config({"path": "./data"})
adapter.upsert([
    {"id": "doc_1", "text": "Content here"},
    {"id": "doc_2", "text": "More content"}
])

records = adapter.get(["doc_1", "doc_2"])
deleted_count = adapter.delete(ids=["doc_1"])
```

---

## 边缘情况与注意事项

### 1. 主键不存在时的行为

- **upsert_data**：如果传入的主键不存在，会自动创建新记录
- **fetch_data**：如果主键不存在，该 ID 会被放入 `ids_not_exist` 列表而非抛出异常
- **delete_data**：如果主键不存在，**不会报错**，而是静默跳过（这是常见的"幂等"设计）

### 2. 字段类型转换

API 接收的 `fields` 通常是 JSON 序列化的数据。内部的 `data_utils.convert_dict()` 会尝试将其转换为 Python 对象：

```python
# 这些输入格式都是合法的
fields = '[{"id": "1"}, {"id": "2"}]'  # JSON 字符串
fields = [{"id": "1"}, {"id": "2"}]    # Python List
fields = ({"id": "1"}, {"id": "2"})    # Python Tuple
```

### 3. 向量数据的处理

如果 collection 配置了 `Vectorize`（向量化配置），你可以：

- **传入预计算的向量**：`{"text": "content", "vector": [0.1, 0.2, ...]}`
- **只传文本，让系统自动向量化**：`{"text": "content"}`（需要 VectorizerAdapter）

自动向量化的好处是客户端无需关心 embedding 模型，但会增加写入延迟。

### 4. 大批量操作的性能

`fields` 理论上可以包含任意数量的记录，但实际使用中需要注意：

- 单次请求的推荐上限：**1000 条记录**
- 超过上限时，建议分批调用
- 大量数据写入时，考虑关闭索引的实时更新（后续手动 rebuild）

---

## 相关模块索引

- **[vectordb_domain_models_and_service_schemas](vectordb_domain_models_and_service_schemas.md)**：父模块，包含所有服务层模型的概览
- **[service_api_models_collection_and_index_management](service_api_models_collection_and_index_management.md)**：Collection 和 Index 管理的请求模型
- **[service_api_models_search_requests](service_api_models_search_requests.md)**：搜索请求模型（向量搜索、标量搜索、关键词搜索等）
- **[schema_validation_and_constants](schema_validation_and_constants.md)**：字段类型枚举、验证器、常量定义
- **[collection_contracts_and_results](collection_contracts_and_results.md)**：`ICollection` 接口和 `SearchResult` 定义
- **[collection_adapters_abstraction_and_backends](collection_adapters_abstraction_and_backends.md)**：存储适配器抽象层
- **[local_and_http_collection_backends](local_and_http_collection_backends.md)**：本地和 HTTP 后端实现