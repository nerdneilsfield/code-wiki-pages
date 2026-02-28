# progress_tracking 模块技术深度解析

## 概述

`progress_tracking` 模块是 Beads 工作流系统中负责追踪和展示 Molecule（分子）进度状态的核心组件。当你运行 `bd mol current` 命令时，背后就是这个模块在运作——它需要回答一个看似简单但实际上相当复杂的问题：**"我当前在这个分子工作流的哪个位置，还有哪些步骤可以开始？"**

这个模块解决的问题远不止"显示已完成步骤"这么简单。在一个具有复杂依赖关系的分子工作流中，确定哪些步骤"可以开始"（ready 状态）需要理解依赖图的拓扑结构。此外，系统需要处理多种边界情况： ephemeral（临时）步骤、bonded（绑定）分子、甚至没有明确分子归属的孤立步骤。

---

## 问题空间：为什么需要这个模块？

在 Beads 系统中，**分子（Molecule）** 是一种工作流模板，它由一个根问题（通常是 Epic 类型）和多个步骤（子问题）组成。每个步骤可能依赖于其他步骤，形成一个依赖有向无环图（DAG）。当你"实例化"一个分子模板时，会创建一系列相互关联的问题。

### 核心挑战

1. **依赖可达性判断**：给定一个步骤，如何判断它的所有依赖都已经满足（即被阻塞的步骤都已关闭）？这需要遍历依赖图。

2. **Ephemeral 步骤的排除**：分子中的某些步骤是"临时"的（wisp 类型），它们不应该被常规的 `GetReadyWork` 查询返回，因为后者过滤掉了临时问题。但进度追踪需要看到完整画面。

3. **大型分子的性能**：一个分子可能有数百甚至数千个步骤。如果每次查看进度都加载并分析所有步骤，响应会非常缓慢。需要智能的分页和摘要机制。

4. **-bonded 分子的发现**：分子可以通过"bond"机制动态组合。当一个分子被绑定到另一个分子时，传统的父-子关系查询可能找不到正确的分子根。

---

## 架构设计与数据流

### 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│                     mol_current.go                              │
├─────────────────────────────────────────────────────────────────┤
│  MoleculeProgress     StepStatus         ContinueResult        │
│  ├── MoleculeID       ├── Issue          ├── ClosedStep        │
│  ├── MoleculeTitle    ├── Status         ├── NextStep          │
│  ├── Assignee         └── IsCurrent      ├── AutoAdvanced      │
│  ├── CurrentStep                           └── MolComplete     │
│  ├── NextStep                                                    │
│  ├── Steps (slice)                                               │
│  ├── Completed                                                   │
│  └── Total                                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   核心处理函数                                   │
├─────────────────────────────────────────────────────────────────┤
│  getMoleculeProgress()     - 加载并计算分子进度                 │
│  findInProgressMolecules() - 查找用户正在进行的所有分子         │
│  findHookedMolecules()     - 查找绑定到用户工作的分子（fallback）│
│  findParentMolecule()      - 向上遍历找到分子根                 │
│  AdvanceToNextStep()       - 关闭步骤后自动推进到下一个         │
│  analyzeMoleculeParallel() - 分析并行执行可能性（来自mol_show） │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   依赖的存储层                                   │
├─────────────────────────────────────────────────────────────────┤
│  DoltStore (sql.DB + 版本控制)                                   │
│  └── GetIssue() / SearchIssues() / GetDependencyRecords()       │
│  └── GetMoleculeProgress() / GetDependents()                    │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流：查看当前进度

当你执行 `bd mol current bd-abc123` 时，系统按以下步骤处理：

1. **解析参数**：调用 `utils.ResolvePartialID()` 将部分 ID 解析为完整 ID

2. **检查分子大小**：首先调用 `store.GetMoleculeProgress()` 获取统计信息
   - 如果步骤数超过 `LargeMoleculeThreshold`（100），且用户没有指定 `--limit` 或 `--range`，直接显示摘要信息并返回

3. **加载子图**：调用 `loadTemplateSubgraph()` 加载分子完整结构
   - 这会递归加载根问题和所有子问题
   - 同时加载所有依赖关系

4. **计算就绪状态**：调用 `analyzeMoleculeParallel()` 分析依赖图
   - 构建 `blockedBy` 和 `blocks` 映射
   - 处理 `DepBlocks`、`DepConditionalBlocks`、`DepWaitsFor` 三种依赖类型
   - 计算每个步骤的阻塞深度

5. **构建进度对象**：遍历所有步骤，根据状态分类
   - `StatusClosed` → "done"
   - `StatusInProgress` → "current"
   - `StatusBlocked` → "blocked"
   - 其他 + 有未完成阻塞 → "pending"
   - 其他 + 无阻塞 → "ready"

6. **排序输出**：按照依赖深度排序步骤，确保依赖链上游的步骤显示在前

---

## 核心类型详解

### MoleculeProgress

这是模块的核心数据结构，封装了分子进度的一切信息：

```go
type MoleculeProgress struct {
    MoleculeID    string        // 分子根问题的 ID
    MoleculeTitle string        // 分子标题
    Assignee      string        // 被分配者（如果有）
    CurrentStep   *types.Issue  // 当前正在处理的步骤（in_progress）
    NextStep      *types.Issue  // 下一个可以开始的步骤（ready 状态中的第一个）
    Steps         []*StepStatus // 所有步骤的状态列表
    Completed     int           // 已完成步骤数
    Total         int           // 总步骤数（排除根）
}
```

**设计意图**：这个结构将"进度"的各个方面集中在一起，既便于序列化输出（JSON），也便于人类可读的打印输出。

### StepStatus

每个步骤的状态快照：

```go
type StepStatus struct {
    Issue     *types.Issue // 步骤的完整问题对象
    Status    string       // 状态字符串："done", "current", "ready", "blocked", "pending"
    IsCurrent bool         // 是否为当前步骤（用于 UI 高亮）
}
```

**状态语义**：
- **done**：步骤已关闭（`StatusClosed`），完成
- **current**：步骤正在处理（`StatusInProgress`），用户"在这里"
- **ready**：步骤未被阻塞，可以开始
- **blocked**：步骤被其他未完成步骤阻塞
- **pending**：步骤当前不可开始，但不是因为被阻塞（可能是延迟执行等）

### ContinueResult

用于工作流自动推进的结果：

```go
type ContinueResult struct {
    ClosedStep   *types.Issue // 刚刚关闭的步骤
    NextStep     *types.Issue // 下一个可以开始的步骤
    AutoAdvanced bool         // 是否已自动claimed（标记为 in_progress）
    MolComplete  bool         // 分子是否已完成
    MoleculeID   string       // 分子 ID
}
```

---

## 关键算法：依赖可达性判断

模块使用 `analyzeMoleculeParallel()` 函数来确定哪些步骤是"就绪"的。这个函数的核心逻辑值得深入理解：

### 依赖类型处理

系统支持三种依赖类型影响步骤就绪状态：

1. **`DepBlocks`**：常规阻塞依赖。A blocks B 意味着 B 必须等 A 完成
2. **`DepConditionalBlocks`**：条件阻塞。如"on_failure"只在失败时阻塞
3. **`DepWaitsFor`**：等待门控。等待所有子问题（或任意子问题）完成

### 阻塞深度计算

为了支持并行分析，函数计算每个步骤的"阻塞深度"：

```
depth(step) = max(depth(blocker)) + 1，其中 blocker 是所有未关闭的阻塞步骤
```

具有相同深度的步骤理论上可以并行执行——它们都只依赖于更浅深度的步骤。

### 关键设计决策

**为什么使用 `analyzeMoleculeParallel` 而非 `GetReadyWork`？**

在代码中有这样一条注释：
```go
// Uses analyzeMoleculeParallel instead of GetReadyWork because GetReadyWork
// excludes ephemeral issues (wisp steps are ephemeral by definition).
// See: https://github.com/steveyegge/gastown/issues/1276
```

这是一个重要的设计决策。`GetReadyWork` 是通用查询，会过滤掉 `Ephemeral=true` 的问题。但分子中的某些步骤是临时存在的（比如某些 wisp 步骤），进度追踪需要看到完整画面才能正确判断依赖关系。

---

## 大型分子优化

### LargeMoleculeThreshold

代码中定义了常量：
```go
const LargeMoleculeThreshold = 100
```

当分子步骤数超过 100 时，系统采取以下优化：

1. **默认显示摘要**：不加载完整子图，只调用轻量级的 `GetMoleculeProgress()` 获取统计信息
2. **提示分页**：告诉用户使用 `--limit N` 或 `--range start-end` 查看具体步骤
3. **保留直接查询**：用户可以显式指定 `--limit` 或 `--range` 绕过摘要模式

这种"快慢路径"设计是典型的优化模式：默认行为是安全的（不会因为大分子卡死），但保留了灵活性让高级用户直接访问细节。

---

## 特殊发现逻辑：findHookedMolecules

除了常规的"通过 in_progress 步骤找分子"，模块还有一个 fallback 逻辑用于处理 **bonded 分子**（通过 `bd mol bond` 绑定的分子）：

```go
// This is a fallback when no in_progress steps exist but a molecule is attached
// to the agent's hooked work via a "blocks" dependency.
```

这个函数处理一种边缘情况：用户没有正在处理的步骤，但有一个"挂起"（hooked）的问题，而该问题通过 `blocks` 依赖关联到一个分子根。这种情况出现在 patrol 等自动化的分子工作流中。

---

## 设计权衡分析

### 1. 同步 vs 异步状态计算

**选择**：同步计算。每次调用 `getMoleculeProgress` 时都会重新遍历依赖图。

**权衡**：
- **优点**：简单、无状态、不会有过期数据问题
- **缺点**：对于非常大的分子，每次查看进度都较慢

**适合场景**：分子通常在几十到几百个步骤，同步计算足够快。如果存在数万步骤的巨型分子，可能需要引入缓存层。

### 2. 内聚 vs 解耦

**选择**：将进度追踪逻辑集中在一个文件，但复用了 `analyzeMoleculeParallel`（来自 mol_show.go）。

**权衡**：
- **优点**：进度相关逻辑集中，便于维护
- **复用**：并行分析逻辑只需要维护一份
- **耦合风险**：如果 `TemplateSubgraph` 结构变化，需要同步更新两处

### 3. 边界处理：显式 vs 隐式

**选择**：显式处理多种边缘情况（large molecules、hooked molecules）。

**权衡**：
- **优点**：用户遇到边界情况时有良好体验
- **缺点**：代码复杂度增加，需要理解各种 fallback 路径

---

## 依赖关系

### 被依赖

这个模块被以下组件调用：

- **CLI 命令**：`bd mol current`（来自 `mol_current.go` 中的 `molCurrentCmd`）
- **自动推进逻辑**：`update.go` 中关闭问题后可能调用 `AdvanceToNextStep`

### 依赖

模块依赖以下组件：

- **存储层**：`DoltStore` - 获取问题、依赖、搜索结果
- **类型定义**：`types.Issue`、`types.IssueFilter`、`types.MoleculeProgressStats`
- **工具函数**：`utils.ResolvePartialID` - ID 部分匹配解析
- **UI 渲染**：`ui.RenderPass`、`ui.RenderWarn` 等 - 终端输出着色

---

## 使用指南

### 基本用法

```bash
# 查看当前分子进度
bd mol current

# 查看指定分子
bd mol current bd-abc123

# 查看特定用户的分子
bd mol current --for claude

# 查看特定范围（适合大型分子）
bd mol current bd-abc123 --range 50-100

# 限制显示步骤数
bd mol current bd-abc123 --limit 20

# JSON 输出（适合脚本集成）
bd mol current bd-abc123 --json
```

### 状态输出说明

输出中每个步骤前有状态标记：
- `[done]` - 已完成
- `[current]` - 正在处理（你在这里）
- `[ready]` - 可以开始
- `[blocked]` - 被其他步骤阻塞
- `[pending]` - 等待中

---

## 潜在陷阱与注意事项

### 1. 根问题被排除

计算 `Total` 时使用 `len(subgraph.Issues) - 1`，排除了根问题（分子本身）。这意味着如果一个分子有 1 个根 + 99 个步骤，`Total` 显示为 99。

### 2. 临时问题可能影响进度

虽然使用 `analyzeMoleculeParallel` 而非 `GetReadyWork` 是有意的设计，但如果临时步骤形成关键路径，它们会影响"ready"状态的判断。这在大多数情况下是正确的行为，但如果你发现某个步骤应该 ready 但显示为 blocked，检查它是否依赖了某个已关闭的临时步骤。

### 3. 循环依赖不会在这个模块中检测

依赖图的循环检测在存储层完成。如果存在循环依赖，`analyzeMoleculeParallel` 可能陷入无限循环或产生错误结果。在实际使用中应确保分子模板没有循环依赖。

### 4. 延迟执行问题

带有 `defer_until` 的步骤在达到指定时间前不会显示为 ready，即使它们的依赖都已满足。这是正确的行为，因为时间条件也是依赖的一部分。

---

## 相关文档

- [MOLECULES.md](../MOLECULES.md) - 分子系统的整体介绍
- [molecule_progress_and_dispatch-ready_work_query.md](molecule_progress_and_dispatch-ready_work_query.md) - 可开始工作查询
- [molecule_progress_and_dispatch-gate_discovery.md](molecule_progress_and_dispatch-gate_discovery.md) - 门控发现机制
- [cmd-bd-template.md](cmd-bd-template.md) - 模板系统（包括分子实例化）