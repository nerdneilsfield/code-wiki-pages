# progress_tracking 模块技术深度解析

## 模块概述

`progress_tracking` 模块负责追踪和管理 **Molecule 工作流的执行进度**。它解决了在复杂工作流中“我在哪里”以及“下一步该做什么”的问题。在项目管理中，工作流往往不是简单的线性序列，而是包含并行分支、依赖关系和状态转换的有向无环图（DAG）。这个模块让用户能够清晰地可视化自己的工作位置，并提供自动推进到下一步的功能。

## 模块位置与依赖关系

`progress_tracking` 模块位于 `cmd/bd/mol_current.go` 文件中，属于 CLI 命令层的一部分。它是 [molecule_progress_and_dispatch](cmd-bd-mol_current-molecule_progress_and_dispatch.md) 模块的子模块，主要负责：

1. **进度可视化**：将 molecule 的执行状态以人类可读的方式呈现
2. **自动推进**：提供 `AdvanceToNextStep` 函数，在关闭步骤后自动推进到下一步
3. **自动发现**：通过多种策略自动发现用户正在处理的 molecule

### 主要依赖

- **[Core Domain Types](Core-Domain-Types.md)**：提供 `Issue`、`Dependency` 等核心数据结构
- **[Dolt Storage Backend](Dolt-Storage-Backend.md)**：提供数据存储和查询功能
- **[molecule_progress_and_dispatch](cmd-bd-mol_current-molecule_progress_and_dispatch.md)**：提供并行分析和子图加载功能
- **UI Utilities**：提供终端输出格式化功能

## 架构与工作流程

### 模块架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        progress_tracking                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐     ┌──────────────────┐                │
│  │  CLI Command     │     │  API Functions   │                │
│  │  (molCurrentCmd) │────▶│  (AdvanceToNext- │                │
│  └──────────────────┘     │   Step)          │                │
│         │                   └──────────────────┘                │
│         ▼                                                        │
│  ┌──────────────────┐     ┌──────────────────┐                │
│  │  Progress View   │     │  Discovery Logic  │                │
│  │  Model Builders  │◀────│  (findInProgress- │                │
│  │  (getMolecule-   │     │   Molecules, etc) │                │
│  │   Progress)      │     └──────────────────┘                │
│  └──────────────────┘                                          │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              外部依赖 (Storage, Types, UI)              │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 关键工作流程

#### 1. 查看当前进度流程

1. **用户输入**：执行 `bd mol current` 命令
2. **目标确定**：
   - 如果指定了 molecule ID，直接加载该 molecule
   - 否则，通过 `findInProgressMolecules` 自动发现
   - 如果没有找到，尝试 `findHookedMolecules` 作为后备
3. **大型 molecule 检查**：检查步骤数量是否超过阈值
4. **进度计算**：调用 `getMoleculeProgress` 计算详细进度
5. **结果输出**：根据格式要求输出 JSON 或人类可读格式

#### 2. 自动推进流程

1. **步骤关闭**：用户关闭当前步骤
2. **父 molecule 查找**：调用 `findParentMolecule` 向上追溯
3. **进度重新计算**：调用 `getMoleculeProgress` 获取最新状态
4. **完成检查**：检查 molecule 是否全部完成
5. **下一步查找**：在步骤列表中找到 "ready" 状态的步骤
6. **自动认领**：如果 `autoClaim` 为 true，将下一步标记为 `in_progress`
7. **结果返回**：返回 `ContinueResult` 结构体

## 核心问题与设计意图

### 问题背景

想象你正在处理一个有 50 个步骤的工作流，其中有些步骤可以并行执行，有些必须按顺序执行，还有些被其他步骤阻塞。如果你是新来的开发者，你需要知道：
1. 当前正在处理哪个步骤？
2. 哪些步骤已经完成？
3. 下一步可以做什么？
4. 哪些步骤被阻塞了？

这个模块就是为了解决这些问题而设计的。

### 设计理念

该模块的核心设计理念是：**将复杂的工作流状态空间压缩成用户可理解的视图**。它不只是展示一堆 issue 的状态，而是构建一个**进度追踪器**，把工作流的抽象结构和实时状态结合起来，让用户一眼就能明白自己的位置和下一步行动。

## 核心数据结构

### MoleculeProgress

```go
type MoleculeProgress struct {
    MoleculeID    string        `json:"molecule_id"`
    MoleculeTitle string        `json:"molecule_title"`
    Assignee      string        `json:"assignee,omitempty"`
    CurrentStep   *types.Issue  `json:"current_step,omitempty"`
    NextStep      *types.Issue  `json:"next_step,omitempty"`
    Steps         []*StepStatus `json:"steps"`
    Completed     int           `json:"completed"`
    Total         int           `json:"total"`
}
```

**设计意图**：
- 这个结构体是整个模块的**核心视图模型**
- 它把 molecule 的元数据（ID、标题、负责人）与实时状态（当前步骤、下一步、所有步骤的详细状态）结合在一起
- `Steps` 字段是一个有序列表，按依赖关系排序，让用户能按正确的顺序浏览工作流

### StepStatus

```go
type StepStatus struct {
    Issue     *types.Issue `json:"issue"`
    Status    string       `json:"status"`     // "done", "current", "ready", "blocked", "pending"
    IsCurrent bool         `json:"is_current"` // true if this is the in_progress step
}
```

**设计意图**：
- 封装了单个步骤的状态信息
- `Status` 字段将复杂的 issue 状态（如 `StatusClosed`、`StatusInProgress`、`StatusBlocked`）映射到更直观的用户友好状态
- 特别标记当前步骤，让用户一眼就能找到自己的位置

### ContinueResult

```go
type ContinueResult struct {
    ClosedStep   *types.Issue `json:"closed_step"`
    NextStep     *types.Issue  `json:"next_step,omitempty"`
    AutoAdvanced bool         `json:"auto_advanced"`
    MolComplete  bool         `json:"molecule_complete"`
    MoleculeID   string       `json:"molecule_id,omitempty"`
}
```

**设计意图**：
- 用于 `AdvanceToNextStep` 函数的返回值
- 封装了推进工作流后的所有可能结果：是否完成了步骤、是否自动推进了、molecule 是否完成等
- 让调用者能根据结果采取相应的行动

## 核心功能与实现

### getMoleculeProgress

这是模块的**核心函数**，负责加载 molecule 并计算其进度。

**关键设计决策**：

1. **使用 `analyzeMoleculeParallel` 而不是 `GetReadyWork`**
   - 原因：`GetReadyWork` 会排除临时 issue（wisp 步骤本质上是临时的）
   - 这是一个重要的**兼容性设计**，确保 wisp 类型的 molecule 也能正确计算步骤就绪状态

2. **状态映射逻辑**
   ```go
   switch issue.Status {
   case types.StatusClosed:
       step.Status = "done"
   case types.StatusInProgress:
       step.Status = "current"
   case types.StatusBlocked:
       step.Status = "blocked"
   default:
       // 检查是否就绪（未被阻塞）
       if readyIDs[issue.ID] {
           step.Status = "ready"
       } else {
           step.Status = "pending"
       }
   }
   ```
   - 这里体现了**状态转换的核心逻辑**
   - 将内部状态映射到用户友好的状态
   - 对于未明确状态的 issue，通过依赖分析判断是 "ready" 还是 "pending"

3. **步骤排序**
   - 使用 `sortStepsByDependencyOrder` 函数按依赖关系排序
   - 采用**拓扑排序的简化版本**：按依赖计数排序（依赖越少越靠前）
   - 这样确保用户看到的步骤顺序是符合工作流逻辑的

### findInProgressMolecules 和 findHookedMolecules

这两个函数负责**自动发现用户正在处理的 molecule**。

**设计意图**：
- `findInProgressMolecules`：首先查找有 `in_progress` 状态的步骤，然后向上追溯找到父 molecule
- `findHookedMolecules`：作为后备方案，查找被 "hooked" 的 issue，并检查它们是否连接到某个 molecule

这种**双重策略**确保了即使用户没有明确标记某个步骤为 `in_progress`，系统也能找到用户正在处理的 molecule。

### findParentMolecule

这个函数**向上追溯依赖链**，找到根 molecule。

**关键实现**：
```go
// 遍历父-子依赖关系
for _, dep := range deps {
    if dep.Type == types.DepParentChild && dep.IssueID == currentID {
        parentID = dep.DependsOnID
        break
    }
}

// 检查当前 issue 是否是 molecule 根
// 1. 检查是否有 template 标签
// 2. 检查是否是有子问题的 epic
```

**设计意图**：
- 支持两种类型的 molecule：
  1. 从模板实例化的 molecule（有 `BeadsTemplateLabel` 标签）
  2. 临时构建的 molecule（是 epic 类型且有子问题）

### AdvanceToNextStep

这是模块的**核心操作函数**，负责在关闭一个步骤后自动推进到下一步。

**关键设计决策**：
- 如果 `autoClaim` 为 true，会自动将下一步标记为 `in_progress`
- 返回 `ContinueResult` 结构体，包含所有可能的结果信息
- 检查 molecule 是否完成（`progress.Completed >= progress.Total`）

这个函数体现了**工作流自动化的核心思想：让用户只需关注当前步骤，系统自动处理推进逻辑。

## 大型 molecule 处理策略

模块有一个**重要的性能优化设计：大型 molecule 阈值（`LargeMoleculeThreshold = 100`）。

**设计意图**：
- 对于超过 100 个步骤的 molecule，默认只显示摘要而不是完整列表
- 防止输出过载和查询缓慢
- 用户可以通过 `--limit` 或 `--range` 标志查看特定步骤

这是一个**用户体验与性能之间的平衡设计。

## 数据流向

```
用户输入 (mol current)
    ↓
确定目标 molecule（指定 ID 或自动发现）
    ↓
加载模板子图 (loadTemplateSubgraph)
    ↓
分析并行性 (analyzeMoleculeParallel)
    ↓
构建步骤状态列表
    ↓
按依赖关系排序
    ↓
输出结果（JSON 或人类可读格式）
```

## 设计权衡与决策

### 1. 视图模型 vs 原始数据

**选择**：创建专门的视图模型（`MoleculeProgress`、`StepStatus`）而不是直接返回原始 issue 数据

**原因**：
- 原始数据包含太多细节，用户不需要
- 视图模型将复杂的状态空间压缩成直观的表示
- 可以在视图模型中添加计算字段（如 `IsCurrent`、`Completed`）

**权衡**：
- 增加了数据转换的复杂度
- 但大大提高了用户体验

### 2. 自动发现 vs 明确指定

**选择**：同时支持两种方式

**原因**：
- 明确指定（通过 molecule ID）：精确、直接
- 自动发现（通过 `in_progress` 或 `hooked` 状态）：方便、自动化

**权衡**：
- 自动发现逻辑更复杂，需要处理多种情况
- 但提供了更好的用户体验

### 3. 完整列表 vs 摘要

**选择**：根据 molecule 大小自动切换

**原因**：
- 小型 molecule：完整列表更有用
- 大型 molecule：摘要更清晰，性能更好

**权衡**：
- 增加了代码复杂度
- 但提高了大型 molecule 的用户体验和性能

## 使用场景与示例

### 查看当前 molecule 进度

```bash
# 查看当前正在处理的 molecule
bd mol current

# 查看指定 molecule 的进度
bd mol current <molecule-id>

# 查看指定 agent 的 molecule
bd mol current --for <agent-name>

# 限制显示的步骤数
bd mol current <molecule-id> --limit 50

# 显示特定范围的步骤
bd mol current <molecule-id> --range 100-150
```

### 推进到下一步

```go
// 在关闭步骤后自动推进
result, err := AdvanceToNextStep(ctx, store, closedStepID, true, actorName)
if err != nil {
    // 处理错误
}
if result != nil {
    PrintContinueResult(result)
}
```

## 注意事项与陷阱

### 1. 临时 issue（wisp）的处理

**陷阱**：`GetReadyWork` 会排除临时 issue，所以必须使用 `analyzeMoleculeParallel`

**解决**：在 `getMoleculeProgress` 中已经处理了这个问题

### 2. 大型 molecule 的性能

**陷阱**：加载包含数百个步骤的 molecule 可能会很慢

**解决**：
- 默认显示摘要而不是完整列表
- 提供 `--limit` 和 `--range` 标志

### 3. 自动发现的边界情况

**陷阱**：自动发现可能找不到某些类型的 molecule

**解决**：
- 提供了双重策略（`findInProgressMolecules` 和 `findHookedMolecules`）
- 用户也可以明确指定 molecule ID

### 4. 步骤排序的依赖计数方法

**陷阱**：按依赖计数排序可能不是完美的拓扑排序

**原因**：
- 对于复杂的 DAG，依赖计数排序可能无法处理所有情况
- 但对于大多数工作流来说已经足够

## 总结

`progress_tracking` 模块是一个**专门为工作流进度追踪而设计的视图层模块**。它将复杂的工作流状态空间压缩成用户可理解的视图，解决了“我在哪里”以及“下一步该做什么”的问题。

模块的核心设计理念是：**将抽象结构与实时状态结合，提供直观的用户体验**。它通过视图模型、自动发现、大型 molecule 处理等设计，平衡了用户体验、性能和复杂性。

对于新开发者来说，理解这个模块的关键是理解：
1. 视图模型的设计意图
2. 状态映射逻辑
3. 自动发现策略
4. 大型 molecule 处理
