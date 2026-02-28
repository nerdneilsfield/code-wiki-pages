# 共享权限与列表合约（share_permission_and_listing_contracts）模块技术解析

## 1. 模块概览

**share_permission_and_listing_contracts** 模块是组织资源共享系统的核心数据契约层，负责定义知识库和智能体在组织间共享的权限模型、数据结构和API交互规范。该模块解决了跨租户资源共享的核心挑战：如何在保持数据隔离的同时，实现安全、可控的资源协作。

### 核心问题域

在多租户SaaS系统中，资源共享面临以下关键挑战：
- 如何在租户隔离的前提下，实现跨组织的资源访问？
- 如何定义清晰的权限层次，确保资源访问的安全性？
- 如何让用户直观地了解自己对共享资源的有效权限？
- 如何支持资源的发现、列表和管理操作？

本模块通过定义统一的数据契约和权限模型，为上层的共享服务提供了坚实的基础。

## 2. 核心抽象与心智模型

### 2.1 权限层次模型

该模块采用了**三层权限模型**，类比于文件系统的权限控制：

```
Admin (3) → Editor (2) → Viewer (1)
```

这种设计的核心思想是：**权限具有传递性，高权限包含低权限的所有能力**。通过 `HasPermission()` 方法实现的权限检查，确保了权限控制的一致性和可预测性。

### 2.2 有效权限计算

一个关键的心智模型是：**用户对共享资源的有效权限是双重约束的结果**：
1. 资源在组织内的共享权限（`Permission`）
2. 用户在组织中的角色（`MyRoleInOrg`）

有效权限 = min(资源共享权限, 用户组织角色)

这种设计确保了即便是资源被高权限共享，用户也只能获得不超过自己组织角色的权限。

## 3. 核心组件深度解析

### 3.1 权限模型：OrgMemberRole

```go
type OrgMemberRole string

const (
    OrgRoleAdmin  OrgMemberRole = "admin"
    OrgRoleEditor OrgMemberRole = "editor"
    OrgRoleViewer OrgMemberRole = "viewer"
)
```

**设计意图**：
- 使用字符串类型而非枚举，便于数据库存储和API交互
- 提供 `IsValid()` 方法确保数据完整性
- 通过 `HasPermission()` 方法实现权限层次的比较

**实现细节**：
权限比较采用了数值映射的方式：
```go
roleLevel := map[OrgMemberRole]int{
    OrgRoleAdmin:  3,
    OrgRoleEditor: 2,
    OrgRoleViewer: 1,
}
```

这种设计的优点是权限层次的扩展非常容易，只需在映射中添加新的角色和对应的值即可。

### 3.2 共享记录模型

#### KnowledgeBaseShare 和 AgentShare

这两个结构体分别表示知识库和智能体的共享记录，它们具有相似的结构：

```go
type KnowledgeBaseShare struct {
    ID               string         `json:"id"`
    KnowledgeBaseID  string         `json:"knowledge_base_id"`
    OrganizationID   string         `json:"organization_id"`
    SharedByUserID   string         `json:"shared_by_user_id"`
    SourceTenantID   uint64         `json:"source_tenant_id"`
    Permission       OrgMemberRole  `json:"permission"`
    // ... 其他字段
}
```

**设计意图**：
- `SourceTenantID` 字段是关键：它支持跨租户的资源访问，让系统能够正确路由到资源的原始租户
- 软删除机制（`DeletedAt`）确保了共享历史的可追溯性
- 权限字段 `Permission` 定义了资源在组织内的最大可用权限

### 3.3 共享信息增强模型

#### SharedKnowledgeBaseInfo 和 SharedAgentInfo

这些结构体在基础共享记录上添加了更多上下文信息：

```go
type SharedKnowledgeBaseInfo struct {
    KnowledgeBase  *KnowledgeBase `json:"knowledge_base"`
    ShareID        string         `json:"share_id"`
    OrganizationID string         `json:"organization_id"`
    OrgName        string         `json:"org_name"`
    Permission     OrgMemberRole  `json:"permission"`
    SourceTenantID uint64         `json:"source_tenant_id"`
    SharedAt       time.Time      `json:"shared_at"`
}
```

**设计意图**：
- 将核心知识库/智能体对象与其共享元数据组合在一起
- 包含组织名称等展示型字段，减少API调用次数
- 为前端提供一站式的数据结构

#### OrganizationSharedKnowledgeBaseItem 的特别设计

这个结构体引入了一个重要的概念：**间接共享**：

```go
type OrganizationSharedKnowledgeBaseItem struct {
    SharedKnowledgeBaseInfo
    IsMine          bool                `json:"is_mine"`
    SourceFromAgent *SourceFromAgentInfo `json:"source_from_agent,omitempty"`
}
```

**设计意图**：
- `IsMine` 字段让用户能够快速区分自己的资源和他人共享的资源
- `SourceFromAgent` 支持一种特殊的共享场景：知识库通过智能体间接共享，而不是直接共享。这种情况下，用户只能通过智能体访问知识库，而不能直接浏览。

### 3.4 请求/响应模型

#### UpdateSharePermissionRequest

```go
type UpdateSharePermissionRequest struct {
    Permission OrgMemberRole `json:"permission" binding:"required"`
}
```

**设计意图**：
- 简单、聚焦的请求模型，只包含必要的字段
- 使用 `binding:"required"` 确保数据完整性

#### ListSharesResponse

```go
type ListSharesResponse struct {
    Shares []KnowledgeBaseShareResponse `json:"shares"`
    Total  int64                        `json:"total"`
}
```

**设计意图**：
- 标准的分页列表响应结构
- 包含 `Total` 字段支持前端分页控件

#### KnowledgeBaseShareResponse 的有效权限设计

```go
type KnowledgeBaseShareResponse struct {
    // ... 其他字段
    Permission   string `json:"permission"`     // 资源共享给组织的权限
    MyRoleInOrg  string `json:"my_role_in_org"` // 用户在组织中的角色
    MyPermission string `json:"my_permission"`  // 用户的有效权限
    // ... 其他字段
}
```

**设计意图**：
- 同时展示三种权限信息，让用户清晰理解权限的来源
- `MyPermission` 是计算得出的有效权限，避免了前端重复计算

## 4. 数据流向与架构角色

### 4.1 模块在系统中的位置

该模块作为**数据契约层**，位于：
- 下游：[organization_membership_sharing_and_access_control_repositories](data-access-repositories-identity-tenant-and-organization-repositories-organization-membership-sharing-and-access-control-repositories.md)（数据访问层）
- 上游：[resource_sharing_and_access_services](application-services-and-orchestration-agent-identity-tenant-and-configuration-services-resource-sharing-and-access-services.md)（应用服务层）

### 4.2 典型数据流向

以更新共享权限为例：

1. **API层**接收 `UpdateSharePermissionRequest`
2. **服务层**验证请求，调用仓储层更新 `KnowledgeBaseShare` 或 `AgentShare`
3. **仓储层**持久化更改
4. **服务层**构建包含有效权限计算的 `KnowledgeBaseShareResponse`
5. **API层**返回响应给客户端

## 5. 设计决策与权衡

### 5.1 权限模型的选择

**决策**：采用三级权限模型（Admin/Editor/Viewer）而非更细粒度的权限控制

**权衡**：
- ✅ 优点：简单易懂，用户学习成本低；权限检查高效
- ❌ 缺点：灵活性较低，无法支持非常细粒度的权限控制

**理由**：在协作场景中，大多数用户只需要这三种基本权限级别。过度复杂的权限模型会增加用户认知负担和系统复杂度。

### 5.2 有效权限的计算位置

**决策**：在服务端计算有效权限并在响应中返回，而不是让前端计算

**权衡**：
- ✅ 优点：确保权限计算的一致性；减少前端逻辑；避免权限计算错误导致的安全问题
- ❌ 缺点：响应体积略微增大；服务端需要额外的计算

**理由**：权限计算是核心业务逻辑，应该集中在服务端，确保所有客户端看到一致的结果。

### 5.3 间接共享的支持

**决策**：支持通过智能体间接共享知识库的场景

**权衡**：
- ✅ 优点：提供了更灵活的共享方式；支持"通过智能体使用但不直接暴露知识库"的场景
- ❌ 缺点：增加了模型复杂度；需要处理两种不同的共享来源

**理由**：实际业务中存在这样的场景：智能体配置了多个知识库，用户需要使用智能体但不需要直接访问所有知识库。

## 6. 实战指南与注意事项

### 6.1 使用建议

1. **权限检查**：始终使用 `HasPermission()` 方法进行权限检查，而不是直接比较字符串
2. **有效权限**：在展示资源操作按钮时，应该基于 `MyPermission` 而不是 `Permission`
3. **间接共享处理**：当 `SourceFromAgent` 存在时，应该将知识库显示为只读，并注明来源

### 6.2 常见陷阱

1. **权限顺序错误**：在扩展权限模型时，确保正确设置权限级别数值，避免 `Admin` 的级别低于 `Viewer`
2. **忽略软删除**：查询共享记录时，记得考虑软删除标记，避免返回已撤销的共享
3. **跨租户访问**：访问共享资源时，务必使用 `SourceTenantID` 路由到正确的租户，避免数据访问错误

### 6.3 扩展点

1. **自定义权限**：可以通过添加新的 `OrgMemberRole` 常量和对应级别来扩展权限模型
2. **更多共享类型**：可以参考 `KnowledgeBaseShare` 和 `AgentShare` 的模式，添加新的资源共享类型
3. **权限计算钩子**：可以在有效权限计算中添加业务特定的规则，如临时权限提升等

## 7. 总结

`share_permission_and_listing_contracts` 模块是组织资源共享系统的基石，它通过清晰的权限模型、灵活的共享记录结构和完整的API契约，解决了跨租户资源共享的核心挑战。该模块的设计注重简单性和实用性，同时保留了足够的灵活性来支持各种共享场景。

理解这个模块的关键是掌握**双重权限约束**的心智模型，以及**直接共享与间接共享**的区别。在使用和扩展该模块时，应该始终保持权限计算的一致性和数据契约的完整性。
