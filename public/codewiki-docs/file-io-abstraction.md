# file-io-abstraction Module

## Introduction

`file-io-abstraction` provides CodeWiki’s minimal, shared file-system I/O layer via a single core component: `codewiki.src.utils.FileManager` (plus the exported instance `file_manager`).

Its role is intentionally small but critical: **standardize directory creation and JSON/text persistence across backend generation workflows**.

Instead of each module doing ad-hoc `open()/json.dump()/os.makedirs()`, this module centralizes those operations so orchestration code stays focused on analysis and documentation logic.

---

## Purpose and Scope

### What this module does

- Creates directories safely (`ensure_directory`)
- Persists JSON (`save_json`)
- Loads JSON with missing-file tolerance (`load_json` returns `None` when absent)
- Persists plain text (`save_text`)
- Loads plain text (`load_text`)
- Exposes a reusable singleton-style object: `file_manager = FileManager()`

### What this module does **not** do

- No schema validation for JSON payloads
- No atomic writes/locking/concurrency control
- No custom exception wrapping/retry logic
- No path policy management (that belongs to configuration/runtime modules)

For configuration/path semantics, see [configuration-runtime-and-prompt-control.md](configuration-runtime-and-prompt-control.md).

---

## Core Component

```mermaid
classDiagram
    class FileManager {
      <<utility>>
      +ensure_directory(path: str) None
      +save_json(data: Any, filepath: str) None
      +load_json(filepath: str) Optional~Dict~
      +save_text(content: str, filepath: str) None
      +load_text(filepath: str) str
    }
```

### API behavior summary

| Method | Behavior | Return | Notable semantics |
|---|---|---|---|
| `ensure_directory(path)` | Calls `os.makedirs(path, exist_ok=True)` | `None` | Idempotent directory creation |
| `save_json(data, filepath)` | Writes pretty JSON (`indent=4`) | `None` | Overwrites file if it exists |
| `load_json(filepath)` | Reads JSON file | `dict` or `None` | Returns `None` if file is missing |
| `save_text(content, filepath)` | Writes string to file | `None` | Overwrites file if it exists |
| `load_text(filepath)` | Reads full file content | `str` | Raises if file missing/unreadable |

---

## Internal Design

`FileManager` is implemented as a **stateless static-method utility**. This gives:

- low coupling (no internal mutable state)
- easy call sites (`file_manager.save_json(...)`)
- straightforward testability (can monkeypatch at module boundary)

A module-level instance is exported:

```python
file_manager = FileManager()
```

This pattern offers ergonomic usage while preserving stateless semantics.

---

## Architecture Position

```mermaid
flowchart LR
    CFG[Config paths from runtime config] --> DGB[DependencyGraphBuilder]
    CFG --> DG[DocumentationGenerator]
    CFG --> AO[AgentOrchestrator]

    FM[file-io-abstraction\nFileManager] --> DGB
    FM --> DG
    FM --> AO

    DGB --> OUT1[temp/dependency_graphs/*.json]
    DG --> OUT2[docs/*.md + module_tree.json + metadata.json]
    AO --> OUT3[module docs + module_tree updates]
```

`file-io-abstraction` is a shared infrastructure layer under [Shared Configuration and Utilities.md](Shared%20Configuration%20and%20Utilities.md).

---

## Dependency Relationships

### Code-level dependencies

```mermaid
graph TD
    FM[FileManager]
    FM --> OS[os]
    FM --> JSON[json]
    FM --> TYP[typing Any/Optional/Dict]
```

### System-level consumers

```mermaid
graph LR
    FM[file_manager]

    FM --> DGB[dependency-graph-build-and-leaf-selection\nDependencyGraphBuilder]
    FM --> DG[Documentation Generator\nDocumentationGenerator]
    FM --> AO[orchestration-runtime\nAgentOrchestrator]
    FM --> CLI[cli-adapter-generation\nCLIDocumentationGenerator]
```

Related docs:
- [dependency-graph-build-and-leaf-selection.md](dependency-graph-build-and-leaf-selection.md)
- [Documentation Generator.md](Documentation%20Generator.md)
- [orchestration-runtime.md](orchestration-runtime.md)
- [cli-adapter-generation.md](cli-adapter-generation.md)

---

## Data Flow Patterns

```mermaid
sequenceDiagram
    participant CLI as CLIDocumentationGenerator
    participant DG as DocumentationGenerator
    participant DGB as DependencyGraphBuilder
    participant AO as AgentOrchestrator
    participant FM as file_manager
    participant FS as Filesystem

    CLI->>FM: ensure_directory(output_dir)
    DGB->>FM: ensure_directory(dependency_graph_dir)
    DGB->>FM: save_json(dependency_graph)

    DG->>FM: load_json(first_module_tree.json)
    DG->>FM: save_json(module_tree.json)
    DG->>FM: save_text(module.md / overview.md)
    DG->>FM: save_json(metadata.json)

    AO->>FM: load_json(module_tree.json)
    AO->>FM: save_json(updated module_tree)

    FM->>FS: read/write bytes via open()
```

Key observation: most high-level pipeline state transitions (graph snapshots, module trees, generated docs, metadata) cross the persistence boundary through this module.

---

## Component Interaction in a Typical Run

```mermaid
flowchart TD
    A[Start generation] --> B[Build Config with paths]
    B --> C[DependencyGraphBuilder.build_dependency_graph]
    C --> D[file_manager.save_json graph artifacts]
    D --> E[DocumentationGenerator.generate_module_documentation]
    E --> F[file_manager.load_json module trees]
    F --> G[AgentOrchestrator.process_module]
    G --> H[file_manager.save_json tree updates]
    H --> I[file_manager.save_text module markdown]
    I --> J[DocumentationGenerator.create_documentation_metadata]
    J --> K[file_manager.save_json metadata.json]
```

---

## Process Flows

### 1) JSON lifecycle flow

```mermaid
flowchart LR
    A[Prepare object] --> B[save_json]
    B --> C[json.dump indent=4]
    C --> D[File written]
    D --> E[load_json]
    E --> F{File exists?}
    F -- No --> G[Return None]
    F -- Yes --> H[json.load -> dict]
```

### 2) Text document flow

```mermaid
flowchart LR
    A[Generated markdown content] --> B[save_text]
    B --> C[Open file in write mode]
    C --> D[write content]
    D --> E[Stored markdown file]
    E --> F[load_text when needed]
```

---

## Error Handling and Operational Semantics

- `load_json` is the only method with built-in missing-file soft behavior (`None`).
- Other methods rely on Python I/O exceptions (`FileNotFoundError`, `PermissionError`, JSON decode errors, etc.) to bubble up to orchestrators.
- This design keeps abstraction thin and lets higher layers decide retry/fallback policy.

This aligns with how `DocumentationGenerator` and CLI adapter already wrap stage-level failures and report them as job/runtime errors.

---

## Design Trade-offs

1. **Thin abstraction over robustness features**
   - Pros: simple, predictable, low overhead.
   - Cons: no atomic writes or corruption safeguards.

2. **Static utility + exported instance**
   - Pros: easy to import and use everywhere.
   - Cons: global usage pattern can make strict dependency injection harder.

3. **Mixed strictness across read methods**
   - `load_json`: tolerant of missing file.
   - `load_text`: strict; raises when missing.
   - This is practical for current pipeline expectations but should be documented for maintainers.

---

## Maintainer Guidance

If you extend this module, keep it narrowly scoped. Prefer adding generic, reusable filesystem primitives rather than workflow-specific logic.

Potential safe enhancements:

- optional UTF-8 encoding parameters
- atomic write helper (`write temp + rename`)
- `exists()` / `safe_load_text()` helper for symmetry with `load_json`

Any behavior change (especially exception semantics) should be validated against:
- [Documentation Generator.md](Documentation%20Generator.md)
- [orchestration-runtime.md](orchestration-runtime.md)
- [cli-adapter-generation.md](cli-adapter-generation.md)

---

## Related Module Documentation

- Parent context: [Shared Configuration and Utilities.md](Shared%20Configuration%20and%20Utilities.md)
- Configuration counterpart: [configuration-runtime-and-prompt-control.md](configuration-runtime-and-prompt-control.md)
- Main consumer orchestration:
  - [Documentation Generator.md](Documentation%20Generator.md)
  - [dependency-graph-build-and-leaf-selection.md](dependency-graph-build-and-leaf-selection.md)
  - [orchestration-runtime.md](orchestration-runtime.md)
  - [cli-adapter-generation.md](cli-adapter-generation.md)
