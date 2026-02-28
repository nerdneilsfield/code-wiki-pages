# VikingDB Private Adapter 模块技术深度解析

## 概述

`vikingdb_private_adapter` 模块是 OpenViking 向量存储层的四大后端适配器之一，专门用于连接**私有化部署的 VikingDB 集群**。如果你把整个向量存储系统想象成一个分布式数据库客户端库，那么这个模块就是那个负责与「内部部署」VikingDB 实例对话的适配器——它与公云托管版本（VolcengineAdapter）、本地文件版本（LocalCollectionAdapter）和 HTTP 远程版本（HttpCollectionAdapter）并列存在，各自服务于不同的部署场景。

这个模块的设计核心洞察是：**私有化部署的 VikingDB 通常由运维团队通过控制台手动管理，应用程序不应试图「全能地」创建或销毁集合与索引**。这种「有所为有所不为」的设计哲学深刻影响了整个实现。

## 架构位置与数据流

从模块树结构来看，`vikingdb_private_adapter` 位于 `vectorization_and_storage_adapters` 的子模块中，其父节点 `provider_specific_managed_collection_backends` 包含了两个针对 VikingDB 的适配器实现。该模块的依赖关系如下：

```
CollectionAdapter (抽象基类)
       │
       ▼
VikingDBPrivateCollectionAdapter
       │
       ├──► VikingDBClient (HTTP 通信)
       │
       └──► VikingDBCollection (ICollection 实现)
               │
               ▼
        私有 VikingDB 集群
```

`VikingDBPrivateCollectionAdapter` 继承自 `CollectionAdapter` 抽象基类，后者定义了所有适配器必须实现的统一接口。它的下游依赖包括 `VikingDBClient`（负责 HTTP 通信）和 `VikingDBCollection`（实现了 `ICollection` 接口的具体集合类）。上游被 `Session` 和 `Retriever` 等模块调用，这些模块从不关心底层使用的是哪个后端。

## 核心组件详解

### VikingDBPrivateCollectionAdapter：有所为有所不为的集合适配器

这个类之所以存在，是因为私有化部署的 VikingDB 与公云托管版本在管理模式上存在根本差异。公云版本允许应用程序通过 SDK 动态创建集合和索引，而私有化部署通常由运维团队通过专用控制台预先配置好。因此，这个适配器的核心设计决策是：**只读模式运行，集合和索引必须预先存在**。

#### 初始化与配置

```python
def __init__(
    self,
    *,
    host: str,
    headers: Optional[dict[str, str]],
    project_name: str,
    collection_name: str,
):
```

构造函数接收四个参数。`host` 是私有 VikingDB 服务的 HTTP 端点，比如 `http://vikingdb.internal.company.com:8080`。`headers` 允许传递自定义 HTTP 头，这在私有部署中常用于认证上下文传递或租户标识。`project_name` 和 `collection_name` 分别对应 VikingDB 的项目级别和集合名称。

`from_config` 类方法提供了从配置对象构建适配器的便捷方式：

```python
@classmethod
def from_config(cls, config: Any):
    if not config.vikingdb or not config.vikingdb.host:
        raise ValueError("VikingDB backend requires a valid host")
    return cls(
        host=config.vikingdb.host,
        headers=config.vikingdb.headers,
        project_name=config.project_name or "default",
        collection_name=config.name or "context",
    )
```

注意这里隐含的契约：调用方必须确保配置中提供了有效的 `vikingdb.host`。如果缺失，抛出明确的错误信息而不是使用默认值——这是设计上的有意选择，因为连接到无效主机的失败远不如连接到错误主机（静默使用默认地址）那样难以调试。

#### 集合加载：懒加载与存在性检查

`_load_existing_collection_if_needed` 方法实现了经典的懒加载模式：

```python
def _load_existing_collection_if_needed(self) -> None:
    if self._collection is not None:
        return
    meta = self._fetch_collection_meta()
    if meta is None:
        return
    self._collection = Collection(
        VikingDBCollection(
            host=self._host,
            headers=self._headers,
            meta_data=meta,
        )
    )
```

这里有一个微妙但重要的设计点：**集合不存在时不抛出异常，而是静默返回**。这与基类 `CollectionAdapter` 的 `get_collection()` 方法配合工作——当调用者尝试获取集合时，如果懒加载失败，才会抛出 `CollectionNotFoundError`。这种「延迟失败」的模式给了调用者更多的控制权，也使得批量操作中部分集合缺失的情况更容易处理。

`_fetch_collection_meta` 方法通过 HTTP API 查询集合元数据：

```python
def _fetch_collection_meta(self) -> Optional[Dict[str, Any]]:
    path, method = VIKINGDB_APIS["GetVikingdbCollection"]
    req = {
        "ProjectName": self._project_name,
        "CollectionName": self._collection_name,
    }
    response = self._client().do_req(method, path=path, req_body=req)
    if response.status_code != 200:
        return None
    result = response.json()
    meta = result.get("Result", {})
    return meta or None
```

API 路径和方法通过 `VIKINGDB_APIS` 常量映射表获取，这是一种常见的「配置驱动 API」模式，使得添加新 API 端点时无需修改调用代码。

#### 集合创建：拒绝动态创建

`_create_backend_collection` 方法展示了私有化部署的设计约束：

```python
def _create_backend_collection(self, meta: Dict[str, Any]) -> Collection:
    self._load_existing_collection_if_needed()
    if self._collection is None:
        raise NotImplementedError("private vikingdb collection should be pre-created")
    return self._collection
```

这里明确抛出了 `NotImplementedError`，告诉调用者动态创建集合不是私有部署适配器的职责。对比 `VolcengineCollectionAdapter` 的实现，后者调用 `get_or_create_volcengine_collection` 来动态创建集合——这种差异正是适配器模式「因地制宜」精神的体现。

同样值得注意的是，`VikingDBCollection` 自身的 `drop()` 和 `create_index()` 方法也抛出了 `NotImplementedError`：

```python
def drop(self):
    raise NotImplementedError("collection should be managed manually")

def create_index(self, index_name: str, meta_data: Dict[str, Any]):
    raise NotImplementedError("index should be pre-created")
```

这形成了一个完整的管理边界：私有部署中，集合和索引的生命周期完全由运维控制，应用程序只能进行数据层面的操作（upsert、query、delete 等）。

#### 标量索引字段清理：日期时间字段的特殊处理

`_sanitize_scalar_index_fields` 方法处理了一个微妙的兼容性问题：

```python
def _sanitize_scalar_index_fields(
    self,
    scalar_index_fields: list[str],
    fields_meta: list[dict[str, Any]],
) -> list[str]:
    date_time_fields = {
        field.get("FieldName") for field in fields_meta if field.get("FieldType") == "date_time"
    }
    return [field for field in scalar_index_fields if field not in date_time_fields]
```

VikingDB 的某些版本或配置中，日期时间类型的字段可能不支持标量索引。如果不加过滤地传递这些字段给后端，可能会导致索引创建失败。这个清理逻辑是一个防御性编程实践——它检查字段元数据中的类型信息，自动排除不适合建立标量索引的字段。

#### 默认索引元数据构建

`_build_default_index_meta` 方法展示了如何根据向量类型构建合适的索引配置：

```python
def _build_default_index_meta(
    self,
    *,
    index_name: str,
    distance: str,
    use_sparse: bool,
    sparse_weight: float,
    scalar_index_fields: list[str],
) -> Dict[str, Any]:
    index_type = "hnsw_hybrid" if use_sparse else "hnsw"
    index_meta: Dict[str, Any] = {
        "IndexName": index_name,
        "VectorIndex": {
            "IndexType": index_type,
            "Distance": distance,
            "Quant": "int8",
        },
        "ScalarIndex": scalar_index_fields,
    }
    if use_sparse:
        index_meta["VectorIndex"]["EnableSparse"] = True
        index_meta["VectorIndex"]["SearchWithSparseLogitAlpha"] = sparse_weight
    return index_meta
```

选择 `hnsw` 或 `hnsw_hybrid` 作为索引类型，是因为私有部署场景通常对查询性能有较高要求，HNSW 索引能在召回率和延迟之间取得良好平衡。而量化方法固定为 `int8` 则是一种工程简化——在大多数场景下，int8 量化带来的内存节省和计算加速远大于其对召回率的微小影响。

#### URI 归一化：数据迁移的兼容层

`_normalize_record_for_read` 方法处理了一个实际的数据迁移问题：

```python
def _normalize_record_for_read(self, record: Dict[str, Any]) -> Dict[str, Any]:
    for key in ("uri", "parent_uri"):
        value = record.get(key)
        if isinstance(value, str) and not value.startswith("viking://"):
            stripped = value.strip("/")
            if stripped:
                record[key] = f"viking://{stripped}"
    return record
```

这个逻辑的目的是：当从私有 VikingDB 读取记录时，如果 `uri` 或 `parent_uri` 字段的值不是以 `viking://` 协议开头，就自动为其加上前缀。这可能是因为早期数据录入时使用了裸路径（如 `/foo/bar`），而系统后来统一改为 `viking://` 协议标识。

这类归一化逻辑表明了一个重要的架构洞察：**适配器不仅是数据传输的管道，也是数据语义兼容的适配层**。上层应用可以假设 URI 总是规范化的，而不必关心底层存储的具体格式。

### VikingDBClient：轻量级的 HTTP 客户端

`VikingDBClient` 封装了所有对私有 VikingDB 服务的 HTTP 调用：

```python
class VikingDBClient:
    def __init__(self, host: str, headers: Optional[Dict[str, str]] = None):
        self.host = host.rstrip("/")
        self.headers = headers or {}
```

它使用 Python 标准库的 `requests` 库发送 HTTP 请求，提供了 `do_req` 方法作为统一的请求入口。该方法处理了 URL 拼接、请求头合并、JSON 序列化等常见任务，并设置了默认超时（`DEFAULT_TIMEOUT`）。

值得注意的是，这个客户端保持了极简的设计——没有连接池、没有重试逻辑、没有复杂的错误处理。这符合「适配器」角色的定位：它只负责将请求转发给后端，不承担过多的基础设施职责。

### VikingDBCollection： ICollection 接口的私有化实现

`VikingDBCollection` 实现了 `ICollection` 接口定义的完整契约，包括数据操作（upsert、fetch、delete、aggregate）和索引操作（list_indexes、get_index_meta_data）。但如前所述，部分管理性操作（drop、create_index、update_index、drop_index）被刻意禁用。

该类将 API 端点分为两类：`_console_post/_console_get` 用于元数据操作（集合信息、索引列表等），`_data_post/_data_get` 用于实际的数据操作。这种分离可能对应后端服务的不同部署架构（控制面 vs 数据面）。

## 设计决策与权衡

### 选择一：只读适配器 vs 全能适配器

私有化部署场景下，应用程序是否有权创建和删除集合？这是一个关于**边界责任**的设计决策。

**选择：只读适配器**（集合必须预创建）

**理由**：
1. 私有化部署通常由专门的运维团队管理，他们通过专用控制台配置集合结构、索引策略和访问权限
2. 应用程序拥有创建权限可能导致安全风险（例如意外覆盖已有集合的配置）
3. 简化适配器代码——无需处理复杂的创建/更新/删除状态机
4. 强制显式配置，使得部署意图更加透明

**代价**：
1. 部署流程增加了一个手动步骤
2. 如果集合确实不存在，错误信息可能不如动态创建失败那样具有操作性
3. 测试时需要预先配置集合，增加了测试环境的复杂性

### 选择二：HTTP 客户端 vs SDK

为什么 `VikingDBClient` 使用原生 HTTP 调用而非官方 SDK？

**可能的理由**：
1. 私有化部署可能没有提供或不允许使用官方 SDK
2. HTTP 层的抽象更易于诊断和调试网络问题
3. 避免了额外依赖，保持项目依赖树精简
4. 私有部署的 API 可能与公云版本有细微差异，直接调用更灵活

**代价**：
1. 缺少 SDK 层面的连接池、重试、超时等优化
2. 需要手动处理 JSON 序列化和响应解析
3. 未来 API 变更时维护成本较高

### 选择三：统一 URI 前缀的隐式归一化

`_normalize_record_for_read` 选择了在读取时自动归一化 URI，而非在写入时强制要求规范化格式。

**理由**：
1. 向后兼容——旧的裸路径数据无需迁移即可正常使用
2. 上层代码可以假设统一的 URI 格式，简化业务逻辑
3. 适配器作为「数据清洗层」是合适的位置

**代价**：
1. 每次读取都有额外的字符串检查和转换开销
2. 隐式行为可能导致调试困难——为什么存储的是 `/foo` 但读到的是 `viking://foo`？
3. 归一化逻辑只处理了两个特定字段（uri、parent_uri），其他类似字段可能被遗漏

## 使用指南与注意事项

### 正确使用流程

1. **确认集合已存在**：在使用适配器之前，确保目标集合已在私有 VikingDB 控制台中创建完成

2. **配置正确的主机地址**：
   ```python
   config = OpenVikingConfig(
       vectordb={
           "backend": "vikingdb",
           "vikingdb": {
               "host": "http://vikingdb.internal.company.com:8080",
               "headers": {"X-Tenant-ID": "tenant-123"}  # 可选
           },
           "project_name": "my_project",
           "name": "context_collection"
       }
   )
   adapter = VikingDBPrivateCollectionAdapter.from_config(config)
   ```

3. **使用标准接口操作数据**：
   ```python
   # 插入数据
   adapter.upsert({"id": "doc1", "content": "Hello", "vector": [0.1, 0.2, ...]})
   
   # 查询
   results = adapter.query(query_vector=[0.1, 0.2, ...], limit=10)
   
   # 计数
   total = adapter.count()
   ```

### 新贡献者注意事项

1. **不要尝试调用 `_create_backend_collection` 来创建新集合**：该方法被设计为在集合不存在时抛出 `NotImplementedError`。如果需要动态创建集合，应该使用 `VolcengineCollectionAdapter` 或修改设计。

2. **索引必须在集合创建时一并配置**：`VikingDBCollection.create_index()` 同样抛出 `NotImplementedError`，这意味着你无法通过代码动态创建索引。如果索引配置需要变更，需要通过控制台手动操作。

3. **URI 归一化是隐式的**：如果你添加了新的 URI 相关字段，需要考虑是否也需要在 `_normalize_record_for_read` 中处理。

4. **测试需要 mock VikingDB 服务**：由于无法动态创建集合，单元测试需要使用 `unittest.mock` 模拟 `VikingDBClient` 的响应，或者搭建完整的私有 VikingDB 测试环境。

5. **headers 的安全性**：如果通过配置文件传递 headers，注意不要将其写入日志或错误信息中，以避免敏感信息泄露。

## 相关模块参考

- [collection_adapter_abstractions](./collection_adapter_abstractions.md) - 了解 `CollectionAdapter` 抽象基类定义的标准接口
- [volcengine_adapter](./volcengine_adapter.md) - 对比公云托管版本的实现差异
- [local_and_http_collection_backends](./local-and-http-collection-backends.md) - 了解本地文件和 HTTP 后端的实现
- [provider_specific_managed_collection_backends](./provider_specific_managed_collection_backends.md) - 父模块文档，涵盖两个 VikingDB 适配器的比较