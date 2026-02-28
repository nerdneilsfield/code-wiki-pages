# service_api_models_search_requests 模块技术深度解析

> 本文档面向刚加入团队的高级工程师。假设读者具备扎实的 Python 面向对象编程功底，熟悉 Pydantic 和 RESTful API 设计，但对 OpenViking 项目的架构设计意图和核心抽象可能还不够熟悉。文章的目的不是罗列 API 签名，而是帮助你理解「为什么要这样设计」——每个设计决策背后的权衡取舍，以及这些模型在系统数据流中扮演的角色。

## 1. 问题空间：这个模块解决什么「痛点」

### 1.1 向量数据库服务面临的多模态检索挑战

在 OpenViking 这样的 AI 助手系统中，我们需要支持**多种不同类型的检索场景**：

- **语义向量检索**：用户输入自然语言查询，通过 embedding 模型转换为向量，在向量空间中寻找最相似的文档。这是最核心的场景，用于「语义搜索」。
- **关键词全文检索**：用户可能知道具体术语或关键词，希望精确匹配或模糊匹配。
- **ID 锚点检索**：给定一个已知文档的 ID，找到「相似的其他文档」——常用于「更多类似内容」推荐功能。
- **标量字段排序检索**：按某个数值字段（如时间戳、评分、引用数）降序或升序排列，适用于「最新消息」「最热门」这类需求。
- **随机抽样**：用于「每日推荐」「随便看看」等不基于任何相关性的展示场景。
- **多模态检索**：支持文本、图片、视频等多种媒体作为查询输入，底层通过 VLM（Vision-Language Model）将不同模态映射到统一的向量空间。

**每种检索模式的输入参数完全不同**。向量检索需要 `dense_vector` 和/或 `sparse_vector`；关键词检索需要 `keywords` 或 `query`；ID 检索需要一个 `id`；标量排序需要一个 `field` 名称和 `order` 方向；多模态检索需要 `text`、`image`、`video` 中的至少一个。

如果没有统一的请求模型定义，这些参数会散落在代码各处，导致：API 接口不稳定（新增一种检索类型就要改接口）、类型安全缺失（无法在编译期发现参数错误）、文档不一致（不同检索类型有不同的参数约定）。

### 1.2 为什么需要独立的请求模型层

你可能会问：直接用字典（`Dict[str, Any]`）传参不行吗？为什么要定义这些 Pydantic 模型？

答案是**可演化性**和**契约明确性**。在分布式系统中，接口契约是最难维护的东西。当你的系统需要：
- 添加新字段（比如 `score_threshold` 来做相关性阈值过滤）
- 给字段加描述文档（方便 API 文档自动生成）
- 改变默认值（比如把 `limit` 从 10 改成 20）
- 验证输入合法性（比如 `limit` 必须是正整数）

使用 Pydantic 模型可以一键完成所有这些改进，而散落的字典参数需要逐个文件搜索和修改。

此外，这些请求模型构成了**服务边界**：它们定义了什么输入是合法的、什么算「格式错误」。这对于服务的可测试性和 API 文档生成（如配合 FastAPI）至关重要。

## 2. 架构角色：服务 API 模型层的定位

### 2.1 模块在整体架构中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HTTP Server Layer                                  │
│  (openviking/server/routers/search.py — FindRequest, SearchRequest 等)     │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ HTTP 请求
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Service Layer (业务编排)                             │
│              (调用 CollectionAdapter / Collection)                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ 调用 search_by_* 方法
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  service_api_models_search_requests (当前模块)                              │
│  SearchByVectorRequest, SearchByKeywordsRequest, SearchByIdRequest 等      │
│  → 定义了调用 Collection 各种 search 方法时传递的参数结构                   │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Collection Interface (ICollection)                       │
│       search_by_vector / search_by_keywords / search_by_id 等方法           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Backend Implementations (具体存储引擎)                          │
│    VolcengineCollection / LocalCollection / HttpCollection / VikingDBCollection│
└─────────────────────────────────────────────────────────────────────────────┘
```

**重要澄清**：如果你去看 `openviking/server/routers/search.py`，会发现那里有另一套请求模型（`FindRequest`、`SearchRequest`、`GrepRequest`、`GlobRequest`）。**这两套模型服务于不同的层次**：

- **Server 层请求模型**（server/routers/search.py）：处理 HTTP 端点的请求接收，是外部客户端与服务器之间的契约。
- **Service API 层请求模型**（本模块 app_models.py）：定义服务内部各组件之间的调用契约，是 Collection 适配器与底层 Collection 实现之间的桥梁。

这种分层解耦的好处是：即使将来 HTTP API 的请求格式变了（比如从 GET 改成 POST、从路径参数改成查询参数），底层的 Collection 搜索接口也不需要改动。

### 2.2 核心抽象：「搜索请求」的统一表述

这个模块的核心抽象非常简单：**每一种搜索类型对应一个 Pydantic 模型**。每个模型都包含一组公共字段（`collection_name`、`index_name`、`project`、`filter`、`output_fields`、`limit`、`offset`）和一组特定字段（如 `dense_vector`、`keywords`、`id` 等）。

这种设计的思路类似于**「组合模式」**：公共字段定义了在所有搜索场景中都存在的通用需求（我要查哪个集合的哪个索引、分页参数、过滤条件、要返回哪些字段），特定字段则表达了每种搜索模式的独特输入。

## 3. 核心组件深度解析

### 3.1 SearchByVectorRequest：向量相似度检索

```python
class SearchByVectorRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    dense_vector: Optional[Any] = Field(None, description="Dense vector")
    sparse_vector: Optional[Any] = Field(None, description="Sparse vector")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：这是最核心的检索模型，支持**稠密向量**（`dense_vector`）和**稀疏向量**（`sparse_vector`）两种检索方式，或者两者结合的混合检索。

**为什么 `dense_vector` 和 `sparse_vector` 是可选的且可以同时存在？**

在现代向量检索系统中，**混合检索**（Hybrid Search）是常见需求：稠密向量捕捉语义相似性，稀疏向量（如 BM25）捕捉词项精确匹配。系统允许三种模式：

1. 只用稠密向量 → 纯语义搜索
2. 只用稀疏向量 → 纯关键词搜索  
3. 两者同时提供 → 混合搜索（系统会根据配置的权重融合两种信号）

这种灵活性是通过将两个向量字段都设为 `Optional` 实现的。默认值都是 `None`，但底层的 Collection 实现会检查「至少提供一个向量」这个业务约束。

**字段设计细节**：

- `limit` 和 `offset` 的默认值分别是 10 和 0 —— 这是业界常见的分页默认值。但注意这是一个**客户端默认值**，服务端会接受任何正整数。
- `output_fields` 是 `Optional[Any]` 而不是 `Optional[List[str]]`，这是因为不同后端对输出字段的处理方式不同：有的是列表，有的是字符串逗号分隔。`Any` 类型提供了最大的兼容性。

### 3.2 SearchByIdRequest：基于已有文档的相似文档推荐

```python
class SearchByIdRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    id: Any = Field(..., description="ID for search")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：这个模型解决了一个常见的产品需求——**「更多类似内容」**功能。用户正在浏览一篇文章，希望系统推荐「相似的其他文章」。实现思路是：根据 `id` 查出该文档的向量表示，然后把它当作查询向量去做向量检索。

**注意**：`id` 字段是**必需**的（`...` 表示 required），这和 `SearchByVectorRequest` 中向量字段是可选的不同。这里没有灵活的「二选一」——你必须指定要查询哪个已有文档。

### 3.3 SearchByMultiModalRequest：多模态检索

```python
class SearchByMultiModalRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    text: Optional[str] = Field(None, description="Text for search")
    image: Optional[str] = Field(None, description="Image for search")
    video: Optional[str] = Field(None, description="Video for search")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：支持**任意模态的查询输入**。用户可以传一段文字、一张图片、一段视频，或者它们的组合。系统底层的 VLM（Vision-Language Model）会将这些不同模态的输入编码到同一个向量空间，然后执行向量检索。

**设计亮点**：这三个模态字段（`text`、`image`、`video`）**全部都是可选的**，但业务上要求「至少提供一个」。这种约束无法用 Pydantic 的必填/可选来表达，所以放在了业务层（Collection 实现层）做校验。Pydantic 模型只负责基础类型验证。

### 3.4 SearchByScalarRequest：标量字段排序检索

```python
class SearchByScalarRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    field: str = Field(..., description="Field name for sorting")
    order: Optional[str] = Field("desc", description="Sort order (asc/desc)")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：这个模型用于**不需要向量相似度、而是按某个标量字段排序**的场景。典型用例包括：

- 「最新发布的内容」→ 按 `created_at` 字段 `desc` 排序
- 「最热门的内容」→ 按 `view_count` 字段 `desc` 排序
- 「价格从低到高」→ 按 `price` 字段 `asc` 排序

**注意**：`field` 是必填的（必须告诉系统按哪个字段排序），而 `order` 默认是 `"desc"`（降序）。默认值选择「降序」是因为「最新」「最热」「最贵」等常见需求都是降序。

### 3.5 SearchByRandomRequest：随机抽样检索

```python
class SearchByRandomRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：用于**随机抽样**场景——「每日推荐」「随便看看」「随机挑选 N 条」。虽然可以配合 `filter` 来做「随机抽取满足条件的 N 条」，但核心是不依赖任何相关性排序。

**实现提示**：真正的随机抽样在分布式数据库中是一个**昂贵且棘手**的操作。很多系统会用 `ORDER BY RAND() LIMIT N` 这种简单方式，但在数据量大时性能很差。更好的做法是预先计算随机分数、或者用 reservoir sampling 算法。这个请求模型本身不关心实现细节，只表达「我要随机结果」这个意图。

### 3.6 SearchByKeywordsRequest：关键词全文检索

```python
class SearchByKeywordsRequest(BaseModel):
    collection_name: str = Field(..., description="Collection name")
    index_name: str = Field(..., description="Index name")
    project: Optional[str] = Field("default", description="Project name")
    keywords: Optional[Any] = Field(None, description="Keywords list")
    query: Optional[str] = Field(None, description="Query string")
    filter: Optional[Any] = Field(None, description="Filter conditions")
    output_fields: Optional[Any] = Field(None, description="Output fields")
    limit: Optional[int] = Field(10, description="Result limit")
    offset: Optional[int] = Field(0, description="Result offset")
```

**设计意图**：支持**关键词匹配**和**全文检索**两种模式。

- `keywords`：一个关键词列表（如 `["AI", "大模型", "2024"]`），精确匹配这些词
- `query`：一个完整的查询字符串，系统会先做分词、再做匹配

**和 SearchByVectorRequest 的关系**：表面上看起来 `SearchByKeywordsRequest` 和向量检索是互斥的，但实际上很多系统会**先对关键词做向量化**（使用文本 embedding 模型），再转换成向量检索。设计时让这两个模型保持独立，底层实现可以选择是否要做这种转换。

## 4. 数据流向与依赖关系

### 4.1 完整的请求-响应流程

```
客户端 HTTP 请求
      │
      ▼
server/routers/search.py: find() / search() 等端点
      │
      ▼
业务逻辑层 (service.search.find / service.search.search)
      │
      ├──→ CollectionAdapter.query() 
      │         │
      │         ▼
      │    Collection.search_by_vector() / search_by_scalar() / search_by_random()
      │         │
      │         ▼
      │    ICollection 接口的具体实现 (VolcengineCollection 等)
      │         │
      │         ▼
      │    向量数据库后端 API (VikingDB / Volcengine 等)
      │
      └──→ 如果需要向量化的查询
            │
            ▼
       VectorizerFactory / 各个 Embedder 实现
```

### 4.2 这个模块「不做什么」

这个模块**只定义请求的数据结构**，它：

- ❌ 不包含任何业务逻辑
- ❌ 不调用任何后端 API
- ❌ 不处理响应数据（响应模型在 `result.py` 中定义，如 `SearchResult`）
- ❌ 不做参数校验以外的任何验证（比如不会检查 `collection_name` 是否真的存在于数据库中）

这样做的好处是**关注点分离**：请求模型只关心「输入格式是否正确」，不关心「这个输入有没有意义」。意义的判断交给业务层。

### 4.3 依赖关系分析

**上游依赖**（谁调用这些模型）：

- `CollectionAdapter.query()` 方法将参数组装后调用 `collection.search_by_*` 方法。这些方法的签名与请求模型是对应的。
- 各后端的 `ICollection` 实现（如 `VolcengineCollection`）接收这些参数，构建发送给后端服务的请求体。

**下游依赖**（这些模型依赖什么）：

- `pydantic.BaseModel`：所有模型的基类，提供自动验证、序列化、JSON Schema 生成等能力。
- `typing.Any`：大量使用 `Any` 类型以保持后端兼容性（不同后端对向量格式、filter 格式的支持度不同）。

**关键依赖组件**：

| 组件 | 路径 | 关系 |
|------|------|------|
| ICollection 接口 | `openviking.storage.vectordb.collection.collection.ICollection` | 定义 search_by_* 方法签名，与请求模型参数对应 |
| Collection 包装器 | `openviking.storage.vectordb.collection.collection.Collection` | 对 ICollection 的封装，暴露统一接口 |
| CollectionAdapter | `openviking.storage.vectordb_adapters.base.CollectionAdapter` | 高级抽象，封装了常见查询模式 |
| SearchResult | `openviking.storage.vectordb.collection.result.SearchResult` | 与请求模型对应的响应模型 |

## 5. 设计决策与权衡分析

### 5.1 决策一：用 `Any` 类型而非强类型定义

**现状**：大量字段使用 `Any` 类型，如 `dense_vector: Optional[Any]`、`filter: Optional[Any]`、`output_fields: Optional[Any]`。

**分析与权衡**：

- **灵活性**：不同后端（Volcengine、VikingDB、Local、HTTP）对向量格式的支持不同。有的用 `List[float]`，有的用嵌套字典，有的用 base64 编码的字符串。`Any` 类型让请求模型可以接受任何格式，兼容性最好。
- **代价**：失去了静态类型检查的保护。传入一个错误的向量格式不会在编译期被发现，只会在运行时抛出错误。

**为什么这是合理的**：这是一个**底层服务模块**，它处于类型系统的「边缘」——它要对接多种外部系统，无法强求一种统一的类型。如果在上层（如 CollectionAdapter 层）做类型转换和验证，就能既保持灵活性又不失安全性。

### 5.2 决策二：每个搜索类型独立一个模型

**现状**：六个搜索类型对应六个独立的 Pydantic 类，没有共用基类。

**分析与权衡**：

- **优点**：每个模型独立，字段清晰，不会出现「有些字段对某些搜索类型无意义但必须填 `None`」的情况。API 使用者看到 `SearchByVectorRequest` 就能知道需要传向量，看到 `SearchByScalarRequest` 就能知道需要传排序字段。
- **缺点**：有重复代码（`collection_name`、`index_name`、`project`、`filter`、`output_fields`、`limit`、`offset` 在每个模型中都出现了一遍）。

**为什么这是合理的**：代码重复在这个层级不是大问题，因为这些模型的字段数量很少（少于 10 个）。更重要的是**API 的清晰性和自描述性**。如果你用过一些「一个 DTO 包打天下」的 API，就会知道当一个模型有 30+ 字段、其中 2/3 对你的场景无意义时，维护和使用有多痛苦。

### 5.3 决策三：默认值的选择

**现状**：`limit` 默认 10，`offset` 默认 0，`order` 默认 `"desc"`，`project` 默认 `"default"`。

**分析与权衡**：

- **`limit=10`**：这是业界最常见的分页默认值，从 Google 搜索到社交媒体动态流都用 10 或 20。选择 10 是因为它足够小以保证响应速度，又足够大以提供有意义的搜索结果。
- **`offset=0`**：分页从第一页开始是天经地义的。
- **`order="desc"`**：如前所述，大部分「排序展示」场景（最新、最热、最贵）都是降序。
- **`project="default"`**：提供一个默认项目名，减少大部分场景下的显式指定。

这些默认值是**经验性**的，是团队在多个产品迭代中沉淀出来的最佳实践。它们不是技术强制的，而是** UX 导向的默认值**——让最常见的用例不需要写任何配置。

### 5.4 决策四：必填字段使用 `...` (Ellipsis)

**现状**：`collection_name: str = Field(...)`、`index_name: str = Field(...)`。

**分析**：在 Pydantic 中，`Field(...)` 表示这个字段是**必填的**，没有默认值。调用者必须显式提供。

**为什么这是合理的**：`collection_name` 和 `index_name` 标识了「在哪里搜索」，没有这两个字段搜索根本无法执行，所以它们应该是必填的。

## 6. 开发者指南：如何在这个模块上工作

### 6.1 添加新的搜索类型

假设产品团队要求支持「按地理位置搜索」（基于经纬度坐标的范围查询），你需要：

1. **在 app_models.py 中添加新模型**：
   ```python
   class SearchByGeoRequest(BaseModel):
       collection_name: str = Field(..., description="Collection name")
       index_name: str = Field(..., description="Index name")
       project: Optional[str] = Field("default", description="Project name")
       latitude: float = Field(..., description="Latitude")
       longitude: float = Field(..., description="Longitude")
       radius_km: float = Field(..., description="Radius in kilometers")
       filter: Optional[Any] = Field(None, description="Filter conditions")
       output_fields: Optional[Any] = Field(None, description="Output fields")
       limit: Optional[int] = Field(10, description="Result limit")
       offset: Optional[int] = Field(0, description="Result offset")
   ```

2. **在 ICollection 接口中添加方法**（collection/collection.py）：
   ```python
   @abstractmethod
   def search_by_geo(
       self,
       index_name: str,
       latitude: float,
       longitude: float,
       radius_km: float,
       limit: int = 10,
       offset: int = 0,
       filters: Optional[Dict[str, Any]] = None,
       output_fields: Optional[List[str]] = None,
   ) -> SearchResult:
       raise NotImplementedError
   ```

3. **在 Collection 包装类中实现委托**（collection/collection.py 的 Collection 类）

4. **在所有 ICollection 实现中添加具体逻辑**（VolcengineCollection、LocalCollection 等）

5. **在 CollectionAdapter.query() 中添加路由逻辑**（如果想在适配器层支持这种查询方式）

### 6.2 修改现有字段的默认值

如果产品数据表明用户经常修改 `limit`，你想把默认值从 10 改成 20：

```python
# 改动前
limit: Optional[int] = Field(10, description="Result limit")

# 改动后
limit: Optional[int] = Field(20, description="Result limit")
```

这个改动会**自动影响**：

- Pydantic 验证逻辑
- FastAPI OpenAPI 文档中的默认值
- 所有使用这个模型的代码

你不需要逐个文件搜索修改。

### 6.3 添加新的公共字段

如果你发现所有搜索类型都需要支持「返回相关性分数阈值过滤」功能，需要在每个模型中添加 `min_score: Optional[float] = Field(None, description="Minimum score threshold")`。

这是**破坏性变更**，因为它改变了所有模型的签名。团队需要协调好变更节奏，确保调用方同步更新。

## 7. 边缘情况与注意事项

### 7.1 向量和关键词同时缺失

`SearchByVectorRequest` 允许 `dense_vector` 和 `sparse_vector` 都是 `None`，`SearchByKeywordsRequest` 允许 `keywords` 和 `query` 都是 `None`。这在 Pydantic 层面是合法的，但底层业务逻辑必须检查并抛出有意义的错误。

**代码中常见的防御性检查**：
```python
if not dense_vector and not sparse_vector:
    raise ValueError("At least one of dense_vector or sparse_vector must be provided")
```

### 7.2 多模态输入的组合爆炸

`SearchByMultiModalRequest` 允许 `text`、`image`、`video` 的任意组合：只有文本、只有图片、只有视频、文本+图片、文本+视频、图片+视频、三者全有。这在模型层面是合法的，但底层 VLM 实现需要处理这些组合。

### 7.3 分页越界

`offset` 可以是任意非负整数，理论上可以传 `offset=100000` 来跳到第 100001 条结果。但在大规模数据集中，这种「深度分页」会导致性能问题（skip-limit 方式的分页在数据量大时需要扫描大量数据）。

某些向量数据库会限制最大 `offset` 值，或者推荐使用「游标分页」（基于上一页最后一条结果的 ID 而不是数值 offset）。如果你需要处理大规模数据，这是需要注意的优化点。

### 7.4 filter 参数的结构多样性

`filter` 字段的类型是 `Optional[Any]`，它可以接受：

- 简单字典：`{"field": "status", "op": "eq", "value": "published"}`
- 复杂嵌套：`{"op": "and", "conds": [{"op": "must", ...}, {"op": "not", ...}]}`
- 原始 DSL：有些后端直接接受后端原生的 DSL 结构

这种灵活性是有代价的：很难在请求模型层面做完整的 filter 语法验证。通常的做法是「信任调用方，延迟到后端执行时再校验」。

## 8. 相关模块与延伸阅读

- **[service_api_models_collection_and_index_management](service-api-models-collection-and-index-management.md)** — 了解 Collection 和 Index 的创建、更新、删除请求模型
- **[service_api_models_data_operations](service-api-models-data-operations.md)** — 了解数据写入和删除的请求模型（DataUpsertRequest、DataDeleteRequest 等）
- **[domain_models_and_contracts](domain-models-and-contracts.md)** — ICollection 接口和 SearchResult 响应模型
- **[collection_adapters_abstraction_and_backends](collection-adapters-abstraction-and-backends.md)** — CollectionAdapter 抽象层，以及不同后端（Local、Volcengine、VikingDB、HTTP）的实现差异
- **[server_api_contracts](server-api-contracts.md)** — HTTP Server 层的请求模型（FindRequest、SearchRequest 等），对比本模块理解分层设计