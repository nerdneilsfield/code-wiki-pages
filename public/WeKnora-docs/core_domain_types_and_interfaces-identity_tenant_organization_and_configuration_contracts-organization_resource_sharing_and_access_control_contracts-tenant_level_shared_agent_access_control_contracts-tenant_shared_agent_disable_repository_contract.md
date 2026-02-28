# 租户级共享代理禁用仓库合约技术深度解析

## 1. 模块概述与问题解决

在多租户、多组织的智能体共享环境中，一个核心的用户体验问题是：如何让用户能够个性化地管理自己可见的代理列表，同时不影响其他用户的视图和代理的原始共享状态？

`tenant_shared_agent_disable_repository_contract` 模块正是为了解决这个问题而设计的。它提供了一个契约，允许每个租户（个人或组织）独立地"隐藏"（禁用）特定的共享代理，而不会从系统中真正移除这些代理的共享关系，也不会影响其他租户对这些代理的可见性。

## 2. 核心抽象与心智模型

### 2.1 核心抽象

该模块的核心抽象是 `TenantDisabledSharedAgentRepository` 接口，它定义了一套用于管理租户级代理禁用状态的数据访问契约。你可以把它想象成一个**租户的"代理隐藏列表"管理器**——每个租户都有自己的一个黑名单，可以将不希望在自己的对话下拉菜单中看到的代理添加进去，但这个黑名单只对自己生效。

### 2.2 心智模型类比

这个抽象类似于你手机上的应用抽屉：
- 所有应用都安装在系统中（代理共享关系存在）
- 但你可以将某些应用移动到文件夹中隐藏起来（禁用代理）
- 隐藏的应用仍然安装在手机上，只是不在主界面显示（代理仍然共享，只是不在当前租户的下拉菜单中显示）
- 每个用户的应用抽屉布局都是独立的（每个租户的禁用列表独立）

## 3. 架构角色与数据流

### 3.1 架构定位

`TenantDisabledSharedAgentRepository` 接口位于系统架构的**数据访问契约层**，是组织资源共享与访问控制子系统的一部分。它与 `AgentShareService` 和 `AgentShareRepository` 协作，共同完成智能体共享的全生命周期管理。

### 3.2 核心组件

该模块的核心组件是 `TenantDisabledSharedAgentRepository` 接口，定义了四个关键方法：

```go
type TenantDisabledSharedAgentRepository interface {
    // 列出指定租户禁用的所有代理
    ListByTenantID(ctx context.Context, tenantID uint64) ([]*types.TenantDisabledSharedAgent, error)
    
    // 列出指定租户禁用的自己的代理ID列表
    ListDisabledOwnAgentIDs(ctx context.Context, tenantID uint64) ([]string, error)
    
    // 为指定租户添加一个禁用的代理
    Add(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64) error
    
    // 为指定租户移除一个禁用的代理
    Remove(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64) error
}
```

### 3.3 数据流分析

当用户与共享代理交互时，典型的数据流如下：

1. **列出可用代理时**：
   - 系统首先通过 `AgentShareRepository` 获取所有共享给当前用户的代理
   - 然后通过 `TenantDisabledSharedAgentRepository.ListByTenantID` 获取当前租户禁用的代理列表
   - 最后过滤掉禁用的代理，只显示可用的代理

2. **禁用代理时**：
   - 用户通过 UI 触发禁用操作
   - `AgentShareService.SetSharedAgentDisabledByMe` 被调用
   - 服务层调用 `TenantDisabledSharedAgentRepository.Add` 添加禁用记录

3. **启用代理时**：
   - 用户通过 UI 触发启用操作
   - `AgentShareService.SetSharedAgentDisabledByMe` 被调用
   - 服务层调用 `TenantDisabledSharedAgentRepository.Remove` 移除禁用记录

## 4. 核心方法深度解析

### 4.1 ListByTenantID

**设计意图**：获取指定租户禁用的所有代理记录，包括来自其他租户的共享代理和该租户自己的代理。

**使用场景**：当需要构建一个完整的"已隐藏代理"列表时，或者需要过滤掉所有被禁用的代理时使用。

**参数**：
- `ctx context.Context`：上下文，用于传递请求范围的值、取消信号等
- `tenantID uint64`：租户ID，标识要查询的租户

**返回值**：
- `[]*types.TenantDisabledSharedAgent`：禁用代理记录的切片
- `error`：操作过程中可能发生的错误

### 4.2 ListDisabledOwnAgentIDs

**设计意图**：专门获取租户自己的代理中被禁用的ID列表。这个方法存在的意义是区分"自己的代理"和"共享的代理"，因为租户对自己的代理有完全的控制权，而对共享代理只有使用权。

**使用场景**：当需要处理租户自己的代理（例如在管理界面中显示自己的代理哪些被隐藏）时使用。

**参数**：
- `ctx context.Context`：上下文
- `tenantID uint64`：租户ID

**返回值**：
- `[]string`：被禁用的自有代理ID列表
- `error`：操作过程中可能发生的错误

**设计亮点**：这个方法体现了接口设计的**单一职责原则**，将"查询所有禁用代理"和"查询自有禁用代理"分开，使接口更加清晰，调用方的意图更加明确。

### 4.3 Add

**设计意图**：为指定租户添加一个禁用的代理记录。这是实现"隐藏代理"功能的核心操作。

**使用场景**：当用户在界面上选择"隐藏此代理"时调用。

**参数**：
- `ctx context.Context`：上下文
- `tenantID uint64`：执行禁用操作的租户ID
- `agentID string`：要禁用的代理ID
- `sourceTenantID uint64`：代理的原始所有者租户ID

**返回值**：
- `error`：操作过程中可能发生的错误

**设计思考**：需要同时传入 `tenantID` 和 `sourceTenantID` 是因为：
1. 一个代理可能被多个租户共享
2. 需要明确标识是"哪个租户的代理"被"哪个租户禁用"
3. 这是一个复合主键的设计，确保记录的唯一性

### 4.4 Remove

**设计意图**：为指定租户移除一个禁用的代理记录，即"重新显示"之前隐藏的代理。

**使用场景**：当用户在界面上选择"显示此代理"时调用。

**参数**：与 `Add` 方法完全相同
- `ctx context.Context`：上下文
- `tenantID uint64`：执行启用操作的租户ID
- `agentID string`：要启用的代理ID
- `sourceTenantID uint64`：代理的原始所有者租户ID

**返回值**：
- `error`：操作过程中可能发生的错误

**设计一致性**：`Remove` 方法与 `Add` 方法使用相同的参数签名，这是一个很好的设计实践，确保了接口的一致性和可预测性。

## 5. 设计权衡与决策

### 5.1 关注点分离：禁用状态 vs 共享关系

**设计决策**：将代理的禁用状态与代理的共享关系完全分离存储。

**为什么这样设计**：
- **独立性**：每个租户的禁用状态只影响自己，不影响其他租户
- **灵活性**：共享关系可以独立变化，不影响已有的禁用状态
- **可扩展性**：未来可以为不同的场景添加不同的"视图过滤器"，而不修改核心共享逻辑

**替代方案考虑**：
- 方案A：在 `AgentShare` 记录中添加一个 `disabled` 字段。但这会导致一个问题：如果多个租户共享同一个代理，一个租户禁用它会影响所有其他租户。
- 方案B：为每个用户创建独立的共享记录副本。但这会导致数据冗余和一致性问题。

**最终选择**：独立的禁用状态存储是最佳方案，它在数据一致性、用户体验和系统复杂度之间取得了良好的平衡。

### 5.2 复合标识符设计

**设计决策**：使用 `(tenantID, agentID, sourceTenantID)` 三元组作为禁用记录的唯一标识。

**为什么这样设计**：
- `tenantID`：标识谁在禁用代理
- `agentID`：标识哪个代理被禁用
- `sourceTenantID`：标识这个代理属于谁

**这三个元素合在一起确保了记录的唯一性**，因为：
1. 同一个租户可以禁用来自不同源租户的同名代理
2. 不同租户可以独立禁用同一个代理

### 5.3 接口粒度设计

**设计决策**：提供了 `ListByTenantID` 和 `ListDisabledOwnAgentIDs` 两个分离的查询方法，而不是一个带有过滤参数的通用方法。

**权衡分析**：
- **优点**：
  - 接口更加清晰，调用方的意图更加明确
  - 实现可以针对不同场景进行优化
  - 类型安全，不需要传递过滤参数
  
- **缺点**：
  - 如果未来需要更多的查询方式，需要添加更多的方法
  - 可能会有一些代码重复

**为什么这样选择**：在这个场景下，清晰性和类型安全比灵活性更重要。这两个查询方法覆盖了主要的使用场景，而且接口相对稳定，不太可能频繁变化。

## 6. 与其他模块的协作

### 6.1 与 AgentShareService 的协作

`TenantDisabledSharedAgentRepository` 最主要的协作者是 `AgentShareService`，特别是其中的 `SetSharedAgentDisabledByMe` 方法。服务层负责业务逻辑，而仓库层负责数据持久化。

```go
// 在 AgentShareService 中
SetSharedAgentDisabledByMe(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64, disabled bool) error
```

这个方法会根据 `disabled` 参数决定调用 `TenantDisabledSharedAgentRepository.Add` 还是 `Remove`。

### 6.2 与 AgentShareRepository 的协作

在列出共享代理时，系统通常会：
1. 先用 `AgentShareRepository` 获取所有共享的代理
2. 再用 `TenantDisabledSharedAgentRepository` 获取禁用的代理
3. 最后将两者进行差集运算，得到最终显示的代理列表

### 6.3 与上层应用的协作

在 HTTP 处理层，这个接口的功能通常会通过特定的 API 端点暴露给前端，例如：
- `POST /api/shared-agents/{agentID}/disable`：禁用代理
- `POST /api/shared-agents/{agentID}/enable`：启用代理

## 7. 使用示例与最佳实践

### 7.1 实现该接口

如果你要实现这个接口，需要确保：

```go
type MyTenantDisabledSharedAgentRepository struct {
    // 数据库连接或其他存储介质
    db *sql.DB
}

func (r *MyTenantDisabledSharedAgentRepository) ListByTenantID(ctx context.Context, tenantID uint64) ([]*types.TenantDisabledSharedAgent, error) {
    // 实现查询逻辑
}

func (r *MyTenantDisabledSharedAgentRepository) ListDisabledOwnAgentIDs(ctx context.Context, tenantID uint64) ([]string, error) {
    // 实现查询逻辑，注意过滤 source_tenant_id = tenant_id
}

func (r *MyTenantDisabledSharedAgentRepository) Add(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64) error {
    // 实现插入逻辑，注意处理重复插入的情况（幂等性）
}

func (r *MyTenantDisabledSharedAgentRepository) Remove(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64) error {
    // 实现删除逻辑，注意处理不存在的记录（幂等性）
}
```

### 7.2 调用该接口

在服务层调用该接口时的典型模式：

```go
type AgentShareService struct {
    agentShareRepo AgentShareRepository
    disabledRepo   TenantDisabledSharedAgentRepository
}

func (s *AgentShareService) SetSharedAgentDisabledByMe(ctx context.Context, tenantID uint64, agentID string, sourceTenantID uint64, disabled bool) error {
    if disabled {
        return s.disabledRepo.Add(ctx, tenantID, agentID, sourceTenantID)
    }
    return s.disabledRepo.Remove(ctx, tenantID, agentID, sourceTenantID)
}

func (s *AgentShareService) ListSharedAgents(ctx context.Context, userID string, currentTenantID uint64) ([]*types.SharedAgentInfo, error) {
    // 1. 获取所有共享的代理
    allAgents, err := s.agentShareRepo.ListSharedAgentsForUser(ctx, userID)
    if err != nil {
        return nil, err
    }
    
    // 2. 获取当前租户禁用的代理
    disabledAgents, err := s.disabledRepo.ListByTenantID(ctx, currentTenantID)
    if err != nil {
        return nil, err
    }
    
    // 3. 创建禁用代理的快速查找集合
    disabledSet := make(map[string]bool)
    for _, d := range disabledAgents {
        key := fmt.Sprintf("%s-%d", d.AgentID, d.SourceTenantID)
        disabledSet[key] = true
    }
    
    // 4. 过滤掉禁用的代理
    var result []*types.SharedAgentInfo
    for _, agent := range allAgents {
        key := fmt.Sprintf("%s-%d", agent.AgentID, agent.SourceTenantID)
        if !disabledSet[key] {
            result = append(result, agent)
        }
    }
    
    return result, nil
}
```

## 8. 注意事项与陷阱

### 8.1 幂等性要求

**重要**：`Add` 和 `Remove` 方法的实现必须是**幂等**的。

- 如果尝试添加一个已经存在的禁用记录，不应该报错，而应该视为成功
- 如果尝试删除一个不存在的禁用记录，不应该报错，而应该视为成功

这是因为用户可能会多次点击"隐藏"或"显示"按钮，系统应该能够优雅地处理这种情况。

### 8.2 数据一致性

当代理被取消共享或删除时，相关的禁用记录应该如何处理？

- **建议**：实现应该监听代理共享关系的变化，当代理不再共享给某个租户时，自动清理该租户的禁用记录
- **或者**：在查询时进行 JOIN，只返回仍然有效的共享关系的禁用记录

如果不处理这种情况，可能会导致禁用记录的累积，产生"僵尸数据"。

### 8.3 租户隔离

确保在实现中严格遵守租户隔离原则：
- 一个租户只能操作自己的禁用记录
- 查询时必须正确过滤 `tenantID`
- 防止出现越权访问其他租户禁用记录的情况

### 8.4 性能考虑

当租户数量很大，或者每个租户禁用的代理很多时，需要考虑性能优化：
- 为 `(tenantID, sourceTenantID, agentID)` 创建复合索引
- 考虑使用缓存来加速频繁查询的禁用列表
- 对于 `ListByTenantID`，考虑分页（虽然当前接口没有定义分页参数）

## 9. 总结

`tenant_shared_agent_disable_repository_contract` 模块是一个设计精良的接口契约，它解决了多租户环境下共享代理的个性化可见性问题。通过将禁用状态与共享关系分离，它实现了租户之间的完全隔离，同时保持了系统的简洁性和可扩展性。

该模块的设计体现了几个重要的软件工程原则：
- **单一职责原则**：每个方法只做一件事
- **关注点分离**：将数据访问契约与具体实现分离
- **接口隔离原则**：定义了最小化的接口，只包含必要的方法
- **幂等性设计**：确保操作可以重复执行而不会产生副作用

对于新加入团队的开发者来说，理解这个模块的关键是把握"每个租户有自己的代理隐藏列表"这个核心心智模型，以及理解为什么禁用状态需要与共享关系分离存储。
