# service_api_models_data_operations 模块技术深度解析

## 一、模块定位与问题空间

`service_api_models_data_operations` 模块是 OpenViking 向量数据库服务层中的**数据传输对象（DTO）定义模块**，位于 `openviking.storage.vectordb.service.app_models` 包中。该模块定义了三个核心的 Pydantic 模型，用于封装客户端向向量数据库发起的数据增删改查请求。

在分布式向量数据库系统中，客户端与服务器之间的通信需要一套标准化的请求格式。这些请求格式必须满足以下需求：首先，能够清晰表达操作意图（是插入、更新还是删除）；其次，能够携带操作所需的所有上下文信息（目标集合、主键、字段数据等）；最后，能够在传输层进行有效的序列化和反序列化。该模块正是为了解决这三个需求而设计的。

从架构角度来看，这个模块扮演着**API 契约定义**的角色。它位于 FastAPI 服务层和业务逻辑层之间，充当二者之间的桥梁。任何希望与向量数据库服务交互的客户端——无论是 Python SDK、CLI 工具还是第三方集成——都需要遵循这些模型所定义的契约。

## 二、核心抽象与设计意图

### 2.1 数据模型的三种操作形态

该模块定义了三种核心数据操作模型，它们分别对应 CRUD 完整生命周期中的三个关键动作：

**DataUpsertRequest** 模型负责数据的插入或更新。"Upsert"（Update + Insert）是一种常见的数据库操作模式：当指定主键的记录不存在时，执行插入操作；当记录已存在时，执行更新操作。这种设计避免了传统数据库中需要先查询再决定是插入还是更新的两步操作，大大简化了客户端代码并减少了竞态条件的可能性。该模型的 `fields` 字段采用 `Any` 类型设计，这是出于灵活性的考虑——向量数据库需要支持多种不同结构的文档，强制指定固定 schema 会限制其适用范围。

**DataFetchRequest** 模型专注于数据的读取操作。它通过主键列表精确获取记录，这种按 ID 查询的方式是向量数据库中最基础也是最高效的检索手段。与向量相似性搜索不同，按 ID 获取数据是一种确定性操作，结果完全由输入的主键决定，不涉及任何评分或排序逻辑。

**DataDeleteRequest** 模型处理数据的删除。它支持两种删除模式：一种是指定主键列表的精确删除，另一种是清空整个集合的批量删除。这种设计参考了 Redis 等键值存储的 API 风格，提供了从单条记录到整个数据集合的不同粒度控制。

### 2.2 设计决策背后的考量

在设计这些模型时，团队做出了几个重要的权衡决策：

**字段命名的风格选择**：注意到 `DataUpsertRequest` 使用小写字母开头的字段名（如 `collection_name`、`project`、`fields`），而 `CollectionCreateRequest` 等管理类模型使用大写字母开头的字段名（如 `CollectionName`、`ProjectName`）。这种不一致并非疏忽，而是有意为之：数据操作请求遵循的是内部 Python 风格（snake_case），而管理类请求遵循的是外部 API 风格（PascalCase），这种区分反映了请求来源和使用场景的差异。

**Any 类型的广泛使用**：`fields`、`ids`、`filter` 等字段都使用了 `Any` 类型而非强类型定义。这是经过深思熟虑的决策：向量数据库的存储格式高度灵活，可能包含向量、标量字段、嵌套对象等不同类型的数据，在服务层进行严格的类型约束会导致模型过于僵硬，无法适应实际业务的多样性。类型验证的责任被下沉到了更接近存储层的 Collection 实现中。

**TTL 支持的设计**：`DataUpsertRequest` 中包含 `ttl` 字段，支持为每条记录设置生命周期。这一特性在构建缓存系统或时序数据场景时非常有用。例如，在 RAG（检索增强生成）系统中，可以将知识库文档的 embedding 结果设置为一定时间后自动过期，从而实现数据的周期性更新。

## 三、数据流向与模块协作

### 3.1 完整的数据流路径

理解该模块的最佳方式是追踪一条数据从请求到存储的完整路径。

当客户端发送一个 `DataUpsertRequest` 请求时，请求首先到达 FastAPI 路由层（定义在 `api_fastapi.py` 中的 `/api/vikingdb/data/upsert` 端点）。FastAPI 会自动将 JSON 请求体反序列化为 `DataUpsertRequest` Pydantic 模型，在这一步骤中进行基础的字段验证和类型转换。

接下来，API 处理器会调用 `get_collection_or_raise` 依赖函数，该函数根据请求中的 `collection_name` 和 `project` 参数从项目组中获取对应的 Collection 实例。如果指定的集合不存在，抛出 `VikingDBException` 异常。

获取到 Collection 实例后，请求中的字段数据会被传递给 Collection 的 `upsert_data` 方法。此时，数据操作请求模型完成了其历史使命，后续的向量编码、索引更新、数据持久化等工作都由 Collection 层及其背后的存储适配器完成。

```python
# api_fastapi.py 中的请求处理逻辑
@data_router.post("/upsert", response_model=ApiResponse)
async def upsert_data(request: DataUpsertRequest, req: Request):
    collection = get_collection_or_raise(request.collection_name, request.project or "default")
    ttl = request.ttl or 0
    data_list = data_utils.convert_dict(request.fields)
    result = collection.upsert_data(data_list=data_list, ttl=ttl)
    return success_response("upsert data success", result.ids, request=req)
```

### 3.2 模块依赖关系

该模块处于依赖链的关键位置，它被以下模块直接消费：

**服务层（API）**：在 `api_fastapi.py` 中，所有的数据端点（upsert、fetch、delete）都直接依赖这些 Pydantic 模型。API 层不关心数据的具体内容，只负责将请求路由到正确的 Collection 实例。

**Collection 接口层**：`ICollection` 接口（定义在 `collection/collection.py`）定义了 `upsert_data`、`fetch_data`、`delete_data` 四个抽象方法，这些方法与请求模型形成一一对应关系。Collection 是请求模型的消费者，它将结构化的请求数据转换为底层存储引擎可以理解的操作指令。

**Collection 适配器层**：各种后端实现（如 `LocalCollectionAdapter`、`VolcengineCollectionAdapter`、`VikingDBPrivateCollectionAdapter`）通过实现 `ICollection` 接口来处理实际的数据操作。适配器层屏蔽了不同存储引擎的差异，提供统一的 Collection 接口。

**存储原语层**：最终，数据被转换为 `Op` 操作（定义在 `storage/vectordb/store/store.py` 中的 `Op` 和 `OpType`），写入底层的键值存储或向量索引。

## 四、组件深度解析

### 4.1 DataUpsertRequest

```python
class DataUpsertRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    fields: Any = Field(..., description="Data list")
    ttl: Optional[int] = Field(0, description="Time to live")
```

这个模型的设计体现了"约定优于配置"的原则：`project` 字段有默认值 "default"，这意味着单租户场景下客户端可以完全省略该项目参数；`ttl` 默认为 0，表示数据永久存储，这对大多数知识库场景是合理的。

`fields` 字段是整个模型中最复杂的部分。它期望接收一个数据列表（List[Dict]），每个字典代表一条记录，记录中必须包含主键字段（通常命名为 `id`）。在实际使用中，这个字段通常承载着非常丰富的数据结构：文本内容、向量化向量、文本的元数据（来源、更新时间等）以及可能的用户自定义字段。

**一个典型的 upsert 请求示例**：

```json
{
    "collection_name": "document_embeddings",
    "project": "rag_knowledge_base",
    "fields": [
        {
            "id": "doc_12345",
            "text": "向量数据库是一种专门用于存储和检索向量数据的数据库系统",
            "dense_vector": [0.123, -0.456, 0.789, ...],
            "sparse_vector": {"word1": 0.5, "word2": 0.3},
            "metadata": {
                "source": "technical_wiki",
                "update_time": 1699000000
            }
        }
    ],
    "ttl": 86400
}
```

### 4.2 DataFetchRequest

```python
class DataFetchRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    ids: Any = Field(..., description="Primary key list")
```

该模型的设计遵循"最小惊讶原则"：最常用的场景是按 ID 精确查询，因此 `ids` 是必填字段。从实现角度看，按 ID 获取数据是向量数据库中性能最高的操作，因为它直接利用了主键索引，不需要进行任何向量计算或相似度匹配。

值得注意的是，该模型的 `ids` 字段同样使用 `Any` 类型，这样设计允许客户端传递多种格式的 ID 列表——可能是 JSON 数组、逗号分隔的字符串，或其他可序列化的形式。实际的类型转换在 API 处理器中通过 `data_utils.convert_dict` 函数完成。

### 4.3 DataDeleteRequest

```python
class DataDeleteRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    project: Optional[str] = Field("default", description="Project name")
    ids: Optional[Any] = Field(None, description="Primary key list")
    del_all: Optional[bool] = Field(False, description="Delete all flag")
```

这个模型引入了互斥设计：`ids` 和 `del_all` 不能同时为真。当 `del_all` 被设置为 `true` 时，表示清空整个集合的所有数据，但保留集合的 schema 和索引结构。这在需要快速重建知识库但不想重新创建 Collection 的场景下非常有用。

**设计上的微妙之处**：`ids` 是 Optional 字段，但如果同时不提供 `ids` 也不设置 `del_all` 为 true，API 将返回成功但不执行任何删除操作（删除 0 条记录）。这种宽容的设计避免了误删除的可能性，但也意味着客户端需要显式地表达删除意图。

## 五、设计权衡与 trade-off 分析

### 5.1 灵活性 vs 类型安全

该模块选择在请求验证层面保持较低的约束程度，这带来了显著的灵活性收益：不同的 Collection 可以存储完全不同结构的文档，同一个 Collection 内的不同记录可以有不同的字段集。这种设计非常适合原型开发和快速迭代阶段。

然而，灵活的代价是类型安全性的降低。当 `fields` 字段是 `Any` 类型时，Pydantic 无法在请求入口处检测到字段名的拼写错误或类型不匹配。这类错误会延迟到 Collection 层甚至存储层才被发现，增加了调试的难度。

**缓解措施**：在实际部署中，建议在 Collection 适配器层或业务逻辑层添加 schema 验证逻辑，使用 `schema_validation_and_constants` 模块中定义的验证器来补充 API 层的不足。

### 5.2 统一响应模型

与数据操作请求对应的是统一的 `ApiResponse` 模型：

```python
class ApiResponse(BaseModel):
    code: int = Field(..., description="Status code")
    message: str = Field(..., description="Response message")
    data: Optional[Any] = Field(None, description="Response data")
    time_cost: Optional[float] = Field(None, description="Time cost in seconds", alias="time_cost(second)")
```

这种设计将成功和错误情况的处理进行了统一：成功时 `code` 为 0（`ErrorCode.NO_ERROR`），`data` 字段承载实际的返回数据；失败时 `code` 为非 0 错误码，`message` 提供人类可读的错误描述。`time_cost` 字段用于性能监控，对于线上问题的排查非常有价值。

**统一响应模型的优势**在于客户端代码可以以相同的方式处理所有 API 响应，不需要为每种操作单独编写解析逻辑。但它也意味着响应数据的结构无法通过类型系统静态验证，客户端需要根据 `code` 字段动态判断如何解析 `data` 内容。

### 5.3 项目隔离的设计

每个数据操作请求都包含 `project` 参数，默认值为 "default"。这一设计支持多租户场景：不同的项目（Project）代表完全隔离的数据空间，Collection 名称可以在不同项目间重复而不会产生冲突。

这种设计参考了云存储服务（如 AWS S3）的组织方式：将资源首先按项目/桶进行隔离，再在项目内部按名称进行唯一性约束。它避免了全局唯一的 Collection 命名要求，降低了命名管理的复杂度。

## 六、使用指南与最佳实践

### 6.1 调用数据操作 API

以下是使用这些数据操作模型的典型代码模式：

```python
from openviking.storage.vectordb.service.app_models import (
    DataUpsertRequest,
    DataFetchRequest,
    DataDeleteRequest,
)
import requests

# Upsert 操作
def upsert_documents(collection_name: str, documents: list[dict], project: str = "default"):
    request = DataUpsertRequest(
        collection_name=collection_name,
        project=project,
        fields=documents,
        ttl=0  # 永久存储
    )
    response = requests.post(
        "http://localhost:8000/api/vikingdb/data/upsert",
        json=request.model_dump()
    )
    return response.json()

# Fetch 操作
def fetch_documents(collection_name: str, doc_ids: list[str], project: str = "default"):
    request = DataFetchRequest(
        collection_name=collection_name,
        project=project,
        ids=doc_ids
    )
    response = requests.get(
        "http://localhost:8000/api/vikingdb/data/fetch_in_collection",
        params={"ids": doc_ids, "collection_name": collection_name, "project": project}
    )
    return response.json()

# Delete 操作
def delete_documents(collection_name: str, doc_ids: list[str], project: str = "default"):
    request = DataDeleteRequest(
        collection_name=collection_name,
        project=project,
        ids=doc_ids,
        del_all=False
    )
    response = requests.post(
        "http://localhost:8000/api/vikingdb/data/delete",
        json=request.model_dump(exclude_none=True)
    )
    return response.json()
```

### 6.2 通过 Collection 适配器操作

对于 Python 客户端，更推荐使用高层 API——通过 Collection 适配器进行操作，这样可以将请求模型的构造细节完全屏蔽：

```python
from openviking.storage.vectordb_adapters.local_adapter import LocalCollectionAdapter

adapter = LocalCollectionAdapter.from_config({"path": "./data"})
adapter.upsert([
    {"id": "doc1", "text": "内容", "vector": [...]},
    {"id": "doc2", "text": "另一篇", "vector": [...]},
])

results = adapter.get(["doc1", "doc2"])

adapter.delete(ids=["doc1"])
```

### 6.3 批量操作的注意事项

当需要处理大量数据时，应当考虑批量操作的策略：

**批量大小控制**：虽然 API 本身不限制 `fields` 数组的长度，但过大的请求会导致网络传输延迟增加、内存占用升高，甚至触发超时。建议将单次请求的记录数控制在 1000 条以内。

**重试机制**：网络故障可能导致部分数据写入失败，此时需要实现幂等的重试逻辑。DataUpsertRequest 的"upsert"语义天然支持重试：即使某条记录已经成功写入，再次执行 upsert 也会保持相同的状态（如果是完全覆盖则可能产生幂等性问题，建议在业务层面使用版本号或时间戳来实现乐观锁）。

## 七、边界情况与已知限制

### 7.1 主键处理的行为差异

不同的 Collection 实现对主键的处理方式存在差异。部分实现要求显式提供 `id` 字段，部分实现会自动生成 UUID 作为主键。当主键缺失时，`upsert_data` 方法的行为是不确定的——可能报错，也可能自动生成。客户端代码应当始终显式提供主键，以避免歧义。

### 7.2 稀疏向量的兼容性

`fields` 中的 `sparse_vector` 字段是一个特殊字段，用于存储稀疏向量（通常由 BM25 等算法生成）。该字段的使用需要与 Collection 创建时的索引配置相匹配：如果索引配置中启用了稀疏向量支持，但 upsert 数据时没有提供稀疏向量字段，数据仍然可以成功写入，但搜索时的混合检索效果会受到影响。

### 7.3 删除操作的不可逆性

`delete_all=True` 的删除操作是物理删除而非逻辑删除。一旦执行，被删除的数据无法恢复。在生产环境中执行此类操作时应当格外谨慎，建议先通过 `fetch_data` 确认待删除的数据范围，或使用支持软删除的 Collection 实现。

### 7.4 TTL 行为的实现依赖

`ttl` 字段的行为依赖于底层存储引擎的支持程度。并非所有的 Collection 实现都支持 TTL 功能，对于不支持的实现，该字段会被静默忽略。客户端不应依赖 TTL 来实现关键的数据过期逻辑，而应该在应用层实现定时清理任务。

## 八、相关模块参考

- **[vectordb-domain-models-and-service-schemas](vectordb-domain-models-and-service-schemas.md)**：父模块，包含了向量数据库服务层的整体架构概述
- **[service-api-models-collection-and-index-management](vectordb-domain-models-and-service-schemas-service-api-models-collection-and-index-management.md)**：集合和索引管理的请求模型，与数据操作模型同属一个包
- **[service-api-models-search-requests](vectordb-domain-models-and-service-schemas-service-api-models-search-requests.md)**：搜索请求模型，定义了向量搜索、标量搜索、多模态搜索等请求格式
- **[schema-validation-and-constants](vectordb-domain-models-and-service-schemas-schema-validation-and-constants.md)**：字段类型枚举、验证器和常量定义，用于在更接近存储层的位置进行数据验证
- **[domain-models-and-contracts](vectordb-domain-models-and-service-schemas-domain-models-and-contracts.md)**：Collection 接口和搜索结果类型的定义，描述了数据操作请求如何被消费
- **[collection-adapters-abstraction-and-backends](vectorization-and-storage-adapters-collection-adapters-abstraction-and-backends.md)**：Collection 适配器层，展示了数据操作如何路由到不同的后端存储