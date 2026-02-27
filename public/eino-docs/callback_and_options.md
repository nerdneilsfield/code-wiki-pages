# callback_and_options 模块深度解析

`callback_and_options` 是 host multi-agent 的“事件侧通道”：主流程负责让 Host 选择 Specialist 并执行任务，而这个模块专门把“发生了 handoff（转交）”这件事可靠地暴露给外部观察者。你可以把它想成机场塔台的广播系统：飞机（主流程）照常起降，但塔台会把关键动作（转交给哪个 specialist、携带什么参数）广播给监听者做审计、埋点、UI 追踪或策略干预。如果没有这层，业务方只能侵入主流程代码或重复解析模型输出，既脆弱又高耦合。

## 这个模块解决了什么问题？

在 host 模式下，真正有业务价值的不只是最终回答，还有“Host 为什么把任务交给了谁”。这个决策体现在模型输出的 `ToolCalls` 里，但它有两个现实复杂度：第一，调用既可能是同步 `Generate`，也可能是流式 `Stream`；第二，流式下工具调用经常是分片出现，甚至函数名和参数跨 chunk 拼接。一个天真的实现通常是“在每个调用点手写 if/for 去读 `ToolCalls`”，但会很快出现重复逻辑、流式拼接不一致、以及与 compose callback 体系脱节的问题。

本模块的设计洞察是：**不要在业务路径里散落 handoff 识别逻辑，而是把它收敛为 host 专属回调接口 `MultiAgentCallback`，再桥接到通用 `callbacks.Handler`**。这样，host agent 运行时只需标准化地安装 handler，handoff 事件就能在同一机制下覆盖同步和流式两条路径。

## 心智模型：一个“协议适配器 + 事件提取器”

建议用两层心智模型理解：

第一层是**选项收集器**。`WithAgentCallbacks(...)` 把业务回调塞进 `agent.AgentOption` 的 impl-specific 区域；`convertCallbacks(...)` 在运行入口把这些专属 option 取出来。

第二层是**回调协议适配器**。`ConvertCallbackHandlers(...)` 把 `[]MultiAgentCallback` 适配成 compose 能识别的 `callbacks.Handler`，并把 chat model 的结束事件（`OnEnd` / `OnEndWithStreamOutput`）翻译成更语义化的 `OnHandOff`。

可以把它类比成“网关协议转换”：上游说的是底层 transport 事件（model callback），下游要的是领域事件（handoff）。这个模块就是转换层。

## 架构与数据流

```mermaid
flowchart LR
  A[调用方: WithAgentCallbacks] --> B[agent.AgentOption]
  B --> C[MultiAgent.Generate/Stream]
  C --> D[convertCallbacks]
  D --> E[ConvertCallbackHandlers]
  E --> F[callbacks.Handler]
  F --> G[compose callback bound to host node]
  G --> H[Host ChatModel OnEnd / OnEndWithStreamOutput]
  H --> I[提取 ToolCalls -> HandOffInfo]
  I --> J[MultiAgentCallback.OnHandOff]
```

运行时的关键路径是：调用方把 `WithAgentCallbacks` 作为 `agent.AgentOption` 传给 `MultiAgent.Generate` 或 `MultiAgent.Stream`；`Generate/Stream` 内部先取普通 compose options（`agent.GetComposeOptions`），再用 `convertCallbacks` 抽取 host 专属 callbacks。若存在回调，就把桥接后的 `callbacks.Handler` 通过 `compose.WithCallbacks(handler).DesignateNode(ma.HostNodeKey())` 绑定到 host 节点。随后当 host chat model 结束时，handler 在 callback 层读取输出消息，提取 `ToolCalls`，逐条构造 `HandOffInfo{ToAgentName, Argument}` 并调用每个 `MultiAgentCallback.OnHandOff`。

这里的一个关键架构选择是 **DesignateNode(host)**：它把监听范围严格限定在 host 节点，避免 specialist 或其它节点的 tool 调用噪声污染 handoff 语义。

## 组件深潜

### `type HandOffInfo struct`

`HandOffInfo` 是领域事件载体，字段非常克制：

- `ToAgentName string`：来自 `toolCall.Function.Name`
- `Argument string`：来自 `toolCall.Function.Arguments`

设计意图是把 handoff 事件压缩到“路由目标 + 路由依据参数”这两个稳定信号，避免把整个 `schema.ToolCall` 暴露出去造成上层与底层 schema 过耦合。

### `type MultiAgentCallback interface`

接口只定义一个钩子：

```go
OnHandOff(ctx context.Context, info *HandOffInfo) context.Context
```

这不是通用 callback 总线，而是 host 领域接口。返回 `context.Context` 让调用方可在同步路径里链式传播上下文（例如注入 trace/span、请求级标记等）。

### `func WithAgentCallbacks(agentCallbacks ...MultiAgentCallback) agent.AgentOption`

这是模块的注册入口。它用 `agent.WrapImplSpecificOptFn(func(opts *options){...})` 把 host 专属配置写入私有 `options` 结构体（`agentCallbacks []MultiAgentCallback`）。

为什么不用公开 `options`？因为它是实现细节：调用方只应通过 `AgentOption` 通道传意图，不应依赖内部存储结构。

### `func convertCallbacks(opts ...agent.AgentOption) callbacks.Handler`

`convertCallbacks` 是运行入口里的提取器。它调用：

- `agent.GetImplSpecificOptions(&options{}, opts...)`：从统一 option 列表中抽出 host 专属部分
- 若没有注册回调，返回 `nil`（调用方据此跳过 callback 安装）
- 否则调用 `ConvertCallbackHandlers(...)`

这段逻辑体现了一个常见模式：**统一 option 容器 + 各实现按类型领取自己的配置**，兼顾了跨模块一致调用方式与实现自治。

### `func ConvertCallbackHandlers(handlers ...MultiAgentCallback) callbacks.Handler`

这是核心适配器，处理同步和流式两种结束事件。

在 `OnEnd`（同步输出）中，它检查：

1. `output.Message != nil`
2. `msg.Role == schema.Assistant`
3. `len(msg.ToolCalls) > 0`

只有满足这些条件才触发 handoff，避免把普通回答误当成转交事件。随后按“回调列表 × toolCalls”双层循环分发。

在 `OnEndWithStreamOutput`（流式输出）中，它起一个 goroutine，先把 `*schema.StreamReader[*model.CallbackOutput]` 转成 message stream（`schema.StreamReaderWithConvert`），再通过 `schema.ConcatMessageStream` 合并分片，最后遍历 `msg.ToolCalls` 触发 handoff。

这里有两个重要实现含义：

第一，**流式路径必须先 concat 再判定**。因为 tool call 的 `Function.Name` / `Arguments` 可能跨 chunk 分裂，不先合并就可能拿到半截参数。

第二，**异步回调不阻塞主链路**。goroutine 让 `OnEndWithStreamOutput` 快速返回，优先保证流式主流程吞吐；代价是回调执行时序与主流程解耦，调用方不能假设 `Stream` 返回后 handoff 回调已完成。

## 依赖分析（调用关系与契约）

从“本模块调用谁”看：

本模块依赖 `agent` option 系统（`WrapImplSpecificOptFn` / `GetImplSpecificOptions` / `GetComposeOptions`）来完成注册与提取；依赖 `utils/callbacks` 的 `NewHandlerHelper().ChatModel(...).Handler()` 生成标准 handler；依赖 `schema` 的流式工具（`StreamReaderWithConvert`、`ConcatMessageStream`）处理流式聚合；依赖 `components/model.CallbackOutput` 与 `schema.Message` 的数据结构读取 `ToolCalls`。

从“谁调用本模块”看：

直接调用面是 `MultiAgent.Generate` 与 `MultiAgent.Stream`（见 [types_and_config](types_and_config.md)），它们在运行前调用 `convertCallbacks` 并把结果注入 compose 运行选项。更高层调用方通常只感知 `WithAgentCallbacks`。

数据契约方面最关键的是：

- handoff 语义来源于 host chat model 输出的 `Message.ToolCalls[*].Function{Name,Arguments}`。
- 同步路径只接受 `Role == schema.Assistant` 且存在 tool calls 的消息。
- 流式路径通过 `ConcatMessageStream` 重建最终消息后再取 `ToolCalls`。

如果上游模型不以 tool call 表达路由决策，这个模块就不会发出 handoff 事件。

## 设计决策与权衡

这个模块明显偏向“轻量、低侵入”而不是“全能回调框架”。

首先，它把接口收窄为单事件 `OnHandOff`。好处是语义稳定、上手快；代价是无法直接拿到 runInfo、token usage 等更多上下文。若业务需要更丰富事件，需扩展接口或并行使用通用 callback。

其次，流式采用“末端聚合后一次性发事件”，而不是“增量事件”。这保证了参数完整性和实现简单性，但牺牲了事件实时性（你拿到 handoff 通常晚于首个 tool-call chunk）。

再次，异步 goroutine 提升主链路响应性，但引入并发语义：回调顺序、完成时机与主调用生命周期不再强绑定。

最后，`fmt.Printf` 用于流式 concat 错误输出，属于非常轻量的错误处理策略。它避免把 callback 内部问题向主流程抛错，但也意味着错误治理更依赖外部日志采集。

## 使用方式与示例

最常见用法是在调用 `Generate/Stream` 时传入 `WithAgentCallbacks(...)`：

```go
type auditCB struct{}

func (a *auditCB) OnHandOff(ctx context.Context, info *host.HandOffInfo) context.Context {
    // 例如：记录 handoff 审计日志
    // info.ToAgentName / info.Argument
    return ctx
}

out, err := ma.Generate(ctx, msgs,
    host.WithAgentCallbacks(&auditCB{}),
)
```

如果你把 `MultiAgent` 嵌入更大图中，也可以直接使用桥接函数获得标准 handler，再按节点路径绑定：

```go
handler := host.ConvertCallbackHandlers(&auditCB{})

out, err := fullGraph.Invoke(ctx, input,
    compose.WithCallbacks(handler).
        DesignateNodeWithPath(compose.NewNodePath("host_ma_node", ma.HostNodeKey())),
)
```

这两种方式本质一致：前者是封装好的快捷入口，后者适合跨图编排场景。

## 新贡献者需要特别注意的点

最容易踩坑的是并发与时序。`OnEndWithStreamOutput` 内部起 goroutine，因此测试里通常需要像 `compose_test.go` 那样用 `WaitGroup` 等待回调完成；否则你会看到“主流程已结束但回调数据还没写完”。

第二个坑是上下文传播语义不一致：同步路径会把 `OnHandOff` 返回的 `ctx` 继续传下去；流式路径当前实现里对返回值是忽略的（`_ = cb.OnHandOff(...)`）。这意味着如果你依赖“回调返回的新 context 被后续逻辑使用”，流式下不会生效。

第三个坑是触发条件差异。同步路径显式检查 `Role == schema.Assistant`；流式路径在 concat 后直接读 `ToolCalls`，没有同样的 role 过滤。通常模型输出不会违背语义，但这是行为细节差异。

第四个坑是回调执行次数：分发是“每个注册回调 × 每个 tool call”。当 host 一次选多个 specialist 时，会触发多次 `OnHandOff`。

最后，`WithAgentCallbacks` 是 append 语义，不是覆盖语义。多次传入会累积回调。

## 参考文档

- [types_and_config](types_and_config.md)：`MultiAgent` 主入口、`Generate/Stream` 调用面、配置校验
- [graph_composition_runtime](graph_composition_runtime.md)：host multi-agent 图运行与节点路径绑定语义
- [component_introspection_and_callback_switch](component_introspection_and_callback_switch.md)：通用 callback 分发与 timing 选择机制
