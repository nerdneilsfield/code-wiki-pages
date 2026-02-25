# dependency-graph-build-and-leaf-selection Module

## Introduction

The `dependency-graph-build-and-leaf-selection` module is the finalization layer of dependency analysis.
Its core component, `DependencyGraphBuilder`, transforms parsed repository components into a traversable dependency graph, persists graph artifacts, and selects valid **leaf nodes** that are suitable as downstream documentation entry points.

In the Dependency Analyzer pipeline, this module sits after component projection and before documentation planning/generation.

---

## Core Component

### `DependencyGraphBuilder`

`DependencyGraphBuilder` exposes one primary workflow method:

- **`build_dependency_graph() -> tuple[Dict[str, Any], List[str]]`**

It performs six responsibilities in order:

1. Ensure dependency graph output directory exists.
2. Build repository-scoped output file paths (sanitized repo name).
3. Read include/exclude file patterns from runtime config.
4. Parse repository components via `DependencyParser`.
5. Build in-memory graph and compute candidate leaf nodes.
6. Apply post-filtering to keep only valid, component-backed, type-eligible leaf IDs.

---

## Architectural Position

```mermaid
flowchart LR
    CFG[Config\nShared Configuration and Utilities] --> DGB[DependencyGraphBuilder]

    DGB --> DP[DependencyParser\ndependency-parser-and-component-projection]
    DP --> AS[AnalysisService\nanalysis-service-orchestration]
    AS --> CGA[CallGraphAnalyzer\ncall-graph-analysis-engine]
    AS --> RSA[RepoAnalyzer\nrepository-structure-analysis]

    DGB --> TS[topo_sort\nbuild_graph_from_components + get_leaf_nodes]
    DGB --> FM[file_manager.ensure_directory]

    DGB --> OUT1[dependency_graph.json]
    DGB --> OUT2[components map + filtered leaf_nodes]
```

`DependencyGraphBuilder` does not parse AST directly; it composes:

- projection from [`dependency-parser-and-component-projection.md`](dependency-parser-and-component-projection.md), and
- graph/leaf algorithms from topo-sort helpers.

---

## Dependency Relationships

```mermaid
graph TD
    DGB[DependencyGraphBuilder]

    DGB --> C[Config]
    DGB --> P[DependencyParser]
    DGB --> BG[build_graph_from_components]
    DGB --> GL[get_leaf_nodes]
    DGB --> FM[file_manager.ensure_directory]
    DGB --> OS[os.path]
    DGB --> LOG[logging]

    P --> AS[AnalysisService]
    AS --> RSA[RepoAnalyzer]
    AS --> CGA[CallGraphAnalyzer]
```

### Key dependency semantics

- `Config` provides:
  - `repo_path`
  - `dependency_graph_dir`
  - `include_patterns` / `exclude_patterns` (from agent instructions)
- `DependencyParser` returns normalized `components: Dict[str, Node]`.
- `build_graph_from_components` converts `Node.depends_on` into adjacency sets.
- `get_leaf_nodes` derives initial leaves after cycle handling.
- `DependencyGraphBuilder` then applies **additional hardening filter logic** before returning leaf nodes.

---

## End-to-End Data Flow

```mermaid
flowchart TD
    IN[Config and repo path] --> DIR[Ensure output directory]
    DIR --> PATHS[Build sanitized output paths]
    PATHS --> PARSER[Create DependencyParser with filters]
    PARSER --> COMP[Parse repository components]
    COMP --> SAVE[Save dependency graph json]

    COMP --> GRAPH[Build adjacency graph]
    GRAPH --> LEAVES[Get candidate leaf nodes]
    LEAVES --> FILTER[Apply leaf validation and type filter]
    FILTER --> OUT[Return components and leaf nodes]
```

---

## Component Interaction (Sequence)

```mermaid
sequenceDiagram
    participant Caller
    participant DGB as DependencyGraphBuilder
    participant FM as file_manager
    participant DP as DependencyParser
    participant TS as topo_sort

    Caller->>DGB: build_dependency_graph()
    DGB->>FM: ensure_directory(config.dependency_graph_dir)
    DGB->>DGB: compute sanitized repo-based file paths
    DGB->>DP: DependencyParser(repo_path, include_patterns, exclude_patterns)
    DGB->>DP: parse_repository(filtered_folders=None)
    DP-->>DGB: components
    DGB->>DP: save_dependency_graph(dependency_graph_path)

    DGB->>TS: build_graph_from_components(components)
    TS-->>DGB: graph
    DGB->>TS: get_leaf_nodes(graph, components)
    TS-->>DGB: candidate leaf_nodes

    DGB->>DGB: validate/filter candidates
    DGB-->>Caller: (components, keep_leaf_nodes)
```

---

## Leaf Selection and Filtering Logic

The module performs a two-stage leaf strategy:

1. **Topology stage** (from `get_leaf_nodes`) to get candidate leaves.
2. **Validation stage** (inside `DependencyGraphBuilder`) to enforce runtime quality constraints.

### Validation rules in `DependencyGraphBuilder`

- Reject invalid identifiers:
  - non-string
  - empty/whitespace-only
  - strings containing error markers (`error`, `exception`, `failed`, `invalid`)
- Keep only IDs that exist in `components`.
- Keep only components with allowed `component_type`:
  - default: `{class, interface, struct}`
  - fallback: include `function` if none of those structural types exist in the repository.

```mermaid
flowchart TD
    CANDS[candidate leaf_nodes] --> V1{is non-empty string\nand not error-like?}
    V1 -- no --> DROP1[discard]
    V1 -- yes --> V2{exists in components?}
    V2 -- no --> DROP2[warn + discard]
    V2 -- yes --> V3{component_type in valid_types?}
    V3 -- no --> DROP3[discard]
    V3 -- yes --> KEEP[append to keep_leaf_nodes]
```

This extra filter protects downstream module/document generation from malformed graph outputs and from selecting semantically weak node types.

---

## Build Process Flow (Operational)

```mermaid
stateDiagram-v2
    [*] --> Initialized
    Initialized --> OutputPrepared: ensure output dir + build paths
    OutputPrepared --> Parsed: parser.parse_repository
    Parsed --> GraphPersisted: parser.save_dependency_graph
    GraphPersisted --> GraphBuilt: build_graph_from_components
    GraphBuilt --> CandidateLeaves: get_leaf_nodes
    CandidateLeaves --> FilteredLeaves: validate + type-filter
    FilteredLeaves --> Completed: return tuple
    Completed --> [*]

    Parsed --> Failed
    GraphPersisted --> Failed
    GraphBuilt --> Failed
    CandidateLeaves --> Failed
    Failed --> [*]
```

---

## Inputs and Outputs

### Input

- `DependencyGraphBuilder(config: Config)`
  - expects a fully initialized config with repository and output paths.

### Output of `build_dependency_graph()`

- `components: Dict[str, Node-like]`
  - keyed by canonical component ID
  - each value includes metadata and dependency references (`depends_on`)
- `keep_leaf_nodes: List[str]`
  - validated leaf component IDs suitable for downstream selection logic

### Side effects

- Creates output directory if missing.
- Writes `<sanitized_repo>_dependency_graph.json` under `dependency_graph_dir`.
- (Currently disabled in code) reserved path for `<sanitized_repo>_filtered_folders.json` caching.

---

## Error Handling and Robustness Notes

- Uses conservative leaf-node validation to avoid propagating parser/analyzer artifacts.
- Logs warnings for unknown or invalid leaf IDs rather than failing entire build.
- Uses repository-name sanitization for filesystem-safe output filenames.
- Relies on upstream parser/analyzer modules for deep error handling; see:
  - [`dependency-parser-and-component-projection.md`](dependency-parser-and-component-projection.md)
  - [`analysis-service-orchestration.md`](analysis-service-orchestration.md)

---

## Cross-Module Context

For deeper details, refer to:

- **Component projection and serialization**: [`dependency-parser-and-component-projection.md`](dependency-parser-and-component-projection.md)
- **Analysis orchestration and multi-language pipeline**: [`analysis-service-orchestration.md`](analysis-service-orchestration.md)
- **Call graph extraction internals**: [`call-graph-analysis-engine.md`](call-graph-analysis-engine.md)
- **Repository file tree and filtering policies**: [`repository-structure-analysis.md`](repository-structure-analysis.md)

This module should be read as the graph finalization/selection layer on top of those lower-level analysis modules.
