# response_and_usage_models 模块技术文档

## 模块概述

`response_and_usage_models` 是 OpenViking HTTP Server 的响应契约层，位于 `openviking/server/models.py`。它定义了所有 API 端点返回的标准响应结构——一个统一的"信封"，无论调用哪个接口，客户端都能预期一致的响应格式。

这个模块解决的问题是：**当你的后端有数十个端点时，如何确保每个端点返回的数据结构是一致的？** 如果每个路由自行决定返回什么，客户端将陷入解析各种不同结构的噩梦。Response 模型充当了 API 的"公共语言"——无论是搜索、文件操作还是会话管理，都使用同一套响应格式。

## 架构角色

这个模块在系统架构中扮演着**契约定义者**的角色。它不执行业务逻辑，也不处理数据存储，它的唯一职责是定义数据在网络上传输时的形状。从分层架构的角度来看，它位于最顶层——直接面向 HTTP 客户端，是服务端对外承诺的接口边界。

```
┌─────────────────────────────────────────────────────────────┐
│                    HTTP Clients (外部)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               Server Routers (sessions, search...)          │
│   业务逻辑执行者，将结果包装进 Response 返回                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│         response_and_usage_models (当前模块)                │
│   定义 Response, UsageInfo, ErrorInfo 等契约模型             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Pydantic (数据验证与序列化底层)                 │
└─────────────────────────────────────────────────────────────┘
```

## 核心模型解析

### Response — 标准 API 响应信封

```python
class Response(BaseModel):
    status: str  # "ok" | "error"
    result: Optional[Any] = None
    error: Optional[ErrorInfo] = None
    time: float = 0.0
    usage: Optional[UsageInfo] = None
```

**设计意图**：Response 是一个**正交分解**的设计选择。它没有把"成功时返回 X，失败时返回 Y"这样的逻辑混在一起，而是将 status、result、error、time、usage 作为五个独立的维度。无论成功还是失败，时间总是会被记录；无论有没有实际数据返回，status 总是会告知调用方当前的状态。

**字段详解**：

- **status**：字符串类型的枚举，只有 "ok" 和 "error" 两种取值。调用方首先应该检查这个字段——如果看到 "error"，就应该忽略 result，转而从 error 字段中提取错误信息。
- **result**：泛型字段，承载实际业务数据。搜索返回搜索结果列表，文件操作返回操作后的文件状态，会话创建返回新会话信息。它的类型是 `Any`，因为不同端点返回的数据结构差异很大。
- **error**：当 status 为 "error" 时，这个字段才会被填充。它包含错误码、错误消息和可选的详细信息。
- **time**：服务端处理耗时（秒）。这是一个横切关注点——将计时信息放在统一的响应结构中，客户端无需为每个端点单独解析耗时字段。
- **usage**：可选的资源使用统计，用于可观测性。我们稍后会详细讨论这个字段的现状。

### UsageInfo — 资源使用统计

```python
class UsageInfo(BaseModel):
    tokens: Optional[int] = None
    vectors_scanned: Optional[int] = None
```

**设计意图**：UsageInfo 存在的意义是为未来的计费、监控和性能分析提供基础设施。在一个涉及 LLM 调用的系统中，了解每次请求消耗了多少 token、扫描了多少向量是极其重要的。

**当前状态**：值得注意的是，这个字段目前**并未在任何路由器中被实际填充**。所有端点都返回 `usage=None`。这表明 UsageInfo 是一个为未来功能预留的"沉睡字段"——架构已经就位，等待后续的监控和计费系统接入。

### ErrorInfo — 错误详情

```python
class ErrorInfo(BaseModel):
    code: str
    message: str
    details: Optional[dict] = None
```

**设计意图**：ErrorInfo 采用"宽进严出"的设计——code 和 message 是必需的，details 是可选的。这种设计允许在简单场景下只提供基本的错误信息，而在复杂场景下可以附加调试所需的上下文数据。

### ERROR_CODE_TO_HTTP_STATUS — 错误码到 HTTP 状态的映射

```python
ERROR_CODE_TO_HTTP_STATUS = {
    "OK": 200,
    "INVALID_ARGUMENT": 400,
    "NOT_FOUND": 404,
    "PERMISSION_DENIED": 403,
    "UNAUTHENTICATED": 401,
    "INTERNAL": 500,
    # ... 更多映射
}
```

**设计意图**：这是一个静态查找表，将应用层的错误码映射到标准的 HTTP 状态码。在 RESTful API 中，HTTP 状态码本身就是一种"元语言"——4xx 表示客户端错误，5xx 表示服务端错误。通过这个映射，系统在返回 JSON 错误信息的同时，也能返回正确的 HTTP 状态码，这对于 HTTP 层的负载均衡器、日志系统等基础设施是必要的。

**命名风格观察**：错误码采用 `UPPER_SNAKE_CASE`（如 `INVALID_ARGUMENT`），而 HTTP 方法通常采用 `CamelCase`（如 `InvalidArgument`）。这里的命名选择与 Google 的 gRPC 状态码规范保持一致——这是一种常见的工业实践。

## 数据流分析

让我们追踪一个典型请求的生命周期：

1. **客户端发起请求**：HTTP POST 到 `/api/v1/search/find`
2. **FastAPI 路由接收**：`search.py` 中的 `find` 处理器被调用
3. **业务逻辑执行**：调用 `service.search.find(...)` 获取结果
4. **响应包装**：`return Response(status="ok", result=result)`
5. **Pydantic 序列化**：Response 对象被序列化为 JSON
6. **网络传输**：JSON 响应发送回客户端

关键观察点：路由器**从不直接返回原始数据**。即使业务逻辑返回的是最简单的字典，路由器也会将其包装进 `Response` 对象。这一约束保证了客户端始终能预期统一的响应结构。

### 谁依赖这个模块？

从代码分析来看，以下路由器直接导入并使用 Response 模型：

- `openviking/server/routers/search.py` — 搜索端点
- `openviking/server/routers/sessions.py` — 会话管理端点
- `openviking/server/routers/system.py` — 系统状态端点

所有这些端点都遵循相同的模式：执行业务逻辑，然后用 `Response(...)` 包装结果返回。

## 设计决策与权衡

### 1. 为什么使用 Pydantic 而不是手动序列化？

Pydantic 提供了开箱即用的数据验证和 JSON 序列化。在这个模块中，每个模型都继承自 `BaseModel`，这意味着：

- **自动验证**：如果某个路由器尝试传入无效数据（比如 status 字段填入了 "unknown"），Pydantic 会在返回给客户端之前抛出验证错误。
- **自动序列化**：Response 对象可以无缝转换为 JSON，无需手动调用 `json.dumps()`。
- **IDE 支持**：类型提示让 IDE 能够提供自动补全和错误检查。

**替代方案考量**：如果追求极致性能，可以考虑使用 `dataclasses` 配合手动序列化，但会丧失验证能力。对于一个 HTTP API 服务来说，Pydantic 的运行时开销通常是可以接受的——API 的瓶颈往往在 I/O 而不是 CPU。

### 2. 为什么 Result 字段是 Any 类型？

使用 `Any` 而不是泛型（如 `Response[T]`）的原因是基于实用主义的考量。FastAPI 的路由可以返回任何可序列化的事物，而不同的端点返回的数据结构差异巨大——搜索返回 `FindResult`，会话返回会话元数据，文件系统操作返回操作结果。

**权衡**：这种设计的代价是客户端失去了静态类型的保障。但考虑到这是一个内部工具系统而非面向公众的 API，这种灵活性是可以接受的。

### 3. 为什么 time 字段默认值是 0.0 而不是 None？

这是一个微妙的决策。选择 `float = 0.0` 意味着时间字段总是存在的，即使服务端没有实际测量。这意味着客户端可以无条件地访问 `response.time`，而不必处理 `None` 的情况。

**权衡**：如果用 `Optional[float]`，客户端需要写 `response.time or 0.0` 这样的防御性代码。默认值 0.0 简化了客户端的逻辑，但代价是无法区分"未测量"和"实际耗时为 0"两种情况。

## 扩展点与注意事项

### 扩展点 1：向 Response 添加新字段

由于 Response 是 Pydantic 模型，向其中添加新字段是向后兼容的（只要提供默认值）。例如，假设未来需要添加 `request_id` 字段：

```python
class Response(BaseModel):
    # ... 现有字段
    request_id: Optional[str] = None  # 新增
```

这种添加不会破坏现有客户端——旧客户端会简单地忽略这个未知字段。

### 扩展点 2：填充 UsageInfo

如前所述，UsageInfo 目前未被使用。要启用它，需要在业务逻辑层添加计费逻辑。一个典型的实现位置是在路由处理器的 finally 块中：

```python
@router.post("/search/find")
async def find(request: FindRequest, ...):
    start_time = time.time()
    try:
        result = await service.search.find(...)
        # ... 转换结果
        return Response(status="ok", result=result)
    finally:
        elapsed = time.time() - start_time
        # 需要在业务逻辑中获取 tokens 和 vectors_scanned
        return Response(
            status="ok", 
            result=result,
            time=elapsed,
            usage=UsageInfo(tokens=..., vectors_scanned=...)
        )
```

### 注意事项 1：状态与错误的互斥关系

Response 模型本身**不强制** status="error" 时必须有 error 字段。这意味着以下响应在技术上是合法的：

```python
Response(status="error", result=None)  # 没有 error 字段
```

但这种响应会让客户端困惑。约定是：当 status="error" 时，必须提供有意义的 error 信息。

### 注意事项 2：time 字段需要手动填充

当前所有端点都返回 `time=0.0`，因为**路由器没有自动计时**。如果需要真实的处理耗时，每个路由处理器需要自行测量时间并填充。这是架构上的一次 Conway 定律体现——响应模型定义了契约，但计时逻辑需要各个路由器自行实现。

### 注意事项 3：错误码覆盖不完整

`ERROR_CODE_TO_HTTP_STATUS` 映射表中定义了很多错误码，但不是所有应用层错误码都在其中。当遇到未映射的错误码时，调用方需要回退到默认的 500 状态码。

## 总结

`response_and_usage_models` 模块是 OpenViking API 的"门面"——它定义了客户端能预期的响应结构。虽然代码量不大，但它是确保系统一致性和可维护性的关键抽象。

对于新加入团队的开发者，关键是理解这一点：**不要直接返回业务数据，总是将其包装在 Response 中**。这一纪律保证了整个系统的对外接口一致性，无论内部业务逻辑如何演变。

## 相关模块

- [system_endpoint_contracts](system_endpoint_contracts.md) — 系统端点契约，包括健康检查就绪探针
- [session_message_contracts](session_message_contracts.md) — 会话消息请求模型
- [search_request_contracts](search_request_contracts.md) — 搜索请求模型
- [server_api_contracts](../server_api_contracts.md) — Server API 契约总览