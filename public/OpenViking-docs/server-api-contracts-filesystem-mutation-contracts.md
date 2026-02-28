# filesystem_mutation_contracts 模块技术深度解析

## 模块概述

`filesystem_mutation_contracts` 模块是 OpenViking 系统中文件系统变更操作的 HTTP API 契约层。它位于 `openviking.server.routers.filesystem` 命名空间下，核心职责是定义两个最基础的文件系统变更请求模型：`MkdirRequest`（创建目录）和 `MvRequest`（移动文件或目录）。

这个模块解决的问题是：**如何在分布式架构中安全、可控地暴露文件系统变更能力给远程客户端**。在 OpenViking 的架构设计中，客户端可能运行在完全不同的进程甚至不同的机器上，它们通过 HTTP API 与服务器通信。文件系统变更操作不同于查询操作——它们会改变系统状态，因此需要明确的契约定义、身份认证、以及对底层存储层的合理封装。

如果你把这个模块想象成餐厅的前台接待处，那么 `MkdirRequest` 和 `MvRequest` 就是两张设计精良的点菜单——它们不仅规定了客人可以说出的"命令"（请求格式），还确保后厨（服务层）能够准确理解客人的需求，并最终传递到厨房深处的存储引擎（VikingFS/AGFS）执行。

---

## 架构定位与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HTTP Client (CLI)                              │
│                    AsyncHTTPClient / SyncHTTPClient                        │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ HTTP POST/GET
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    openviking.server.routers.filesystem                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │  MkdirRequest   │  │    MvRequest    │  │  其他端点: ls/tree/stat/rm  │ │
│  │  (Pydantic)     │  │   (Pydantic)    │  │                             │ │
│  └────────┬────────┘  └────────┬────────┘  └──────────────┬──────────────┘ │
└───────────┼─────────────────────┼─────────────────────────┼────────────────┘
            │                     │                         │
            ▼                     ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          FSService (服务层)                                 │
│                    async def mkdir() / mv()                                 │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VikingFS (存储抽象层)                               │
│         async def mkdir() / mv() + 向量索引同步                             │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AGFS (实际文件系统客户端)                                │
│                  本地文件系统 / 远程存储抽象                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 核心组件职责

| 组件 | 所在文件 | 职责 |
|------|----------|------|
| `MkdirRequest` | filesystem.py | 定义创建目录请求的数据契约，仅包含 `uri` 字段 |
| `MvRequest` | filesystem.py | 定义移动操作请求的契约，包含 `from_uri` 和 `to_uri` 两个字段 |
| `mkdir` 端点 | filesystem.py | FastAPI 路由处理器，接收请求、提取上下文、调用服务层 |
| `mv` 端点 | filesystem.py | FastAPI 路由处理器，接收请求、提取上下文、调用服务层 |
| `FSService` | service/fs_service.py | 文件系统操作的服务层编排，处理 VikingFS 初始化和异常转换 |
| `VikingFS` | storage/viking_fs.py | 核心存储抽象层，负责 URI 转换、权限检查、以及向量索引同步 |

---

## 核心请求模型详解

### MkdirRequest

```python
class MkdirRequest(BaseModel):
    """Request model for mkdir."""

    uri: str
```

**设计意图**：这个模型简单到了极致——只包含一个 `uri` 字段。这种极简设计反映了 Unix "一切皆文件" 哲学的现代映射：创建目录本质上就是在一个特定的虚拟路径上声明一个新的命名空间。

**字段说明**：
- `uri`：目标目录的 Viking URI，格式类似 `viking://account/resources/myproject/data/`

**为什么不需要其他参数**：
- 权限模式（mode）：系统默认使用 `755`，避免客户端传递可能存在安全风险的权限位
- 父目录创建（parents）：VikingFS 底层已经实现了自动父目录创建逻辑，服务层会处理
- exist_ok 参数：虽然 VikingFS 支持，但 HTTP 层面选择不暴露，保持 API 简洁

### MvRequest

```python
class MvRequest(BaseModel):
    """Request model for mv."""

    from_uri: str
    to_uri: str
```

**设计意图**：移动操作需要明确指定源和目标，这与 Unix 的 `mv src dest` 命令一致。请求模型清晰地表达了这个语义。

**字段说明**：
- `from_uri`：源文件或目录的 Viking URI
- `to_uri`：目标位置的 Viking URI

**设计考量**：这个模型故意不支持 `cp`（复制）操作。如果客户端需要复制，它必须先调用 `mkdir` 创建目标目录，然后读取源文件内容，再写入目标位置。这种设计避免了功能膨胀，同时让核心移动语义保持清晰。

---

## 数据流转全程解析

### mkdir 操作的数据流

1. **客户端发起**：`client.mkdir("viking://user/project/newdir")`
   - HTTP 客户端将调用翻译为 `POST /api/v1/fs/mkdir` 请求
   - 请求体：`{"uri": "viking://user/project/newdir"}`

2. **路由层处理**：
   ```python
   @router.post("/mkdir")
   async def mkdir(
       request: MkdirRequest,
       _ctx: RequestContext = Depends(get_request_context),
   ):
       service = get_service()
       await service.fs.mkdir(request.uri, ctx=_ctx)
       return Response(status="ok", result={"uri": request.uri})
   ```
   - FastAPI 自动验证请求体符合 `MkdirRequest` 格式
   - `get_request_context` 依赖注入从认证头提取用户身份
   - 调用 `service.fs.mkdir()` 传递请求 URI 和请求上下文

3. **服务层编排**（`FSService.mkdir`）：
   ```python
   async def mkdir(self, uri: str, ctx: RequestContext) -> None:
       viking_fs = self._ensure_initialized()
       await viking_fs.mkdir(uri, ctx=ctx)
   ```
   - 确保 VikingFS 已初始化
   - 透传调用到 VikingFS 层

4. **存储抽象层**（`VikingFS.mkdir`）：
   ```python
   async def mkdir(self, uri: str, mode: str = "755", exist_ok: bool = False, ctx=None):
       self._ensure_access(uri, ctx)
       path = self._uri_to_path(uri, ctx=ctx)
       await self._ensure_parent_dirs(path)  # 自动创建父目录
       self.agfs.mkdir(path)
   ```
   - `_ensure_access`：验证请求上下文有权限操作该 URI
   - `_uri_to_path`：将 Viking URI 转换为底层存储路径
   - `_ensure_parent_dirs`：确保父目录存在（幂等操作）
   - 调用 AGFS 执行实际的目录创建

5. **返回**：各层依次返回，最终客户端收到 `{"status": "ok", "result": {"uri": "..."}}`

### mv 操作的数据流

移动操作的数据流与 mkdir 类似，但包含一个关键的特殊逻辑——**向量索引同步**：

```python
async def mv(self, old_uri: str, new_uri: str, ctx=None):
    # ... 权限检查和路径转换 ...
    uris_to_move = await self._collect_uris(old_path, recursive=True, ctx=ctx)
    uris_to_move.append(target_uri)
    
    result = self.agfs.mv(old_path, new_path)
    await self._update_vector_store_uris(uris_to_move, old_uri, new_uri, ctx=ctx)
    return result
```

这意味着当一个文件或目录被移动时：
1. 底层文件系统执行实际的移动操作
2. **所有相关的向量索引记录也会被同步更新**，确保语义搜索结果保持正确

这是一个重要的设计决策——系统不仅管理文件，还管理文件的语义表示（向量嵌入）。移动操作必须保持这两者的一致性。

---

## 设计决策与权衡分析

### 1. 极简契约 vs 丰富配置

**选择**：极简契约

**权衡**：
- **优点**：API 简洁、易于理解、版本兼容性好、客户端代码简单
- **缺点**：某些高级用户可能需要更多控制（如显式指定权限位）

**原因**：OpenViking 的目标用户是 AI Agent，而非需要精细控制的高级系统管理员。简化 API 可以降低 AI 使用系统的认知负担，提高成功率。复杂的配置可以通过其他机制（如配置文件、环境变量）提供，而不是每次请求都传递。

### 2. 同步语义 vs 异步事件

**选择**：同步等待完成

**权衡**：
- **优点**：客户端能立即知道操作是否成功，简化错误处理逻辑
- **缺点**：大文件移动可能阻塞请求

**原因**：文件系统变更操作在 OpenViking 的使用场景中（主要是 AI Agent 的工具调用）通常是小规模的目录创建或文件移动，同步等待不会造成显著的性能问题。异步事件模型虽然性能更好，但会显著增加客户端的复杂度。

### 3. 向量索引自动同步

**选择**：自动同步向量索引

**权衡**：
- **优点**：对用户完全透明，搜索结果始终正确
- **缺点**：移动操作的延迟增加，需要额外的存储操作

**原因**：这是 OpenViking 区别于普通文件系统的核心价值——它的存在是为了支持语义搜索。如果移动文件后搜索不到，或者搜索到的是旧位置的文件，那么整个系统的语义能力就会崩溃。牺牲一点性能来保证语义一致性是值得的。

### 4. 错误转换策略

**设计观察**：在 `stat` 端点中，有一个有趣的错误转换逻辑：

```python
except AGFSClientError as e:
    err_msg = str(e).lower()
    if "not found" in err_msg or "no such file or directory" in err_msg:
        raise NotFoundError(uri, "file")
    raise
```

**选择**：将底层存储异常转换为统一的业务异常

**权衡**：
- **优点**：客户端只需要处理统一的异常类型，错误处理代码更简洁
- **缺点**：丢失了一些底层细节，可能影响诊断能力

**原因**：HTTP API 是系统的边界，应当对内部实现细节进行隔离。客户端不需要知道底层是 AGFS 还是其他存储系统，只需要知道"文件找不到"这个业务层面的事实。

---

## 依赖关系分析

### 上游依赖（谁调用这个模块）

| 调用者 | 调用方式 | 预期契约 |
|--------|----------|----------|
| `AsyncHTTPClient` | `POST /api/v1/fs/mkdir` | 请求体必须是有效的 JSON，`uri` 字段非空 |
| `SyncHTTPClient` | `POST /api/v1/fs/mv` | 请求体必须是有效的 JSON，`from_uri` 和 `to_uri` 字段非空 |
| 其他内部服务 | 直接导入 | 直接使用 Pydantic 模型做数据验证 |

### 下游依赖（这个模块依赖谁）

| 被依赖组件 | 依赖方式 | 契约 |
|------------|----------|------|
| `BaseModel` | Pydantic 基类 | 请求模型继承自 Pydantic，获得自动验证能力 |
| `get_request_context` | FastAPI 依赖注入 | 提取认证信息构建 RequestContext |
| `get_service` | 函数调用 | 获取 OpenVikingService 实例以调用服务层 |
| `Response` | 返回类型 | 所有端点返回标准 Response 格式 |

### 数据契约

**输入契约**：
- `MkdirRequest.uri`：非空字符串，必须是有效的 Viking URI 格式
- `MvRequest.from_uri` 和 `to_uri`：非空字符串，必须是有效的 Viking URI 格式

**输出契约**：
- 成功：`Response(status="ok", result={...})`
- 失败：抛出具体异常（`NotFoundError`、`PermissionDeniedError` 等）

---

## 常见问题与注意事项

### 1. URI 规范化

**观察**：HTTP 客户端在发送请求前会调用 `VikingURI.normalize()`：

```python
async def mkdir(self, uri: str) -> None:
    uri = VikingURI.normalize(uri)  # 先规范化
    response = await self._http.post(
        "/api/v1/fs/mkdir",
        json={"uri": uri},
    )
```

**注意**：客户端应该始终在发送请求前规范化 URI。服务器端假设收到的 URI 已经是规范化的，不会进行额外的规范化处理。这是一种信任契约——客户端负责确保输入格式正确。

### 2. 相对路径 vs 绝对路径

**观察**：这个模块只接受完整的 Viking URI（`viking://...`），不支持相对路径。

**原因**：在分布式系统中，相对路径具有歧义性——相对于哪个工作目录？相对于哪个用户？Viking URI 通过包含账户和用户信息，避免了这种歧义。

**注意**：如果你在实现新的客户端或测试工具，确保始终使用完整的 Viking URI。

### 3. 幂等性考量

**观察**：`mkdir` 操作在目标目录已存在时的行为取决于 VikingFS 的 `exist_ok` 参数（默认为 False），但 HTTP API 层面没有暴露这个参数。

**注意**：如果客户端尝试创建已存在的目录，服务器会返回错误。这是符合 RESTful 最佳实践的设计——幂等操作（GET、PUT、DELETE）在重复执行时应该有确定的结果，而创建操作（POST）在资源已存在时应当报错。

### 4. 移动操作的原子性

**观察**：移动操作包含两个步骤——文件系统移动 + 向量索引更新。

**潜在问题**：如果在向量索引更新过程中发生故障，可能会导致文件已移动但搜索结果不一致。

**当前缓解**：代码中有错误处理逻辑，如果移动源文件时收到 404 错误，会清理孤儿索引记录：

```python
except AGFSHTTPError as e:
    if e.status_code == 404:
        await self._delete_from_vector_store(uris_to_move, ctx=ctx)
```

**注意**：这是一个已知的设计权衡。完全的事务性需要分布式事务支持，当前实现选择的是"尽力而为"的策略。

### 5. 权限模型

**观察**：所有端点都依赖 `get_request_context` 进行身份认证：

```python
_ctx: RequestContext = Depends(get_request_context)
```

**注意**：请求上下文包含 `user`（用户标识）和 `role`（角色）。 VikingFS 层会使用这个上下文进行权限检查。如果你正在扩展这些端点，确保不要遗漏这个依赖。

---

## 扩展指南

### 添加新的文件系统变更操作

如果你需要添加新的文件系统变更操作（如 `cp`、`chmod`），可以参照以下模式：

1. **定义请求模型**（在 filesystem.py 中）：
   ```python
   class CopyRequest(BaseModel):
       from_uri: str
       to_uri: str
   ```

2. **添加路由端点**：
   ```python
   @router.post("/cp")
   async def cp(
       request: CopyRequest,
       _ctx: RequestContext = Depends(get_request_context),
   ):
       service = get_service()
       await service.fs.cp(request.from_uri, request.to_uri, ctx=_ctx)
       return Response(status="ok", result={...})
   ```

3. **在 FSService 中添加方法**（service/fs_service.py）

4. **在 VikingFS 中添加方法**（storage/viking_fs.py），包括必要的向量索引处理

### 扩展现有操作的参数

如果你需要为现有操作添加更多参数（例如为 `mkdir` 添加 `mode` 参数），建议：

1. **谨慎评估**：是否真的需要这个参数？大多数配置应该通过系统级别设置，而不是每次请求传递
2. **向后兼容**：添加可选参数而不是必需参数，避免破坏现有客户端
3. **更新客户端**：确保 CLI 客户端也更新以支持新参数

---

## 相关模块文档

- [server_api_contracts](../server_api_contracts.md) - API 契约总览
- [session_message_contracts](../session_message_contracts.md) - 会话消息契约
- [search_request_contracts](../search_request_contracts.md) - 搜索请求契约
- [resource_and_relation_contracts](../resource_and_relation_contracts.md) - 资源和关系契约
- [pack_import_export_contracts](../pack_import_export_contracts.md) - 导入导出契约