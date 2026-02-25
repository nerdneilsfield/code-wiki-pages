# frontend-models-and-configuration

## Introduction

The **frontend-models-and-configuration** module defines two foundational building blocks used across the Web Frontend runtime:

- `CacheEntry` (`codewiki.src.fe.models.CacheEntry`): the canonical in-memory/domain record for cached documentation metadata.
- `WebAppConfig` (`codewiki.src.fe.config.WebAppConfig`): centralized operational constants and filesystem setup utilities for frontend execution.

Although small, this module is a critical contract boundary: it standardizes how cache metadata is represented and how runtime defaults (paths, queue limits, cache TTL, retry windows, server defaults, git knobs) are shared across web-facing services.

---

## Purpose and Scope

This module is responsible for:

1. **Cache metadata schema** used by cache persistence/retrieval logic.
2. **Frontend runtime configuration constants** consumed by worker, routing, and repository processing code.
3. **Directory bootstrapping and path normalization helpers** used during app startup and path handling.

It does **not** contain queue execution, route orchestration, or rendering logic. For those behaviors, see:

- [job-processing-and-execution](job-processing-and-execution.md)
- [web-routing-and-request-lifecycle](web-routing-and-request-lifecycle.md)

---

## Component Overview

```mermaid
classDiagram
    class CacheEntry {
      +repo_url: str
      +repo_url_hash: str
      +docs_path: str
      +created_at: datetime
      +last_accessed: datetime
    }

    class WebAppConfig {
      <<static-config>>
      +CACHE_DIR: str
      +TEMP_DIR: str
      +OUTPUT_DIR: str
      +QUEUE_SIZE: int
      +CACHE_EXPIRY_DAYS: int
      +JOB_CLEANUP_HOURS: int
      +RETRY_COOLDOWN_MINUTES: int
      +DEFAULT_HOST: str
      +DEFAULT_PORT: int
      +CLONE_TIMEOUT: int
      +CLONE_DEPTH: int
      +ensure_directories()
      +get_absolute_path(path) str
    }
```

---

## Architecture Context

```mermaid
flowchart LR
    subgraph FEC[frontend-models-and-configuration]
      CE[CacheEntry]
      WAC[WebAppConfig]
    end

    CM[CacheManager]
    BW[BackgroundWorker]
    WR[WebRoutes]
    GHP[GitHubRepoProcessor]

    CE --> CM
    WAC --> CM
    WAC --> BW
    WAC --> WR
    WAC --> GHP
```

### Key relationships
- `CacheEntry` is instantiated and managed by `CacheManager` as the typed representation of each cache index row.
- `WebAppConfig` is a shared static configuration source for multiple frontend runtime components:
  - queue sizing (`BackgroundWorker`)
  - cleanup/retry policy (`WebRoutes`)
  - cache location and expiry (`CacheManager`)
  - clone behavior defaults (`GitHubRepoProcessor`)

---

## `CacheEntry` Detailed Documentation

### Data contract

`CacheEntry` is a dataclass with five fields:

- `repo_url`: normalized repository URL (e.g., `https://github.com/org/repo`)
- `repo_url_hash`: stable short hash key derived from URL
- `docs_path`: absolute/relative filesystem path to generated docs
- `created_at`: timestamp of cache creation
- `last_accessed`: timestamp updated on successful cache reads

### Lifecycle in the system

```mermaid
sequenceDiagram
    participant BW as BackgroundWorker
    participant CM as CacheManager
    participant CE as CacheEntry
    participant IDX as cache_index.json

    BW->>CM: add_to_cache(repo_url, docs_path)
    CM->>CM: get_repo_hash(repo_url)
    CM->>CE: create CacheEntry(...)
    CM->>IDX: save_cache_index()

    Note over CM: Later read path
    BW->>CM: get_cached_docs(repo_url)
    CM->>CM: lookup by repo_url_hash
    alt entry valid (not expired)
      CM->>CE: update last_accessed
      CM->>IDX: save_cache_index()
      CM-->>BW: docs_path
    else expired
      CM->>CM: remove_from_cache(repo_url)
      CM-->>BW: None
    end
```

### Semantics and constraints
- Cache identity is URL-hash based (not commit-hash based in this module).
- Validity is determined by `created_at` relative to `WebAppConfig.CACHE_EXPIRY_DAYS`.
- `last_accessed` supports read-tracking and future cache policy evolution.

---

## `WebAppConfig` Detailed Documentation

### Configuration surface

| Area | Constants / Methods | Role |
|---|---|---|
| Directories | `CACHE_DIR`, `TEMP_DIR`, `OUTPUT_DIR` | Filesystem roots for cache, temporary clones, and output artifacts |
| Queue | `QUEUE_SIZE` | Upper bound for pending background jobs |
| Cache | `CACHE_EXPIRY_DAYS` | TTL used to invalidate stale cache entries |
| Job retention/retry | `JOB_CLEANUP_HOURS`, `RETRY_COOLDOWN_MINUTES` | Cleanup horizon and failed-job resubmission cooldown |
| Server | `DEFAULT_HOST`, `DEFAULT_PORT` | Web server defaults |
| Git | `CLONE_TIMEOUT`, `CLONE_DEPTH` | Clone behavior defaults for repo operations |
| Utility | `ensure_directories()` | Creates required output directories |
| Utility | `get_absolute_path(path)` | Normalizes paths to absolute form |

### Process flow: directory initialization

```mermaid
flowchart TD
    A[Application startup] --> B[WebAppConfig.ensure_directories]
    B --> C[Create CACHE_DIR if missing]
    B --> D[Create TEMP_DIR if missing]
    B --> E[Create OUTPUT_DIR if missing]
    C --> F[Frontend runtime can persist artifacts]
    D --> F
    E --> F
```

### Process flow: runtime policy usage

```mermaid
flowchart LR
    WAC[WebAppConfig constants] --> BW[BackgroundWorker uses QUEUE_SIZE/TEMP_DIR]
    WAC --> CM[CacheManager uses CACHE_DIR/CACHE_EXPIRY_DAYS]
    WAC --> WR[WebRoutes uses JOB_CLEANUP_HOURS/RETRY_COOLDOWN_MINUTES]
    WAC --> GHP[GitHubRepoProcessor uses CLONE_TIMEOUT/CLONE_DEPTH]
```

---

## Dependency Map

```mermaid
graph TD
    CE[fe.models.CacheEntry]
    WAC[fe.config.WebAppConfig]

    CM[fe.cache_manager.CacheManager]
    BW[fe.background_worker.BackgroundWorker]
    WR[fe.routes.WebRoutes]
    GHP[fe.github_processor.GitHubRepoProcessor]

    CE --> CM
    WAC --> CM
    WAC --> BW
    WAC --> WR
    WAC --> GHP
```

> For deeper behavior of these consumers, refer to:
> - [job-processing-and-execution](job-processing-and-execution.md)
> - [web-routing-and-request-lifecycle](web-routing-and-request-lifecycle.md)

---

## Data Flow Summary

```mermaid
flowchart TD
    RepoURL[Normalized repo URL] --> Hash[get_repo_hash]
    Hash --> Lookup[cache_index lookup]
    Lookup -->|hit + valid| Path[docs_path returned]
    Lookup -->|miss/expired| Generate[worker generates docs]
    Generate --> Add[create CacheEntry]
    Add --> Persist[save cache_index.json]
```

This module contributes the **data shape** (`CacheEntry`) and **policy values** (`WebAppConfig`) that make the above flow deterministic across services.

---

## Interaction with Adjacent Frontend Models

`codewiki.src.fe.models` contains additional models (`RepositorySubmission`, `JobStatus`, `JobStatusResponse`) that define request and job-lifecycle contracts. This module focuses on the cache/config subset only.

For full request and status lifecycle details, see [web-routing-and-request-lifecycle](web-routing-and-request-lifecycle.md).

---

## Operational Notes for Maintainers

- Keep `WebAppConfig` as the single source of truth for frontend runtime defaults; avoid hardcoding equivalent constants in worker/router/cache code.
- If cache key precision must become commit-aware, evolve both `CacheEntry` semantics and `CacheManager` keying strategy together.
- Any changes to directory constants should be validated against startup initialization (`ensure_directories`) and persisted artifact locations used by job execution.

---

## Summary

The **frontend-models-and-configuration** module is a compact but central contract layer for the Web Frontend: `CacheEntry` standardizes cache metadata, while `WebAppConfig` centralizes runtime settings and bootstrapping utilities. Together, they provide stable data and policy primitives consumed by route handling and background execution flows.