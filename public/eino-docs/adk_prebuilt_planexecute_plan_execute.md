# plan_execute 核心实现详解

> 本文档深入分析 `planexecute_core_and_state` 模块的核心实现，涵盖 Plan 接口、三种 Agent（Planner/Executor/Replanner）的内部机制，以及它们如何通过 Session State 协同工作。

---

## 1. Plan 接口与实现

### 1.1 Plan 接口设计

```go
type Plan interface {
    FirstStep() string
    json.Marshaler
    json.Unmarshaler
}
```

**设计意图**：
- `FirstStep()` 提供**命令式**的步骤获取方式 —— "告诉我下一步该做什么"
- JSON 序列化支持**声明式**的计划表示 —— "计划是一个有序的步骤列表"
- 这种双重接口使得 Plan 既可以被 LLM 生成，也可以被代码消费

### 1.2 defaultPlan 实现

```go
type defaultPlan struct {
    Steps []string `json:"steps"`
}

func (p *defaultPlan) FirstStep() string {
    if len(p.Steps) == 0 {
        return ""
    }
    return p.Steps[0]
}
```

**实现特点**：
- 零个步骤返回空字符串（表示计划已完成）
- 只返回第一个步骤（每次只执行一步是 Plan-Execute-Replan 的核心约束）

### 1.3 为什么设计成"单步执行"？

这是该模式的关键设计决策：

```
传统的多步规划:  [Step1, Step2, Step3] → 一次性执行所有步骤
Plan-Execute-Replan: [Step1] → 执行 → 评估 → [修订计划] → [Step1', Step2] → 执行 → ...
```

**优势**：
1. **适应变化**：执行 Step1 后可能发现 Step2/3 需要调整
2. **错误隔离**：一个步骤失败不会导致整个计划泡汤
3. **可解释性**：每个步骤都有明确的执行结果记录

---

## 2. Planner 详解

### 2.1 核心职责

Planner 的唯一任务是：**将用户目标转化为结构化的步骤列表**

### 2.2 两种配置模式

```go
type PlannerConfig struct {
    // 方式1: 直接输出结构化数据（需要模型支持）
    ChatModelWithFormattedOutput model.BaseChatModel
    
    // 方式2: 通过 Tool Calling 生成
    ToolCallingChatModel model.ToolCallingChatModel
    ToolInfo            *schema.ToolInfo  // 可选，默认 PlanToolInfo
}
```

**选择建议**：
- OpenAI/GPT-4、Claude 等支持结构化输出的模型 → 方式1
- 不支持结构化输出的模型 → 方式2

### 2.3 内部工作流程

```go
func (p *planner) Run(ctx context.Context, input *adk.AgentInput, ...) *adk.AsyncIterator[*adk.AgentEvent] {
    // 1. 生成输入消息
    msgs := p.genInputFn(ctx, input.Messages)
    
    // 2. 调用 ChatModel
    response := p.chatModel.Generate(ctx, msgs)
    
    // 3. 解析为 Plan
    var planJSON string
    if p.toolCall {
        planJSON = response.ToolCalls[0].Function.Arguments
    } else {
        planJSON = response.Content
    }
    
    plan := p.newPlan(ctx)
    plan.UnmarshalJSON([]byte(planJSON))
    
    // 4. 存入 Session（供后续 Agent 使用）
    adk.AddSessionValue(ctx, PlanSessionKey, plan)
    
    return event
}
```

### 2.4 Prompt 模板分析

```go
PlannerPrompt = prompt.FromMessages(schema.FString,
    schema.SystemMessage(`You are an expert planning agent...
    
    ## PLANNING REQUIREMENTS
    Each step in your plan must be:
    - **Specific and actionable**: Clear instructions that can be executed
    - **Self-contained**: Include all necessary context
    - **Independently executable**: Can be performed without dependencies
    - **Logically sequenced**: Arranged in optimal order
    - **Objective-focused**: Directly contribute to achieving the main goal
    `),
    schema.MessagesPlaceholder("input", false),
)
```

**Prompt 工程要点**：
- 强调"independently executable"——每个步骤必须能独立完成
- 使用"step-by-step"结构化格式引导
- 通过 PLANNING REQUIREMENTS 明确质量标准

---

## 3. Executor 详解

### 3.1 核心职责

Executor 的职责是：**执行计划中的第一步，并返回执行结果**

### 3.2 基于 ChatModelAgent 的设计

```go
agent, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
    Name:          "executor",
    Description:   "an executor agent",
    Model:         cfg.Model,
    ToolsConfig:   cfg.ToolsConfig,
    GenModelInput: genInput,      // 自定义输入生成
    MaxIterations: cfg.MaxIterations,
    OutputKey:     ExecutedStepSessionKey,  // 关键：输出到 Session
})
```

**为什么复用 ChatModelAgent？**
1. 它已经实现了完整的 ReAct 循环（思考 → 工具调用 → 观察 → 重复）
2. 支持多轮工具调用直到任务完成
3. 内置重试、超时等容错机制

### 3.3 输入生成逻辑

```go
func defaultGenExecutorInputFn(ctx context.Context, in *ExecutionContext) ([]adk.Message, error) {
    msgs, err := ExecutorPrompt.Format(ctx, map[string]any{
        "input":          formatInput(in.UserInput),
        "plan":           string(planJSON),
        "executed_steps": formatExecutedSteps(in.ExecutedSteps),
        "step":           in.Plan.FirstStep(),  // 只传第一步！
    })
}
```

**关键点**：
- `in.Plan.FirstStep()` — 只告诉 LLM 需要做什么，而不是整个计划
- `executed_steps` — 提供历史，让 LLM 知道之前的尝试结果

### 3.4 Prompt 模板分析

```go
ExecutorPrompt = prompt.FromMessages(schema.FString,
    schema.SystemMessage(`You are a diligent and meticulous executor agent. 
    Follow the given plan and execute your tasks carefully and thoroughly.`),
    schema.UserMessage(`## OBJECTIVE
{input}

## Given the following plan:
{plan}

## COMPLETED STEPS & RESULTS
{executed_steps}

## Your task is to execute the first step, which is: 
{step}`))
```

**Prompt 工程要点**：
- 强调"first step"——明确只执行一步
- 提供完整上下文（原始目标 + 计划 + 历史）
- 使用"diligent and meticulous"塑造负责任的执行者角色

---

## 4. Replanner 详解

### 4.1 核心职责

Replanner 是**决策者**，负责：
1. 评估当前执行结果
2. 决定是继续执行还是完成任务
3. 如果继续，生成修订后的计划

### 4.2 决策机制：二选一

Replanner 使用两个 Tool 进行决策：

```go
// Plan tool: 继续执行
PlanToolInfo = schema.ToolInfo{
    Name: "plan",
    Desc: "Plan with a list of steps to execute in order...",
    ParamsOneOf: schema.NewParamsOneOfByParams(...),
}

// Respond tool: 完成任务
RespondToolInfo = schema.ToolInfo{
    Name: "respond",
    Desc: "Generate a direct response to the user...",
    ParamsOneOf: schema.NewParamsOneOfByParams(...),
}
```

模型需要**二选一**调用其中一个 Tool。

### 4.3 内部工作流程

```go
func (r *replanner) Run(ctx context.Context, input *adk.AgentInput, ...) *adk.AsyncIterator[*adk.AgentEvent] {
    // 1. 记录执行结果到 ExecutedSteps
    executedStep := getSessionValue(ExecutedStepSessionKey)
    executedSteps := append(getSessionValue(ExecutedStepsSessionKey), ExecutedStep{
        Step:   plan.FirstStep(),
        Result: executedStep,
    })
    adk.AddSessionValue(ctx, ExecutedStepsSessionKey, executedSteps)
    
    // 2. 生成评估输入
    msgs := r.genInputFn(ctx, &ExecutionContext{
        UserInput:     userInput,
        Plan:          plan,
        ExecutedSteps: executedSteps,
    })
    
    // 3. 调用模型（强制选择 Tool）
    response := r.chatModel.Generate(ctx, msgs, 
        model.WithToolChoice(schema.ToolChoiceForced))
    
    // 4. 处理决策
    toolCall := response.ToolCalls[0]
    
    if toolCall.Name == r.respondTool.Name {
        // 完成：退出循环
        action := adk.NewBreakLoopAction(r.Name(ctx))
        generator.Send(&adk.AgentEvent{Action: action})
    } else {
        // 继续：更新计划
        plan := r.newPlan(ctx)
        plan.UnmarshalJSON([]byte(toolCall.Function.Arguments))
        adk.AddSessionValue(ctx, PlanSessionKey, plan)
    }
}
```

### 4.4 循环控制机制

```go
// 在 LoopAgent 中处理 BreakLoopAction
if lastActionEvent.Action.BreakLoop != nil && !lastActionEvent.Action.BreakLoop.Done {
    lastActionEvent.Action.BreakLoop.Done = true
    // 循环终止
    return
}
```

**设计要点**：
- `BreakLoop` 是框架层面的控制机制，不是 LLM 可直接触发的
- LLM 通过调用 `respond` tool 间接触发循环终止
- 设置 `Done = true` 防止重复处理

### 4.5 Prompt 模板分析

```go
ReplannerPrompt = prompt.FromMessages(schema.FString,
    schema.SystemMessage(`You are going to review the progress toward an objective.
    
    ## YOUR TASK
    Based on the progress above, you MUST choose exactly ONE action:
    
    ### Option 1: COMPLETE (if objective is fully achieved)
    Call '{respond_tool}' with:
    - A comprehensive final answer
    
    ### Option 2: CONTINUE (if more work is needed)
    Call '{plan_tool}' with a revised plan that:
    - Contains ONLY remaining steps (exclude completed ones)
    - Incorporates lessons learned from executed steps
    `),
    schema.UserMessage(`## OBJECTIVE
{input}

## ORIGINAL PLAN
{plan}

## COMPLETED STEPS & RESULTS
{executed_steps}`))
```

**关键设计**：
- "MUST choose exactly ONE action" — 强制二选一
- "exclude completed ones" — 新计划只包含剩余步骤
- "Incorporates lessons learned" — 要求从历史中学习

---

## 5. Session State 通信机制

### 5.1 Session Keys 映射

| Key | 类型 | 生产者 | 消费者 | 用途 |
|-----|------|--------|--------|------|
| `UserInput` | `[]adk.Message` | (外部输入) | Planner, Executor, Replanner | 原始用户请求 |
| `Plan` | `Plan` | Planner, Replanner | Executor, Replanner | 当前执行计划 |
| `ExecutedStep` | `string` | Executor | Replanner | 单次执行结果 |
| `ExecutedSteps` | `[]ExecutedStep` | Replanner | Executor, Replanner | 完整执行历史 |

### 5.2 状态流转图

```
                    ┌─────────────────┐
                    │    UserInput    │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │     Planner     │──────┐
                    │ (生成 Plan)     │      │
                    └────────┬────────┘      │
                             │               │
                             │ Plan          │
                             ▼               │
                    ┌─────────────────┐      │
                    │     Executor     │      │
                    │ (执行 FirstStep) │      │
                    └────────┬────────┘      │
                             │               │
                             │ ExecutedStep  │
                             ▼               │
                    ┌─────────────────┐      │
                    │    Replanner     │◄─────┘
                    │ (评估+决策)      │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
        [Respond]                    [Plan 更新]
        BreakLoop                    ExecutedSteps + Plan
        退出循环                      返回执行
```

### 5.3 为什么不直接用参数传递？

**可选方案对比**：

```go
// 方案1: 参数链式传递（被否定）
func ExecutorRun(ctx context.Context, input *AgentInput, plan Plan, history []ExecutedStep)

// 方案2: Session State（当前方案）
adk.AddSessionValue(ctx, PlanSessionKey, plan)
plan, _ := adk.GetSessionValue(ctx, PlanSessionKey)
```

**选择理由**：
1. **解耦**：Planner 输出什么、Executor 需要什么，两者是独立定义的
2. **可恢复**：中断恢复时 Session 自动从 Checkpoint 恢复
3. **多消费者**：ExecutedSteps 需要被 Executor（查看历史）和 Replanner（更新历史）同时访问

---

## 6. 组合机制：Sequential + Loop

### 6.1 为什么需要两层组合？

```
Planner → Loop(Executor ↔ Replanner)
```

这种设计解决了两个问题：

**问题1：单次 vs 循环**
- Planner 只执行一次
- Executor 和 Replanner 需要反复执行直到完成

**问题2：循环终止**
- 只有 Replanner 有能力决定何时终止
- LoopAgent 监听 `BreakLoopAction` 信号

### 6.2 数据流验证

```go
loop, _ := adk.NewLoopAgent(ctx, &adk.LoopAgentConfig{
    SubAgents: []adk.Agent{cfg.Executor, cfg.Replanner},
    MaxIterations: maxIterations,
})

return adk.NewSequentialAgent(ctx, &adk.SequentialAgentConfig{
    SubAgents: []adk.Agent{cfg.Planner, loop},
})
```

执行顺序：
1. Sequential 调用 Planner → 产生 Plan
2. Loop 开始第一次迭代：
   - 调用 Executor → 产生 ExecutedStep
   - 调用 Replanner → 决定继续/终止
3. 循环直到 Replanner 返回 BreakLoop 或达到 MaxIterations

---

## 7. 扩展点与定制

### 7.1 自定义 Plan 结构

```go
type CustomPlan struct {
    Steps     []string `json:"steps"`
    Reasoning string   `json:"reasoning"`  // 添加思考过程
}

func (p *CustomPlan) FirstStep() string { ... }
func (p *CustomPlan) MarshalJSON() ([]byte, error) { ... }
func (p *CustomPlan) UnmarshalJSON([]byte) error { ... }

// 在配置中使用
NewPlanner(ctx, &PlannerConfig{
    ToolCallingChatModel: model,
    NewPlan: func(ctx context.Context) Plan {
        return &CustomPlan{}
    },
})
```

### 7.2 自定义输入生成

```go
NewExecutor(ctx, &ExecutorConfig{
    Model: model,
    GenInputFn: func(ctx context.Context, in *ExecutionContext) ([]adk.Message, error) {
        // 完全自定义输入生成逻辑
        // 例如：添加更多上下文、改变格式、添加约束等
    },
})
```

### 7.3 自定义工具集

```go
NewExecutor(ctx, &ExecutorConfig{
    Model: model,
    ToolsConfig: adk.ToolsConfig{
        Tools: []tool.BaseTool{
            myCustomTool1,
            myCustomTool2,
        },
    },
})
```

---

## 8. 边界情况处理

### 8.1 空计划

```go
func (p *defaultPlan) FirstStep() string {
    if len(p.Steps) == 0 {
        return ""  // 空字符串表示完成
    }
    return p.Steps[0]
}
```

**处理**：Executor 收到空步骤时应该终止并报告完成。

### 8.2 模型未返回 Tool Call

```go
if len(msg.ToolCalls) == 0 {
    return nil, fmt.Errorf("no tool call")
}
```

**处理**：视为错误，触发重试或向上传递错误。

### 8.3 达到最大迭代次数

- LoopAgent 的 MaxIterations 控制整体循环次数
- Executor 内部的 MaxIterations 控制单次执行中的模型调用次数
- 两者独立设置

---

## 9. 与框架其他部分的交互

### 9.1 依赖的 ADK 核心功能

| 功能 | 使用位置 |
|------|----------|
| `adk.Agent` 接口 | 实现 Planner, Executor, Replanner |
| `adk.AsyncIterator` | 流式返回执行事件 |
| `adk.AddSessionValue` | 存储 Plan, ExecutedSteps |
| `adk.GetSessionValue` | 读取 Plan, UserInput |
| `adk.NewChatModelAgent` | 构建 Executor |
| `adk.NewSequentialAgent` | 组合 Planner + Loop |
| `adk.NewLoopAgent` | 组合 Executor + Replanner |
| `adk.NewBreakLoopAction` | Replanner 发出终止信号 |

### 9.2 依赖的 Compose 组件

```go
c := compose.NewChain[*adk.AgentInput, Plan]().
    AppendLambda(...).    // 生成输入
    AppendChatModel(...). // 调用模型
    AppendLambda(...).    // 解析输出
    AppendLambda(...)     // 存入 Session
```

**设计模式**：使用 Compose Chain 构建 Agent 内部流水线，而非手写循环，这是 ADK 推崇的组合式架构。

---

## 10. 总结

Plan-Execute-Replan 模块展示了如何将经典 Agent 设计范式落地为可用的代码：

1. **Plan 接口**作为核心契约，解耦计划生成与计划执行
2. **Session State**作为通信总线，实现 Agent 间的状态共享
3. **Tool Calling**作为决策机制，让 LLM 可以显式选择行动
4. **Compose Chain**作为内部流水线，保持代码结构清晰
5. **Sequential + Loop**作为宏观架构，平衡单次执行与迭代控制

理解这个模块的关键在于把握"**分而治之**"的思想：Planner 负责分解，Executor 负责执行，Replanner 负责协调——三者各司其职，通过 Session 状态通信，形成一个自适应的控制系统。