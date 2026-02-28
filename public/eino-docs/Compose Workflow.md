# Compose Workflow 模块深度解析

## 1. 模块概述：解决的核心问题

`Compose Workflow` 是一个高级工作流编排框架，它的出现是为了解决直接使用 [Compose Graph Engine](Compose_Graph_Engine.md) 时面临的复杂性问题。

### 1.1 问题空间

在构建复杂的 AI 应用时，我们经常需要将多个组件（如聊天模型、提示模板、工具调用、检索器等）组合成一个完整的处理管道。直接使用 Graph 来构建这些管道会面临几个痛点：

1. **边管理的复杂性**：需要手动添加节点之间的边，不仅要考虑数据流向，还要考虑执行顺序
2. **数据映射的繁琐**：需要编写大量的胶水代码来处理节点间的数据格式转换
3. **错误处理困难**：手动管理的依赖关系容易出现循环依赖、缺失依赖等问题
4. **可读性差**：直接操作图的代码很难直观表达业务逻辑

想象一下，您需要构建一个"提问→检索→总结"的管道：
- 直接用 Graph：您需要手动添加三条边，处理数据从输入到检索器、检索器到总结模型、总结模型到输出的流动
- 用 Workflow：您只需声明"检索器需要提问的数据，总结模型需要检索器的结果"，剩下的都由框架处理

这就是 Workflow 存在的意义：它让开发者专注于"要做什么"，而不是"怎么做"。

### 1.2 模块定位

Workflow 位于整个 Compose 技术栈的**上层**：
- 底层：[Compose Graph Engine](Compose_Graph_Engine.md) 提供图执行能力
- 中间层：各种组件接口和实现
- 上层：Workflow 提供声明式的工作流编排

它的角色类似于一个"智能编译器"，将开发者的声明式描述转换为底层可执行的图结构。

## 2. 架构设计与心智模型

### 2.1 核心心智模型

理解 Workflow 的最佳方式是将其想象成一个**智能的管道系统**：

- **节点**是管道上的各种处理设备（过滤器、加热器、混合器等）
- **依赖声明**是告诉系统"设备 A 必须在设备 B 之前运行，而且设备 B 需要设备 A 的输出"
- **字段映射**是告诉系统"如何将设备 A 的输出连接到设备 B 的输入"
- **编译过程**是系统自动规划整个管道布局，确保所有设备按正确顺序连接

这种设计的核心理念是：**开发者描述关系，系统管理实现**。

### 2.2 核心组件架构

Workflow 的架构采用了清晰的分层设计：

```
┌─────────────────────────────────────────────────────────┐
│                      用户 API 层                           │
│  Workflow, WorkflowNode, ChainBranch, Parallel           │
└──────────────────────┬──────────────────────────────────┘
                       │ 声明关系
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   关系管理层                               │
│  依赖管理、字段映射、静态值设置                             │
└──────────────────────┬──────────────────────────────────┘
                       │ 转换
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  底层图执行层                              │
│              Compose Graph Engine                        │
└─────────────────────────────────────────────────────────┘
```

### 2.3 数据流向深度解析

让我们通过一个具体例子来追踪数据流向：

假设我们要构建一个"用户提问→检索相关文档→用文档内容回答问题"的工作流：

1. **节点创建阶段**：
   - 创建提示模板节点：将用户提问和检索到的文档组合成提示
   - 创建检索器节点：根据用户提问检索相关文档
   - 创建聊天模型节点：根据组合好的提示生成回答

2. **依赖声明阶段**：
   ```go
   promptNode.AddInput("input") // 提示模板需要工作流输入（用户提问）
   retrieverNode.AddInput("input") // 检索器也需要用户提问
   promptNode.AddInput("retriever") // 提示模板还需要检索器的结果
   modelNode.AddInput("prompt") // 模型需要提示模板的输出
   wf.End().AddInput("model") // 工作流输出是模型的结果
   ```

3. **编译阶段**：
   - Workflow 分析所有依赖关系
   - 构建依赖图，确保没有循环
   - 自动添加必要的边和数据处理器
   - 生成可执行的图结构

4. **执行阶段**：
   - 输入数据进入工作流
   - 同时分发给提示模板节点和检索器节点
   - 检索器完成后，结果发送给提示模板节点
   - 提示模板组合好所有数据后发送给模型
   - 模型生成答案，作为工作流输出

### 2.4 关键设计模式

Workflow 模块中采用了几个重要的设计模式：

1. **构建器模式**：通过链式调用逐步构建工作流
2. **声明式 API**：描述"要什么"而不是"怎么做"
3. **延迟执行**：所有的边和依赖都在编译阶段才真正创建
4. **封装底层复杂性**：将 Graph 的复杂性完全隐藏起来

## 3. 核心组件深度解析

### 3.1 Workflow：工作流的编排者

`Workflow` 是整个模块的核心，它扮演着"智能编译器"的角色，将开发者的声明式描述转换为可执行的图。

```go
type Workflow[I, O any] struct {
    g                *graph
    workflowNodes    map[string]*WorkflowNode
    workflowBranches []*WorkflowBranch
    dependencies     map[string]map[string]dependencyType
}
```

**设计意图分析**：

1. **泛型设计**：`I` 和 `O` 类型参数提供了编译时类型安全，这是一个重要的设计决策。
   - **为什么选择泛型**：虽然增加了 API 的复杂性，但带来了类型安全，避免了运行时的类型断言错误。
   - **权衡**：牺牲了一些灵活性（不能动态改变输入输出类型），但换来了可靠性和开发体验。

2. **延迟执行策略**：注意到 `workflowNodes` 和 `addInputs` 的设计，所有的边和依赖都不是立即创建的，而是存储起来在编译阶段处理。
   - **为什么这样设计**：允许开发者以任意顺序添加节点和依赖，最后统一处理和验证。
   - **类比**：就像写文章时，可以先写下所有想法，然后再组织逻辑结构。

3. **依赖类型追踪**：`dependencies` 字段追踪每个节点的依赖类型（正常依赖、无直接依赖、分支依赖）。
   - **为什么需要这个**：不同的依赖类型在编译和执行时有不同的处理逻辑，特别是在分支场景中。

### 3.2 WorkflowNode：工作流的基本构建块

`WorkflowNode` 代表工作流中的一个节点，但它不是直接执行的节点，而是一个"节点构建器"。

```go
type WorkflowNode struct {
    g                *graph
    key              string
    addInputs        []func() error
    staticValues     map[string]any
    dependencySetter func(fromNodeKey string, typ dependencyType)
    mappedFieldPath  map[string]any
}
```

**内部机制解析**：

1. **延迟添加的输入**：`addInputs` 是一个函数切片，每个函数代表一个待处理的输入关系。
   - **为什么用函数而不是直接存储数据**：因为添加输入时可能还没有足够的上下文来验证和处理，延迟到编译阶段可以确保所有信息都可用。

2. **字段映射冲突检测**：`mappedFieldPath` 用于跟踪已映射的字段路径，防止冲突。
   - **实现原理**：它使用嵌套的 map 结构来表示字段路径，当检测到某个路径既是中间节点又是终端节点时，就会报错。
   - **为什么需要这个**：防止数据映射的歧义，例如不能同时将整个对象和对象的某个字段映射到同一个目标。

3. **依赖设置回调**：`dependencySetter` 是一个函数，它将依赖关系通知给父 Workflow。
   - **设计模式**：这是一个典型的回调模式，允许节点在不知道 Workflow 内部结构的情况下更新其状态。

### 3.3 ChainBranch：条件执行的抽象

`ChainBranch` 允许在工作流中创建条件分支，它是对 GraphBranch 的高级封装。

```go
type ChainBranch struct {
    internalBranch *GraphBranch
    key2BranchNode map[string]nodeOptionsPair
    err            error
}
```

**设计特点**：

1. **错误收集**：注意到 `err` 字段，ChainBranch 会收集构建过程中的错误，而不是立即返回。
   - **为什么这样设计**：允许链式调用，即使中间出现错误也能继续构建，最后统一检查。
   - **权衡**：可能会让开发者忽略错误，但提高了 API 的流畅性。

2. **与 Workflow 分支的差异**：
   - Graph 的分支：自动将输入传递给选中的节点
   - Workflow 的分支：不会自动传递输入，分支的结束节点需要自己定义字段映射
   - **为什么有这个差异**：为了更灵活的数据流动，避免不必要的数据拷贝，同时让每个分支路径更独立。

### 3.4 Parallel：并行执行的抽象

`Parallel` 支持多个节点并行执行，提高处理效率。

```go
type Parallel struct {
    nodes      []nodeOptionsPair
    outputKeys map[string]bool
    err        error
}
```

**设计解析**：

1. **输出键管理**：`outputKeys` 用于确保每个并行节点有唯一的输出键。
   - **为什么需要唯一键**：因为所有并行节点的输出会被收集到一个 map 中，需要键来区分不同节点的输出。

2. **与 Chain 的集成**：Parallel 设计为可以在 Chain 中使用，通过 `AppendParallel` 方法。
   - **设计模式**：这是一个组合模式的例子，Parallel 可以作为 Chain 中的一个步骤。

## 4. 关键设计决策与权衡

Workflow 模块的设计充满了深思熟虑的权衡，让我们深入分析几个关键决策。

### 4.1 依赖声明 vs 显式边：为什么选择声明式？

这是 Workflow 最根本的设计决策，它决定了整个 API 的风格。

**选择：依赖声明**

```go
// 声明式风格
modelNode.AddInput("promptNode") // 模型节点需要提示节点的输出
```

**替代方案：显式边**

```go
// 命令式风格
wf.AddEdge("promptNode", "modelNode") // 显式添加一条边
```

**决策分析**：

1. **认知模型匹配**：
   - 依赖声明更符合人类的思维方式："我需要什么" vs "我要连接什么"
   - 对于复杂的工作流，认知负担显著降低

2. **关注点分离**：
   - 依赖声明将"需要什么数据"和"如何执行"分开
   - 系统可以自动优化执行顺序，开发者不需要关心

3. **权衡**：
   - **失去的**：直接控制边的灵活性，在某些极端情况下可能不够用
   - **得到的**：更简洁的 API，更少的错误，更好的可读性

**类比**：这就像 SQL 和 NoSQL 的区别——SQL 让你声明"要什么数据"，系统决定"如何获取"；而 NoSQL 让你更多地控制"如何获取"。

### 4.2 字段映射机制：为什么不直接传递整个对象？

Workflow 实现了强大的字段映射机制，而不是简单地在节点间传递整个对象。

**设计选择**：

```go
// 字段级别的映射
node.AddInput("userNode", MapFields("user.name", "displayName"))

// 或者整个对象
node.AddInput("dataNode")
```

**决策分析**：

1. **数据封装**：
   - 节点只接收它需要的数据，而不是整个对象
   - 这遵循了"最小知识原则"，减少了节点间的耦合

2. **灵活性**：
   - 可以从多个源收集数据，合并到一个节点的输入中
   - 可以重命名字段，适配不同节点的预期输入格式

3. **静态值支持**：
   - 可以在编译时设置某些字段的值，而不需要一个专门的节点
   - 这对于配置类的数据特别有用

4. **权衡**：
   - **增加的复杂性**：需要实现字段映射和冲突检测逻辑
   - **性能考虑**：字段映射有运行时开销，但通常可以忽略

### 4.3 分支设计：为什么不自动传递输入？

Workflow 的分支设计与 Graph 的分支有一个关键区别：Workflow 的分支不会自动将输入传递给选中的节点。

**Graph 的分支**：
```go
// Graph 分支自动将输入传递给选中的节点
graph.AddBranch("decider", branch)
```

**Workflow 的分支**：
```go
// Workflow 分支需要手动设置字段映射
wf.AddBranch("decider", branch)
// 分支内的节点需要自己声明依赖
branchNode.AddInput("someOtherNode")
```

**决策分析**：

1. **数据流动的明确性**：
   - 每个节点的数据来源都显式声明，没有隐式的传递
   - 这使得工作流更易理解和调试

2. **灵活性**：
   - 分支节点可以从任何节点获取数据，不仅限于分支输入
   - 不同的分支路径可以有完全不同的数据来源

3. **无直接依赖选项**：
   - `WithNoDirectDependency()` 选项解决了分支场景下的特殊需求
   - 它允许创建数据映射，但不创建直接的执行依赖，让分支处理执行顺序

4. **权衡**：
   - **增加的代码量**：需要更多的代码来设置字段映射
   - **减少的魔法**：没有"自动"的数据传递，一切都是显式的

### 4.4 泛型设计：类型安全 vs 灵活性

Workflow 使用泛型来提供类型安全，这是一个重要的设计决策。

**设计选择**：
```go
wf := compose.NewWorkflow[string, string]() // 输入和输出都是 string
```

**决策分析**：

1. **编译时类型检查**：
   - 类型错误在编译时就能发现，而不是运行时
   - 这提高了可靠性，减少了调试时间

2. **API 文档自描述**：
   - 类型参数本身就是文档，清楚地表明了工作流的输入输出类型
   - IDE 可以提供更好的自动完成和类型提示

3. **权衡**：
   - **失去的灵活性**：不能动态改变工作流的输入输出类型
   - **增加的 API 复杂性**：泛型使 API 看起来更复杂，特别是对于不熟悉泛型的开发者

### 4.5 延迟执行：为什么不立即创建边？

Workflow 使用延迟执行策略，所有的边和依赖都在编译阶段才真正创建。

**设计选择**：
```go
// 这些调用只是记录意图，不立即创建边
node.AddInput("otherNode")
// 直到编译时才真正创建边
runnable, err := wf.Compile(ctx)
```

**决策分析**：

1. **任意顺序的声明**：
   - 开发者可以按任意顺序添加节点和依赖，不需要先创建依赖的节点
   - 这提高了开发体验，减少了顺序相关的错误

2. **统一验证**：
   - 所有的依赖关系可以一起验证，更容易发现循环依赖、缺失依赖等问题
   - 可以进行全局优化，如确定最佳的执行顺序

3. **错误处理**：
   - 所有错误集中在编译阶段处理，而不是分散在构建过程中
   - 更容易提供完整、清晰的错误信息

4. **权衡**：
   - **内存使用**：需要存储所有的中间状态，直到编译
   - **错误发现时机**：某些错误可能要到编译时才发现，而不是立即发现

## 5. 实用指南与常见模式

### 5.1 基本工作流构建

让我们通过一个真实的例子来展示如何构建一个完整的 RAG（检索增强生成）工作流：

```go
// 创建一个 RAG 工作流，输入是用户问题，输出是回答
wf := compose.NewWorkflow[string, string]()

// 1. 添加节点
// 检索器：根据用户问题检索相关文档
retrieverNode := wf.AddRetrieverNode("retriever", myRetriever)
// 提示模板：将用户问题和检索结果组合成提示
promptNode := wf.AddChatTemplateNode("prompt", ragPromptTemplate)
// 聊天模型：根据提示生成回答
modelNode := wf.AddChatModelNode("model", myChatModel)

// 2. 设置依赖关系
// 检索器需要用户问题
retrieverNode.AddInput("input")
// 提示模板需要用户问题和检索结果
promptNode.AddInput("input")
promptNode.AddInput("retriever", MapFields("documents", "context"))
// 模型需要提示
modelNode.AddInput("prompt")
// 工作流输出是模型的结果
wf.End().AddInput("model")

// 3. 编译并运行
runnable, err := wf.Compile(ctx)
if err != nil {
    log.Fatalf("Failed to compile workflow: %v", err)
}

answer, err := runnable.Invoke(ctx, "什么是 RAG？")
```

### 5.2 高级：带分支的工作流

在更复杂的场景中，我们可能需要根据条件选择不同的处理路径：

```go
wf := compose.NewWorkflow[string, string]()

// 添加一个决策节点，用于判断用户问题类型
classifierNode := wf.AddLambdaNode("classifier", 
    compose.InvokeLambda(func(ctx context.Context, question string) (string, error) {
        if strings.Contains(question, "代码") || strings.Contains(question, "编程") {
            return "coding", nil
        }
        return "general", nil
    }))

// 创建分支
branch := compose.NewChainBranch(func(ctx context.Context, questionType string) (string, error) {
    return questionType, nil
})

// 添加分支路径
// 编程问题路径
codingPrompt := wf.AddChatTemplateNode("coding_prompt", codingPromptTemplate)
codingModel := wf.AddChatModelNode("coding_model", codingSpecializedModel)
codingPrompt.AddInput("input")
codingModel.AddInput("coding_prompt")
branch.AddChatTemplate("coding", codingPromptTemplate)

// 通用问题路径
generalPrompt := wf.AddChatTemplateNode("general_prompt", generalPromptTemplate)
generalModel := wf.AddChatModelNode("general_model", generalModel)
generalPrompt.AddInput("input")
generalModel.AddInput("general_prompt")
branch.AddChatTemplate("general", generalPromptTemplate)

// 添加分支到工作流
wf.AddBranch("classifier", branch)

// 分支节点需要从其他节点获取数据时，使用 WithNoDirectDependency
// 因为分支本身会处理执行顺序
codingPrompt.AddInputWithOptions("input", nil, compose.WithNoDirectDependency())

// 设置输出
wf.End().AddInput("coding_model")
wf.End().AddInput("general_model")
```

### 5.3 静态值的使用

静态值是一个强大但经常被忽视的功能，它允许我们在编译时设置某些值：

```go
wf := compose.NewWorkflow[string, string]()

promptNode := wf.AddChatTemplateNode("prompt", myPromptTemplate)

// 设置静态值，这些值在工作流执行时保持不变
promptNode.SetStaticValue(FieldPath{"system_prompt"}, "你是一个乐于助人的 AI 助手。")
promptNode.SetStaticValue(FieldPath{"temperature"}, 0.7)

// 动态值仍然可以从其他节点获取
promptNode.AddInput("input")
```

### 5.4 并行执行模式

Parallel 允许我们同时执行多个节点，然后收集它们的输出：

```go
// 创建并行对象
parallel := compose.NewParallel()

// 添加并行节点
parallel.AddChatModel("sentiment", sentimentModel) // 分析情感
parallel.AddChatModel("topic", topicModel)         // 提取主题
parallel.AddChatModel("summary", summaryModel)     // 生成摘要

// 在工作流中使用并行
// 注意：Parallel 设计为在 Chain 中使用，但也可以通过 AddGraphNode 在 Workflow 中使用
chain := compose.NewChain[string, map[string]any]()
chain.AppendParallel(parallel)

// 然后将 chain 作为一个节点添加到 Workflow 中
wf.AddGraphNode("analysis", chain)
```

## 6. 陷阱与注意事项

在使用 Workflow 时，有一些常见的陷阱和非明显的行为需要注意。

### 6.1 分支场景的注意事项

分支是最容易出错的地方之一，特别是在处理跨分支数据访问时：

**常见错误**：
```go
// 错误：在分支场景中没有使用 WithNoDirectDependency
branchNode.AddInput("nodeFromAnotherBranch")
```

**正确做法**：
```go
// 正确：在分支场景中使用 WithNoDirectDependency
branchNode.AddInputWithOptions("nodeFromAnotherBranch", mappings, compose.WithNoDirectDependency())
```

**为什么重要**：
- 如果不使用 `WithNoDirectDependency()`，可能会创建绕过分支的直接依赖
- 这会导致执行顺序不正确，或者分支条件被忽略
- 使用这个选项可以确保分支控制执行顺序，同时仍然允许数据流动

### 6.2 字段映射冲突

字段映射冲突是另一个常见问题，特别是在复杂的工作流中：

**冲突示例**：
```go
// 错误：同时映射整个对象和对象的字段
node.AddInput("userNode") // 映射整个用户对象
node.AddInput("userNode", MapFields("user.name", "userName")) // 又映射用户名字段
```

**为什么会冲突**：
- 第一种映射告诉系统"将整个用户对象映射到目标"
- 第二种映射告诉系统"将用户名字段映射到目标的 userName 字段"
- 这两种映射是冲突的，因为目标位置有重叠

**如何避免**：
- 明确你是想映射整个对象还是特定字段
- 如果需要多个字段，可以分别映射它们，而不是映射整个对象

### 6.3 循环依赖

Workflow 不支持循环依赖，这是设计决定：

**循环依赖示例**：
```go
// 错误：循环依赖
nodeA.AddInput("nodeB")
nodeB.AddInput("nodeA")
```

**为什么不支持**：
- Workflow 内部使用 `NodeTriggerMode(AllPredecessor)`，这意味着节点等待所有前驱完成
- 循环依赖会导致死锁，因为两个节点互相等待
- 从概念上讲，工作流应该是一个有向无环图（DAG）

**如何解决**：
- 重新设计工作流，打破循环
- 如果需要迭代处理，考虑使用其他机制，如外部循环或检查点

### 6.4 静态值与动态值的交互

静态值和动态值可以一起使用，但有一些注意事项：

**注意事项**：
```go
// 设置静态值
node.SetStaticValue(FieldPath{"config", "temperature"}, 0.7)

// 尝试从动态源映射相同的路径 - 这会冲突！
node.AddInput("configNode", MapFields("temperature", "config.temperature"))
```

**最佳实践**：
- 明确哪些值是静态的，哪些是动态的
- 避免静态值和动态值映射到相同的路径
- 如果确实需要覆盖静态值，可以考虑使用 Lambda 节点来处理

### 6.5 类型安全的边界

虽然泛型提供了类型安全，但它有边界：

**注意事项**：
```go
// 编译时类型检查只适用于工作流的输入和输出
wf := compose.NewWorkflow[string, string]()

// 但节点之间的数据传递仍然是 interface{}，在运行时进行类型断言
// 这意味着如果字段映射错误，可能在运行时才发现
node.AddInput("otherNode", MapFields("non_existent_field", "target"))
```

**如何缓解**：
- 编写单元测试，覆盖工作流的所有路径
- 使用有意义的字段名，减少拼写错误
- 考虑为复杂的数据结构创建类型安全的映射函数

## 7. 性能考虑

虽然 Workflow 提供了很多便利，但也有一些性能方面的考虑：

### 7.1 字段映射的开销

字段映射在运行时有一定的开销，特别是在处理大数据结构时：

**优化建议**：
- 只映射实际需要的字段，而不是整个对象
- 考虑使用 Lambda 节点来处理复杂的数据转换
- 对于性能关键路径，可以使用 Graph 直接控制

### 7.2 并行执行的开销

Parallel 提供了便利的并行执行，但也有一些开销：

**注意事项**：
- 并行执行不是免费的，有协调和同步的开销
- 对于非常快的节点，并行执行可能反而更慢
- 确保并行执行的节点有足够的工作量，以抵消协调开销

**最佳实践**：
- 对 IO 密集型操作（如模型调用、检索）使用并行
- 对 CPU 密集型但快速的操作（如简单的数据转换）考虑串行执行
- 测试和测量，确保并行确实提高了性能

## 8. 模块关系与依赖

Workflow 模块不是孤立的，它与整个 Compose 生态系统中的其他模块紧密协作。

### 8.1 与 Compose Graph Engine 的关系

这是最重要的依赖关系，Workflow 本质上是 Graph Engine 的高级包装器：

```
┌─────────────────────────────────────────┐
│   Compose Workflow (声明式 API)         │
│  - 依赖声明                              │
│  - 字段映射                              │
│  - 分支处理                              │
└──────────────┬──────────────────────────┘
               │ 编译
               ▼
┌─────────────────────────────────────────┐
│   Compose Graph Engine (执行引擎)       │
│  - 节点执行                              │
│  - 数据传递                              │
│  - 并发控制                              │
└─────────────────────────────────────────┘
```

**关键点**：
- Workflow 负责"用户友好的 API"
- Graph Engine 负责"实际的执行"
- 两者通过 `Compile` 方法连接

### 8.2 与其他模块的依赖

Workflow 模块还依赖以下模块：

1. **[Component Interfaces](Component_Interfaces.md)**：
   - 定义了各种组件的接口（ChatModel, Retriever 等）
   - Workflow 使用这些接口来添加不同类型的节点

2. **[Schema Core Types](Schema_Core_Types.md)**：
   - 提供核心数据结构定义
   - 用于节点间的数据传递

3. **[Compose Tool Node](Compose_Tool_Node.md)**：
   - 提供工具节点的实现
   - 可以通过 `AddToolsNode` 方法添加到工作流中

### 8.3 数据流转

整个数据流转可以概括为：

1. **输入阶段**：Workflow 接收类型安全的输入
2. **编译阶段**：Workflow 将声明式描述转换为 Graph
3. **执行阶段**：Graph Engine 执行实际的处理
4. **输出阶段**：Workflow 返回类型安全的输出

## 9. 总结与最佳实践

Workflow 模块是一个强大的工具，但要充分利用它，需要遵循一些最佳实践：

### 9.1 何时使用 Workflow

**适合使用 Workflow 的场景**：
- 构建复杂的多步骤处理管道
- 需要灵活的数据映射和转换
- 希望代码更易读、更易维护
- 需要条件分支或并行执行

**考虑使用 Graph 的场景**：
- 需要极其精细的控制
- 性能关键路径，需要最小化开销
- 需要循环或更复杂的控制流

### 9.2 最佳实践

1. **从小处开始**：
   - 先构建简单的线性工作流
   - 逐步添加分支、并行等复杂结构

2. **明确依赖关系**：
   - 让每个节点的依赖关系尽可能明确
   - 避免过度使用 `WithNoDirectDependency()`，除非确实需要

3. **合理使用静态值**：
   - 对于不变的配置，使用静态值
   - 避免过度使用，保持工作流的灵活性

4. **测试工作流**：
   - 为工作流编写单元测试
   - 测试所有分支路径
   - 验证错误处理

5. **文档化工作流**：
   - 为复杂的工作流添加注释
   - 说明每个节点的作用
   - 记录设计决策和权衡

### 9.3 最终思考

Workflow 模块体现了一个重要的设计理念：**让简单的事情保持简单，让复杂的事情成为可能**。

它通过提供声明式的 API，隐藏了底层图执行的复杂性，让开发者可以专注于业务逻辑。同时，它也保留了足够的灵活性，通过选项和低级 API 来处理复杂场景。

当你使用 Workflow 时，记住：
- 利用它的抽象能力，但不要忘记理解底层原理
- 遵循最佳实践，但不要被它们束缚
- 始终关注代码的可读性和可维护性

希望这份文档能帮助你更好地理解和使用 Compose Workflow 模块！

## 子模块与相关文档

### 详细子模块文档

- [chain_branch](chain_branch.md)：ChainBranch 模块，专门为链式工作流设计的条件分支结构
- [parallel_execution](parallel_execution.md)：Parallel 执行模块，用于定义和管理并行执行的节点组

### 相关模块文档

- [Compose Graph Engine](Compose_Graph_Engine.md)：提供 Workflow 底层的图实现
- [Compose Tool Node](Compose_Tool_Node.md)：提供工具节点的实现
- [Compose Checkpoint](Compose_Checkpoint.md)：提供检查点机制，支持工作流的中断和恢复
- [Component Interfaces](Component_Interfaces.md)：定义了各种组件的接口
- [Schema Core Types](Schema_Core_Types.md)：提供核心数据结构定义
