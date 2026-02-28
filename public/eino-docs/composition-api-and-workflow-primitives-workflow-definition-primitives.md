# composition-api-and-workflow-primitives-workflow-definition-primitives

## 模块概述

`workflow_definition_primitives` 是 Eino 框架中工作流编排的核心模块，位于 `compose/workflow.go` 文件中。它提供了一套比底层图（Graph）更高层次、更声明式的 API，用于定义有向无环图（DAG）结构的工作流。**这个模块解决的问题是：如何让开发者用更直观、更流畅的方式描述节点间的依赖关系和数据流向，而不必直接处理底层边的连接。**

想象一下建造一座城市：如果说 `Graph` 是城市规划师直接绘制道路网格图，那么 `Workflow` 就是开发商使用的"需求清单"——你只需要声明"餐厅需要从供货商进货"、"顾客需要先排队点餐"，系统会自动推断出正确的执行顺序和数据流向。Workflow 模块正是这种"声明式"思维的实现。

## 核心抽象与心智模型

### 1. Workflow 的本质

`Workflow` 是对底层 `graph` 结构的**包装器（wrapper）**。它的核心思想是将"边的添加"（AddEdge）替换为更符合直觉的"依赖声明"（AddInput）和"字段映射"（Field Mapping）。

```go
// 底层 Graph 的写法
g.AddEdge("predecessor", "successor")
g.AddEdge("predecessor", END)

// Workflow 的写法
node.AddInput("predecessor")
```

这种设计体现了**最小惊讶原则**：在工作流场景中，你关心的是"数据从哪里来"，而不是"控制流如何连接"。

### 2. 关键数据结构

#### Workflow<I, O> — 工作流容器

```go
type Workflow[I, O any] struct {
    g                *graph                           // 底层图结构
    workflowNodes    map[string]*WorkflowNode         // 工作流节点的注册表
    workflowBranches []*WorkflowBranch                // 分支列表
    dependencies     map[string]map[string]dependencyType  // 依赖关系追踪
}
```

**设计意图**：`Workflow` 通过泛型参数 `<I, O>` 声明输入输出类型，这在编译期就能捕获类型不匹配的错误。与 `Graph` 的区别在于，它使用 `NodeTriggerMode(AllPredecessor)`，因此**不支持循环**——这是 DAG 特性带来的约束，也是保证执行可预测性的设计选择。

#### WorkflowNode — 节点声明对象

```go
type WorkflowNode struct {
    g                *graph
    key              string
    addInputs        []func() error              // 延迟执行的输入添加函数
    staticValues     map[string]any              // 编译期确定的静态值
    dependencySetter func(fromNodeKey string, typ dependencyType)
    mappedFieldPath  map[string]any
}
```

**设计意图**：注意 `addInputs` 字段是一个**函数切片**，而不是立即执行的逻辑。这是因为 Workflow 采用了**延迟求值（lazy evaluation）**策略：用户在定义阶段不断追加输入关系，直到 `Compile()` 时才真正执行边的添加。这种设计允许节点以任意顺序定义——你可以在定义节点 C 之后，再声明它依赖节点 A。

#### dependencyType — 依赖类型枚举

```go
const (
    normalDependency     dependencyType = iota  // 正常依赖：数据和执行顺序都依赖
    noDirectDependency                          // 非直接依赖：仅数据依赖，执行顺序通过其他路径保证
    branchDependency                            // 分支依赖：来自分支的依赖
)
```

这是模块中最微妙的概念。`normalDependency` 是最常见的情况，但 `noDirectDependency` 允许**数据流与控制流分离**——这是实现跨分支数据访问的关键。

### 3. 字段映射（Field Mapping）机制

字段映射是 Workflow 的灵魂。它定义了数据如何从一个节点的输出流向另一个节点的输入。看这个例子：

```go
node.AddInput("predecessor", MapFields("user.name", "displayName"))
```

这行代码说："从 predecessor 节点的 `user.name` 字段取值，映射到当前节点的 `displayName` 字段。" 底层机制通过 `FieldMapping` 结构实现，支持：

- **结构体字段映射**：`MapFields("fieldA", "fieldB")`
- **嵌套路径映射**：`MapFieldPaths(FieldPath{"user", "profile", "name"}, FieldPath{"display"})`
- **整个输出映射**：`FromField("fieldA")` 或 `ToField("fieldB")`
- **自定义提取器**：`WithCustomExtractor(fn)` 用于复杂的数据转换

## 数据流与执行流程

### 构建阶段（Build Phase）

```
用户代码 → NewWorkflow[I,O]()
           ↓
         AddXXXNode()     // 添加各种节点
           ↓
         node.AddInput()  // 声明依赖关系
           ↓
         .End()           // 连接终点
           ↓
         Workflow.Compile()
```

关键流程在 `Compile()` 方法中：

1. **分支处理**：遍历 `workflowBranches`，为每个分支的结束节点设置 `branchDependency`
2. **延迟执行**：遍历所有节点，执行 `addInputs` 函数切片，将声明式的输入关系转换为底层的边
3. **静态值处理**：将 `staticValues` 转换为 `handlerPair`（包含 invoke 和 transform 函数），在运行时将静态值合并到节点输入中
4. **委托编译**：最后调用 `wf.g.compile()` 完成底层的图编译

### 运行时阶段（Runtime Phase）

当编译好的 Workflow 作为 `Runnable[I, O]` 执行时：

```
输入 I
   ↓
[Graph 执行引擎 - Pregel 或 DAG 模式]
   ↓
节点 N1 → 节点 N2 → 节点 N3
   ↓        ↓          ↓
  输出1   输出2      输出3
   ↓
[字段映射器] → 应用 MapFields 转换
   ↓
输出 O
```

字段映射在运行时通过 `handlerPair` 中的 `transform` 函数应用到流式数据上，确保即使是流式输出也能正确地进行字段重命名和重组。

## 依赖关系分析

### 上游依赖：Workflow 依赖什么

Workflow 的实现严重依赖 `compose` 包中的几个核心组件：

| 依赖组件 | 作用 | 依赖原因 |
|---------|------|---------|
| `graph` 结构 | 底层 DAG 实现 | Workflow 本质上是对 graph 的高级封装 |
| `FieldMapping` | 字段映射定义 | AddInput 的核心参数类型 |
| `GraphBranch` | 分支逻辑 | AddBranch 的核心参数类型 |
| `handlerPair` | 运行时数据处理器 | 用于静态值注入和字段转换 |
| 组件接口（model, prompt, retriever 等） | 节点类型 | AddXXXNode 方法的参数 |

### 下游调用者：谁使用 Workflow

```
用户代码
    ↓
compose.NewWorkflow[I,O]()
    ↓
wf.AddXXXNode() / node.AddInput()
    ↓
wf.Compile(ctx) → Runnable[I,O]
    ↓
runnable.Invoke(ctx, input)
```

典型调用模式如 `workflow_test.go` 中所示：

```go
w := NewWorkflow[*Input, *Output]()

w.AddChatModelNode("llm", modelImpl).
    AddInput(START, FromField("query"))

w.AddLambdaNode("processor", lambdaImpl).
    AddInput("llm", MapFields("answer", "result"))

w.End().AddInput("processor")

runnable, _ := w.Compile(ctx)
result, _ := runnable.Invoke(ctx, &Input{Query: "..."})
```

## 设计决策与权衡

### 1. 延迟求值 vs 立即求值

**决策**：使用 `addInputs []func() error` 实现延迟求值。

**权衡**：
- **优点**：允许用户以任意顺序定义节点关系，后定义的节点可以引用先定义的节点，反之亦然
- **缺点**：所有错误都会延迟到 Compile 阶段才暴露，增加了调试难度

### 2. 数据流与控制流分离

**决策**：通过 `WithNoDirectDependency()` 选项允许建立"数据依赖"而不建立"执行依赖"。

**使用场景**：当跨越分支边界时，分支本身已经保证了执行顺序，此时不需要建立额外的直接依赖：

```go
// 分支场景：branchNode 之后的节点需要访问 branchNode 的数据
// 但执行顺序已经由分支机制保证
node.AddInputWithOptions("branchNode", mappings, WithNoDirectDependency())
```

**风险**：这个选项要求使用者理解图的执行语义，如果使用不当可能导致数据在节点执行时尚未准备好。

### 3. DAG 约束 vs 支持循环

**决策**：Workflow 强制使用 `AllPredecessor` 触发模式，不支持循环。

**原因**：工作流（Workflow）通常代表明确的业务流程，循环逻辑应该通过分支（Branch）的条件判断或外部循环控制来实现，而不是图内部的环。这简化了执行模型，也使得状态管理和断点续跑更容易实现。

### 4. 静态值注入

**决策**：通过 `SetStaticValue()` 在编译期注入静态配置。

**实现方式**：静态值被转换为 `handlerPair`，在运行时通过 `mergeValues` 合并到输入数据中。这种方式的优点是零运行时开销（值在编译时已确定），但限制是值必须是可序列化的。

## 使用指南与最佳实践

### 基本工作流构建模式

```go
// 1. 创建工作流，声明类型
wf := NewWorkflow[Input, Output]()

// 2. 添加节点
wf.AddChatModelNode("llm", myChatModel, WithInputKey("prompt")).
    AddInput(START, FromField("query"))

wf.AddLambdaNode("parser", ParseLambda).
    AddInput("llm", ToField("llm_output"))

// 3. 定义终点
wf.End().AddInput("parser")

// 4. 编译
runnable, err := wf.Compile(ctx)
```

### 复杂字段映射

```go
// 嵌套字段映射
node.AddInput("preprocessor", MapFieldPaths(
    FieldPath{"user", "profile", "name"},
    FieldPath{"display", "name"},
))

// 整个输出映射
node.AddInput("configLoader", ToField("config"))

// 多输入合并
node.AddInput("userLoader", FromField("user")).
      AddInput("productLoader", FromField("product"))
```

### 分支处理

```go
condition := func(ctx context.Context, in Input) (string, error) {
    if in.Amount > 100 {
        return "premium", nil
    }
    return "standard", nil
}

branch := NewGraphBranch(condition, map[string]bool{
    "premium":   true,
    "standard":  true,
})

wf.AddBranch("classifier", branch)

// 注意：Workflow 的分支不会自动传递输入
// 每个分支的结束节点需要自己定义输入映射
```

## 边缘情况与陷阱

### 1. 字段映射冲突

**问题**：同一个节点不能同时使用"整个输出映射"和"字段级映射"。

```go
// 错误示例
node.AddInput("a")                    // 整个输出作为输入
node.AddInput("b", ToField("field"))  // 再尝试添加字段映射

// 错误信息: "entire output has already been mapped"
```

**解决**：始终使用一致的映射策略。

### 2. 间接依赖的正确性

**问题**：`WithNoDirectDependency()` 依赖于图中存在其他路径连接前后节点。

```go
// 危险示例
nodeA.AddInputWithOptions("nodeB", mappings, WithNoDirectDependency())
// 但 nodeB 和 nodeA 之间没有任何其他直接依赖路径！

// 结果：数据映射会被添加，但执行顺序无法保证，可能导致运行时错误
```

**解决**：确保在使用 `WithNoDirectDependency()` 前，图中存在其他路径连接相关节点。

### 3. 循环引用检测缺失

**问题**：Workflow 本身在 `Compile` 阶段不会显式检查循环引用。

```go
// 虽然 Workflow 设计上应该是有向无环的，
// 但如果用户错误地创建了循环，错误会在底层 graph.compile() 时抛出
// 而不是更友好的 Workflow 层级提示

nodeA.AddInput("nodeB")
nodeB.AddInput("nodeA")  // 潜在循环，但错误信息可能不够直观
```

**解决**：在定义阶段就确保依赖关系是有向无环的，可以借助可视化工具检查图结构。

### 4. 分支与输入的交互

**问题**：`GraphBranch` 会自动将输入传递给选择的节点，但 `WorkflowBranch` 不会。

```go
// 在 Graph 中
branch := NewGraphBranch(condition, endNodes)
// 输入会被自动传递到选择的节点

// 在 Workflow 中
wb := wf.AddBranch("decision", branch)
// 分支不会自动传递输入，每个 endNode 必须自己定义 AddInput
```

**解决**：为分支的每个结束节点显式添加输入映射。

### 5. 静态值与字段映射的优先级

当同时存在静态值和输入映射时：

```go
node.SetStaticValue(FieldPath{"query"}, "static query")
node.AddInput("prev", MapFields("input", "query"))
```

**行为**：`mergeValues` 会合并这两个来源，但字段映射的输入会覆盖静态值。理解这一点对于调试"为什么我的静态值没生效"很重要。

## 相关文档

- [branch-and-parallel-chain-primitives](branch-and-parallel-chain-primitives.md) — 分支与并行执行的底层原语
- [field-mapping-and-value-merging](field-mapping-and-value-merging.md) — 字段映射与值合并机制详解
- [composable-graph-types-and-lambda-options](composable-graph-types-and-lambda-options.md) — 图类型与 Lambda 选项
- [graph-node-addition-options](graph-node-addition-options.md) — 节点添加选项配置