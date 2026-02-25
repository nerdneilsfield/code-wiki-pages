# frontend_workspace_contexts 模块文档

## 1. 概述

`frontend_workspace_contexts` 模块是前端应用中负责管理工作区上下文的核心模块，提供了 React Context 机制来共享和管理工作区相关的状态。该模块主要包含两个关键的上下文管理组件：`ArtifactsContext` 和 `ThreadContext`，它们分别用于管理工件（artifacts）状态和线程（thread）状态。

### 1.1 设计目的

该模块的设计目的是解决在复杂的工作区应用中状态共享和管理的问题。通过 React Context API，它允许组件树中的不同组件访问和修改共享状态，而无需通过 props 层层传递。这种设计模式特别适合管理工作区这种需要在多个组件间同步状态的场景。

### 1.2 核心功能

- **工件管理**：提供工件列表的维护、选择和展示控制
- **线程状态共享**：提供线程 ID 和线程流状态的上下文访问
- **状态同步**：确保相关组件间的状态一致性
- **错误处理**：提供上下文使用的安全检查机制

## 2. 架构

`frontend_workspace_contexts` 模块采用了 React Context 模式的标准架构，每个上下文都包含类型定义、Context 创建、Provider 组件和自定义 Hook 四个主要部分。

```mermaid
graph TD
    A[frontend_workspace_contexts] --> B[artifacts/context]
    A --> C[messages/context]
    
    B --> B1[ArtifactsContextType]
    B --> B2[ArtifactsProviderProps]
    B --> B3[ArtifactsProvider]
    B --> B4[useArtifacts]
    
    C --> C1[ThreadContextType]
    C --> C2[ThreadContext]
    C --> C3[useThread]
    
    D[React Context API] --> B
    D --> C
    
    E[frontend_core_domain_types_and_state] --> C
```

### 2.1 架构说明

该模块由两个相对独立的子模块组成：

1. **artifacts/context**：负责管理工作区中的工件相关状态，包括工件列表、选中状态和侧边栏显示状态。
2. **messages/context**：负责提供线程上下文，使组件能够访问当前线程的 ID 和状态流。

两个子模块都遵循 React Context 的最佳实践，提供了类型安全的上下文定义、Provider 组件和自定义 Hook，确保了使用的便利性和安全性。

## 3. 子模块

### 3.1 artifacts/context 子模块

该子模块提供了工件管理的上下文功能，是工作区中展示和操作工件的核心。

#### 核心组件

**ArtifactsContextType**：定义了工件上下文的类型接口，包含以下属性：
- `artifacts`：工件列表数组
- `setArtifacts`：设置工件列表的函数
- `selectedArtifact`：当前选中的工件
- `autoSelect`：是否自动选择工件的标志
- `select`：选择工件的函数
- `deselect`：取消选择工件的函数
- `open`：工件侧边栏是否打开
- `autoOpen`：是否自动打开侧边栏的标志
- `setOpen`：设置侧边栏打开状态的函数

**ArtifactsProvider**：工件上下文的 Provider 组件，负责初始化和管理工件相关状态。它使用 React 的 useState Hook 管理各种状态，并提供了处理工件选择和侧边栏显示的逻辑。

**useArtifacts**：自定义 Hook，用于在组件中安全地访问工件上下文。如果在 Provider 外部使用，会抛出明确的错误信息。

#### 状态管理逻辑

该子模块包含以下关键逻辑：
- 工件列表的维护
- 工件选择与取消选择
- 侧边栏打开/关闭状态管理
- 自动选择和自动打开行为控制
- 与环境变量的集成（如 `NEXT_PUBLIC_STATIC_WEBSITE_ONLY`）

更多详细信息，请参考 [artifacts_context 子模块文档](artifacts_context.md)。

### 3.2 messages/context 子模块

该子模块提供了线程上下文的功能，使组件能够访问当前线程的信息。

#### 核心组件

**ThreadContextType**：定义了线程上下文的类型接口，包含：
- `threadId`：当前线程的唯一标识符
- `thread`：线程的流状态，类型为 `UseStream<AgentThreadState>`

**ThreadContext**：使用 React 的 `createContext` 创建的上下文对象，初始值为 `undefined`。

**useThread**：自定义 Hook，用于在组件中安全地访问线程上下文。与 `useArtifacts` 类似，如果在 Provider 外部使用，会抛出明确的错误信息。

#### 与其他模块的依赖

该子模块依赖于 `frontend_core_domain_types_and_state` 模块中的 `AgentThreadState` 类型，以及 `@langchain/langgraph-sdk/react` 中的 `UseStream` 类型。

更多详细信息，请参考 [messages_context 子模块文档](messages_context.md)。

## 4. 主要组件

### 4.1 ArtifactsProvider

`ArtifactsProvider` 是工件上下文的核心组件，负责初始化和管理所有工件相关的状态。

**功能特点**：
- 初始化工件列表为空数组
- 管理选中工件状态
- 控制侧边栏的打开/关闭状态
- 处理自动选择和自动打开的逻辑
- 与侧边栏组件集成

**使用场景**：
需要在应用的顶层包裹该组件，以便所有子组件都能访问工件上下文。

### 4.2 useArtifacts

`useArtifacts` 是访问工件上下文的自定义 Hook，封装了上下文访问的安全检查。

**返回值**：
返回 `ArtifactsContextType` 类型的对象，包含所有工件相关的状态和方法。

**错误处理**：
如果在 `ArtifactsProvider` 外部使用，会抛出错误："useArtifacts must be used within an ArtifactsProvider"。

### 4.3 ThreadContext

`ThreadContext` 是线程状态的上下文对象，用于在线程相关组件间共享状态。

**特点**：
- 类型安全的上下文定义
- 初始值为 `undefined`，确保使用前必须被 Provider 包裹

### 4.4 useThread

`useThread` 是访问线程上下文的自定义 Hook，提供了安全的上下文访问方式。

**返回值**：
返回 `ThreadContextType` 类型的对象，包含 `threadId` 和 `thread` 状态。

**错误处理**：
如果在 `ThreadContext.Provider` 外部使用，会抛出错误："useThread must be used within a ThreadContext"。

## 5. 技术栈与依赖

| 技术/依赖                | 用途                             | 来源模块                  |
|--------------------------|----------------------------------|---------------------------|
| React                    | UI 框架和 Context API            | react                     |
| TypeScript               | 类型安全                         | typescript                |
| UseStream                | 线程流状态类型                   | @langchain/langgraph-sdk  |
| AgentThreadState         | 线程状态类型                     | frontend_core_domain_types_and_state |
| useSidebar               | 侧边栏状态管理 Hook              | 内部 UI 组件库            |
| env                      | 环境变量访问                     | 内部环境配置              |

## 6. 关键模块与典型用例

### 6.1 使用 ArtifactsContext

**功能说明**：ArtifactsContext 用于管理工作区中的工件列表和选择状态。

**配置与依赖**：
- 必须在组件树中使用 `ArtifactsProvider` 包裹
- 可选依赖：环境变量 `NEXT_PUBLIC_STATIC_WEBSITE_ONLY`

**示例代码**：

```tsx
// 在应用顶层
import { ArtifactsProvider } from "@/components/workspace/artifacts/context";

function App() {
  return (
    <ArtifactsProvider>
      <YourAppComponents />
    </ArtifactsProvider>
  );
}

// 在子组件中使用
import { useArtifacts } from "@/components/workspace/artifacts/context";

function ArtifactList() {
  const { artifacts, selectedArtifact, select, setArtifacts } = useArtifacts();
  
  // 设置工件列表
  const loadArtifacts = () => {
    setArtifacts(['file1.txt', 'file2.txt', 'file3.txt']);
  };
  
  return (
    <div>
      <button onClick={loadArtifacts}>加载工件</button>
      {artifacts.map(artifact => (
        <div 
          key={artifact}
          onClick={() => select(artifact)}
          className={selectedArtifact === artifact ? 'selected' : ''}
        >
          {artifact}
        </div>
      ))}
    </div>
  );
}
```

### 6.2 使用 ThreadContext

**功能说明**：ThreadContext 用于共享当前线程的 ID 和状态流。

**配置与依赖**：
- 必须在组件树中使用 `ThreadContext.Provider` 包裹
- 依赖：`@langchain/langgraph-sdk/react` 的 `UseStream` 类型
- 依赖：`frontend_core_domain_types_and_state` 的 `AgentThreadState` 类型

**示例代码**：

```tsx
// 在线程组件顶层
import { ThreadContext } from "@/components/workspace/messages/context";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { AgentThreadState } from "@/core/threads";

function ThreadView({ threadId }: { threadId: string }) {
  const thread = useStream<AgentThreadState>({ threadId });
  
  return (
    <ThreadContext.Provider value={{ threadId, thread }}>
      <ThreadMessages />
      <ThreadInput />
    </ThreadContext.Provider>
  );
}

// 在子组件中使用
import { useThread } from "@/components/workspace/messages/context";

function ThreadMessages() {
  const { thread } = useThread();
  
  return (
    <div>
      {thread.messages.map((message, index) => (
        <div key={index}>{message.content}</div>
      ))}
    </div>
  );
}
```

## 7. 配置、部署与开发

### 7.1 环境变量

该模块使用以下环境变量：

- `NEXT_PUBLIC_STATIC_WEBSITE_ONLY`：控制是否为静态网站模式，影响侧边栏的默认打开状态和工件选择行为。

### 7.2 开发注意事项

1. **Provider 包裹**：确保在使用对应的 Hook 之前，组件已被相应的 Provider 包裹。
2. **类型安全**：利用 TypeScript 类型定义确保上下文使用的正确性。
3. **状态更新**：当更新上下文状态时，注意避免不必要的重渲染，可以考虑使用 useMemo 或其他优化技术。

## 8. 监控与维护

### 8.1 常见问题与解决方案

**问题 1**："useArtifacts must be used within an ArtifactsProvider" 错误
- **原因**：在 ArtifactsProvider 外部使用了 useArtifacts Hook
- **解决方案**：确保组件树被 ArtifactsProvider 包裹

**问题 2**："useThread must be used within a ThreadContext" 错误
- **原因**：在 ThreadContext.Provider 外部使用了 useThread Hook
- **解决方案**：确保组件树被 ThreadContext.Provider 包裹

**问题 3**：工件选择后侧边栏没有关闭
- **原因**：可能是环境变量 NEXT_PUBLIC_STATIC_WEBSITE_ONLY 设置为 "true"
- **解决方案**：检查环境变量设置，或修改 select 函数的逻辑

## 9. 总结

`frontend_workspace_contexts` 模块是前端工作区功能的核心支撑模块，通过 React Context 机制提供了状态共享的基础设施。它的两个主要子模块分别处理工件管理和线程状态，为构建功能丰富的工作区应用提供了必要的状态管理能力。

该模块遵循 React 最佳实践，提供了类型安全的接口和安全的访问机制，同时与环境变量和其他 UI 组件集成，为开发者提供了灵活且强大的工具来构建工作区相关功能。
