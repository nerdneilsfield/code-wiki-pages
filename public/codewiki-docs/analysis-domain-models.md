# analysis-domain-models Module

## Introduction

The `analysis-domain-models` module defines the **canonical data contracts** used across the Dependency Analyzer pipeline.
It provides the shared Pydantic models that represent:

- repository identity and analysis context,
- discovered code components,
- caller/callee relationships,
- assembled analysis output, and
- optional user-driven node selection for partial export.

In short: this module is the **schema backbone** that keeps parsing, graph-building, and orchestration layers interoperable.

---

## Core Components

- `Node`
- `CallRelationship`
- `Repository`
- `AnalysisResult`
- `NodeSelection`

---

## Architectural Role in the System

```mermaid
flowchart LR
    RSA[RepoAnalyzer\nrepository-structure-analysis] --> AS[AnalysisService\nanalysis-service-orchestration]
    CGA[CallGraphAnalyzer\ncall-graph-analysis-engine] --> AS

    AS --> AR[AnalysisResult]
    AR --> REPO[Repository]
    AR --> NODE[Node list]
    AR --> REL[CallRelationship list]

    DP[DependencyParser\ndependency-parser-and-component-projection] --> NODE
    DGB[DependencyGraphBuilder\ndependency-graph-build-and-leaf-selection] --> NODE

    NS[NodeSelection] --> DGB
```

### Why this matters

These models decouple subsystem responsibilities:

- analyzers can focus on extraction,
- orchestrators can focus on workflow,
- graph/build/export layers can consume stable typed structures.

---

## Domain Model Structure

```mermaid
classDiagram
    class Repository {
      +str url
      +str name
      +str clone_path
      +str analysis_id
    }

    class Node {
      +str id
      +str name
      +str component_type
      +str file_path
      +str relative_path
      +Set~str~ depends_on
      +Optional~str~ source_code
      +int start_line
      +int end_line
      +bool has_docstring
      +str docstring
      +Optional~List~str~~ parameters
      +Optional~str~ node_type
      +Optional~List~str~~ base_classes
      +Optional~str~ class_name
      +Optional~str~ display_name
      +Optional~str~ component_id
      +get_display_name() str
    }

    class CallRelationship {
      +str caller
      +str callee
      +Optional~int~ call_line
      +bool is_resolved
    }

    class AnalysisResult {
      +Repository repository
      +List~Node~ functions
      +List~CallRelationship~ relationships
      +Dict~str,Any~ file_tree
      +Dict~str,Any~ summary
      +Dict~str,Any~ visualization
      +Optional~str~ readme_content
    }

    class NodeSelection {
      +List~str~ selected_nodes
      +bool include_relationships
      +Dict~str,str~ custom_names
    }

    AnalysisResult --> Repository
    AnalysisResult --> Node
    AnalysisResult --> CallRelationship
```

---

## Component Details

### `Node`

Represents a single code component discovered by analyzers and later used in dependency graph construction.

Key semantics:

- `id`: canonical unique identifier (primary key across modules).
- `component_type`: semantic role (`class`, `interface`, `struct`, `function`, etc.).
- `depends_on`: outgoing dependency edges to other node IDs.
- `source_code`, `docstring`, `parameters`, line-range fields: metadata for documentation and analysis quality.
- `display_name` + `get_display_name()`: presentation-safe label fallback to `name`.

Used heavily by:

- [`dependency-parser-and-component-projection.md`](dependency-parser-and-component-projection.md)
- [`dependency-graph-build-and-leaf-selection.md`](dependency-graph-build-and-leaf-selection.md)

### `CallRelationship`

Represents a raw or resolved call edge between two component IDs/names.

- `caller` / `callee`: relationship endpoints.
- `call_line`: source line hint when available.
- `is_resolved`: indicates whether endpoint resolution has high confidence.

This model is a transfer object between call-graph extraction and projection logic.

### `Repository`

Stores repository-level metadata for traceability:

- origin (`url`),
- logical identity (`name`),
- local runtime location (`clone_path`),
- analysis run ID (`analysis_id`).

Primarily assembled by [`analysis-service-orchestration.md`](analysis-service-orchestration.md).

### `AnalysisResult`

Top-level aggregate returned by full analysis mode.

It consolidates:

- repository metadata,
- discovered nodes and relationships,
- file tree + summary statistics,
- visualization payload,
- optional README content.

This is the module’s central integration contract.

### `NodeSelection`

Defines selective export scope for downstream workflows.

- `selected_nodes`: explicit node IDs to include.
- `include_relationships`: whether to include graph edges among selected nodes.
- `custom_names`: optional alias mapping for display/custom packaging.

This model supports partial, user-directed documentation generation without mutating source analysis data.

---

## Dependency Relationships (Code-Level)

```mermaid
graph TD
    ANALYSISPY[models.analysis] --> COREPY[models.core]
    ANALYSISPY --> PYD[pydantic.BaseModel]
    COREPY --> PYD

    ANALYSISPY --> NODE[Node]
    ANALYSISPY --> REL[CallRelationship]
    ANALYSISPY --> REPO[Repository]
```

- `models.analysis` depends on `models.core` for reusable primitives.
- All models inherit from `BaseModel`, enabling validation/serialization and predictable schema behavior.

---

## Data Flow Across Modules

```mermaid
flowchart TD
    A[CallGraphAnalyzer output\nfunctions + relationships] --> B[DependencyParser]
    B --> C[Node objects + depends_on projection]

    D[RepoAnalyzer output\nfile_tree + summary] --> E[AnalysisService]
    C --> E

    E --> F[AnalysisResult]
    F --> G[DependencyGraphBuilder / Documentation pipeline]

    H[User/agent selected subset] --> I[NodeSelection]
    I --> G
```

Interpretation:

1. Raw extraction generates low-level function/relationship data.
2. Projection normalizes them into `Node` and edge contracts.
3. Orchestration composes everything into `AnalysisResult`.
4. Optional `NodeSelection` narrows downstream processing scope.

---

## Component Interaction (Sequence)

```mermaid
sequenceDiagram
    participant AS as AnalysisService
    participant CG as CallGraphAnalyzer
    participant DP as DependencyParser
    participant DGB as DependencyGraphBuilder

    AS->>CG: analyze_code_files(...)
    CG-->>AS: functions, relationships, visualization
    AS->>AS: build Repository + AnalysisResult

    DP->>AS: _analyze_structure + _analyze_call_graph
    AS-->>DP: call_graph_result
    DP->>DP: convert to Node, project depends_on

    DGB->>DP: parse_repository()
    DP-->>DGB: Dict[id, Node]
    DGB->>DGB: build graph + select leaf nodes
```

---

## Model Lifecycle and Process Flow

```mermaid
stateDiagram-v2
    [*] --> Extracted: analyzer emits raw data
    Extracted --> Normalized: Node / CallRelationship created
    Normalized --> Aggregated: AnalysisResult assembled
    Aggregated --> Scoped: optional NodeSelection applied
    Scoped --> Consumed: graph build, docs, exports
    Consumed --> [*]
```

---

## Contract and Validation Notes

- Models are typed with Pydantic `BaseModel`, providing runtime validation and structured dumps.
- `Node.depends_on` is set-based in memory (good for deduplication) and often converted to list for JSON serialization by downstream components.
- `AnalysisResult.visualization` and `summary` are flexible `Dict[str, Any]` contracts to support analyzer evolution without frequent schema churn.
- `NodeSelection` defaults allow no-selection/relationship-inclusive behavior out of the box.

### Practical caution for maintainers

Several fields use mutable defaults (`{}`, `[]`, `set()`). If refactoring model behavior, prefer explicit `Field(default_factory=...)` patterns to avoid accidental shared-state edge cases and to keep intent clear.

---

## How This Module Fits the Overall System

The `analysis-domain-models` module sits at the center of the Dependency Analyzer subsystem:

- Upstream analyzers produce data that must map into these models.
- Midstream orchestration uses these models to compose stable outputs.
- Downstream graph/documentation modules rely on these contracts for selection, traversal, and rendering.

Because of this central role, changes to these schemas should be treated as **cross-module contract changes**.

---

## Cross-Module References

For implementation details beyond these models, see:

- Analysis workflow orchestration: [`analysis-service-orchestration.md`](analysis-service-orchestration.md)
- Component projection from analyzer output: [`dependency-parser-and-component-projection.md`](dependency-parser-and-component-projection.md)
- Graph construction and leaf-node filtering: [`dependency-graph-build-and-leaf-selection.md`](dependency-graph-build-and-leaf-selection.md)
- Call graph extraction internals: [`call-graph-analysis-engine.md`](call-graph-analysis-engine.md)
- Repository structure scan and filtering: [`repository-structure-analysis.md`](repository-structure-analysis.md)
