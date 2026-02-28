# admin_user_and_role_contracts 模块详解

> 本文档面向刚加入团队的高级工程师，旨在帮助你理解这个模块的设计意图、架构角色以及关键设计决策背后的"为什么"。

## 1. 这个模块解决了什么问题？

在多租户系统中，一个核心挑战是**如何安全地隔离不同租户的数据，同时提供一个统一的管理接口**。想象一下：一个 SaaS 平台有多个公司（账户）使用，每个公司又有多个员工（用户），而平台本身还有一个超级管理员（ROOT）。

OpenViking 的 `admin_user_and_role_contracts` 模块正是这个问题的答案。它提供了**账户管理**和**用户角色管理**的 HTTP API 契约，让系统管理员能够：

1. **创建和删除账户（Workspace）** — 每个账户是一个独立的虚拟工作空间
2. **在账户内注册和管理用户** — 每个账户可以包含多个用户
3. **分配和变更用户角色** — ROOT、ADMIN、USER 三级权限体系
4. **管理 API 密钥** — 用户访问系统的凭证

如果没有这个模块，每个想要集成 OpenViking 的客户端都需要自己实现一套用户权限体系，容易出现安全漏洞。这个模块用**声明式的请求模型**（Pydantic）和**强制的角色检查**（FastAPI 依赖注入），把"谁可以做什么"这个问题用代码固定下来。

## 2. 核心抽象与心智模型

### 2.1 角色层级模型

把这个系统想象成**一个金字塔**：

```
         ROOT (超级管理员)
              |
         ┌────┴────┐
         |         |
      ADMIN    ADMIN    (账户管理员)
      (每个账户)  (每个账户)
         |
      ┌──┴──┐
      |     |
    USER  USER  ...   (普通用户)
```

- **ROOT**：拥有系统最高权限，可以管理所有账户、执行任意操作
- **ADMIN**：账户级别的管理员，只能管理自己账户下的用户和数据
- **USER**：普通用户，通常只能访问自己的资源

在代码中，这个层级由 `openviking.server.identity.Role` 枚举定义：

```python
class Role(str, Enum):
    ROOT = "root"
    ADMIN = "admin"
    USER = "user"
```

### 2.2 请求上下文（RequestContext）

每个请求都携带一个**身份上下文**，它像一张"身份证"，记录了**谁（哪个账户的哪个用户）**在发起请求，**他的权限是什么**。这个上下文从 API 密钥解析而来，沿途传递给服务层：

```python
@dataclass
class RequestContext:
    user: UserIdentifier  # 账户ID + 用户ID + 代理ID
    role: Role            # 当前角色的权限级别
    
    @property
    def account_id(self) -> str:
        return self.user.account_id
```

### 2.3 请求契约模型

模块定义了三个核心的 Pydantic 请求模型，它们是 API 的"输入协议"：

| 模型 | 用途 | 关键字段 |
|------|------|----------|
| `CreateAccountRequest` | 创建新账户 | `account_id`, `admin_user_id` |
| `RegisterUserRequest` | 在账户内注册用户 | `user_id`, `role` (默认 "user") |
| `SetRoleRequest` | 修改用户角色 | `role` |

这些模型不仅是数据验证器，更是**API 契约的显式表达**。只要看这些类的定义，你就能知道每个 API 接受什么参数。

## 3. 数据流与依赖分析

### 3.1 关键依赖关系

这个模块不是一个孤立的组件，它站在一系列基础设施的肩膀上：

```
                    ┌─────────────────────────────────────┐
                    │           客户端请求                │
                    │   (携带 API Key)                   │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │     auth.resolve_identity           │
                    │   (从请求头解析 API Key)            │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │    auth.get_request_context         │
                    │   (将 ResolvedIdentity 转为        │
                    │    RequestContext)                  │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │    auth.require_role(...)          │
                    │   (权限检查: ROOT/ADMIN/USER)       │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │   admin.py 路由处理器               │
                    │   • create_account                  │
                    │   • register_user                   │
                    │   • set_user_role                   │
                    │   • ...                              │
                    └──────────────┬──────────────────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  APIKeyManager   │  │  OpenVikingService│  │    VikingFS      │
│  (身份与密钥管理) │  │  (初始化目录结构)  │  │  (数据清理)       │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### 3.2 创建账户的完整流程

以创建一个新账户为例，数据的流动如下：

1. **请求入口**：`POST /api/v1/admin/accounts`
2. **权限检查**：通过 `require_role(Role.ROOT)` 确保只有 ROOT 可以创建账户
3. **密钥生成**：调用 `APIKeyManager.create_account()` 生成 64 字节随机密钥
4. **持久化**：
   - 账户元数据写入 `/_system/accounts.json`
   - 用户数据写入 `/{account_id}/_system/users.json`
   - 内存索引 `_user_keys` 同步更新（O(1) 查找）
5. **目录初始化**：调用 `OpenVikingService.initialize_account_directories()` 在 AGFS 和 VectorDB 中创建预设目录结构
6. **响应返回**：携带新用户的 API Key

```python
@router.post("/accounts")
async def create_account(
    body: CreateAccountRequest,
    request: Request,
    ctx: RequestContext = require_role(Role.ROOT),
):
    """Create a new account (workspace) with its first admin user."""
    manager = _get_api_key_manager(request)
    user_key = await manager.create_account(body.account_id, body.admin_user_id)
    
    service = get_service()
    account_ctx = RequestContext(
        user=UserIdentifier(body.account_id, body.admin_user_id, "default"),
        role=Role.ADMIN,
    )
    await service.initialize_account_directories(account_ctx)
    await service.initialize_user_directories(account_ctx)
    
    return Response(status="ok", result={...})
```

### 3.3 删除账户的级联清理

删除账户是一个**危险操作**，代码中展示了如何安全地进行级联清理：

1. **权限检查**：ROOT 权限
2. **AGFS 清理**：删除四个命名空间的数据（user/agent/session/resources）
3. **VectorDB 清理**：调用存储层的 `delete_account_data()` 删除向量数据
4. **元数据清理**：最后删除账户和用户记录

```python
@router.delete("/accounts/{account_id}")
async def delete_account(...):
    # 构建一个 ROOT 级别的上下文用于清理
    cleanup_ctx = RequestContext(
        user=UserIdentifier(account_id, "system", "system"),
        role=Role.ROOT,
    )
    
    # 1. AGFS 级联删除
    for prefix in ["viking://user/", "viking://agent/", ...]:
        await viking_fs.rm(prefix, recursive=True, ctx=cleanup_ctx)
    
    # 2. VectorDB 级联删除
    storage = viking_fs._get_vector_store()
    await storage.delete_account_data(account_id)
    
    # 3. 删除元数据
    await manager.delete_account(account_id)
```

**设计意图**：这种"先删数据，后删元数据"的顺序确保了如果任何一步失败，元数据还在，可以进行人工恢复或重试。

## 4. 设计决策与权衡

### 4.1 为什么使用 API Key 而不是 OAuth/JWT？

查看 `resolve_identity` 的实现，你会发现它使用的是简单的 API Key 验证：

```python
async def resolve_identity(
    request: Request,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    ...
) -> ResolvedIdentity:
    api_key_manager = getattr(request.app.state, "api_key_manager", None)
    
    if api_key_manager is None:
        # 开发模式：返回 ROOT
        return ResolvedIdentity(role=Role.ROOT, ...)
    
    # 生产模式：通过 APIKeyManager 解析
    identity = api_key_manager.resolve(api_key)
```

**选择理由**：
- **简单**：对于服务间调用（machine-to-machine），API Key 是最简洁的方案
- **可撤销**：一旦泄露，可以在毫秒级别内让密钥失效（从 `_user_keys` 字典中移除）
- **无状态**：不需要维护会话状态，密钥本身包含身份信息

**权衡**：这意味着如果客户端需要支持用户级别的登录态，需要在上层实现额外的会话层。

### 4.2 ADMIN 权限边界检查

看这个辅助函数：

```python
def _check_account_access(ctx: RequestContext, account_id: str) -> None:
    """ADMIN can only operate on their own account."""
    if ctx.role == Role.ADMIN and ctx.account_id != account_id:
        raise PermissionDeniedError(f"ADMIN can only manage account: {ctx.account_id}")
```

**设计意图**：这是一个**纵深防御**的例子。即使 `require_role(Role.ADMIN)` 允许了 ADMIN 访问，这个检查还要确保 ADMIN 只能操作**自己所属的账户**。如果没有这个检查，一个恶意的 ADMIN 用户理论上可以尝试操作其他账户的 API 端点。

### 4.3 内存索引 + 文件持久化

`APIKeyManager` 使用了一个有趣的两层存储模式：

1. **AGFS 文件**（持久化）：
   - `/_system/accounts.json` — 全局账户列表
   - `/{account_id}/_system/users.json` — 每个账户的用户列表

2. **内存字典**（运行时索引）：
   - `_accounts: Dict[str, AccountInfo]`
   - `_user_keys: Dict[str, UserKeyEntry]`

**设计意图**：
- 文件确保**重启后数据不丢失**
- 内存索引确保**每次请求的 O(1) 查找**
- 这是一个经典的"内存缓存 + 磁盘持久化"模式，牺牲一点启动时间换取运行时性能

**Tradeoff**：如果系统有数千个账户和数十万用户，启动时 `load()` 方法会将所有数据加载到内存。这对于中小规模系统没问题，但未来可能需要考虑分页加载或 LRU 淘汰。

### 4.4 API Key 立即失效 vs 滚动更新

`regenerate_key` 方法展示了密钥轮换的设计：

```python
async def regenerate_key(self, account_id: str, user_id: str) -> str:
    """Regenerate a user's API key. Old key is immediately invalidated."""
    old_key = account.users[user_id].get("key", "")
    self._user_keys.pop(old_key, None)  # 立即从内存移除
    
    new_key = secrets.token_hex(32)
    # ... 保存新密钥
    
    return new_key
```

**选择**：**立即失效**而非"宽限期"设计。

- **优点**：安全性最高，无法利用旧密钥的时间窗口进行攻击
- **缺点**：如果客户端没有及时更新密钥，会有短暂的不可用时间

这种设计适合机器间通信场景（API Key 通常配置在服务端），但如果面向最终用户，可能需要考虑双密钥机制。

## 5. 新贡献者需要注意的陷阱

### 5.1 角色检查的隐式假设

所有端点都依赖 `require_role` 依赖注入，但**不同端点允许的角色组合不同**：

| 端点 | 允许角色 |
|------|----------|
| `POST /accounts` | ROOT |
| `GET /accounts` | ROOT |
| `DELETE /accounts/{id}` | ROOT |
| `POST /accounts/{id}/users` | ROOT, ADMIN |
| `GET /accounts/{id}/users` | ROOT, ADMIN |
| `PUT /accounts/{id}/users/{id}/role` | ROOT（只有 ROOT 能改角色！） |

**注意**：修改用户角色是 **ROOT 专属**操作，即使账户的 ADMIN 也不能把自己或其他用户提升为 ROOT，这是为了防止权限提升攻击。

### 5.2 ADMIN 只能管理自己账户的隐式约束

这个约束是通过 `_check_account_access` 显式实现的，但容易遗漏：

```python
@router.post("/accounts/{account_id}/users")
async def register_user(..., account_id: str = Path(...), ctx: RequestContext = require_role(Role.ROOT, Role.ADMIN)):
    _check_account_access(ctx, account_id)  # ← 容易被忘记的检查
```

在添加新端点时，记得检查是否需要这个约束。

### 5.3 异步上下文中的身份构建

注意在创建账户时，如何构建新的 `RequestContext`：

```python
account_ctx = RequestContext(
    user=UserIdentifier(body.account_id, body.admin_user_id, "default"),
    role=Role.ADMIN,
)
```

这里**没有从请求中继承** `ctx`，而是构建了一个**全新的上下文**。这是因为新用户还不存在，无法从请求中获取身份。这种模式在初始化类操作中很常见。

### 5.4 错误处理与 HTTP 状态码

所有错误都通过 `OpenVikingError` 异常体系抛出，但最终映射到 HTTP 状态码：

```python
ERROR_CODE_TO_HTTP_STATUS = {
    "PERMISSION_DENIED": 403,
    "UNAUTHENTICATED": 401,
    "NOT_FOUND": 404,
    "ALREADY_EXISTS": 409,
    ...
}
```

这意味着在路由中不需要显式返回 403/401，抛出异常即可。

### 5.5 UserIdentifier 的字符验证

`UserIdentifier` 类对 `account_id`、`user_id`、`agent_id` 有严格的字符验证：

```python
pattern = re.compile(r"^[a-zA-Z0-9_-]+$")
```

只能包含字母、数字、下划线连字符。这意味着如果你的账户 ID 包含"."或"/"等字符，会在创建时就失败。这是**有意为之**的安全防护，确保这些 ID 不会在路径操作中被利用。

## 6. 扩展点与未来演进

### 6.1 如果需要支持更多角色

目前角色是硬编码的枚举：

```python
class Role(str, Enum):
    ROOT = "root"
    ADMIN = "admin"
    USER = "user"
```

如果要添加 "GUEST" 或 "OPERATOR" 角色，需要：
1. 修改枚举
2. 调整 `require_role` 的权限检查逻辑
3. 考虑角色之间的继承关系（ADMIN 是否自动拥有 USER 的权限？）

### 6.2 如果需要支持邀请链接

目前创建用户是即时完成的，未来可能需要支持邀请链接（用户点击链接后自行设置密码）。这需要在 `RegisterUserRequest` 之外新增 `InviteUserRequest` 模型，并在 `APIKeyManager` 中增加"待激活"状态。

### 6.3 审计日志

目前删除账户和用户是静默的，未来可能需要添加审计日志，记录"谁在什么时候删除了什么"。这可以在 `delete_account` 和 `remove_user` 方法中增加日志写入逻辑。

## 7. 参考文档

- [身份与角色系统](server-api-contracts.md) — 了解 `Role`、`RequestContext`、`ResolvedIdentity` 的完整定义
- [认证中间件](server-auth.md) — 了解 API Key 解析和身份验证的细节
- [API 密钥管理](server-api-keys.md) — 了解 `APIKeyManager` 的内部实现细节
- [响应模型](server-models.md) — 了解标准 `Response` 包装器和错误码映射
- [目录初始化](core-session-runtime-and-skill-discovery.md) — 了解账户和用户目录是如何创建的