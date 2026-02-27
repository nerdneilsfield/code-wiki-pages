# task_tool_subagent_dispatch（`adk/prebuilt/deep/task_tool.go`）技术深潜

`task_tool_subagent_dispatch` 的本质，是把“一个总控 agent 如何把复杂子任务安全、可描述地转交给不同子 agent”这件事，封装成一个标准 tool。你可以把它理解成一个“任务调度前台”：主 agent 不直接知道每个子 agent 的调用细节，只需要调用一个统一的 `task` 工具，给出 `subagent_type` 和 `description`，模块就负责路由到正确的子 agent 并返回结果。没有这一层，主 agent 要么自己维护多套 tool 接口（高耦合），要么把子 agent 细节暴露给模型（更容易出错、提示词更难维护）。

---

## 1. 这个模块要解决什么问题？

在 Deep Agent 场景里，主 agent 经常会遇到“应该委托给专门角色处理”的任务，例如代码搜索、特定分析、重型多步执行。朴素做法是：把所有子 agent 都直接挂成 tools，让模型自行决定调用谁。这种方案短期可行，但会很快出现三个问题。第一，接口不统一：不同子 agent 期望的输入 JSON 结构并不一定一致，模型需要记忆多种参数模式。第二，提示词膨胀：每多一个子 agent，主 prompt 需要多解释一遍“何时用、怎么用”。第三，扩展成本高：新增或替换子 agent 会牵动 prompt、tool 注册和路由逻辑多个位置。

这个模块选择了“单一入口 + 内部路由”的设计：对模型只暴露一个 `task` 工具，对运行时内部维护 `subagent_type -> InvokableTool` 映射。模型层只做“选择角色 + 描述任务”，路由和参数适配由代码保证。这是典型的“把不稳定复杂性收进边界内”的工程手法。

---

## 2. 心智模型：把它当成“呼叫中心总机”

最容易记住的类比是呼叫中心总机。用户（主 agent）拨打统一号码（`task`），告诉总机“我要找哪个部门”（`subagent_type`）和“我要办什么事”（`description`）。总机不处理业务本身，它做三件事：校验请求格式、把请求转成部门听得懂的话、转接并返回结果。

对应到代码，`taskTool` 就是这台总机：

- `Info` 负责“对外公布总机号码和可用参数”；
- `InvokableRun` 负责“解析请求、查表路由、参数再封装、调用目标子 agent”；
- `newTaskTool` 负责“搭建可路由的子 agent 注册表”；
- `newTaskToolMiddleware` 负责“把这台总机作为 middleware 注入到主 agent”。

这套抽象的关键收益是：模型看到的是稳定接口，子 agent 生态可以在内部演进。

---

## 3. 架构与数据流

```mermaid
flowchart TD
    A[deep.New] --> B[newTaskToolMiddleware]
    B --> C[newTaskTool]
    C --> D[adk.NewChatModelAgent<br/>optional general agent]
    C --> E[adk.NewAgentTool + assertAgentTool]
    B --> F[AgentMiddleware<br/>AdditionalInstruction=taskPrompt<br/>AdditionalTools=[taskTool]]
    F --> G[主 ChatModelAgent 运行时]
    G --> H[taskTool.Info]
    G --> I[taskTool.InvokableRun]
    I --> J[subAgents map 路由并调用目标 InvokableTool]
```

从调用关系看，模块内主干非常短：`newTaskToolMiddleware -> newTaskTool`。但运行时链路很关键。`deep.New`（见 [deep_agent_composition](deep_agent_composition.md)）在构建主 agent 时调用 `newTaskToolMiddleware`，该函数先生成 `taskTool`，再返回一个 `adk.AgentMiddleware`，其中 `AdditionalInstruction` 注入 `taskPrompt`，`AdditionalTools` 注入统一 `task` 工具。

主 agent 运行时会先读取工具元信息（`Info`），模型据此构造工具调用参数；当模型触发 `task` tool call 时，执行进入 `InvokableRun`：先把 `argumentsInJSON` 反序列化为 `taskToolArgument`，再用 `SubagentType` 在映射表中查目标子 agent，随后把 `Description` 重新封装为 `{"request": "..."}`，最后把这个请求转发给被选中的 `InvokableTool`。因此，数据是“二段式变换”：模型参数协议 -> 内部统一结构 -> 子 agent 请求协议。

---

## 4. 组件深潜（逐个解释设计意图）

## `newTaskToolMiddleware(...)`

这个函数的职责不是“创建工具”，而是“把工具变成主 agent 能消费的中间件增量”。它调用 `newTaskTool` 得到 `tool.InvokableTool` 后，封装为 `adk.AgentMiddleware{ AdditionalInstruction, AdditionalTools }`。

这里的设计点在于把提示词和工具一起注入。仅注入工具，不保证模型会正确使用；仅注入提示词，又没有可执行入口。二者打包能让“认知引导”和“能力暴露”保持一致。

## `newTaskTool(...)`

这是模块最核心的装配函数，做了三步初始化：

1. 创建 `taskTool`，默认描述生成器 `descGen = defaultTaskToolDescription`；
2. 如果传入 `taskToolDescriptionGenerator`，覆盖默认描述生成逻辑；
3. 构建 `subAgents` 路由表（含可选 general subagent + 显式传入 `subAgents`）。

它的一个重要设计是 `withoutGeneralSubAgent` 开关。若不关闭，会用 `adk.NewChatModelAgent` 现场生成一个 `generalAgent`，并通过 `adk.NewAgentTool` + `assertAgentTool` 转成 `tool.InvokableTool` 放入路由表。这样即使调用方没有提供任何专门子 agent，系统仍有一个通用兜底执行者，避免 `task` 工具形同虚设。

另一个细节是双结构存储：`subAgents map[string]tool.InvokableTool` 和 `subAgentSlice []adk.Agent` 并存。前者服务运行时 O(1) 路由；后者服务描述生成（`Info` 中的可读列表），这是一种典型的“读路径分离”。

## `type taskTool struct`

`taskTool` 只保留三块最小状态：

- 路由表 `subAgents`；
- 描述用切片 `subAgentSlice`；
- 描述生成函数 `descGen`。

没有会话态、没有锁、没有缓存，说明它被设计为“轻量无状态路由器”（除初始化后的静态配置）。这降低并发复杂度，也让行为更可预测。

## `func (t *taskTool) Info(ctx)`

`Info` 在 tool calling 协议里是“模型可见合同”。该实现先调用 `descGen` 动态生成描述，再返回 `schema.ToolInfo`，参数结构通过 `schema.NewParamsOneOfByParams` 声明为两个字符串字段：`subagent_type` 和 `description`。

这里的权衡是“灵活描述 vs 严格参数约束”。描述文本可以自定义（甚至上下文化），但参数 schema 保持极简稳定，降低模型生成错误参数的概率。

## `type taskToolArgument struct`

这个结构体是 JSON 入参绑定层，字段标签固定为 `subagent_type` 与 `description`。它看似简单，但本质上承担了 tool schema 与运行时代码之间的“编译期锚点”：参数名变更会在这里集中体现。

## `func (t *taskTool) InvokableRun(ctx, argumentsInJSON, opts...)`

这是调度执行核心，步骤非常明确：

- `json.Unmarshal` 解析参数；
- 用 `SubagentType` 查路由表，不存在则返回 `subagent type %s not found`；
- 用 `sonic.MarshalString` 生成子 agent 输入 `{"request": input.Description}`；
- 调用目标 `a.InvokableRun(ctx, params, opts...)`。

关键设计意图是“协议归一”。不要求每个子 agent 暴露同样的公开接口，而是在 dispatch 层统一改写成 `request` 字段。这意味着调用方（主模型）只需要掌握一个参数风格，子 agent 工具契约变化被局部吸收。

## `defaultTaskToolDescription(ctx, subAgents)`

默认描述生成器会遍历所有子 agent，拼出 `- name: description` 列表，再用 `pyfmt.Fmt` 填入 `taskToolDescription` 模板。它确保 tool 描述始终与当前注册子 agent 集合一致，避免“文档说有 A，运行时没有 A”的漂移。

---

## 5. 依赖分析：它依赖谁，谁依赖它

从你提供的模块内依赖图看，显式调用关系只有一条：`newTaskToolMiddleware` 调用 `newTaskTool`。这说明 `task_tool.go` 内部结构是“薄中间件 + 核心装配函数”。

放到跨模块视角，这个模块被 `deep.New` 间接驱动：`deep.New` 在满足 `!cfg.WithoutGeneralSubAgent || len(cfg.SubAgents) > 0` 时调用 `newTaskToolMiddleware`，并把返回的 middleware 合并进主 `ChatModelAgent`。也就是说，它的架构角色是 **Deep Agent 的子任务分发能力插件**，而不是独立入口。

向下游看，它依赖并约束了几个关键契约：

- 对 agent 侧：依赖 `adk.NewAgentTool(ctx, agent)` 可被 `assertAgentTool` 成功转成 `tool.InvokableTool`；
- 对子 agent 入参：当前写死为 `{"request": "..."}`，目标工具需接受该格式；
- 对模型 tool calling：依赖 `Info` 暴露的参数名与 `taskToolArgument` JSON 标签一致；
- 对提示词层：依赖 `taskPrompt` 与 `taskToolDescription` 帮助模型正确选择 `subagent_type`。

如果上游改动 `task` 参数名而不同步 `taskToolArgument`/`Info`，或下游 agent tool 不再接受 `request` 字段，这里会直接失效。

---

## 6. 设计决策与权衡

这份实现明显偏向“简单稳定优先”。它没有做动态能力发现、没有多层路由策略、没有失败重试编排，而是用一个 map 做直接分发。好处是路径短、可调试性高；代价是高级调度（负载、优先级、熔断）需要在外层扩展。

在“耦合 vs 自治”上，方案选择了适度耦合：dispatch 层知道子 agent 统一输入键为 `request`。这降低了模型心智负担，但把子 agent 接口风格收敛到了一个隐式标准。对于同一生态内部，这是合理取舍；如果未来要接入第三方 agent 协议，可能需要额外适配层。

在“可用性 vs 显式性”上，默认创建 general subagent（可通过 `withoutGeneralSubAgent` 关闭）是典型的可用性倾向：默认即有兜底能力。但也意味着行为不是“最小惊讶”的纯显式配置，新贡献者需要记住这个默认注入路径。

---

## 7. 使用方式与示例

在仓库外部你通常不会直接调用 `newTaskToolMiddleware`（未导出）；标准用法是通过 `deep.New` 触发其装配逻辑：

```go
agent, err := deep.New(ctx, &deep.Config{
    ChatModel:               myToolCallingModel,
    SubAgents:               []adk.Agent{codeAgent, researchAgent},
    WithoutGeneralSubAgent:  false,
    TaskToolDescriptionGenerator: nil, // 可选
})
```

若你在 `deep` 包内扩展（或测试）并直接构造，也可以参考 `task_tool_test.go` 的模式：先 `newTaskTool(...)`，再调用 `Info` 检查描述是否包含目标子 agent，最后用 `InvokableRun` 验证分发是否正确。

一个常见扩展点是 `taskToolDescriptionGenerator`。当你希望对不同运行上下文动态突出某些子 agent（例如按租户策略隐藏部分能力）时，可以替换默认 `defaultTaskToolDescription`，但仍保持参数 schema 不变。

---

## 8. 新贡献者重点注意的边界与坑

最容易踩坑的是“名字即路由键”。`InvokableRun` 用 `input.SubagentType` 直接查 `map[string]tool.InvokableTool`，而这个键来自 `agent.Name(ctx)`。若两个子 agent 返回同名，后写入者会覆盖先写入者，且当前实现没有冲突检测。

第二个坑是参数校验较弱。`Info` 只声明了字段类型为 `string`，没有 required/enum 约束；运行时也不校验 `description` 是否为空。这使得模型即使传了空描述也会继续调用下游子 agent，结果质量完全依赖下游容错。

第三个坑是错误来源分层。`InvokableRun` 里三类错误会混在同一路径返回：JSON 反序列化错误、路由 miss、下游 `InvokableRun` 错误。排查时要先区分“参数问题”还是“子 agent 执行问题”。

第四个坑是描述与实际的一致性依赖调用时机。`Info` 每次调用都会根据 `subAgentSlice` 生成描述；如果你在初始化后修改了 agent 的 `Name/Description` 行为（例如上下文相关返回），模型看到的 tool 描述会变化，可能影响稳定性。

---

## 9. 参考阅读

为了避免重复解释底层运行时，建议继续阅读：

- [deep_agent_composition](deep_agent_composition.md)：`deep.New` 如何决定是否注入 task tool middleware。
- [ADK ChatModel Agent](ADK ChatModel Agent.md)：`ChatModelAgentConfig` 与 middleware/tool 合并规则。
- [ADK Agent Tool](ADK Agent Tool.md)：`adk.NewAgentTool` 如何把 `adk.Agent` 暴露为 tool。
- [tool_schema_definition](tool_schema_definition.md)：`schema.ToolInfo` / `schema.ParameterInfo` / `ParamsOneOf` 的 schema 约定。
- [tool_options_callback_and_function_adapters](tool_options_callback_and_function_adapters.md)：`tool.InvokableTool` 与 `tool.Option` 的通用行为。
