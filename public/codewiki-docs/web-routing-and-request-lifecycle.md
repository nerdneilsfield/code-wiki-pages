# web-routing-and-request-lifecycle

## Introduction

The **web-routing-and-request-lifecycle** module defines the HTTP-facing behavior of the CodeWiki web app. It is centered on:

- `WebRoutes` (`codewiki.src.fe.routes.WebRoutes`)
- `RepositorySubmission` (`codewiki.src.fe.models.RepositorySubmission`)
- `JobStatusResponse` (`codewiki.src.fe.models.JobStatusResponse`)
- `JobStatus` (`codewiki.src.fe.models.JobStatus`)

In practice, `WebRoutes` is the request coordinator between the browser UI and the async execution backend (`BackgroundWorker` + `CacheManager`). It validates user input, deduplicates submissions, surfaces job state, and renders generated documentation.

---

## Purpose and Scope

This module is responsible for:

1. **Routing and request handling** for form submissions and docs viewing.
2. **Input validation** for GitHub repositories and commit IDs.
3. **Job deduplication and retry cooldown control** using route-level checks.
4. **Response shaping** for both HTML pages and JSON API responses.
5. **Request-time reconstruction** of completed jobs from cache when job state is missing.

This module does **not** execute documentation generation itself. For worker internals and queue processing, see [job-processing-and-execution](job-processing-and-execution.md).

---

## Position in the System

```mermaid
flowchart LR
    Browser[Browser / User] --> WR[WebRoutes]
    WR --> BW[BackgroundWorker]
    WR --> CM[CacheManager]
    WR --> GHP[GitHubRepoProcessor]
    WR --> TU[render_template]

    BW --> DG[DocumentationGenerator]
    BW --> FS[(jobs.json)]
    CM --> CIDX[(cache_index.json)]
    BW --> DOCS[(generated docs)]
    WR --> DOCS
```

---

## Core Components

```mermaid
classDiagram
    class WebRoutes {
      +index_get(request) HTMLResponse
      +index_post(request, repo_url, commit_id) HTMLResponse
      +get_job_status(job_id) JobStatusResponse
      +view_docs(job_id) RedirectResponse
      +serve_generated_docs(job_id, filename="overview.md") HTMLResponse
      +cleanup_old_jobs()
      -_normalize_github_url(url) str
      -_repo_full_name_to_job_id(full_name) str
      -_job_id_to_repo_full_name(job_id) str
    }

    class RepositorySubmission {
      +repo_url: HttpUrl
    }

    class JobStatusResponse {
      +job_id: str
      +repo_url: str
      +status: str
      +created_at: datetime
      +started_at: datetime?
      +completed_at: datetime?
      +error_message: str?
      +progress: str
      +docs_path: str?
      +main_model: str?
      +commit_id: str?
    }

    class JobStatus {
      +job_id: str
      +repo_url: str
      +status: str
      +created_at: datetime
      +started_at: datetime?
      +completed_at: datetime?
      +error_message: str?
      +progress: str
      +docs_path: str?
      +main_model: str?
      +commit_id: str?
    }

    WebRoutes --> JobStatus : creates/reads
    WebRoutes --> JobStatusResponse : returns API payload
```

### Notes
- `RepositorySubmission` is defined as a Pydantic model (`HttpUrl`) but current route submission uses `Form(...)` parameters directly in `index_post`.
- `JobStatus` is a dataclass used for internal mutable lifecycle tracking.
- `JobStatusResponse` is a Pydantic output contract for status API responses.

---

## Route Surface and Behavior

| Route handler | Type | Primary responsibility |
|---|---|---|
| `index_get` | HTML | Render main page and recent jobs |
| `index_post` | HTML | Validate/queue submission, handle dedupe and cache hit UX |
| `get_job_status` | JSON | Return machine-readable job status |
| `view_docs` | Redirect | Ensure docs available then redirect to docs viewer path |
| `serve_generated_docs` | HTML | Render requested markdown docs page with navigation/metadata |

---

## Request Lifecycle Flows

### 1) Main page load (`index_get`)

```mermaid
sequenceDiagram
    participant U as User
    participant WR as WebRoutes
    participant BW as BackgroundWorker
    participant T as render_template

    U->>WR: GET /
    WR->>BW: get_all_jobs()
    WR->>WR: sort by created_at desc, cap recent list
    WR->>T: render WEB_INTERFACE_TEMPLATE(context)
    WR-->>U: HTMLResponse
```

Key behavior:
- Displays up to the most recent jobs (implementation slices to 100).
- Includes empty form defaults plus recent job history.

### 2) Repository submission (`index_post`)

```mermaid
flowchart TD
    A[POST repo_url, commit_id] --> B[cleanup_old_jobs]
    B --> C[trim input]
    C --> D{repo_url provided?}
    D -- no --> E[error message]
    D -- yes --> F{valid GitHub URL?}
    F -- no --> E
    F -- yes --> G[normalize URL]
    G --> H[get repo info + derive job_id owner--repo]
    H --> I[check existing job + retry cooldown]
    I --> J{existing active/recent failed?}
    J -- yes --> E
    J -- no --> K[check cache by normalized URL]
    K --> L{cache hit and docs exists?}
    L -- yes --> M[create synthetic completed JobStatus]
    L -- no --> N[create queued JobStatus + add_job]
    M --> O[render page with success message]
    N --> O
    E --> O
```

Important controls implemented in this flow:
- **Deduplication**: active (`queued`/`processing`) job with same `job_id` blocks duplicate enqueue.
- **Retry throttle**: recently failed job is blocked until `WebAppConfig.RETRY_COOLDOWN_MINUTES` elapses.
- **Cache short-circuit**: cached docs produce immediate completed status without queue processing.

### 3) Job status polling (`get_job_status`)

```mermaid
sequenceDiagram
    participant Client as Frontend Poller
    participant WR as WebRoutes
    participant BW as BackgroundWorker

    Client->>WR: GET /job/{job_id}/status
    WR->>BW: get_job_status(job_id)
    alt found
        WR-->>Client: JobStatusResponse(asdict(job))
    else missing
        WR-->>Client: 404 Job not found
    end
```

### 4) Docs redirect and rendering (`view_docs`, `serve_generated_docs`)

```mermaid
sequenceDiagram
    participant U as User
    participant WR as WebRoutes
    participant BW as BackgroundWorker
    participant CM as CacheManager
    participant FM as file_manager

    U->>WR: GET /view/{job_id}
    WR->>BW: get_job_status(job_id)
    WR-->>U: 302 /static-docs/{job_id}/

    U->>WR: GET /static-docs/{job_id}/{filename}
    WR->>BW: get_job_status(job_id)
    alt job missing
        WR->>CM: get_cached_docs(https://github.com/{owner/repo})
        WR->>BW: recreate completed JobStatus + save_job_statuses()
    end
    WR->>FM: load module_tree.json / metadata.json (optional)
    WR->>FM: load requested markdown file
    WR->>WR: markdown_to_html + get_file_title
    WR-->>U: HTML docs page
```

---

## Dependency and Interaction Map

```mermaid
graph TD
    WR[WebRoutes]
    M1[fe.models.JobStatus]
    M2[fe.models.JobStatusResponse]
    BW[BackgroundWorker]
    CM[CacheManager]
    GHP[GitHubRepoProcessor]
    CFG[WebAppConfig]
    FM[file_manager]
    TMP[Templates + render_template]
    VIS[visualise_docs markdown_to_html/get_file_title]

    WR --> M1
    WR --> M2
    WR --> BW
    WR --> CM
    WR --> GHP
    WR --> CFG
    WR --> FM
    WR --> TMP
    WR --> VIS
```

### Relationship highlights
- `WebRoutes` is a **composition root** for web concerns; it receives `BackgroundWorker` and `CacheManager` via constructor injection.
- Job identity conversion helpers (`owner/repo` ↔ `owner--repo`) enable cache fallback and URL-safe routing.
- HTML rendering is template-driven (`render_template`) with markdown conversion delegated to docs visualizer utilities.

---

## Data Contracts and State Semantics

### `JobStatus` (internal state)
- Mutable lifecycle object shared with worker state map.
- Canonical statuses used by routes: `queued`, `processing`, `completed`, `failed`.

### `JobStatusResponse` (API payload)
- Built via `JobStatusResponse(**asdict(job))`.
- Ensures typed serialization of timestamps and optional fields.

### `RepositorySubmission` (input contract)
- Strong URL validation (`HttpUrl`) at model level.
- Current routes choose form-parameter validation instead of direct model binding.

---

## Cleanup and Retention Behavior

`cleanup_old_jobs()` removes old terminal jobs from in-memory worker state:

- cutoff = `now - WebAppConfig.JOB_CLEANUP_HOURS`
- removable statuses = `completed` or `failed`
- active states (`queued`, `processing`) are retained

```mermaid
flowchart LR
    ALL[background_worker.get_all_jobs] --> FILTER[created_at < cutoff AND terminal status]
    FILTER --> DEL[delete from background_worker.job_status]
```

This is invoked on `index_post` (submission path), not every read endpoint.

---

## Error Handling Model

Primary error surfaces:
- Invalid or empty repository URL → user-facing HTML error message.
- Missing job or docs artifacts → `HTTPException(404)`.
- File read/render failure in docs serving → `HTTPException(500)` with traceback detail.

Operationally, this creates:
- Friendly validation feedback for submission UX.
- Strict not-found semantics for missing artifacts.
- Best-effort optional loading for `module_tree.json` and `metadata.json` (fail-open behavior).

---

## Process Deep Dive: Cache-assisted Job Reconstruction

A distinctive flow in this module is serving docs when `job_id` is unknown in memory:

```mermaid
flowchart TD
    A[serve_generated_docs] --> B{job exists?}
    B -- yes --> C[use job.docs_path]
    B -- no --> D[job_id to owner/repo]
    D --> E[build GitHub URL]
    E --> F[cache lookup]
    F --> G{cached docs exists?}
    G -- no --> H[404 Documentation not found]
    G -- yes --> I[recreate completed JobStatus]
    I --> J[persist via save_job_statuses]
    J --> C
    C --> K[load markdown and render HTML]
```

This improves resilience when process memory is reset but cache artifacts remain valid.

---

## Cross-Module References

To avoid duplicating implementation details:

- Worker queueing, cloning, cache persistence internals: [job-processing-and-execution](job-processing-and-execution.md)
- Backend generation orchestration: [Documentation Generator](Documentation Generator.md)
- Analyzer and agent backplane details: [Dependency Analyzer](Dependency Analyzer.md), [Agent Orchestration](Agent Orchestration.md)

---

## Summary

`WebRoutes` is the HTTP lifecycle controller for CodeWiki’s frontend runtime: it validates incoming repository requests, coordinates queue/cache decisions, exposes status APIs, and renders navigable documentation pages. Combined with `JobStatus`/`JobStatusResponse`, this module provides a clear boundary between user interactions and asynchronous backend execution.