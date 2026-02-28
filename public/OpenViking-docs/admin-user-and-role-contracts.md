# admin_user_and_role_contracts 模块技术深潜

## 概述

`admin_user_and_role_contracts` 模块是 OpenViking 多租户 HTTP 服务器的身份管理与访问控制核心入口。它定义了创建账户、注册用户、分配角色等管理操作的 API 合约（请求/响应模型），并实现了相应的 FastAPI 端点。

**解决的问题**：在一个共享基础设施上支持多个相互隔离的「工作空间」（账户），每个账户内部又有独立的多用户体系，并通过对用户角色的精细划分来实现权限控制。如果不进行这种设计，所有用户将共享同一套资源，导致数据泄露与权限混乱。

**核心价值**：这个模块充当了多租户系统的「守门人」——它确保只有经过身份验证的请求才能进入系统，并且请求者拥有足够的权限来执行所请求的操作。

---

## 架构角色与数据流

### 架构位置

本模块位于 `server_api_contracts` 层级，属于 API 层的最上游。它不处理具体的业务逻辑（如文件存储、向量检索），而专注于：

1. **请求验证**：使用 Pydantic 模型确保传入数据的结构与类型安全
2. **身份认证与授权**：通过 `require_role` 依赖注入检查调用者身份
3. **委托执行**：将操作委托给 `APIKeyManager`（身份存储）和 `OpenVikingService`（目录初始化）

```
客户端请求
    │
    ▼
┌─────────────────────────────────────────┐
│  FastAPI Router (admin.py)              │
│  • Pydantic 验证请求体                   │
│  • require_role 授权检查                 │
│  • 业务逻辑委托                          │
└─────────────────────────────────────────┘
    │
    ├──▶ APIKeyManager (api_keys.py)
    │       └── 账户/用户元数据 CRUD
    │
    ├──▶ OpenVikingService (service/core.py)
    │       └── 初始化用户目录结构
    │
    └──▶ VikingFS (storage/viking_fs.py)
            └── 级联删除存储数据
```

### 核心组件

#### 1. 请求模型（Contracts）

```python
class CreateAccountRequest(BaseModel):
    account_id: str          # 账户唯一标识
    admin_user_id: str       # 首个管理员用户 ID

class RegisterUserRequest(BaseModel):
    user_id: str             # 用户唯一标识
    role: str = "user"       # 角色，默认为普通用户

class SetRoleRequest(BaseModel):
    role: str                # 目标角色
```

这三个模型是 API 的「输入契约」——它们定义了调用者必须提供什么数据。Pydantic 会在请求到达端点之前自动进行类型检查与基本验证（如必填字段、空值处理）。

#### 2. 角色枚举（Role）

```python
class Role(str, Enum):
    ROOT = "root"    # 超级管理员，可管理所有账户
    ADMIN = "admin"  # 账户管理员，仅可管理所在账户
    USER = "user"    # 普通用户，受限操作
```

这是一个三层级的 RBAC（基于角色的访问控制）设计。选择三个固定角色的理由是：**足够满足多租户场景的权限需求，同时保持授权逻辑的简洁性**。相比通用的 ACL（访问控制列表），RBAC 更易于理解和审计。

#### 3. 授权中间件（require_role）

```python
def require_role(*allowed_roles: Role):
    async def _check(ctx: RequestContext = Depends(get_request_context)):
        if ctx.role not in allowed_roles:
            raise PermissionDeniedError(...)
        return ctx
    return Depends(_check)
```

这个工厂函数是整个授权体系的核心。它采用 FastAPI 的依赖注入机制，在每个受保护端点被调用前执行权限检查。**设计洞察**：将授权逻辑与业务逻辑分离，使得添加新的受保护端点只需一行 `ctx: RequestContext = require_role(Role.ROOT)`，而无需在每个函数内部重复编写权限检查代码。

---

## 核心操作的数据流

### 场景一：创建账户（最复杂）

```
POST /api/v1/admin/accounts
  │
  ▼
require_role(Role.ROOT) 验证调用者是否为 ROOT
  │
  ├──▶ 验证通过
  │     │
  │     ▼
  │   APIKeyManager.create_account()
  │     ├── 在内存中创建 AccountInfo
  │     ├── 生成 admin_user 的 API key (secrets.token_hex(32))
  │     ├── 写入 /local/_system/accounts.json
  │     └── 写入 /local/{account_id}/_system/users.json
  │
  ▼
OpenVikingService.initialize_account_directories()
  └── 为账户创建 AGFS 目录结构
     (viking://user/, viking://agent/, viking://session/, viking://resources/)
  │
  ▼
OpenVikingService.initialize_user_directories()
  └── 为首个管理员用户创建个人目录
  │
  ▼
Response{account_id, admin_user_id, user_key}
```

**关键设计决策**：账户创建是一个「多阶段事务」，涉及元数据存储（APIKeyManager）和物理存储初始化（VikingFS）。这里采用了**乐观设计**——如果 VikingFS 目录创建失败，元数据已经写入，可能导致「有账户无目录」的不一致状态。代码通过 `try/except` 捕获 VikingFS 错误并记录警告，而非回滚整个操作。这种选择的理由是：目录创建失败通常是临时性的环境问题，管理员可以手动重试；而元数据一旦写入就无法轻易撤销。

### 场景二：删除账户（级联清理）

```
DELETE /api/v1/admin/accounts/{account_id}
  │
  ▼
require_role(Role.ROOT)
  │
  ▼
构建 cleanup_ctx (ROOT 级别上下文)
  │
  ├──▶ VikingFS.rm() 递归删除四个前缀
  │      viking://user/
  │      viking://agent/
  │      viking://session/
  │      viking://resources/
  │     (每个都 try/except，失败仅记录警告)
  │
  ├──▶ VectorDB.delete_account_data()
  │     删除该账户的所有向量数据
  │     (失败也仅记录警告)
  │
  └──▶ APIKeyManager.delete_account()
         最后删除元数据
  │
  ▼
Response{deleted: True}
```

**级联删除的哲学**：这是一个「尽力而为」的级联删除。代码选择继续执行而非在第一个失败时中止，原因与创建账户相同——部分清理总比完全不清理要好。但这也意味着：**删除操作可能留下「孤儿数据」，需要通过定期审计来发现和清理**。

### 场景三：注册用户

```
POST /api/v1/admin/accounts/{account_id}/users
  │
  ▼
require_role(Role.ROOT, Role.ADMIN)
  │
  ├──▶ _check_account_access()
  │     如果是 ADMIN，只能操作自己的账户
  │     如果是 ROOT，可以操作任意账户
  │
  ▼
APIKeyManager.register_user()
  └── 在账户的用户注册表中添加新用户
     生成新的 API key
  │
  ▼
OpenVikingService.initialize_user_directories()
  └── 创建该用户的个人目录
  │
  ▼
Response{account_id, user_id, user_key}
```

---

## 设计决策与权衡

### 1. 固定角色层级 vs 通用权限系统

**选择**：固定三层角色（ROOT/ADMIN/USER）

**权衡分析**：
- **优点**：授权检查 O(1) 复杂度，代码简洁，审计简单
- **缺点**：无法细粒度控制（如「可以读文件但不能写」）

**理由**：多租户 SaaS 产品的典型权限模型是「租户管理员 + 普通用户」，ROOT 仅用于平台运营。这种模型足以覆盖 95% 的业务需求，而通用权限系统的复杂度（权限继承、权限委托、ACL 复杂度）在初期是不必要的。

### 2. 内存索引 + 持久化存储的双层架构

**选择**：`APIKeyManager` 维护内存索引 (`_user_keys: Dict[str, UserKeyEntry]`) + AGFS 文件持久化

**权衡分析**：
- **优点**：运行时 O(1) 查找，首次启动加载后无 IO 开销
- **缺点**：内存索引在服务重启时需重新加载，扩容时需同步

**关键洞察**：这是典型的「读多写少」场景。每次 API 请求都需要验证身份（读操作），而账户/用户管理操作（写操作）相对稀少。因此，**用空间换时间**是合理的。如果采用每次都读文件的方案，在高并发下会成为性能瓶颈。

### 3. 管理员权限边界检查

**选择**：ADMIN 只能操作自己所属的账户

```python
def _check_account_access(ctx: RequestContext, account_id: str) -> None:
    if ctx.role == Role.ADMIN and ctx.account_id != account_id:
        raise PermissionDeniedError(f"ADMIN can only manage account: {ctx.account_id}")
```

**权衡分析**：
- **优点**：防止管理员越权访问其他租户数据
- **缺点**：ADMIN 无法跨账户操作（但这正是多租户隔离的要求）

---

## 新贡献者注意事项

### 1. 角色字段的宽松验证

`RegisterUserRequest` 中的 `role` 字段定义为 `str`，而非 `Role` 枚举。这意味着传入任意字符串（如 `"superadmin"`）也能通过 Pydantic 验证，直到调用 `APIKeyManager.register_user()` 时才会尝试转换为 `Role(role)`，此时可能抛出异常或产生意外行为。

**建议**：在请求模型层使用 `Role` 枚举或添加自定义验证器。

### 2. 目录初始化的幂等性

`initialize_account_directories` 和 `initialize_user_directories` 在每次创建账户/用户时被调用。如果这些方法不是幂等的，重复调用（如网络超时重试）会导致目录重复创建或错误。

**检查点**：在添加新的目录初始化逻辑时，确保方法可以安全地重复执行。

### 3. ROOT 上下文的特殊用途

在 `delete_account` 中，代码构建了一个特殊的 `cleanup_ctx`：

```python
cleanup_ctx = RequestContext(
    user=UserIdentifier(account_id, "system", "system"),
    role=Role.ROOT,
)
```

这里使用 `Role.ROOT` 是为了让删除操作能够跨越账户边界（因为要删除该账户的所有子目录和向量数据）。**不要在普通业务逻辑中模仿这种模式**——除非你明确知道需要跨租户操作。

### 4. 错误处理的「宽容」策略

本模块中的错误处理大多采用「记录警告，继续执行」的策略：

```python
try:
    await viking_fs.rm(prefix, recursive=True, ctx=cleanup_ctx)
except Exception as e:
    logger.warning(f"AGFS cleanup for {prefix} in account {account_id}: {e}")
```

这种策略的优点是不会因为部分失败而导致整个操作回滚，缺点是可能导致数据不一致。**如果你需要更强的一致性保证，应该使用事务性操作或显式回滚**。

### 5. API Key 的安全性

API Key 使用 `secrets.token_hex(32)` 生成，这是密码学安全的随机数。但需要注意：
- API Key 一旦生成就不会改变（除非显式重新生成）
- Key 以明文存储在 JSON 文件中（虽然 AGFS 有访问控制）
- 响应中返回的 Key **只会出现一次**，后续无法恢复

---

## 依赖关系图

### 本模块依赖

| 依赖模块 | 用途 |
|---------|------|
| `fastapi` | API 路由与依赖注入 |
| `pydantic` | 请求模型定义与验证 |
| `openviking.server.auth` | `require_role` 授权装饰器 |
| `openviking.server.identity` | `RequestContext`, `Role` 身份模型 |
| `openviking.server.dependencies` | 获取 `OpenVikingService` 单例 |
| `openviking.server.models` | 标准 `Response` 模型 |
| `openviking.storage.viking_fs` | 文件系统操作（级联删除） |
| `openviking_cli.session.user_id` | `UserIdentifier` 用户标识 |
| `openviking_cli.exceptions` | `PermissionDeniedError` 异常 |

### 依赖本模块

| 上游模块 | 依赖方式 |
|---------|---------|
| `server_api_contracts` 父模块 | 本模块是其子模块，暴露 REST API |

---

## 扩展点与未来方向

1. **更细粒度的权限控制**：如果未来需要「用户 A 可以读但不能写文件 B」，可以引入权限资源（Permission Resource）概念，而非仅依赖角色。

2. **审计日志**：当前操作没有审计日志。在合规要求下，每个管理操作都应该记录「谁在什么时候对谁做了什么」。

3. **Webhooks**：账户/用户变更时可以触发 Webhook，便于第三方系统同步。

4. **批量操作**：当前 API 都是单条操作，如果有大量用户导入需求，可以添加批量注册接口。

---

## 相关文档

- [server_api_contracts](../server_api_contracts.md) - API 合约总览
- [session_message_contracts](session_message_contracts.md) - 会话消息协议
- [search_request_contracts](search_request_contracts.md) - 搜索请求协议
- [filesystem_mutation_contracts](filesystem_mutation_contracts.md) - 文件系统操作协议