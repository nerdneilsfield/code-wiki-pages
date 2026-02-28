# search_request_contracts 模块技术深度解析

## 概述

`search_request_contracts` 模块是 OpenViking HTTP 服务器的搜索API入口层，它定义了一组 Pydantic 数据模型，作为客户端与后端服务之间的**契约边界**。如果你把整个系统想象成一个餐厅，那么这个模块就是前台的接待员——它负责接收客人的点单（HTTP 请求），验证点单格式是否正确，然后把规范化的请求传递给厨房（Service 层）去烹饪。

这个模块解决的核心问题是：**如何让外部客户端能够以结构化、类型安全的方式调用多种搜索能力**，同时保证后端服务不需要关心 HTTP 协议层面的细节。模块定义了四种搜索模式的请求模型：语义搜索（Search）、无会话语义搜索（Find）、内容模式匹配（Grep）和文件路径匹配（Glob）。

## 架构角色与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HTTP Client                                  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ POST /api/v1/search/{endpoint}
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  search_request_contracts                           │  ← 当前模块
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │SearchRequest│ │FindRequest  │ │GrepRequest  │ │GlobRequest  │   │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘   │
└─────────┼───────────────┼───────────────┼───────────────┼───────────┘
          │               │               │               │
          ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     OpenVikingService                               │
│   - search.search() / search.find()                                 │
│   - fs.grep() / fs.glob()                                           │
└─────────────────────────────────────────────────────────────────────┘
```

这个模块扮演着 **API Gateway** 的角色——它是外部世界的唯一入口，所有搜索相关的请求都必须通过这里。它将 HTTP 协议的知识（路径、请求体格式）与业务逻辑隔离开来，让下游服务可以专注于搜索算法本身。

### 数据流动过程

当你发起一个典型的搜索请求时，数据流是这样的：

1. **客户端发送请求**：POST 请求携带 JSON 格式的请求体到达 `/api/v1/search/search` 端点

2. **FastAPI 绑定与验证**：FastAPI 根据路由定义将 JSON 反序列化为对应的 Pydantic 模型（`SearchRequest`、`FindRequest` 等），在此过程中自动执行字段类型检查、必填字段验证、默认值填充

3. **依赖注入获取上下文**：`get_request_context` 从请求头中提取用户身份和角色信息，注入为 `RequestContext`；`get_service` 获取全局单例的 `OpenVikingService`

4. **请求模型转换为服务调用**：路由处理函数从 Pydantic 模型中提取字段，以关键字参数形式调用服务层方法

5. **服务层处理**：Service 层执行实际的搜索逻辑，可能涉及向量数据库查询、文件系统遍历等

6. **响应转换**：结果被转换为字典（如果对象有 `to_dict` 方法），然后包装进标准的 `Response` 格式返回给客户端

整个过程中，请求模型是数据的**第一道关卡**——它们定义了"什么请求是合法的"，也是**数据翻译层**——将客户端的 JSON 转换为服务层期望的 Python 类型。

## 核心组件详解

### SearchRequest — 带会话的语义搜索

```python
class SearchRequest(BaseModel):
    query: str
    target_uri: str = ""
    session_id: Optional[str] = None
    limit: int = 10
    score_threshold: Optional[float] = None
    filter: Optional[Dict[str, Any]] = None
```

**设计意图**：`SearchRequest` 是功能最丰富的搜索模型，它支持语义搜索并且可以关联会话上下文。`session_id` 字段的存在是区分它与 `FindRequest` 的关键——当用户希望搜索结果能够利用之前对话的上下文时（如记住之前讨论过的技术栈），可以提供会话 ID。

**字段设计理由**：
- `query`: 搜索查询字符串，必填字段，这是语义搜索的核心输入
- `target_uri`: 搜索范围限制，支持只在特定 URI 下搜索，类似搜索引擎的 site: 限定符
- `session_id`: 可选字段，让搜索能够利用会话记忆——如果提供，服务会加载对应的会话上下文，让搜索结果更贴合用户的具体需求
- `limit`: 结果数量限制，默认 10 条，这是一个合理的默认值——太多则淹没重点，太少则可能遗漏
- `score_threshold`: 相似度阈值过滤，只有得分超过此阈值的结果才会返回——这让用户可以过滤掉低质量的匹配
- `filter`: 额外的元数据过滤器，支持根据文件类型、时间、标签等属性进行过滤

**内部机制**：该模型继承自 Pydantic 的 `BaseModel`，这意味着它自动获得了很多能力——字段类型验证、默认值处理、JSON 序列化/反序列化。FastAPI 会利用这些特性在请求到达处理函数之前就完成数据验证。

### FindRequest — 无会话的语义搜索

```python
class FindRequest(BaseModel):
    query: str
    target_uri: str = ""
    limit: int = 10
    score_threshold: Optional[float] = None
    filter: Optional[Dict[str, Any]] = None
```

**设计意图**：`FindRequest` 是 `SearchRequest` 的简化版本，移除了会话上下文功能。这对应了一种常见的搜索场景：用户只想做一个简单的语义搜索，不需要利用之前的对话历史。它的存在让 API 更灵活——轻量级搜索不需要承担会话管理的开销。

**与 SearchRequest 的区别**：表面上只是少了 `session_id` 字段，但背后的服务实现可能有很大差异。`search.find()` 可能是一个更轻量的实现，不需要加载和维护会话状态。

### GrepRequest — 内容模式匹配

```python
class GrepRequest(BaseModel):
    uri: str
    pattern: str
    case_insensitive: bool = False
```

**设计意图**：`GrepRequest` 对应传统的正则表达式搜索，它不是语义搜索，而是精确的文本模式匹配。用户指定一个 URI 范围和一个正则模式，服务会扫描文件内容找出匹配的行。

**字段设计理由**：
- `uri`: 搜索的根路径，必填——这决定了搜索在文件系统的哪个子树进行
- `pattern`: 正则表达式模式，核心搜索条件
- `case_insensitive`: 大小写敏感开关，默认 False 是因为编程场景通常需要精确匹配

**使用场景**：当用户知道要找什么具体文本（如特定的函数名、错误信息）时，Grep 比语义搜索更精确。它更像是开发者工具中的 "Find in Files" 功能。

### GlobRequest — 文件路径匹配

```python
class GlobRequest(BaseModel):
    pattern: str
    uri: str = "viking://"
```

**设计意图**：`GlobRequest` 用于文件路径的通配符匹配，这是最快的搜索方式——它只需要遍历文件系统路径，不需要解析文件内容或计算向量相似度。

**字段设计理由**：
- `pattern`: 通配符模式，如 `**/*.py` 表示递归查找所有 Python 文件
- `uri`: 搜索的根 URI，默认 `viking://` 是 OpenViking 的虚拟文件系统协议前缀

**使用场景**：当用户想找特定类型或命名模式的文件时（如所有测试文件、所有配置文件），Glob 是最高效的选择。

## 依赖分析与契约关系

### 上游：谁调用这个模块

这个模块的"上游"是 HTTP 客户端和 FastAPI 框架本身。它们依赖这个模块提供：

1. **类型安全的请求解析**：FastAPI 根据这些模型知道如何解析请求体
2. **自动验证**：Pydantic 在反序列化时自动验证字段类型和约束
3. **API 文档生成**：FastAPI 根据这些模型自动生成 OpenAPI 文档中的请求 schema

任何想要调用 OpenViking 搜索 API 的客户端——无论是 Web 前端、CLI 工具，还是第三方集成——都必须遵循这些请求模型定义的契约。

### 下游：这个模块调用谁

模块的"下游"是 `OpenVikingService`，它通过 `get_service()` 依赖注入获取。具体的调用关系：

- `SearchRequest` → 调用 `service.search.search()`
- `FindRequest` → 调用 `service.search.find()`
- `GrepRequest` → 调用 `service.fs.grep()`
- `GlobRequest` → 调用 `service.fs.glob()`

注意这里有个有趣的分化：语义搜索（Search/Find）走 `service.search` 模块，而文件搜索（Grep/Glob）走 `service.fs` 模块。这种分离反映了实现上的关注点分离——语义搜索需要向量数据库和嵌入模型能力，文件搜索只需要文件系统遍历能力。

关于 SearchService 的实现细节，可以参考 [service/search_service.py](https://github.com/beijing-volcengine/OpenViking/blob/main/openviking/service/search_service.py) 或其模块文档。

### 数据契约

**输入侧契约**（客户端 → 模块）：
- 请求必须是有效的 JSON
- 字段类型必须符合模型定义
- 必填字段不能缺失
- 可选字段可以省略

**输出侧契约**（模块 → 客户端）：
- 响应总是 `Response` 格式
- `status` 字段为 "ok" 或 "error"
- `result` 字段包含实际结果数据
- 错误时 `error` 字段包含 `ErrorInfo`

这个标准化的响应格式意味着客户端可以以统一的方式处理所有搜索响应。

## 设计决策与权衡

### 决策一：Pydantic 模型作为请求契约

**选择**：使用 Pydantic 的 `BaseModel` 定义所有请求模型。

**理由**：Pydantic 提供了开箱即用的数据验证、类型转换、默认值处理能力。FastAPI 原生支持 Pydantic 模型，可以自动完成请求解析、验证、OpenAPI 文档生成。这是一个经过验证的组合，能显著减少样板代码。

** tradeoff**：引入 Pydantic 依赖，但这是现代 Python API 的标准选择，收益远大于成本。

### 决策二：SearchRequest 与 FindRequest 分离

**选择**：维护两个相似但不同的请求模型，而不是用一个模型加可选字段来涵盖两种场景。

**理由**：虽然技术上可以用一个模型通过 `session_id` 是否为空来区分两种行为，但分离模型有以下好处：
- **语义清晰**："我要做无会话搜索"和"我要做有会话搜索"是两种不同的意图
- **API 文档更友好**：两个端点 `/find` 和 `/search` 在文档中清晰区分
- **服务层实现更简洁**：不需要在内部判断"是否有会话"并条件分支

** tradeoff**：代码有少量重复，但换取的是更清晰的 API 设计和更简洁的服务实现。

### 决策三：filter 字段使用 Dict[str, Any]

**选择**：`filter` 字段定义为 `Optional[Dict[str, Any]]`，允许任意结构的过滤器。

**理由**：搜索过滤器的结构高度依赖于具体的搜索实现和存储后端，可能需要按文件类型、时间戳、标签等多种维度过滤。用 `Dict[str, Any]` 可以保持最大的灵活性，避免每次新增过滤维度都要修改 API。

** tradeoff**：这相当于把类型检查的责任推给了服务层——如果客户端传了无效的过滤器结构，服务层需要自己验证并返回错误。这是一种"宽进"的设计，假设调用方是善意的。

### 决策四：结果转换为字典

**选择**：在返回响应前，检查结果对象是否有 `to_dict` 方法，如果有则转换为字典。

```python
if hasattr(result, "to_dict"):
    result = result.to_dict()
```

**理由**：服务层可能返回领域模型对象（如自定义的 `FindResult` 类），但 HTTP API 应该返回 JSON 序列化的数据。这种检查-转换的模式允许服务层灵活返回领域对象，同时保证 API 总是返回可序列化的数据。

** tradeoff**：这是一种运行时 duck typing，依赖于约定——服务层应该返回有 `to_dict` 方法的对象。如果返回了没有此方法的对象，会导致什么？代码会直接序列化整个对象——如果对象有复杂的引用关系，可能导致序列化失败或性能问题。这里存在一个潜在的运行时错误风险。

## 扩展点与灵活性

### 如何添加新的搜索参数

如果你需要为某个搜索端点添加新参数（例如为 SearchRequest 添加 `ranker` 字段来选择排序算法）：

1. 在对应的 Pydantic 模型中添加新字段
2. 在路由处理函数中提取该字段并传递给服务层
3. 服务层接口可能需要相应扩展

这种增量扩展是安全的——添加可选字段不会破坏现有客户端。

### 如何添加新的搜索端点

如果需要新的搜索类型（例如按图片搜索）：

1. 在 `search.py` 中定义新的 Request Model
2. 使用 `@router.post()` 注册新端点
3. 在服务层实现对应的方法

FastAPI 的路由机制使得添加新端点非常直接。

### 切换搜索实现

当前所有搜索都委托给 `OpenVikingService`。如果需要支持多个搜索后端，可以在服务层引入策略模式，或在请求中通过字段选择具体实现。

### 实际调用示例

以下是 Python 代码演示如何调用这些端点：

```python
import requests

BASE_URL = "http://localhost:8000/api/v1/search"
HEADERS = {
    "X-OpenViking-Account": "my_account",
    "X-OpenViking-User": "developer_1",
    "Content-Type": "application/json"
}

# 1. 纯语义搜索 (Find)
find_payload = {
    "query": "用户认证流程",
    "target_uri": "viking://my_account/docs",
    "limit": 5,
    "score_threshold": 0.7
}
response = requests.post(f"{BASE_URL}/find", json=find_payload, headers=HEADERS)
print(response.json())

# 2. 带会话的语义搜索 (Search)
search_payload = {
    "query": "那个关于 JWT 的文档",
    "session_id": "session_abc123",
    "limit": 10
}
response = requests.post(f"{BASE_URL}/search", json=search_payload, headers=HEADERS)

# 3. Grep 内容搜索
grep_payload = {
    "uri": "viking://my_account/src",
    "pattern": "def.*authenticate",
    "case_insensitive": False
}
response = requests.post(f"{BASE_URL}/grep", json=grep_payload, headers=HEADERS)

# 4. Glob 文件路径匹配
glob_payload = {
    "pattern": "**/*test*.py",
    "uri": "viking://my_account"
}
response = requests.post(f"{BASE_URL}/glob", json=glob_payload, headers=HEADERS)
```

## 边缘情况与陷阱

### 陷阱一：filter 字段的类型安全

`filter: Optional[Dict[str, Any]] = None` 虽然灵活，但失去了静态类型检查的好处。如果你期望 `filter` 中必须包含某个字段，服务层需要自己验证。考虑在使用频繁的过滤器上定义专门的 Pydantic 模型来获得编译期检查。

### 陷阱二：score_threshold 的有效范围

`score_threshold: Optional[float] = None` 没有约束值的范围（应该是 0 到 1 之间的浮点数）。服务层需要处理传入 -1.5 或 999 这样的无效值。这是个值得在服务层添加断言或返回 400 错误的场景。

### 陷阱三：limit 的默认值

`limit: int = 10` 是硬编码的默认值。如果这个值对某些客户端来说不合适，必须显式传递参数。虽然这是合理的系统设计默认值，但文档中没有说明这个值的来源和调整建议。

### 陷阱四：异步处理函数中的会话加载

```python
session = None
if request.session_id:
    session = service.sessions.session(_ctx, request.session_id)
    await session.load()
```

这里有个微妙的顺序：先创建 session 对象，再调用 `await session.load()` 加载数据。如果 `session_id` 对应的会话不存在，`session.load()` 会做什么？可能会抛出异常。这个错误处理路径没有在请求层处理，会直接返回 500 错误给客户端。

### 陷阱五：uri 和 target_uri 的语义混淆

`SearchRequest` 和 `FindRequest` 使用 `target_uri` 表示搜索范围，而 `GrepRequest` 和 `GlobRequest` 使用 `uri`。虽然语义相似，但字段名不统一。这可能是历史原因，但也增加了理解成本——一个新加入的开发者需要记住不同端点的参数命名差异。

## 相关模块参考

- [server-api-contracts-filesystem-mutation-contracts](server-api-contracts-filesystem-mutation-contracts.md) — 同级模块，包含其他 API 路由的请求模型定义
- [session_runtime](session_runtime.md) — `Session` 类的实现，`SearchRequest` 中的 `session_id` 依赖此模块
- [retrieval-query-orchestration](retrieval-query-orchestration.md) — 检索查询编排模块，语义搜索的逻辑实现
- [client_session_and_transport](client_session_and_transport.md) — 客户端会话管理，HTTP 客户端的实现

## 与其他 API 合约模块的关系

`search_request_contracts` 是 `server_api_contracts` 体系中的一个子模块。同一层级的还包括：

- [server-api-contracts-filesystem-mutation-contracts](server-api-contracts-filesystem-mutation-contracts.md) — 文件系统变更操作（mkdir、mv 等）
- [server-api-contracts-resource-and-relation-contracts](server-api-contracts-resource-and-relation-contracts.md) — 资源和关系管理
- [server-api-contracts-session-message-contracts](server-api-contracts-session-message-contracts.md) — 会话消息处理
- [server-api-contracts-admin-user-and-role-contracts](server-api-contracts-admin-user-and-role-contracts.md) — 管理员和用户角色管理

这些模块共同构成了 OpenViking HTTP Server 的完整 API 面。每个模块都遵循相同的设计模式：定义 Pydantic 请求模型 → 绑定到 FastAPI 路由 → 注入 RequestContext → 调用服务层。

## 认证与上下文流

一个值得深入理解的细节是 `RequestContext` 是如何流动的。查看 `search.py` 的端点定义：

```python
async def find(
    request: FindRequest,
    _ctx: RequestContext = Depends(get_request_context),
):
```

这里的 `_ctx` 参数使用了 FastAPI 的依赖注入机制。`get_request_context` 实际上是从 [auth.py](server-api-contracts-admin-user-and-role-contracts.md) 中导入的，它执行以下操作：

1. 从请求头提取 API Key（`X-Api-Key`）或 Bearer Token
2. 可选地检查 `X-OpenViking-Account`、`X-OpenViking-User`、`X-OpenViking-Agent` 头
3. 将身份信息解析为 `ResolvedIdentity`，包含 role（ROOT/ADMIN/USER）
4. 转换为 `RequestContext`，包含 `user: UserIdentifier` 和 `role: Role`

这个上下文对象会一路传递到 [VikingFS](storage_core_and_runtime_primitives.md)，用于多租户隔离——每个用户的搜索只能看到授权范围内的资源。

## 总结

`search_request_contracts` 模块是 OpenViking 系统面向外部世界的窗口之一。它通过定义清晰的 Pydantic 模型，为搜索 API 提供了类型安全、验证完善、可文档化的请求契约。

对于一个新加入团队的开发者，理解这个模块的关键在于把握它作为"协议边界"的角色：它的一端是形形色色的 HTTP 客户端，另一端是专注业务逻辑的服务层。它的设计决策反映了 API 设计中的常见权衡——灵活性 vs 类型安全、简洁 vs 显式、统一 vs 分离。

在使用和扩展这个模块时，需要特别注意 `filter` 字段的类型安全缺失、`score_threshold` 的值域验证、会话加载的错误处理，以及不同搜索端点之间的命名不一致问题。

**新贡献者快速上手 checklist：**
- [ ] 阅读 `search.py` 的四个端点定义，理解每个端点的职责
- [ ] 追踪 `RequestContext` 的来源，理解认证流程
- [ ] 查看 `SearchService` 和 `FSService` 的实现，理解搜索逻辑如何落地
- [ ] 理解 `Response` 包装模式的意图——为什么所有端点都返回统一格式
- [ ] 尝试用 curl 或 Python requests 调用 `/find` 和 `/search` 端点，观察响应差异