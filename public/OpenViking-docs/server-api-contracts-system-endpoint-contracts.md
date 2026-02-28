# system_endpoint_contracts 模块技术深度解析

## 模块概述

`system_endpoint_contracts` 模块是 OpenViking HTTP Server 的"健康守护者"——它提供了一组系统级端点，用于健康检查、就绪探测、状态查询和异步处理等待。这些端点是基础设施可观测性的基石，使得 Kubernetes 能够探测服务状态、运维人员能够监控系统健康、客户端能够确认资源是否处理完毕。

换个更形象的比喻：如果你把整个 OpenViking 系统比作一座大型工厂，`system_endpoint_contracts` 就是工厂的**中央监控室**。它不参与具体的生产活动（资源处理、语义搜索），但它提供的"门卫"功能确保了工厂能够正常启动、接收请求，并在出现问题时及时报警。

本模块的核心组件是 `openviking.server.routers.system` 模块，其中定义了四个关键的 HTTP 端点和一个请求模型 `WaitRequest`。这些端点共同构成了系统的健康检查体系，无需认证即可被外部监控系统访问。

## 架构角色与设计意图

### 问题空间：为什么需要系统端点？

在分布式系统中，一个服务通常不会独立运行，而是作为更大系统的一部分。OpenViking 依赖多个下游组件才能正常工作：

1. **AGFS (Abstracted Graph File System)**：提供文件系统的抽象层，负责资源的读取和写入
2. **VectorDB (VikingDB)**：向量数据库，负责语义搜索和向量存储
3. **APIKeyManager**：API 密钥管理器，负责认证和授权
4. **QueueManager**：队列管理器，负责异步处理资源（向量化、语义提取等）

当 Kubernetes 启动 Pod 时，它需要知道两件事：**进程是否启动**（健康检查）和**服务是否就绪**（就绪检查）。前者只检查进程是否存活，后者则需要确认所有依赖的下游服务都可用。如果没有这些端点，Kubernetes 可能会将流量路由到尚未准备好的实例，导致请求失败。

此外，当客户端提交资源进行处理时（`add_resource`、`add_skill` 等操作），处理是异步的——资源被放入队列，后台 worker 负责向量化。客户端有时需要确认"所有资源是否已经处理完毕"，这正是 `wait_processed` 端点的作用。

### 解决方案：三层次健康检查体系

该模块设计了三个层次的健康检查：

| 端点 | 用途 | 认证 | 典型调用者 |
|------|------|------|------------|
| `/health` | 简单存活探测 | 无 | Kubernetes livenessProbe |
| `/ready` | 深度就绪检查 | 无 | Kubernetes readinessProbe |
| `/api/v1/system/status` | 运行时状态查询 | 需要 | 运维 dashboard |

这种分层设计遵循了 Kubernetes 的最佳实践：健康检查应该轻量且快速（不检查外部依赖），而就绪检查则需要验证所有依赖可用。

## 核心组件详解

### WaitRequest：等待处理的请求模型

```python
class WaitRequest(BaseModel):
    """Request model for wait."""
    timeout: Optional[float] = None
```

这是一个极其简洁的 Pydantic 模型，只有一个可选的 `timeout` 字段。设计意图非常明确：调用方只需要告诉系统"等多久"，系统返回"等多久"的结果。

**设计思考**：
- 为什么不使用更复杂的模型？因为这个端点的语义足够简单——等待队列处理完成，无需额外参数
- `timeout` 为 `Optional[float]`，这意味着如果客户端不指定，系统可能使用默认超时或者无限等待（取决于 `QueueManager` 的实现）
- 这个模型被设计为可扩展的，但到目前为止，需求没有超过"等待超时"这个简单场景

### health_check：进程存活探测

```python
@router.get("/health", tags=["system"])
async def health_check():
    """Health check endpoint (no authentication required)."""
    return {"status": "ok"}
```

这是最简单的健康检查端点。它的哲学是：**只要进程还在运行，就返回 200**。它不检查任何外部依赖，因为外部依赖的失败不应该导致进程被重启。

**设计意图**：在 Kubernetes 中，livenessProbe 用于判断"容器是否需要重启"。如果进程本身没有崩溃（即使下游服务不可用），也不应该触发重启，因为重启不会解决下游问题，反而会造成服务中断。

### readiness_check：深度就绪探测

```python
@router.get("/ready", tags=["system"])
async def readiness_check(request: Request):
    """Readiness probe — checks AGFS, VectorDB, and APIKeyManager.
    
    Returns 200 when all subsystems are operational, 503 otherwise.
    No authentication required (designed for K8s probes).
    """
    checks = {}
    
    # 1. AGFS: try to list root
    try:
        viking_fs = get_viking_fs()
        await viking_fs.ls("viking://", ctx=None)
        checks["agfs"] = "ok"
    except Exception as e:
        checks["agfs"] = f"error: {e}"
    
    # 2. VectorDB: health_check()
    try:
        viking_fs = get_viking_fs()
        storage = viking_fs._get_vector_store()
        if storage:
            healthy = await storage.health_check()
            checks["vectordb"] = "ok" if healthy else "unhealthy"
        else:
            checks["vectordb"] = "not_configured"
    except Exception as e:
        checks["vectordb"] = f"error: {e}"
    
    # 3. APIKeyManager: check if loaded
    try:
        manager = getattr(request.app.state, "api_key_manager", None)
        if manager is not None:
            checks["api_key_manager"] = "ok"
        else:
            checks["api_key_manager"] = "not_configured"
    except Exception as e:
        checks["api_key_manager"] = f"error: {e}"
    
    all_ok = all(v in ("ok", "not_configured") for v in checks.values())
    status_code = 200 if all_ok else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": "ready" if all_ok else "not_ready", "checks": checks},
    )
```

这是最复杂的端点，它执行三重检查：

1. **AGFS 检查**：尝试列出根目录 `viking://`，这是对文件系统最基本的操作
2. **VectorDB 检查**：调用 `storage.health_check()`，该方法尝试检查集合是否存在
3. **APIKeyManager 检查**：检查 `request.app.state` 是否有 `api_key_manager` 属性

**设计亮点**：
- **graceful degradation**：如果某个组件未被配置（`not_configured`），不会被视为错误。这允许系统在不配置某些可选组件时仍能启动
- **详细的错误信息**：每个检查项都返回具体的状态或错误信息，便于排查问题
- **使用 JSONResponse 而非直接返回**：允许显式控制 HTTP 状态码（200 或 503）

** tradeoff 分析**：
- 为什么不检查 QueueManager？因为队列是异步的，即使队列不可用，HTTP 服务器仍然可以接受请求，只是处理会失败。让就绪检查过于严格可能导致不必要的服务中断
- 为什么 `ctx=None`？这里是一个隐蔽的设计选择：系统健康检查不应该使用任何用户上下文，因为它应该在任何用户请求之前可用

### system_status：运行时状态查询

```python
@router.get("/api/v1/system/status", tags=["system"])
async def system_status(
    _ctx: RequestContext = Depends(get_request_context),
):
    """Get system status."""
    service = get_service()
    return Response(
        status="ok",
        result={
            "initialized": service._initialized,
            "user": service.user._user_id,
        },
    )
```

这是唯一需要认证的端点。它返回：
- `service._initialized`：服务是否已完成初始化
- `service.user._user_id`：当前服务实例关联的用户 ID

**设计意图**：这个端点用于确认服务已完全启动且可用。它需要认证，是因为返回的 `user._user_id` 涉及用户身份信息。

**潜在问题**：返回 `_initialized` 和 `_user_id`（带下划线前缀，表示私有属性）是反模式。虽然在这个上下文中可能是合理的（这些信息对运维有用），但在更严格的设计中，应该通过 property 方法暴露。

### wait_processed：等待异步处理完成

```python
@router.post("/api/v1/system/wait", tags=["system"])
async def wait_processed(
    request: WaitRequest,
    _ctx: RequestContext = Depends(get_request_context),
):
    """Wait for all processing to complete."""
    service = get_service()
    result = await service.resources.wait_processed(timeout=request.timeout)
    return Response(status="ok", result=result)
```

这是最有趣的端点——它实现了**同步等待异步处理**的模式。调用链如下：

1. 客户端 POST 到 `/api/v1/system/wait`，带可选的 `timeout` 参数
2. 路由处理函数调用 `service.resources.wait_processed(timeout=request.timeout)`
3. `ResourceService.wait_processed` 获取 `QueueManager` 并调用 `qm.wait_complete(timeout=timeout)`
4. `QueueManager.wait_complete` 等待所有队列中的消息被处理

**返回值结构**：
```python
{
    "queue_name": {
        "processed": <int>,       # 已处理的消息数
        "error_count": <int>,     # 错误数量
        "errors": [               # 错误详情列表
            {"message": "..."},
            ...
        ]
    },
    ...
}
```

**使用场景**：当客户端提交大量资源进行处理时（使用 `add_resource` 的异步模式），可以调用此端点确认所有资源已向量化完成。这类似于消费者-生产者模式中的"等待所有任务完成"语义。

## 数据流与依赖关系

### 端点调用链

```
客户端请求
    │
    ├─→ /health ──────────────────→ 直接返回 {"status": "ok"}
    │
    ├─→ /ready
    │      │
    │      ├─→ get_viking_fs() ─→ VikingFS
    │      │         │
    │      │         └─→ ls("viking://") ─→ AGFS (检查文件系统)
    │      │
    │      ├─→ viking_fs._get_vector_store()
    │      │         │
    │      │         └─→ storage.health_check() ─→ VikingVectorIndexBackend
    │      │                   │
    │      │                   └─→ collection_exists() ─→ VectorDB
    │      │
    │      └─→ request.app.state.api_key_manager ─→ APIKeyManager (可选)
    │
    ├─→ /api/v1/system/status
    │      │
    │      ├─→ get_request_context() ─→ 认证 → RequestContext
    │      │
    │      └─→ get_service() ─→ OpenVikingService
    │                │
    │                └─→ service._initialized, service.user._user_id
    │
    └─→ /api/v1/system/wait
             │
             ├─→ get_request_context() ─→ 认证 → RequestContext
             │
             └─→ get_service()
                       │
                       └─→ service.resources.wait_processed(timeout)
                                 │
                                 └─→ QueueManager.wait_complete(timeout)
                                           │
                                           └─→ [等待所有队列处理完毕]
```

### 关键依赖解读

| 依赖组件 | 作用 | 耦合方式 |
|----------|------|----------|
| `get_viking_fs()` | 获取 VikingFS 单例 | 全局单例，通过异常表示未初始化 |
| `VikingFS._get_vector_store()` | 获取 VectorDB 后端 | 内部实现细节暴露（带下划线前缀） |
| `RequestContext` | 请求级上下文 | 通过 FastAPI 依赖注入 |
| `get_service()` | 获取服务实例 | 全局单例，通过异常表示未初始化 |
| `QueueManager.wait_complete()` | 等待队列处理 | 异步等待，可能抛出 `TimeoutError` |

**耦合分析**：
- 模块对全局状态（单例）有强依赖，这简化了实现但使得单元测试困难
- 访问 `viking_fs._get_vector_store()` 和 `service._initialized` 使用了私有属性，打破了封装原则，但在这个场景中可能是为了避免引入额外的 property 方法

## 设计决策与 tradeoff

### 决策 1：健康检查不认证，就绪检查也不认证

**选择**：所有系统端点都无需认证（`/health`、`/ready`），状态查询和等待端点需要认证

**理由**：
- Kubernetes probes 需要在认证系统之前可用。如果服务依赖认证系统才能响应健康检查，就会形成鸡生蛋的问题
- `/api/v1/system/status` 返回用户信息，需要认证是合理的
- `/api/v1/system/wait` 操作队列资源，需要认证防止滥用

** tradeoff**：这意味着任何人都可以探测服务的健康状态。对于公网服务，这可能泄露服务架构信息。但在企业内部网络或 Kubernetes 内部网络，风险可控。

### 决策 2：AGFS 检查使用 `ctx=None`

```python
await viking_fs.ls("viking://", ctx=None)
```

**选择**：使用 `None` 而非任何用户上下文

**理由**：这是系统级检查，应该独立于任何用户会话。如果使用用户上下文，可能因为用户权限问题导致误报。此外，初始化阶段可能还没有用户会话。

** alternative**：如果使用用户上下文，可以验证"当前用户能否访问系统"，但这超出了健康检查的范畴。

### decision 3：使用 HTTP 503 表示未就绪

```python
status_code = 200 if all_ok else 503
```

**选择**：返回 503 Service Unavailable 而非 200 OK with error body

**理由**：这遵循 HTTP 语义。503 表示"服务器暂时无法处理请求"，正是就绪检查失败时应该返回的状态。Kubernetes readinessProbe 会自动根据 503 将 Pod 从 Service 中摘除。

### 决策 4：`not_configured` 视为 OK

```python
all_ok = all(v in ("ok", "not_configured") for v in checks.values())
```

**选择**：如果某个组件未配置，不视为错误

**理由**：OpenViking 可能以不同模式运行（如不使用 VectorDB 的本地模式）。强制要求所有组件会不必要地限制部署灵活性。

** tradeoff**：这可能导致"假阳性"——服务报告就绪，但实际上无法处理某些类型的请求。例如，如果 VectorDB 未配置，搜索功能将失败，但就绪检查仍会通过。这是可接受的，因为功能缺失不同于组件故障。

## 常见问题与注意事项

### 1. 为什么 `health_check` 返回 200 而 `readiness_check` 可能返回 503？

这是 Kubernetes 的约定：
- **livenessProbe** 返回非 200 会导致容器重启——所以应该只检查进程是否存活
- **readinessProbe** 返回非 200 会导致 Pod 从 Service 摘除——所以应该检查所有依赖

如果把外部依赖检查放在 livenessProbe 中，可能导致：VectorDB 临时不可用 → livenessProbe 失败 → 容器重启 → 容器启动时 VectorDB 仍不可用 → 再次失败 → 无限重启。

### 2. `wait_processed` 的超时行为

`timeout` 参数的单位是**秒**，可以是浮点数（如 `30.5` 表示 30.5 秒）。如果超时，会抛出 `DeadlineExceededError`。

**注意**：如果队列为空，`wait_complete` 会立即返回，不会等待。如果需要等待"至少有一些消息被处理"，需要额外的逻辑。

### 3. 私有属性的使用

代码中多处访问私有属性：
- `service._initialized`
- `service.user._user_id`
- `viking_fs._get_vector_store()`

这是技术债务的信号。理想情况下，应该通过公共 property 暴露这些信息。但在这个场景中，可能是为了快速迭代或避免引入更多公共接口。

### 4. 错误处理的粒度

每个检查项都使用 `try/except` 捕获异常，并将异常消息放入返回的 `checks` 字典。这种设计让调用方能清楚地看到**哪个组件失败了以及为什么失败**。

但也意味着，如果检查逻辑本身有 bug（比如 VikingFS 的 `ls` 方法抛出意外异常），这个异常会被捕获并记录，但不会导致整个端点失败。这可能是优点（隔离检查项）也可能是缺点（隐藏实现错误）。

### 5. 并发安全

所有端点都是 `async` 函数，这意味着它们在 FastAPI 的异步上下文中运行。但：
- `get_viking_fs()` 和 `get_service()` 返回全局单例
- 检查操作（`ls`、`health_check`）可能有竞态条件

如果多个探测同时到达，它们会并发执行检查操作。由于每个操作都是独立的查询而非修改操作，竞态条件的影响有限——最坏情况是"检查结果略微过时"，这在健康检查场景中是可以接受的。

## 相关模块与延伸阅读

- [response-and-usage-models](response-and-usage-models.md) — 了解 `Response` 模型的结构和用途
- [session-runtime-and-skill-discovery](session-runtime-and-skill-discovery.md) — 了解 `OpenVikingService` 的完整生命周期
- [queue-based-processing-primitives](../storage_core_and_runtime_primitives/observer-and-queue-processing-primitives.md) — 深入理解 `QueueManager` 和异步处理机制
- [vector-index-backend-and-collection-management](../vectorization_and_storage_adapters/collection-adapters-abstraction-and-backends.md) — 了解 `VikingVectorIndexBackend` 的适配器模式实现
- [resource-and-relation-contracts](resource-and-relation-contracts.md) — 了解 `add_resource` 和 `add_skill` 如何与 `wait_processed` 配合

## 小结

`system_endpoint_contracts` 模块是 OpenViking 系统的健康守护者，它通过三个层次的端点（健康检查、就绪检查、状态查询）提供了完整的可观测性能力。设计决策体现了对 Kubernetes 生态的适配、对不同部署模式的兼容，以及对系统稳定性的重视。

对于新加入团队的开发者，关键是理解：
1. **为什么需要这些端点**：为了适配 Kubernetes 的探针机制，提供服务可用性的外部可见性
2. **为什么健康检查不检查外部依赖**：因为外部依赖的失败不应该导致进程重启
3. **为什么就绪检查要检查外部依赖**：因为只有所有依赖都可用时，服务才能真正处理请求
4. **`wait_processed` 的作用**：它是同步等待异步处理的桥梁，让客户端能够确认资源处理完成

这个模块的设计虽然简洁，但每一行代码都承载着对分布式系统稳定性的深思熟虑。