# agent-editing-toolchain Module

## Introduction

The `agent-editing-toolchain` module provides the **safe, stateful file editing interface** used by CodeWiki agents during documentation generation.

It centers on three core components:

- `WindowExpander`: expands line-based view/edit windows to cleaner semantic boundaries (e.g., blank lines, Python defs/classes).
- `EditTool`: performs constrained filesystem operations (`view`, `create`, `str_replace`, `insert`, `undo_edit`) with validation, history, and formatted output.
- `Filemap`: creates abbreviated structural views of large Python files using tree-sitter.

Together, these components let an LLM agent inspect repository files and modify docs with predictable behavior, bounded access, and recoverability.

---

## Position in the System

```mermaid
flowchart LR
    ORCH[orchestration-runtime\nAgentOrchestrator] --> TOOL[str_replace_editor tool]
    DEP[agent-dependency-context\nCodeWikiDeps] --> TOOL

    TOOL --> ET[EditTool]
    ET --> WE[WindowExpander]
    ET --> FM[Filemap optional]

    ET --> DOCS[docs workspace\nread/write]
    ET --> REPO[repo workspace\nview-only]

    TOOL --> MM[Mermaid validation for .md edits]
```

This module is the **execution boundary between agent intent and filesystem mutation**.

For orchestration behavior, see [orchestration-runtime.md](orchestration-runtime.md).  
For dependency context injection, see [agent-dependency-context.md](agent-dependency-context.md).

---

## Core Components

## 1) `EditTool`

`EditTool` is the operational engine behind the `str_replace_editor` tool.

### Responsibilities

- Validate path + command combinations before execution.
- Enforce command constraints:
  - directories: `view` only,
  - non-existent files: only `create`,
  - existing files: cannot use `create`.
- Execute file operations and return user-friendly, line-numbered outputs (`cat -n` style).
- Maintain per-file edit history (`registry["file_history"]`) for `undo_edit`.
- Apply truncation policy for long outputs.
- Optionally integrate lint checks (present in code path, currently toggled by `USE_LINTER=False`).

### Supported commands

| Command | Behavior |
|---|---|
| `view` | Show directory tree (max depth 2, non-hidden) or file content with line numbers; optional ranged view |
| `create` | Create new file (fails if already exists) |
| `str_replace` | Replace a **unique** exact string occurrence |
| `insert` | Insert text at a specific line index |
| `undo_edit` | Revert last edit from in-memory persisted history |

### Key reliability controls

- **Absolute path requirement** inside the low-level tool.
- **Uniqueness check** for `old_str` in `str_replace` prevents ambiguous replacements.
- **History-backed revert** enables iterative correction.
- **Encoding fallback strategy** (`utf-8`, `latin-1`, replacement mode) for resilient reads.

---

## 2) `WindowExpander`

`WindowExpander` improves readability and edit confirmation by expanding requested line ranges.

### How it works

- Finds nearby "breakpoints" above and below a target range.
- Breakpoint heuristics include:
  - blank lines / double blank lines,
  - Python semantic anchors (`def`, `class`, decorators),
  - file boundaries.
- Returns a non-shrinking expanded range bounded by `max_added_lines`.

### Current runtime settings

In this module configuration:

- `MAX_WINDOW_EXPANSION_VIEW = 0`
- `MAX_WINDOW_EXPANSION_EDIT_CONFIRM = 0`

So expansion logic exists but is effectively disabled unless constants are changed.

---

## 3) `Filemap`

`Filemap` builds a compressed representation of large Python files by eliding long function bodies.

### Mechanism

- Uses `tree_sitter_languages` parser/query for Python.
- Detects function body nodes.
- Elides body line ranges beyond threshold length.
- Emits line-numbered output with placeholders like `... eliding lines X-Y ...`.

### Runtime usage

Currently gated by:

- `USE_FILEMAP = False`

When enabled and file output is large, `view` can return abbreviated structure first, prompting agent to query precise ranges next.

---

## Public Tool Entry Point

Besides the three core classes, the module exposes async function `str_replace_editor(...)` and registers `str_replace_editor_tool = Tool(...)`.

## Wrapper-level policy

The wrapper enforces workspace-level safety:

- `working_dir = "repo"` → **only `view` allowed**.
- `working_dir = "docs"` → full edit commands allowed.
- Accepts both `path` and `file` parameter names (compatibility shim).
- Resolves relative input to absolute paths using `CodeWikiDeps` roots.
- Runs Mermaid validation after non-view edits to `.md` files via `validate_mermaid_diagrams(...)`.

This creates a clear split: repository inspection is read-only; documentation workspace is mutable.

---

## Internal Architecture

```mermaid
graph TD
    A[str_replace_editor async wrapper] --> B[Resolve path from deps roots]
    B --> C{working_dir}

    C -->|repo| D[allow only view]
    C -->|docs| E[allow view/create/str_replace/insert/undo_edit]

    D --> F[EditTool.__call__]
    E --> F

    F --> G[validate_path]
    G --> H[view]
    G --> I[create_file]
    G --> J[str_replace]
    G --> K[insert]
    G --> L[undo_edit]

    H --> M[WindowExpander]
    H --> N[Filemap optional]
    J --> O[history push + snippet confirm]
    K --> O
    L --> P[history pop + restore]

    A --> Q[Mermaid validation for edited markdown]
```

---

## Dependency Map

```mermaid
graph LR
    TOOL[agent-editing-toolchain]

    TOOL --> DEPS[CodeWikiDeps]
    TOOL --> PAI[pydantic_ai\nRunContext + Tool]

    TOOL --> FS[pathlib.Path]
    TOOL --> PROC[subprocess\nfind + flake8]
    TOOL --> RE[regex heuristics]
    TOOL --> JSON[json registry serialization]

    TOOL --> TS[tree_sitter_languages optional]
    TOOL --> VM[validate_mermaid_diagrams]
```

### Notes

- `tree_sitter_languages` is used only by `Filemap`.
- `flake8` integration exists but is disabled by default (`USE_LINTER=False`).

---

## Data Flow

```mermaid
flowchart TD
    IN[Agent tool call\nworking_dir, command, path, args] --> WRAP[str_replace_editor wrapper]
    WRAP --> RESOLVE[Resolve absolute path from deps]
    RESOLVE --> CHECK[Workspace/command policy check]
    CHECK --> EDIT[EditTool execution]

    EDIT --> READ[Read file/dir]
    EDIT --> MUTATE[create/replace/insert/undo]
    MUTATE --> WRITE[Write file if needed]
    WRITE --> HIST[Update file_history in registry]

    EDIT --> OUT[Formatted log output]
    OUT --> TRUNC[maybe_truncate]

    MUTATE --> MD{edited markdown?}
    MD -->|yes| MERM[validate_mermaid_diagrams]
    MD -->|no| DONE[return result]
    MERM --> DONE
```

---

## Component Interaction Sequence

```mermaid
sequenceDiagram
    participant Ag as Agent
    participant W as str_replace_editor wrapper
    participant ET as EditTool
    participant FS as Filesystem
    participant MV as Mermaid validator

    Ag->>W: call(command, working_dir, path, args)
    W->>W: resolve path via CodeWikiDeps
    W->>W: enforce repo/docs policy
    W->>ET: execute command

    alt view
        ET->>FS: read file or list dir
        ET-->>W: line-numbered output
    else create/str_replace/insert/undo
        ET->>FS: read/modify/write
        ET->>ET: update file_history
        ET-->>W: edit confirmation snippet
        opt path endsWith .md
            W->>MV: validate_mermaid_diagrams
            MV-->>W: validation result
        end
    end

    W-->>Ag: combined response
```

---

## Process Flows

### A) `str_replace` lifecycle

```mermaid
flowchart TD
    S1[Receive old_str/new_str] --> S2[Read file + normalize tabs]
    S2 --> S3{count old_str occurrences}
    S3 -->|0| S4[abort: not found]
    S3 -->|>1| S5[abort: ambiguous]
    S3 -->|1| S6[replace content]
    S6 --> S7[write file]
    S7 --> S8[push previous content to history]
    S8 --> S9[build snippet around edit]
    S9 --> S10[return confirmation]
```

### B) `undo_edit` lifecycle

```mermaid
flowchart TD
    U1[Request undo_edit] --> U2{history exists?}
    U2 -->|no| U3[return no history]
    U2 -->|yes| U4[pop previous content]
    U4 --> U5[write restored file]
    U5 --> U6[return restored output]
```

---

## State and Persistence Model

`EditTool` persistence is session-scoped via `CodeWikiDeps.registry`:

- `file_history` is serialized to JSON in `registry`.
- History is keyed by file path, storing prior versions.
- This enables multi-step edits across tool calls in one agent session.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Viewing: view
    Idle --> Editing: create/str_replace/insert
    Editing --> HistoryUpdated
    HistoryUpdated --> Idle
    Idle --> Undoing: undo_edit
    Undoing --> Idle
```

---

## Error Handling and Guardrails

- Invalid command parameters append actionable logs rather than hard-crashing.
- Invalid ranges (`view_range`, `insert_line`) return precise constraints.
- Non-absolute paths are rejected with suggested absolute path hint.
- Directory mutation attempts are blocked.
- Long responses are clipped with explicit continuation guidance.

Operationally, this design optimizes for **agent recoverability**: failures are informative and incremental retries are easy.

---

## Integration with Other Modules

- **Upstream runtime**: [orchestration-runtime.md](orchestration-runtime.md) creates agent/tool runtime and invokes this tool.
- **Dependency contract**: [agent-dependency-context.md](agent-dependency-context.md) supplies workspace roots and shared registry.
- **Higher-level generation pipeline**: [documentation-generator.md](documentation-generator.md).
- **Parent architecture context**: [agent-orchestration.md](agent-orchestration.md).

---

## Maintenance Notes

- `MAX_WINDOW_EXPANSION_*`, `USE_FILEMAP`, and `USE_LINTER` are key behavior toggles.
- If enabling linter filtering, verify `_update_previous_errors`/`format_flake8_output` behavior against multiline edits.
- If enabling filemap broadly, validate tree-sitter availability in runtime environments.
- Keep wrapper-level workspace restrictions (`repo` view-only) intact to preserve safety guarantees.
