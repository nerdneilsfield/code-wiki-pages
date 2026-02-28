# 组织加入请求工作流合约 (organization_join_request_workflow_contracts)

## 1. 问题背景与模块定位

### 为什么需要这个模块？

在多租户协作场景中，组织（Organization）作为跨租户资源共享的核心载体，面临着复杂的成员准入与权限管理问题：

1. **多路径加入机制**：用户可以通过邀请码、组织ID搜索、管理员直接添加等多种方式加入组织
2. **审批流程需求**：部分组织需要管理员审批才能加入，而另一些则可以直接加入
3. **权限升级管理**：现有成员可能需要申请更高权限，这同样需要审批流程
4. **请求状态追踪**：需要完整记录请求的生命周期（待审批、已批准、已拒绝）

一个简单的"直接添加成员"方案无法满足这些复杂需求。我们需要一个统一的、可追踪的工作流来管理所有类型的组织加入和权限变更请求，这就是本模块存在的意义。

### 模块核心价值

本模块定义了组织加入请求工作流的**数据契约（Contracts）**，它就像一套"共同语言"，让整个系统的不同部分（HTTP 处理器、应用服务、数据仓库）能够以一致的方式理解和处理加入请求。

## 2. 核心抽象与心智模型

### 关键概念与抽象

要理解这个模块，你需要在脑海中建立以下几个核心抽象：

1. **请求类型（JoinRequestType）**：区分"新成员加入"和"现有成员权限升级"两种场景
2. **请求状态（JoinRequestStatus）**：请求在生命周期中的位置（待审批/已批准/已拒绝）
3. **组织角色（OrgMemberRole）**：定义了权限等级的层次结构（管理员>编辑者>查看者）
4. **加入请求实体（OrganizationJoinRequest）**：整个工作流的核心，承载了所有请求相关信息

### 心智模型：请求作为状态机

你可以把每个 `OrganizationJoinRequest` 想象成一个**状态机**：

```
创建请求 → [待审批] → {批准 → 成为成员/升级权限
                      拒绝 → 终止流程}
```

这个状态机的设计有几个关键点：
- 一旦批准或拒绝，请求就进入终态（不可再次变更）
- 审批者需要记录（ReviewedBy）和时间戳（ReviewedAt）
- 双方都可以留下消息（Message 和 ReviewMessage）

### 角色权限的层次模型

`OrgMemberRole` 采用了一种**数值化权限等级**的设计：

```
Admin (3) > Editor (2) > Viewer (1)
```

这种设计的好处是权限检查变得非常简单——只需比较数值大小即可，这就是 `HasPermission()` 方法的核心思想。

## 3. 核心组件深度解析

### 3.1 组织角色 (OrgMemberRole)

**设计意图**：定义组织内的权限层级，并提供权限验证能力。

```go
type OrgMemberRole string

const (
    OrgRoleAdmin  OrgMemberRole = "admin"  // 完全控制
    OrgRoleEditor OrgMemberRole = "editor" // 可编辑内容
    OrgRoleViewer OrgMemberRole = "viewer" // 仅可查看
)
```

**关键方法**：

- `IsValid()`：验证角色字符串是否合法，防止无效角色值进入系统
- `HasPermission(required)`：检查当前角色是否满足所需权限级别

**设计亮点**：
- 使用字符串类型而非枚举，便于数据库存储和API交互
- 通过 `roleLevel` 映射实现权限等级比较，代码清晰且易扩展
- 权限检查逻辑封装在类型内部，符合面向对象设计原则

### 3.2 加入请求实体 (OrganizationJoinRequest)

**设计意图**：作为整个工作流的核心数据结构，完整记录加入或权限升级请求的所有信息。

这是一个典型的**富数据模型**，包含了：

1. **身份标识**：ID, OrganizationID, UserID, TenantID
2. **请求元数据**：RequestType, RequestedRole, PrevRole（仅升级请求）
3. **状态信息**：Status, ReviewedBy, ReviewedAt
4. **交互信息**：Message（申请者留言）, ReviewMessage（审批者留言）
5. **时间追踪**：CreatedAt, UpdatedAt
6. **关联数据**：Organization, User, Reviewer（GORM 关联）

**设计亮点**：
- 统一处理"加入"和"升级"两种场景，通过 `RequestType` 区分
- `PrevRole` 字段仅在升级请求时有意义，体现了数据模型的灵活性
- 完整的审计追踪：谁、在什么时候、做了什么决定

### 3.3 请求/响应契约

模块定义了一系列精确的请求和响应结构，每个都有明确的职责：

#### 请求结构

| 结构名 | 用途 | 关键字段 |
|--------|------|----------|
| `JoinOrganizationRequest` | 通过邀请码直接加入 | InviteCode |
| `SubmitJoinRequestRequest` | 提交需要审批的加入请求 | InviteCode, Message, Role |
| `JoinByOrganizationIDRequest` | 通过组织ID加入可搜索组织 | OrganizationID, Message, Role |
| `ReviewJoinRequestRequest` | 审批加入请求 | Approved, Message, Role |
| `RequestRoleUpgradeRequest` | 申请权限升级 | RequestedRole, Message |

#### 响应结构

| 结构名 | 用途 | 关键字段 |
|--------|------|----------|
| `JoinRequestResponse` | 单个请求详情 | User info, RequestType, Status, CreatedAt |
| `ListJoinRequestsResponse` | 请求列表 | Requests, Total |

**设计亮点**：
- 每个请求结构都只包含该场景下必要的字段，避免过度加载
- 使用 `binding` 标签声明验证规则，实现声明式验证
- 响应结构包含了前端展示所需的关联数据（如用户名、邮箱），减少额外查询

## 4. 数据流与架构位置

### 在系统中的位置

本模块处于**领域层**，是整个组织管理功能的"契约中心"：

```
HTTP 层 (http_handlers_and_routing)
    ↓ 使用
应用服务层 (application_services_and_orchestration)
    ↓ 使用
领域契约层 (本模块)
    ↓ 被使用
数据仓库层 (data_access_repositories)
```

### 典型数据流

#### 场景1：用户提交加入请求

1. 用户调用 API，携带 `SubmitJoinRequestRequest`
2. HTTP 处理器验证请求结构
3. 应用服务创建 `OrganizationJoinRequest` 实体，状态设为 `Pending`
4. 数据仓库保存实体
5. 返回 `JoinRequestResponse`

#### 场景2：管理员审批请求

1. 管理员提交 `ReviewJoinRequestRequest`
2. 应用服务加载对应的 `OrganizationJoinRequest`
3. 更新状态为 `Approved` 或 `Rejected`，记录审批信息
4. 如批准，创建 `OrganizationMember` 记录（或更新角色）
5. 保存变更

## 5. 设计决策与权衡

### 5.1 统一请求模型 vs 分离模型

**决策**：使用单个 `OrganizationJoinRequest` 模型处理"加入"和"升级"两种场景

**权衡**：
- ✅ 优点：代码复用，统一的审批流程，简化数据仓库设计
- ⚠️ 缺点：有些字段（如 `PrevRole`）只在特定场景下有意义，可能导致部分字段为空
- 为什么这样选择：两种场景在业务流程上高度相似（提交→审批→执行），统一模型的好处超过了轻微的数据模型不完美

### 5.2 字符串类型 vs iota 枚举

**决策**：使用字符串类型定义角色和状态，而非 Go 的 iota 枚举

**权衡**：
- ✅ 优点：数据库存储直观，API 调试友好，无需额外的序列化/反序列化逻辑
- ⚠️ 缺点：编译期类型检查较弱，需要 `IsValid()` 方法进行运行时验证
- 为什么这样选择：在多语言环境（Go 后端 + TypeScript 前端 + 关系数据库）中，字符串是最通用的"接口语言"

### 5.3 权限数值化 vs 显式检查

**决策**：使用数值映射（Admin=3, Editor=2, Viewer=1）进行权限比较

**权衡**：
- ✅ 优点：权限检查简单高效（一行比较），易于理解和扩展
- ⚠️ 缺点：如果未来需要更细粒度的权限控制（如"编辑但不能删除"），这种线性模型可能不够灵活
- 为什么这样选择：当前的三种角色已经覆盖了绝大多数场景，简单性优先。如果未来需要更复杂的权限模型，可以迁移到基于权限位的设计。

## 6. 使用指南与注意事项

### 6.1 如何使用这些契约

**在 HTTP 处理器中**：
```go
// 绑定请求
var req SubmitJoinRequestRequest
if err := c.ShouldBindJSON(&req); err != nil {
    // 处理验证错误
}

// 验证角色
if req.Role != "" && !req.Role.IsValid() {
    // 返回无效角色错误
}
```

**在应用服务中**：
```go
// 创建请求实体
joinRequest := &OrganizationJoinRequest{
    ID:             uuid.New().String(),
    OrganizationID: orgID,
    UserID:         userID,
    TenantID:       tenantID,
    RequestType:    JoinRequestTypeJoin,
    RequestedRole:  req.Role,
    Status:         JoinRequestStatusPending,
    Message:        req.Message,
    CreatedAt:      time.Now(),
}
```

### 6.2 常见陷阱与注意事项

1. **不要忽略 `IsValid()` 检查**：虽然有 `binding` 验证，但在处理来自其他来源（如数据库、消息队列）的数据时，仍需手动验证
2. **权限升级需要设置 `PrevRole`**：创建升级请求时，务必设置 `PrevRole`，否则审计追踪会不完整
3. **审批后状态不可逆转**：设计上，一旦请求被批准或拒绝，就不应再变更状态。如果需要重新申请，应该创建新的请求
4. **注意角色权限的方向**：`HasPermission()` 检查的是"当前角色是否至少有 required 的权限"，不要搞反了参数顺序
5. **空值处理**：`RequestedRole` 有默认值 "viewer"，但在处理请求时仍需注意空值情况

### 6.3 扩展点

如果未来需要扩展功能，这些是设计上预留的扩展点：

- **新的请求类型**：可以在 `JoinRequestType` 中添加新类型
- **新的角色**：在 `OrgMemberRole` 中添加，并更新 `roleLevel` 映射
- **更复杂的审批流程**：可以在 `OrganizationJoinRequest` 中添加字段（如多级审批）

## 7. 依赖关系

本模块是一个**纯契约模块**，不依赖其他业务模块，只依赖：
- 标准库 `time`
- ORM 库 `gorm.io/gorm`

它被以下模块依赖：
- [组织治理与成员管理契约](core_domain_types_and_interfaces-identity_tenant_organization_and_configuration_contracts-organization_governance_membership_and_join_workflow_contracts.md)
- [组织成员管理仓库](data_access_repositories-identity_tenant_and_organization_repositories-organization_membership_sharing_and_access_control_repositories.md)
- [组织治理 HTTP 处理器](http_handlers_and_routing-agent_tenant_organization_and_model_management_handlers.md)

## 8. 总结

`organization_join_request_workflow_contracts` 模块是组织加入与权限管理工作流的"骨架"。它通过精心设计的数据结构和契约，统一了多种加入场景的处理流程，同时保持了足够的灵活性。

记住这个模块的几个核心思想：
1. **请求即状态机**：每个请求都有清晰的生命周期
2. **权限即层次**：数值化的角色等级让权限检查变得简单
3. **契约即共识**：统一的数据结构让系统各部分能够无缝协作

当你需要处理组织加入相关的功能时，从这里开始——理解了这些契约，就理解了整个工作流的核心。
