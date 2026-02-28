# Bond Polymorphic Orchestration 模块深度解析

## 1. 问题空间与设计意图

想象一下，你正在管理一个复杂的软件项目，需要将不同的工作单元组合起来：有时你想把两个预定义的工作流程模板合并成一个新模板；有时你需要将一个模板实例化并附加到正在进行的工作流中；有时你只是想把两个正在进行的任务连接起来。这就是 `bond_polymorphic_orchestration` 模块要解决的核心问题。

### 为什么需要这个模块？

在项目管理和工作流自动化中，我们经常遇到以下场景：
- **模板组合**：将两个工作流模板（protos）合并成一个更复杂的模板
- **模板实例化**：将一个模板实例化并附加到现有的工作流（molecule）中
- **工作流连接**：将两个正在进行的工作流连接起来，形成一个更大的工作流

一个简单的解决方案是为每种情况编写单独的命令，但这样会导致代码重复和用户界面不一致。`bond_polymorphic_orchestration` 模块通过**多态设计**，用一个统一的 `bond` 命令处理所有这些场景，同时保持了灵活性和表达力。

## 2. 核心心智模型

### 关键抽象

这个模块的核心是**多态调度**的概念，我们可以将其想象为一个"智能连接器"：

1. **操作数类型检测**：首先确定两个操作数的类型（proto 或 molecule）
2. **策略选择**：根据操作数类型组合选择相应的 bonding 策略
3. **执行与适配**：执行选定的策略，并根据用户提供的选项进行适配

### 类比：乐高积木拼接

你可以把这个模块想象成一个智能的乐高积木拼接器：
- **Protos** 是预定义的积木套装（模板）
- **Molecules** 是已经拼好的积木结构（实例化的工作流）
- **Bonding** 是将这些积木拼接在一起的过程

拼接器会根据你提供的积木类型（是套装还是已拼好的结构）自动选择最合适的拼接方式，同时还允许你指定拼接的类型（顺序、并行、条件）和其他属性。

## 3. 架构与数据流

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                      molBondCmd                              │
│                   (Cobra Command)                            │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    runMolBond                                 │
│              (多态调度入口函数)                               │
└─────────────┬─────────────────────────┬──────────────────────┘
              │                         │
              ▼                         ▼
┌──────────────────────┐    ┌──────────────────────────┐
│ resolveOrCookToSubgraph│  │   操作数类型检测与调度     │
└──────────┬───────────┘    └───────────┬──────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐    ┌──────────────────────────┐
│  公式解析与模板加载   │    │  bondProtoProto          │
│                      │    │  bondProtoMol            │
│                      │    │  bondMolProto            │
│                      │    │  bondMolMol              │
└──────────────────────┘    └───────────┬──────────────┘
                                          │
                                          ▼
                                ┌──────────────────┐
                                │   BondResult     │
                                └──────────────────┘
```

### 数据流程详解

让我们通过一个典型的使用场景来追踪数据流：

1. **命令解析**：用户执行 `bd mol bond protoA molB --type parallel`
2. **参数验证**：`runMolBond` 验证参数和标志的有效性
3. **操作数解析**：
   - 对 `protoA`：调用 `resolveOrCookToSubgraph` 加载模板子图
   - 对 `molB`：调用 `resolveOrCookToSubgraph` 加载现有分子
4. **类型检测**：确定 `protoA` 是 proto，`molB` 是 molecule
5. **策略调度**：选择 `bondProtoMol` 策略
6. **执行策略**：
   - 加载 proto 的完整子图
   - 检查必要的变量
   - 确定 ephemeral 标志
   - 构建克隆选项
   - 调用 `spawnMoleculeWithOptions` 实例化并附加
7. **结果返回**：返回 `BondResult` 结构，包含操作结果信息

## 4. 核心组件深度解析

### 4.1 BondResult 结构

```go
type BondResult struct {
	ResultID   string            `json:"result_id"`
	ResultType string            `json:"result_type"` // "compound_proto" 或 "compound_molecule"
	BondType   string            `json:"bond_type"`
	Spawned    int               `json:"spawned,omitempty"`    // 生成的问题数量
	IDMapping  map[string]string `json:"id_mapping,omitempty"` // 旧ID到新ID的映射
}
```

**设计意图**：
- 提供统一的结果格式，无论使用哪种 bonding 策略
- 包含足够的信息供机器解析（JSON 输出）和人类阅读
- `IDMapping` 允许调用者跟踪从模板到实例的 ID 转换

### 4.2 runMolBond 函数

这是模块的核心调度函数，负责：
1. 参数解析和验证
2. 操作数解析（通过 `resolveOrCookToSubgraph`）
3. 操作数类型检测
4. 根据类型组合调度到相应的 bonding 函数

**关键设计决策**：
- 使用 `resolveOrCookToSubgraph` 统一处理 issue ID 和公式名称
- 通过类型检测实现多态调度，而不是使用接口或继承
- 支持 dry-run 模式，允许用户预览操作结果

### 4.3 四种 Bonding 策略

#### bondProtoProto：proto + proto → compound proto

**用途**：将两个模板合并成一个新的复合模板

**实现细节**：
- 创建一个新的 root issue 作为复合模板
- 添加两个原 proto 作为子项
- 根据 bond type 添加适当的依赖关系
- 始终创建持久化的模板（Ephemeral=false）

**设计权衡**：
- 选择创建新的 root issue 而不是修改现有 proto，保持了原 proto 的不变性
- 复合 proto 作为一个整体，可以像其他 proto 一样被实例化

#### bondProtoMol：proto + molecule → spawn + attach

**用途**：实例化一个模板并将其附加到现有工作流

**实现细节**：
- 加载 proto 的完整子图
- 检查必要的变量
- 根据目标 molecule 或用户标志确定 ephemeral 状态
- 使用 `spawnMoleculeWithOptions` 原子性地实例化和附加
- 支持动态 ID 生成（通过 `--ref` 标志）

**设计亮点**：
- 通过 `AttachToID` 选项确保实例化和附加在单个事务中完成
- 支持变量替换和动态 ID 生成，实现"圣诞装饰"模式

#### bondMolProto：molecule + proto → spawn + attach（对称）

**用途**：与 `bondProtoMol` 相同，但操作数顺序相反

**实现细节**：
- 简单地调用 `bondProtoMol`，交换参数顺序
- 保持 API 的对称性，提高用户体验

#### bondMolMol：molecule + molecule → compound molecule

**用途**：将两个现有工作流连接起来

**实现细节**：
- 在两个 molecule 之间创建依赖关系
- 根据 bond type 选择适当的依赖类型
- 不创建新的 issue，只是修改现有 issue 之间的关系

**设计权衡**：
- 选择修改依赖关系而不是创建新的 root issue，保持了原 molecule 的身份
- 依赖于存储层的约束（每个 (issue_id, depends_on_id) 对只能有一个依赖）

### 4.4 resolveOrCookToSubgraph 函数

**用途**：统一处理 issue ID 和公式名称，将它们解析为子图

**实现细节**：
- 首先尝试解析为 issue ID
- 如果失败，检查是否看起来像公式名称
- 如果是公式，将其内联烹饪为内存子图（不存储在数据库中）
- 返回子图和一个标志，表示是否是从公式烹饪而来

**设计亮点**：
- 实现了 gt-4v1eo 需求：公式被烹饪为内存子图，不污染数据库
- 支持步骤条件过滤（通过 vars 参数）
- 统一了 issue 和公式的处理，简化了上层逻辑

## 5. 依赖关系分析

### 5.1 核心依赖

这个模块依赖于几个关键组件：

1. **formula 包**：用于解析和烹饪公式
2. **storage 包**：特别是 `dolt.DoltStore`，用于数据持久化
3. **types 包**：提供核心数据类型，如 `Issue`、`Dependency` 等
4. **utils 包**：提供 `ResolvePartialID` 等工具函数
5. **cobra 包**：用于命令行界面

### 5.2 被依赖情况

这个模块主要被 CLI 层调用，是用户通过 `bd mol bond` 命令直接交互的接口。

### 5.3 数据契约

**输入契约**：
- 两个操作数，可以是 issue ID 或公式名称
- 各种选项标志，如 `--type`、`--ephemeral`、`--ref` 等

**输出契约**：
- `BondResult` 结构，包含操作结果信息
- 或者在错误情况下，返回相应的错误信息

## 6. 设计决策与权衡

### 6.1 多态调度 vs 接口继承

**选择**：使用类型检测和函数调度，而不是接口继承

**原因**：
- 操作数类型组合有限（只有 4 种）
- 函数调度更直观，更容易追踪和调试
- 避免了为每种类型创建单独的结构体和方法

**权衡**：
- 失去了一些面向对象的优雅
- 但获得了更好的可理解性和可维护性

### 6.2 内存子图 vs 数据库存储

**选择**：公式被烹饪为内存子图，不存储在数据库中

**原因**：
- 公式是临时的，不需要持久化
- 避免了数据库污染
- 提高了性能，避免了不必要的数据库操作

**权衡**：
- 内存子图在操作完成后就消失了
- 但这正是我们想要的行为

### 6.3 原子性操作 vs 分步操作

**选择**：使用 `AttachToID` 选项确保实例化和附加在单个事务中完成

**原因**：
- 避免了部分完成的状态
- 提高了数据一致性
- 简化了错误处理

**权衡**：
- 事务可能会更大，锁定时间更长
- 但在这个场景下，这是可以接受的

### 6.4 显式标志 vs 隐式行为

**选择**：提供显式标志（如 `--ephemeral` 和 `--pour`），同时有合理的默认行为

**原因**：
- 给用户提供了控制权
- 合理的默认行为使常见情况更简单
- 显式标志使意图更清晰

**权衡**：
- 增加了 API 的复杂性
- 但提高了灵活性和表达力

## 7. 使用指南与示例

### 7.1 基本用法

```bash
# 顺序连接两个 proto
bd mol bond protoA protoB

# 并行连接两个 molecule
bd mol bond molA molB --type parallel

# 条件连接 proto 和 molecule
bd mol bond protoA molB --type conditional
```

### 7.2 高级选项

```bash
# 使用自定义标题创建复合 proto
bd mol bond protoA protoB --as "My Compound Proto"

# 强制生成持久化的实例
bd mol bond protoA molB --pour

# 强制生成临时的实例
bd mol bond protoA molB --ephemeral

# 使用动态 ID 生成
bd mol bond protoA molB --ref "arm-{{name}}" --var name=ace
```

### 7.3 常见模式

#### 模式 1：创建复合模板

```bash
bd mol bond mol-feature mol-deploy --as "Feature + Deploy"
```

这会创建一个新的复合模板，可以像其他模板一样被实例化。

#### 模式 2：附加模板到现有工作流

```bash
bd mol bond mol-test bd-abc123 --pour
```

这会实例化 `mol-test` 模板并将其附加到 `bd-abc123` 工作流中，强制生成持久化的实例。

#### 模式 3：动态 ID 生成

```bash
bd mol bond mol-arm bd-patrol --ref "arm-{{name}}" --var name=ace
```

这会创建一个 ID 为 `bd-patrol.arm-ace` 的实例，而不是随机哈希。

## 8. 边缘情况与注意事项

### 8.1 变量替换

- 当使用 `--ref` 标志时，确保提供所有必要的变量
- 未提供的变量会导致错误
- 变量名区分大小写

### 8.2 Ephemeral 标志

- `--ephemeral` 和 `--pour` 不能同时使用
- 如果都不使用，会遵循目标的 ephemeral 状态
- Ephemeral issue 不会被导出到 JSONL

### 8.3 Bond 类型

- 顺序连接：B 在 A 完成后运行（无论结果如何）
- 条件连接：B 只在 A 失败时运行
- 并行连接：B 和 A 同时运行，没有阻塞关系

### 8.4 公式名称

- 公式名称通常以 "mol-" 开头
- 也可以是包含 ".formula" 的文件路径
- 公式被烹饪为内存子图，不会存储在数据库中

## 9. 总结

`bond_polymorphic_orchestration` 模块是一个优雅的多态设计示例，它通过统一的接口处理多种不同的 bonding 场景。它的核心优势在于：

1. **多态调度**：根据操作数类型自动选择合适的策略
2. **内存子图**：公式被烹饪为内存子图，避免数据库污染
3. **原子操作**：确保实例化和附加在单个事务中完成
4. **灵活选项**：提供丰富的选项，满足各种需求

这个模块展示了如何在保持简单性的同时实现强大的功能，是项目管理和工作流自动化领域的一个重要组成部分。
