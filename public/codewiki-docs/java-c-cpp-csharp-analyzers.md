# java-c-cpp-csharp-analyzers

## Introduction

The **java-c-cpp-csharp-analyzers** module provides Tree-sitter-based static analysis for four compiled language families in CodeWiki’s Dependency Analyzer pipeline:

- Java (`TreeSitterJavaAnalyzer`)
- C (`TreeSitterCAnalyzer`)
- C++ (`TreeSitterCppAnalyzer`)
- C# (`TreeSitterCSharpAnalyzer`)

Its responsibility is to transform a single source file into normalized graph primitives:

- `Node` objects (discovered components)
- `CallRelationship` edges (dependencies and usage links)

These outputs are consumed downstream by graph resolution/projection services rather than fully resolved in this module.

---

## Scope and Responsibilities

This module focuses on **language-specific AST extraction**, not repository orchestration.

### What it does

1. Parse one file at a time using Tree-sitter grammars.
2. Extract language constructs into `Node` entries.
3. Build stable component IDs based on repository-relative module paths.
4. Emit relationship edges (calls, inheritance, field/property/type usage, object creation).
5. Return `(List[Node], List[CallRelationship])` through wrapper functions.

### What it does not do

- Repository traversal and file discovery.
- Cross-repository/global symbol resolution.
- Final deduplication/normalization across all files.

Those responsibilities are handled by:
- [call-graph-analysis-engine](call-graph-analysis-engine.md)
- [dependency-parser-and-component-projection](dependency-parser-and-component-projection.md)
- [analysis-service-orchestration](analysis-service-orchestration.md)

---

## Core Components

### `TreeSitterJavaAnalyzer`
**Path:** `codewiki.src.be.dependency_analyzer.analyzers.java.TreeSitterJavaAnalyzer`

Extracts nodes for:
- class / abstract class
- interface
- enum
- record
- annotation
- method (stored as `ClassName.method` name when class context exists)

Extracts relationships for:
- inheritance (`class extends`)
- interface implementation (`implements`)
- field type usage
- method invocation (object-based, heuristic variable type lookup)
- object creation (`new`)

Key characteristics:
- Uses primitive/common built-in filter set to avoid noisy links.
- Frequently emits unresolved edges (`is_resolved=False`) for later global resolution.

---

### `TreeSitterCAnalyzer`
**Path:** `codewiki.src.be.dependency_analyzer.analyzers.c.TreeSitterCAnalyzer`

Extracts nodes for:
- function definitions
- struct definitions (including typedef-struct forms)
- global variables (tracked in lookup map; only function/struct emitted in final `nodes` list)

Extracts relationships for:
- function-to-function calls (excluding known libc/system functions)
- function usage of global variables

Key characteristics:
- Treats global variable references as resolved intra-file dependencies.
- Emits function call targets as simple names for later cross-file resolution.

---

### `TreeSitterCppAnalyzer`
**Path:** `codewiki.src.be.dependency_analyzer.analyzers.cpp.TreeSitterCppAnalyzer`

Extracts nodes for:
- class
- struct
- function
- method (detected from enclosing class/struct; used in lookup)
- namespace
- global variable

Extracts relationships for:
- call expressions (`calls`)
- class inheritance (`inherits`)
- object creation (`creates`)
- global variable usage (`uses`)

Key characteristics:
- Distinguishes class methods vs free functions where possible.
- Applies heuristic class-method target detection (`_class_has_method`) for call edges.
- Uses relationship labels (`relationship_type`) in emitted edges where available.

---

### `TreeSitterCSharpAnalyzer`
**Path:** `codewiki.src.be.dependency_analyzer.analyzers.csharp.TreeSitterCSharpAnalyzer`

Extracts nodes for:
- class / abstract class / static class
- interface
- struct
- enum
- record
- delegate

Extracts relationships for:
- class base-list inheritance/implementation (when base found among top-level nodes)
- property type usage
- field type usage
- method parameter type usage

Key characteristics:
- Focuses on type-level dependencies more than call-expression-level invocation edges.
- Uses primitive/common framework-type filtering for dependency noise reduction.

---

## Shared Contract and Model Usage

All analyzers emit shared analysis-domain models from [analysis-domain-models](analysis-domain-models.md):

- `Node`
  - identity (`id`, `component_id`, `name`)
  - kind (`component_type`, `node_type`)
  - source location (`file_path`, `relative_path`, `start_line`, `end_line`)
  - source snippet and metadata (`source_code`, `docstring`, `class_name`, etc.)
- `CallRelationship`
  - `caller`, `callee`, `call_line`, `is_resolved`

```mermaid
classDiagram
    class Node {
      +id: str
      +name: str
      +component_type: str
      +file_path: str
      +relative_path: str
      +depends_on: Set[str]
      +source_code: Optional[str]
      +start_line: int
      +end_line: int
      +node_type: Optional[str]
      +class_name: Optional[str]
      +component_id: Optional[str]
    }

    class CallRelationship {
      +caller: str
      +callee: str
      +call_line: Optional[int]
      +is_resolved: bool
    }

    TreeSitterJavaAnalyzer --> Node : creates
    TreeSitterJavaAnalyzer --> CallRelationship : creates
    TreeSitterCAnalyzer --> Node : creates
    TreeSitterCAnalyzer --> CallRelationship : creates
    TreeSitterCppAnalyzer --> Node : creates
    TreeSitterCppAnalyzer --> CallRelationship : creates
    TreeSitterCSharpAnalyzer --> Node : creates
    TreeSitterCSharpAnalyzer --> CallRelationship : creates
```

---

## Module Architecture

```mermaid
flowchart LR
    subgraph LANG[java-c-cpp-csharp-analyzers]
      J[TreeSitterJavaAnalyzer]
      C[TreeSitterCAnalyzer]
      CPP[TreeSitterCppAnalyzer]
      CS[TreeSitterCSharpAnalyzer]
    end

    TSJ[tree_sitter_java] --> J
    TSC[tree_sitter_c] --> C
    TSCPP[tree_sitter_cpp] --> CPP
    TSCS[tree_sitter_c_sharp] --> CS

    J --> MODELS[Node / CallRelationship]
    C --> MODELS
    CPP --> MODELS
    CS --> MODELS

    MODELS --> CGA[call-graph-analysis-engine]
    CGA --> DPP[dependency-parser-and-component-projection]
```

---

## Dependency and Integration Context

This module sits in the Language Analyzers layer and integrates as follows:

```mermaid
flowchart TD
    AS[analysis-service-orchestration] --> CGA[call-graph-analysis-engine]
    CGA --> DISPATCH{language by extension}

    DISPATCH --> JAVA[java analyzer]
    DISPATCH --> C[c analyzer]
    DISPATCH --> CPP[cpp analyzer]
    DISPATCH --> CSHARP[csharp analyzer]

    JAVA --> OUT[Node + CallRelationship]
    C --> OUT
    CPP --> OUT
    CSHARP --> OUT

    OUT --> CGA_RESOLVE[_resolve_call_relationships + dedup]
    CGA_RESOLVE --> PROJ[dependency-parser-and-component-projection]
    PROJ --> GRAPH[dependency-graph-build-and-leaf-selection]
```

Related module documentation:
- [call-graph-analysis-engine](call-graph-analysis-engine.md)
- [dependency-parser-and-component-projection](dependency-parser-and-component-projection.md)
- [dependency-graph-build-and-leaf-selection](dependency-graph-build-and-leaf-selection.md)
- [analysis-service-orchestration](analysis-service-orchestration.md)
- [analysis-domain-models](analysis-domain-models.md)

---

## End-to-End Data Flow

```mermaid
sequenceDiagram
    participant CGA as CallGraphAnalyzer
    participant A as Language Analyzer (Java/C/C++/C#)
    participant TS as Tree-sitter Parser
    participant M as Node/CallRelationship

    CGA->>A: analyze_<lang>_file(file_path, content, repo_path)
    A->>TS: parse(content)
    TS-->>A: root AST node

    A->>A: _extract_nodes(...)
    A->>A: _extract_relationships(...)

    A-->>M: List[Node], List[CallRelationship]
    M-->>CGA: analyzer output merged
    CGA->>CGA: cross-file resolution and dedup
```

---

## Component Interaction Pattern (Common Analyzer Lifecycle)

Although each language analyzer differs in grammar details, they follow a shared pattern:

```mermaid
flowchart TD
    INIT[__init__] --> SET[store file_path/content/repo_path]
    SET --> PARSE[_analyze: init parser + parse bytes]
    PARSE --> NODES[_extract_nodes recursive walk]
    NODES --> MAP[build top_level_nodes lookup]
    MAP --> REL[_extract_relationships recursive walk]
    REL --> DONE[nodes + call_relationships available]
```

### Internal interaction roles

- `top_level_nodes` map:
  - temporary symbol table for local resolution hints.
- `_get_module_path` + `_get_component_id`:
  - normalizes IDs into dotted, file-qualified component keys.
- `_is_primitive_type` / `_is_system_function`:
  - filters standard-library noise.

---

## Per-Language Process Flows

### Java flow

```mermaid
flowchart LR
    A[Parse Java AST] --> B[Collect declarations: class/interface/enum/record/annotation/method]
    B --> C[Create Node objects]
    C --> D[Extract relationships: extends/implements/fields/method_invocation/new]
    D --> E[Emit unresolved-first edges]
```

### C flow

```mermaid
flowchart LR
    A[Parse C AST] --> B[Collect function/struct/global variable]
    B --> C[Emit function + struct nodes]
    C --> D[Extract call_expression edges]
    D --> E[Extract global variable usage edges]
    E --> F[Filter system functions]
```

### C++ flow

```mermaid
flowchart LR
    A[Parse C++ AST] --> B[Collect class/struct/function/method/namespace/global variable]
    B --> C[Create nodes + class context metadata]
    C --> D[Extract calls/inherits/creates/uses]
    D --> E[Heuristic method-owner resolution]
```

### C# flow

```mermaid
flowchart LR
    A[Parse CSharp AST] --> B[Collect type declarations: class/interface/struct/enum/record/delegate]
    B --> C[Create Node objects]
    C --> D[Extract type relationships from base/property/field/method params]
    D --> E[Filter primitive/common framework types]
```

---

## Identifier and Resolution Strategy

All analyzers derive component IDs from repository-relative file paths, then append symbol names.

```mermaid
flowchart TD
    FP[file_path + repo_path] --> RP[relative path]
    RP --> MP[strip extension + slash-to-dot]
    MP --> CID[component id creation]

    CID --> EX1[module.Class]
    CID --> EX2[module.function]
    CID --> EX3[module.Class.method]
```

Resolution semantics in this module:
- `is_resolved=True` generally means locally resolvable with analyzer context.
- `is_resolved=False` means deferred resolution is expected downstream.

For global resolution rules, see [call-graph-analysis-engine](call-graph-analysis-engine.md).

---

## Quality Characteristics and Trade-offs

### Strengths

- Multi-language parity under one normalized output contract.
- AST-based extraction (better structural fidelity than regex parsing).
- Preserves rich source metadata for documentation and graph rendering.

### Current trade-offs

- Resolution is mostly heuristic/local (especially method/variable type inference in Java/C++).
- Built-in/system filtering lists are curated and incomplete by design.
- Different analyzers emphasize different dependency styles:
  - Java/C++ include more behavior-oriented call edges.
  - C# emphasizes type coupling edges.
  - C focuses function + global-variable usage.

---

## Public Wrapper Functions

Each file exposes a thin convenience entry point:

- `analyze_java_file(file_path, content, repo_path=None)`
- `analyze_c_file(file_path, content, repo_path=None)`
- `analyze_cpp_file(file_path, content, repo_path=None)`
- `analyze_csharp_file(file_path, content, repo_path=None)`

All wrappers:
1. instantiate analyzer class,
2. run analysis during initialization,
3. return `(nodes, call_relationships)`.

---

## How This Module Fits the Overall System

`java-c-cpp-csharp-analyzers` is the **language extraction backend** for statically typed/compiled-language files in CodeWiki.

It supplies standardized graph primitives into the Dependency Analyzer pipeline, where cross-file linking, deduplication, projection, and documentation generation happen in adjacent modules.

```mermaid
flowchart LR
    RA[repository-structure-analysis] --> CGA[call-graph-analysis-engine]
    CGA --> L[java-c-cpp-csharp-analyzers]
    L --> CGA
    CGA --> DP[dependency-parser-and-component-projection]
    DP --> DG[dependency-graph-build-and-leaf-selection]
    DG --> DOC[Documentation Generator]
```
