# CLI 表面守护进程 (cli_surface_daemon) 模块文档

## 1. 概述

`cli_surface_daemon` 模块是 ZeptoClaw 系统中的一个核心组件，负责提供一个监督式的长期运行守护进程功能。该模块设计用于确保系统的关键组件（特别是网关服务）能够持续运行，并在发生故障时自动重启，从而提高整个系统的可用性和可靠性。

### 核心功能
- 自动重启机制：当监控的组件（如网关）发生故障时，系统会自动尝试重启
- 指数退避策略：重启尝试之间使用指数退避算法，避免过度消耗系统资源
- 状态持久化：将守护进程和组件的状态信息保存到磁盘，以便查询和监控
- 优雅关闭：支持接收系统信号进行优雅关闭
- 重启计数和错误跟踪：记录组件的重启次数和最后一次错误信息

### 设计理念
该模块基于“监督者模式”设计，将系统的关键组件置于守护进程的监控之下。通过将复杂的重启逻辑和状态管理集中化，简化了主应用程序的代码，并提供了一致的故障恢复机制。状态持久化功能允许外部工具（如 CLI 的 status 命令）查询当前系统状态，增强了系统的可观测性。

## 2. 架构与主流程

`cli_surface_daemon` 模块的架构相对简洁，但功能完整。它主要由状态管理、重启逻辑和主命令入口三部分组成。

```mermaid
sequenceDiagram
    participant User as 用户
    participant Daemon as 守护进程(cmd_daemon)
    participant State as 状态管理(write_state/read_state)
    participant Gateway as 网关组件(cmd_gateway)
    participant Signal as 信号处理
    
    User->>Daemon: 启动守护进程
    Daemon->>State: 初始化并写入"running"状态
    loop 主循环
        Daemon->>Gateway: 启动网关组件
        alt 网关正常退出
            Gateway-->>Daemon: 返回成功
            Daemon->>State: 写入"stopped"状态
            break 退出循环
        else 网关发生错误
            Gateway-->>Daemon: 返回错误
            Daemon->>State: 写入"restarting"状态
            alt 收到关闭信号
                Signal-->>Daemon: 中断
                Daemon->>State: 写入"stopped"状态
                break 退出循环
            else 继续重启
                Daemon->>Daemon: 应用指数退避等待
                Daemon->>Daemon: 增加重启计数
            end
        end
    end
    Daemon-->>User: 守护进程结束
```

### 组件关系

1. **状态管理部分**：由 `DaemonState` 和 `ComponentState` 结构体以及相关的读写函数组成，负责状态的序列化、持久化和恢复。
2. **重启逻辑部分**：由 `compute_backoff` 函数和主循环中的重试机制组成，实现了带有指数退避的重启策略。
3. **主命令入口**：由 `cmd_daemon` 函数提供，是 CLI 命令 `zeptoclaw daemon` 的实现，协调整个守护进程的运行。

这些组件共同工作，形成了一个完整的监督和重启系统，确保被监控组件的高可用性。

## 3. 核心组件详解

### 3.1 DaemonState 结构体

`DaemonState` 是守护进程的主状态结构，用于保存整个守护进程的运行状态信息。

```rust
pub struct DaemonState {
    pub status: String,
    pub started_at: String,
    pub gateway: String,
    pub components: Vec<ComponentState>,
}
```

**字段说明**：
- `status`：守护进程的当前状态，可能的值包括 "running"（运行中）、"restarting"（重启中）和 "stopped"（已停止）
- `started_at`：守护进程启动的时间，使用 RFC3339 格式的字符串表示
- `gateway`：网关服务的地址，格式为 "host:port"
- `components`：被监控组件的状态列表，目前主要包含网关组件

**用途**：该结构会被序列化为 JSON 并保存到磁盘，供 CLI 的 status 命令查询使用，也用于在重启过程中保持状态的连续性。

### 3.2 ComponentState 结构体

`ComponentState` 结构体保存单个被监控组件的详细状态信息。

```rust
pub struct ComponentState {
    pub name: String,
    pub running: bool,
    pub restart_count: u64,
    pub last_error: Option<String>,
}
```

**字段说明**：
- `name`：组件的名称，例如 "gateway"
- `running`：表示组件当前是否正在运行
- `restart_count`：组件的重启次数计数
- `last_error`：记录组件最后一次发生的错误信息，如果没有错误则为 None

**用途**：允许详细跟踪每个组件的健康状况和历史故障信息，为故障排查提供有价值的数据。

### 3.3 状态管理函数

#### 3.3.1 write_state 函数

```rust
pub fn write_state(state: &DaemonState) -> Result<()>
```

**功能**：将提供的 `DaemonState` 结构体序列化为 JSON 格式，并写入到磁盘上的固定位置。

**参数**：
- `state`：要写入的守护进程状态引用

**返回值**：
- `Result<()>`：成功时返回 Ok(())，失败时返回错误

**工作流程**：
1. 获取状态文件的路径
2. 确保路径的父目录存在，如不存在则创建
3. 将状态结构体序列化为美观打印的 JSON 字符串
4. 将 JSON 字符串写入文件

**注意**：此函数在无法写入状态时会返回错误，但在 `cmd_daemon` 中调用时忽略了错误，以避免状态写入问题影响主功能。

#### 3.3.2 read_state 函数

```rust
pub fn read_state() -> Option<DaemonState>
```

**功能**：从磁盘读取并反序列化守护进程状态文件。

**返回值**：
- `Option<DaemonState>`：成功读取并解析时返回 Some(DaemonState)，否则返回 None

**用途**：主要被 CLI 的 status 命令使用，用于向用户展示当前守护进程的状态。

#### 3.3.3 remove_state 函数

```rust
pub fn remove_state()
```

**功能**：在干净关闭时删除守护进程状态文件。

**用途**：当守护进程正常、干净地关闭时，调用此函数可以移除状态文件，表示没有正在运行的守护进程。

### 3.4 指数退避相关组件

#### 3.4.1 常量定义

```rust
pub const INITIAL_BACKOFF_MS: u64 = 1_000;
pub const MAX_BACKOFF_MS: u64 = 300_000; // 5 minutes
```

- `INITIAL_BACKOFF_MS`：初始退避时间，设置为 1 秒
- `MAX_BACKOFF_MS`：最大退避时间，设置为 5 分钟，防止退避时间无限增长

#### 3.4.2 compute_backoff 函数

```rust
pub fn compute_backoff(current_ms: u64) -> u64
```

**功能**：根据当前的退避时间计算下一次的退避时间。

**参数**：
- `current_ms`：当前的退避时间（毫秒）

**返回值**：
- `u64`：计算后的下一次退避时间（毫秒）

**算法**：
1. 将当前退避时间乘以 2
2. 将结果与最大退避时间比较，取较小值
3. 返回结果

**示例**：
```
初始值: 1000ms
第1次: 2000ms
第2次: 4000ms
第3次: 8000ms
...
直到达到 300000ms (5分钟)，之后保持为 300000ms
```

这种指数退避策略可以在组件持续失败的情况下，逐渐减少重启频率，避免系统资源被过度消耗。

### 3.5 cmd_daemon 函数

```rust
pub(crate) async fn cmd_daemon() -> Result<()>
```

**功能**：这是 `zeptoclaw daemon` CLI 命令的主要实现函数，负责协调整个守护进程的运行。

**工作流程**：
1. 打印启动消息
2. 加载配置
3. 记录启动时间和网关地址
4. 设置信号处理，监听 Ctrl+C 以支持优雅关闭
5. 初始化重启计数和退避时间
6. 进入主循环：
   a. 创建并写入当前状态
   b. 尝试启动网关组件
   c. 如果网关正常退出，打破循环
   d. 如果网关失败，增加重启计数，记录错误，更新状态
   e. 检查是否收到关闭信号，如果是则打破循环
   f. 否则，等待指数退避时间后继续循环
7. 写入最终状态
8. 打印关闭消息并返回

**关键特性**：
- 使用 `Arc<AtomicBool>` 来在异步任务间共享关闭信号状态
- 使用 `Arc<AtomicU64>` 来安全地跟踪重启计数
- 在每次重启前更新状态文件，确保外部可以观测到最新状态
- 只有在网关组件干净退出或收到关闭信号时才会结束主循环

## 4. 配置与依赖

### 4.1 配置依赖

`cli_surface_daemon` 模块依赖于 `Config` 结构，特别是网关配置部分：

```rust
let config = Config::load()?;
// ...
let gateway_addr = format!("{}:{}", config.gateway.host, config.gateway.port);
```

**关键配置项**：
- `config.gateway.host`：网关服务的主机地址
- `config.gateway.port`：网关服务的端口号

这些配置项决定了状态文件中记录的网关地址，也间接影响了网关组件的启动参数。

### 4.2 外部依赖

- `zeptoclaw::config::Config`：系统配置管理，参考 [configuration](configuration.md) 模块
- `super::gateway::cmd_gateway`：网关组件的启动函数，参考相关网关模块文档
- 标准库和第三方库：
  - `std::path::PathBuf`：路径处理
  - `std::sync::atomic`：原子操作，用于线程安全的状态管理
  - `tokio`：异步运行时，用于异步任务执行和信号处理
  - `serde`：序列化/反序列化，用于状态的 JSON 格式存储
  - `anyhow`：错误处理
  - `tracing`：日志记录
  - `chrono`：时间处理

## 5. 使用指南与示例

### 5.1 基本使用

启动 ZeptoClaw 守护进程非常简单，只需在命令行中运行：

```bash
zeptoclaw daemon
```

这将启动守护进程，它会自动加载配置，启动网关组件，并在网关组件发生故障时自动重启。

### 5.2 状态监控

虽然 `cli_surface_daemon` 模块本身没有提供查看状态的功能，但它的状态文件可以被其他组件（如 CLI 的 status 命令）使用：

```bash
# 假设存在 status 命令
zeptoclaw status
```

这将读取 `daemon_state.json` 文件并显示当前守护进程的状态。

### 5.3 停止守护进程

要停止正在运行的守护进程，可以在运行守护进程的终端中按 `Ctrl+C`，这会触发优雅关闭流程。

## 6. 监控与维护

### 6.1 状态文件位置

状态文件保存在配置目录下的 `daemon_state.json` 文件中：

```rust
pub fn daemon_state_path() -> PathBuf {
    Config::dir().join("daemon_state.json")
}
```

具体位置取决于 `Config::dir()` 的实现，通常是用户主目录下的 `.zeptoclaw` 或类似目录。

### 6.2 日志

守护进程使用 `tracing` 库记录重要事件，包括：
- 启动和关闭事件
- 网关组件的启动和退出
- 错误发生和重启决策
- 退避等待信息

建议在生产环境中配置适当的日志收集和监控，以便及时发现和处理问题。

### 6.3 常见问题排查

| 问题 | 可能原因 | 排查建议 |
|------|----------|----------|
| 守护进程频繁重启 | 网关组件配置错误或依赖缺失 | 检查日志中的 `last_error` 字段，确认网关无法启动的具体原因 |
| 重启间隔已达到最大值 | 网关持续失败 | 检查系统资源、网络连接和网关配置，考虑手动干预 |
| 状态文件不存在 | 守护进程未运行或已干净关闭 | 使用 `ps` 等工具确认守护进程是否在运行 |
| 无法停止守护进程 | 信号处理失效 | 在极端情况下，可以使用 `kill` 命令，但建议先尝试正常关闭流程 |

## 7. 总结

`cli_surface_daemon` 模块为 ZeptoClaw 系统提供了可靠的进程监控和自动恢复能力。通过简单的指数退避重启策略和状态持久化机制，它确保了系统核心组件的高可用性，同时为运维人员提供了必要的可观测性工具。

该模块的设计简洁而有效，遵循了单一职责原则，将复杂的故障恢复逻辑封装在一个独立的模块中。无论是在开发环境还是生产环境中，它都是确保 ZeptoClaw 系统稳定运行的重要组成部分。
