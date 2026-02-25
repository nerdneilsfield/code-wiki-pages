# orchestration-runtime Module

## Introduction

The `orchestration-runtime` module is the execution core of CodeWiki’s agent-based documentation workflow.

Its main component, `AgentOrchestrator`, is responsible for:

- selecting the right AI agent profile for a module,
- injecting runtime dependencies (repository/docs paths, module tree, depth constraints, config),
- executing the agent with the correct prompts and tools,
- handling idempotency checks and persistence of orchestration state.

In short: this module turns *module metadata + code components* into an actual **agent run** that writes documentation artifacts.

---

## Position in the System

```mermaid
flowchart LR
    CLI[CLI Interface / Web Frontend] --> DG[Documentation Generator]
    DG --> ORT[orchestration-runtime\nAgentOrchestrator]

    ORT --> DEPCTX[agent-dependency-context\nCodeWikiDeps]
    ORT --> TOOLS[agent-editing-toolchain\nread_code_components, str_replace_editor,\ngenerate_sub_module_documentation]
    ORT --> PROMPTS[prompt templates]
    ORT --> LLM[LLM services\nFallback models]

    TOOLS --> DOCS[docs/*.md]
    ORT --> MT[module_tree.json]

    ORT --> DA[Dependency Analyzer models\nNode]
    ORT --> SC[Shared Configuration and Utilities\nConfig, FileManager]
```

`orchestration-runtime` is not a parser and not a renderer—it is the **runtime coordinator** for AI documentation agents.

---

## Core Component: `AgentOrchestrator`

### Class Responsibilities

`AgentOrchestrator` owns three key responsibilities:

1. **Runtime bootstrap**
   - Stores global `Config`.
   - Builds fallback model chain via `create_fallback_models(config)`.
   - Extracts prompt customizations (`config.get_prompt_addition()`) and output language.

2. **Agent construction strategy** (`create_agent`)
   - Uses `is_complex_module(...)` to decide between:
     - **complex-module agent**: can generate sub-module docs (`generate_sub_module_documentation_tool` included),
     - **leaf-module agent**: read/edit tools only.
   - Chooses matching system prompt template:
     - `format_system_prompt(...)` for complex modules,
     - `format_leaf_system_prompt(...)` for leaf modules.

3. **Module execution lifecycle** (`process_module`)
   - Loads module tree from docs workspace.
   - Builds `CodeWikiDeps` runtime context.
   - Applies skip guards when output artifacts already exist.
   - Runs agent with `format_user_prompt(...)`.
   - Persists updated `module_tree.json`.
   - Logs and rethrows exceptions.

---

## Internal Architecture

```mermaid
graph TD
    A[AgentOrchestrator.__init__] --> B[create_fallback_models]
    A --> C[Config prompt additions + output language]

    D[create_agent] --> E{is_complex_module?}
    E -->|Yes| F[Agent with 3 tools\nread + edit + submodule-gen]
    E -->|No| G[Agent with 2 tools\nread + edit]
    F --> H[format_system_prompt]
    G --> I[format_leaf_system_prompt]

    J[process_module] --> K[load module_tree.json]
    J --> L[build CodeWikiDeps]
    J --> M[artifact existence checks]
    M -->|already exists| N[return without run]
    M -->|missing| O[agent run with prompt and deps]
    O --> P[save module_tree.json]
    O --> Q[return updated tree]
```

---

## Dependency Map

```mermaid
graph LR
    ORT[AgentOrchestrator]

    ORT --> CFG[Config]
    ORT --> FILE[file_manager]
    ORT --> NODE[dependency_analyzer.models.core.Node]

    ORT --> LLM[create_fallback_models]
    ORT --> PROMPT[format_user_prompt / format_system_prompt / format_leaf_system_prompt]
    ORT --> COMPLEX[is_complex_module]

    ORT --> DEPS[CodeWikiDeps]
    ORT --> TOOL1[read_code_components_tool]
    ORT --> TOOL2[str_replace_editor_tool]
    ORT --> TOOL3[generate_sub_module_documentation_tool]

    ORT --> AGENT[pydantic_ai.Agent]
```

### External modules to reference

- Dependency and context object details: [agent-dependency-context.md](agent-dependency-context.md)
- Editor and file mutation toolchain: [agent-editing-toolchain.md](agent-editing-toolchain.md)
- Top-level orchestration layer: [agent-orchestration.md](agent-orchestration.md)
- Global config and file I/O helpers: [shared-configuration-and-utilities.md](shared-configuration-and-utilities.md)
- Upstream workflow driver: [documentation-generator.md](documentation-generator.md)

---

## Data Flow

```mermaid
flowchart TD
    IN1[module_name]
    IN2[core_component_ids]
    IN3[components dict of Node objects]
    IN4[module_path]
    IN5[working_dir]

    IN1 --> PM[process_module]
    IN2 --> PM
    IN3 --> PM
    IN4 --> PM
    IN5 --> PM

    PM --> LOAD[load module_tree from docs dir]
    PM --> BUILD[construct CodeWikiDeps]
    PM --> CHECK{overview/module doc exists?}

    CHECK -->|Yes| OUT1[return existing module_tree]
    CHECK -->|No| RUN[agent run with user prompt and deps]

    RUN --> SAVE[save updated module_tree.json]
    SAVE --> OUT2[return updated module_tree]
```

### Runtime Context (`CodeWikiDeps`) injected into agent

`AgentOrchestrator` passes a rich dependency object to tools and agent runtime, including:

- absolute docs and repo paths,
- current module identity and module-tree location,
- full component registry for lookup,
- recursion limits (`max_depth`, `current_depth`),
- global config and custom instructions.

This context is the contract that allows agent tools to behave deterministically across nested module-generation steps.

---

## Component Interaction Sequence

```mermaid
sequenceDiagram
    participant Up as DocumentationGenerator/Caller
    participant Or as AgentOrchestrator
    participant Fm as file_manager
    participant Ag as pydantic_ai.Agent
    participant Tl as Agent Tools

    Up->>Or: process_module(module_name, components, core_ids, module_path, working_dir)
    Or->>Fm: load_json(module_tree_path)
    Fm-->>Or: module_tree

    Or->>Or: create_agent(...)
    Or->>Or: build CodeWikiDeps(...)
    Or->>Or: check overview/module doc existence

    alt artifacts already exist
        Or-->>Up: return module_tree (skip)
    else artifacts missing
        Or->>Ag: run(format_user_prompt(...), deps)
        Ag->>Tl: invoke read/edit/submodule tools
        Tl-->>Ag: tool results
        Ag-->>Or: agent result
        Or->>Fm: save_json(deps.module_tree, module_tree_path)
        Or-->>Up: return deps.module_tree
    end
```

---

## Process Flow (State-Oriented)

```mermaid
stateDiagram-v2
    [*] --> Initialized
    Initialized --> AgentSelected: create_agent()
    AgentSelected --> DepsReady: CodeWikiDeps built
    DepsReady --> SkipCheck: output guards
    SkipCheck --> Skipped: artifacts already exist
    SkipCheck --> Running: agent.run(...)
    Running --> Persisted: save module tree
    Persisted --> Completed
    Skipped --> Completed
    Running --> Failed: exception
    Failed --> [*]
    Completed --> [*]
```

---

## Notable Runtime Behaviors

- **Complexity-based capability elevation**: only multi-file (complex) modules receive the sub-module generation tool.
- **Prompt specialization**: system prompt differs for complex vs leaf modules; user prompt always includes formatted module tree and grouped core-component code.
- **Idempotency guards**:
  - If overview artifact exists, execution short-circuits.
  - If module markdown already exists, execution short-circuits.
- **Persistent orchestration state**: updated module tree is written back after successful run.
- **Fail-fast errors**: exceptions are logged with traceback and re-raised for upstream handling.

---

## Operational and Maintenance Notes

1. **Guard ordering matters**
   - `overview` existence is checked before module doc existence; this can bypass run execution early.
   - If behavior changes are needed (e.g., regenerate module docs while overview exists), update guard policy explicitly.

2. **`module_tree` nullability**
   - `load_json` can return `None` when file is missing; callers should ensure the file is initialized before orchestration starts.

3. **Depth control is delegated via deps**
   - Recursive or sub-module generation policy is carried through `CodeWikiDeps` (`max_depth`, `current_depth`).

4. **Tool contract stability is critical**
   - Runtime correctness depends on agent tools (`read_code_components`, `str_replace_editor`, sub-module generator) honoring `CodeWikiDeps` conventions.

---

## How This Module Fits the Overall Architecture

`orchestration-runtime` is the **execution bridge** between static analysis/planning and concrete markdown output.

- Upstream modules decide *what* module should be generated.
- This module decides *how* to run the agent for that module.
- Toolchain modules perform *actual file/code interactions*.

```mermaid
flowchart LR
    PLAN[Dependency Analyzer + Clustering + Job planning] --> ORT[orchestration-runtime]
    ORT --> TOOLS[Tool invocations]
    TOOLS --> DOCS[Generated docs]
    DOCS --> POST[HTML/Git/Frontend consumption]
```

---

## Related Documentation

- [agent-orchestration.md](agent-orchestration.md)
- [agent-dependency-context.md](agent-dependency-context.md)
- [agent-editing-toolchain.md](agent-editing-toolchain.md)
- [documentation-generator.md](documentation-generator.md)
- [dependency-analyzer.md](dependency-analyzer.md)
- [shared-configuration-and-utilities.md](shared-configuration-and-utilities.md)
