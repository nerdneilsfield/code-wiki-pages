# Event Bus and Agent Runtime Event Contracts 模块文档

## 模块概述

这个模块是系统的事件总线基础设施和代理运行时事件契约。它提供了一个灵活的发布-订阅系统，解耦了系统各个组件，实现了松耦合的通信，特别适用于代理运行时的事件流处理。

## 文档结构

- [主文档](event_bus_and_agent_runtime_event_contracts.md) - 模块的总体介绍和架构设计
- [事件总线核心契约](platform_infrastructure_and_runtime-event_bus_and_agent_runtime_event_contracts-event_bus_core_contracts.md) - 事件总线的核心实现和接口
- [会话和聊天事件负载](platform_infrastructure_and_runtime-event_bus_and_agent_runtime_event_contracts-session_and_chat_event_payloads.md) - 会话和聊天相关的事件数据结构
- [检索和结果融合事件负载](platform_infrastructure_and_runtime-event_bus_and_agent_runtime_event_contracts-retrieval_and_result_fusion_event_payloads.md) - 检索和结果融合相关的事件数据结构
- [代理规划推理和完成事件负载](platform_infrastructure_and_runtime-event_bus_and_agent_runtime_event_contracts-agent_planning_reasoning_and_completion_event_payloads.md) - 代理规划、推理和完成相关的事件数据结构
- [代理工具调用结果和引用事件负载](platform_infrastructure_and_runtime-event_bus_and_agent_runtime_event_contracts-agent_tool_calls_results_and_references_event_payloads.md) - 代理工具调用、结果和引用相关的事件数据结构

## 快速开始

### 基本使用

```go
// 创建事件总线
bus := event.NewEventBus()

// 注册事件处理器
bus.On(event.EventQueryReceived, func(ctx context.Context, evt event.Event) error {
    // 处理事件
    return nil
})

// 发布事件
bus.Emit(ctx, event.Event{
    Type: event.EventQueryReceived,
    Data: event.QueryData{
        OriginalQuery: "用户查询",
        SessionID:     "session-123",
    },
})
```

### 异步模式

```go
// 创建异步事件总线
bus := event.NewAsyncEventBus()

// 事件将被异步处理
bus.Emit(ctx, event.Event{...})
```

## 核心概念

### 事件类型

模块定义了多种事件类型，涵盖了查询处理、检索、代理运行等各个阶段：

- 查询处理事件
- 检索事件
- 重排序事件
- 合并事件
- 聊天完成事件
- 代理事件
- 流式事件
- 错误事件
- 会话事件
- 控制事件

### 事件数据结构

每种事件类型都有对应的数据结构，用于承载事件的具体信息。

## 设计亮点

1. **同步异步双模式** - 灵活应对不同场景需求
2. **适配器模式** - 避免循环依赖，提高模块解耦
3. **类型安全的事件数据** - 为不同事件类型定义专用数据结构
4. **流式事件支持** - 专门为实时反馈设计的事件类型

## 依赖关系

这个模块是系统的基础设施，被多个上层模块依赖：

- 核心域类型和接口
- 聊天管道插件和流程
- 代理运行时和工具
