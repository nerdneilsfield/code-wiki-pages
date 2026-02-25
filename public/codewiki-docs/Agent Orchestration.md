# Agent Orchestration

## 简介与职责

`Agent Orchestration` 模块是 CodeWiki 文档生成流程中的**执行中枢**：它负责把“模块树 + 核心组件代码 + 运行配置”转化为一次可执行的 AI Agent 文档生成任务，并通过受控工具链完成文档落盘。

该模块核心价值：

- 根据模块复杂度动态装配 Agent 能力（普通模块 vs 复杂模块）
- 注入统一运行时依赖上下文（`CodeWikiDeps`）
- 协调工具调用（读代码、编辑文档、生成子模块文档）
- 保证幂等执行（已有文档时跳过）与状态持久化（`module_tree.json`）

---

## 在系统中的位置

```mermaid
flowchart LR
    CLI[CLI Interface] --> DG[Documentation Generator]
    FE[Web Frontend] --> DG

    DG --> AO[Agent Orchestration]

    AO --> DA[Dependency Analyzer]
    AO --> LAT[Language Analyzers]
    AO --> DOCS[docs/*.md]
    AO --> MT[module_tree.json]

    AO --> SCU[Shared Configuration and Utilities]
```

- 与上游关系：由 [Documentation Generator.md](Documentation Generator.md) 触发具体模块文档生成。
- 与下游关系：产出的 Markdown 后续可被 [CLI Interface.md](CLI Interface.md) 的 HTML/Git 流程或 [Web Frontend.md](Web Frontend.md) 消费。

> 说明：本文件聚焦 **Agent Orchestration**，不重复依赖分析细节。依赖图构建请见 [Dependency Analyzer.md](Dependency Analyzer.md) 与 [Language Analyzers.md](Language Analyzers.md)。

---

## 架构总览

```mermaid
graph TD
    A[AgentOrchestrator] --> B[create_agent]
    B --> C{is_complex_module?}
    C -->|Yes| D[Agent + read_code_components + str_replace_editor + generate_sub_module_documentation]
    C -->|No| E[Agent + read_code_components + str_replace_editor]

    A --> F[process_module]
    F --> G[加载 module_tree.json]
    F --> H[构建 CodeWikiDeps]
    F --> I{overview/module 文档是否已存在}
    I -->|是| J[直接返回]
    I -->|否| K[agent.run + user prompt]
    K --> L[工具写入 docs]
    K --> M[保存 module_tree.json]
```

---

## 核心组件与子模块

当前模块可分为 3 个子模块：

1. **orchestration-runtime**（运行时编排）  
   负责 Agent 创建策略、执行流程、跳过策略与状态持久化。  
   详见：[orchestration-runtime.md](orchestration-runtime.md)

2. **agent-dependency-context**（依赖上下文契约）  
   通过 `CodeWikiDeps` 承载路径、组件、模块树、深度控制与全局配置。  
   详见：[agent-dependency-context.md](agent-dependency-context.md)

3. **agent-editing-toolchain**（编辑工具链）  
   提供 `WindowExpander`、`EditTool`、`Filemap` 等能力，支撑安全可回滚的文档编辑。  
   详见：[agent-editing-toolchain.md](agent-editing-toolchain.md)

---

## 关键组件关系

```mermaid
classDiagram
    class AgentOrchestrator {
      +create_agent(module_name, components, core_component_ids)
      +process_module(module_name, components, core_component_ids, module_path, working_dir)
    }

    class CodeWikiDeps {
      +absolute_docs_path
      +absolute_repo_path
      +registry
      +components
      +path_to_current_module
      +current_module_name
      +module_tree
      +max_depth
      +current_depth
      +config
      +custom_instructions
    }

    class EditTool
    class WindowExpander
    class Filemap

    AgentOrchestrator --> CodeWikiDeps : 构建并注入
    AgentOrchestrator --> EditTool : 通过 str_replace_editor 调用
    EditTool --> WindowExpander : 视窗扩展
    EditTool --> Filemap : 大文件摘要(可选)
```

---

## 端到端数据流

```mermaid
sequenceDiagram
    participant U as 上游调用方(Documentation Generator)
    participant O as AgentOrchestrator
    participant D as CodeWikiDeps
    participant A as pydantic_ai.Agent
    participant T as Agent Tools
    participant FS as docs/module_tree 持久层

    U->>O: process_module(...)
    O->>FS: 读取 module_tree.json
    O->>O: create_agent(按复杂度装配)
    O->>D: 构建运行时依赖

    alt 文档已存在
      O-->>U: 跳过并返回 module_tree
    else 需要生成
      O->>A: run(format_user_prompt, deps=D)
      A->>T: 调用 read/edit/submodule tools
      T-->>A: 返回结果
      A-->>O: run result
      O->>FS: 保存更新后的 module_tree.json
      O-->>U: 返回最新 module_tree
    end
```

---

## 设计要点（维护视角）

- **能力按复杂度升级**：复杂模块才启用 `generate_sub_module_documentation`，避免简单模块过度拆分。
- **仓库与文档目录隔离**：`str_replace_editor` 在 `repo` 目录仅允许 `view`，编辑仅限 `docs`，降低误改源码风险。
- **幂等与可恢复**：已存在文档即跳过；工具支持 `undo_edit`。
- **统一上下文协议**：工具和 Agent 通过 `CodeWikiDeps` 共享同一运行时事实，减少参数漂移。

---

## 与其它模块的边界

- 依赖分析来源： [Dependency Analyzer.md](Dependency Analyzer.md)、[Language Analyzers.md](Language Analyzers.md)
- 任务与配置模型： [CLI Models.md](CLI Models.md)
- 触发入口与运维交互： [CLI Interface.md](CLI Interface.md)、[Web Frontend.md](Web Frontend.md)
- 全局配置与文件工具： [Shared Configuration and Utilities.md](Shared Configuration and Utilities.md)

---

## 文件索引

- 主文档：`Agent Orchestration.md`
- 子模块：
  - `orchestration-runtime.md`
  - `agent-dependency-context.md`
  - `agent-editing-toolchain.md`
