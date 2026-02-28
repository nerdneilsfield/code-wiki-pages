# reduction_tool_result_contracts 模块技术深潜

## 概述

`reduction_tool_result_contracts` 模块是工具结果缩减中间件的核心契约层。想象一下：当一个 AI Agent 与用户进行长对话时，工具调用的结果会不断累积，逐渐填满 LLM 的上下文窗口。这个模块解决的问题是**如何在有限的上下文窗口中管理不断增长的工具结果**——它不是简单地截断或丢弃数据，而是采用两种互补的策略：一种是将**旧的结果替换为占位符**（类比于图书馆的参考索引卡），另一种是将**过大的单个结果卸载到文件系统**（类比于将不常用的书籍搬到仓库，只在需要时取回）。

这个模块本身不实现任何缩减逻辑，它定义的是**接口契约**和**配置结构**。它告诉调用者："如果你想实现工具结果缩减，你需要提供这样的 Backend，你需要配置这些参数"。实际的清除策略和卸载策略分别由同级的 `clear_tool_result_policy` 和 `large_tool_result_offloading` 模块实现。

## 架构定位

```
adk_middlewares_and_filesystem/
└── generic_tool_result_reduction/
    ├── reduction_tool_result_contracts    ← 当前模块（契约层）
    │   ├── Backend (interface)
    │   └── ToolResultConfig (struct)
    ├── clear_tool_result_policy           ← 清除策略实现
    └── large_tool_result_offloading       ← 卸载策略实现
```

从模块树结构可以看出，`reduction_tool_result_contracts` 是 `generic_tool_result_reduction` 的子模块，它与两个实现模块处于同一层级。`ToolResultConfig` 实际上是一个**组合配置**，它将两种策略的配置统一在一起，通过 `NewToolResultMiddleware` 函数创建出一个组合中间件。

**依赖关系**：
- 依赖 `adk.AgentMiddleware`（中间件类型定义）
- 依赖 `filesystem.WriteRequest`（文件写入请求格式）
- 依赖 `compose.ToolInput`（工具输入结构）
- 依赖 `schema.Message`（消息结构，用于 token 计数）

## 核心组件

### Backend 接口

```go
type Backend interface {
    Write(context.Context, *filesystem.WriteRequest) error
}
```

**设计意图**：Backend 接口是整个缩减系统的存储抽象。它只定义了一个 `Write` 方法，这是经过深思熟虑的设计选择——工具结果卸载只需要**写入**能力，不需要读取。这是因为卸载后，内容通过专门的 `read_file` 工具（由文件系统中间件提供）供 LLM 读取，而不是通过这个 Backend。

这种极简接口设计的好处是：调用者可以轻松接入任何支持写入的存储系统，无论是本地文件系统、云存储还是数据库。只要实现了 `Write` 方法，即可作为 Backend 使用。

**参数**：
- `context.Context`：用于传播取消信号和超时控制
- `*filesystem.WriteRequest`：包含 `FilePath`（绝对路径）和 `Content`（要写入的内容）

**返回**：错误表示写入失败，调用方需要处理重试或降级策略。

### ToolResultConfig 结构

```go
type ToolResultConfig struct {
    ClearingTokenThreshold   int
    KeepRecentTokens         int
    ClearToolResultPlaceholder string
    TokenCounter             func(msg *schema.Message) int
    ExcludeTools             []string
    Backend                  Backend
    OffloadingTokenLimit     int
    ReadFileToolName         string
    PathGenerator            func(ctx context.Context, input *compose.ToolInput) (string, error)
}
```

这个配置结构体现了**双策略组合**的设计思想。每一项配置都对应着工具结果管理的一个维度：

**令牌阈值配置**：
- `ClearingTokenThreshold`：清除阈值，默认 20000。当所有工具结果的 token 总和超过此值时，触发清除逻辑
- `KeepRecentTokens`：保留最近 token 数，默认 40000。这是一种"保护窗口"机制，确保最近的对话历史不被清除，即使触发清除条件
- `OffloadingTokenLimit`：卸载阈值，默认 20000。当单个工具结果超过此值时，触发文件系统卸载

为什么有两个 20000 的默认值？这反映了两种策略的不同触发条件：清除策略处理的是**累积量**（总量超标），卸载策略处理的是**个体量**（单个过大）。

**清除策略配置**：
- `ClearToolResultPlaceholder`：清除后的替代文本，默认 `"[Old tool result content cleared]"`。LLM 会看到这个占位符，知道这里有历史数据但被优化了
- `TokenCounter`：自定义 token 计数函数。默认使用字符数/4 的启发式估算，这在大多数情况下足够准确
- `ExcludeTools`：排除列表，某些工具的结果永远不被清除（比如关键的摘要工具）

**卸载策略配置**：
- `Backend`：存储后端，**必需**。这是实现卸载的关键依赖
- `ReadFileToolName`：LLM 用来读取卸载内容的工具名，默认 `"read_file"`。这个名称会被嵌入到卸载提示中
- `PathGenerator`：生成卸载文件路径的函数，默认 `/large_tool_result/{ToolCallID}`。使用 ToolCallID 确保每个工具调用有唯一的存储位置

### NewToolResultMiddleware 函数

```go
func NewToolResultMiddleware(ctx context.Context, cfg *ToolResultConfig) (adk.AgentMiddleware, error)
```

这是模块的**出口函数**，它将配置转化为可执行的中间件。注意它返回的是一个组合中间件：

```go
return adk.AgentMiddleware{
    BeforeChatModel: bc,  // 清除策略
    WrapToolCall:    tm,  // 卸载策略
}, nil
```

- `BeforeChatModel`：在 LLM 调用之前执行，负责清除过期的工具结果
- `WrapToolCall`：包装工具调用，负责将过大的单个结果卸载到文件系统

## 数据流分析

### 清除策略数据流

```
用户输入 → Agent 运行 → 工具调用 → 工具结果生成
                                    ↓
                        BeforeChatModel (清除中间件)
                                    ↓
                        1. 遍历所有工具结果消息
                        2. 计算每个消息的 token 数
                        3. 从后向前累加，判断是否超出 KeepRecentTokens
                        4. 对超出保留窗口的消息，检查是否在 ExcludeTools 中
                        5. 将需要清除的结果替换为占位符
                                    ↓
                        LLM 接收处理后的消息列表
```

清除策略是**向后扫描**的：从最新的消息开始向前计算 token 数，直到累积量低于 `KeepRecentTokens`。这确保了"最近的对话"总是被保留。

### 卸载策略数据流

```
工具调用执行 → WrapToolCall 中间件拦截
                    ↓
            检查工具结果 token 数
                    ↓
            ┌───────────────┐
            │ 超出阈值？     │
            └───────┬───────┘
              是   │   否
              ↓    ↓
        写入 Backend │ 直接返回
              ↓
        生成摘要消息
        (包含文件路径和 read_file 工具提示)
              ↓
        返回摘要 + 原始结果引用
```

卸载策略是**即时处理**的：每个工具调用完成后立即检查结果大小，不需要等待累积。

## 设计决策与权衡

### 决策一：双策略组合而非单一策略

**可选方案**：
1. 单一清除策略：只替换旧结果为占位符
2. 单一卸载策略：只将大结果写文件
3. 组合策略：同时支持清除和卸载

**当前选择**：组合策略。

**理由**：单一策略都有明显局限。清除策略会导致**信息丢失**——如果旧工具结果中有 LLM 需要的关键信息，清除后可能影响推理质量。卸载策略对于**大量小结果累积**的情况效果不佳。组合策略兼顾了两种场景：累积量大时清除旧结果，单个大小时卸载该结果。

### 决策二：基于启发式的 Token 估算

**可选方案**：
1. 精确 Tokenizer：使用完整的分词器精确计算
2. 启发式估算：字符数/4
3. 用户自定义函数

**当前选择**：默认启发式估算 + 支持自定义。

**理由**：这是一个典型的**性能 vs 准确性**权衡。精确 Tokenizer 引入额外依赖和计算开销，而工具结果主要是代码输出、日志等文本内容，字符数/4 的估算在大多数情况下足够接近。使用启发式可以让中间件保持轻量，同时通过 `TokenCounter` 字段保留灵活性给对准确性有高要求的用户。

### 决策三：Backend 接口极简化

**可选方案**：
1. 完整 CRUD 接口：支持读、写、删、列表
2. 仅 Write 接口
3. 读写分离：Write 接口 + 单独的 Read 工具

**当前选择**：仅 Write 接口。

**理由**：这个设计体现了**关注点分离**。卸载后的内容读取由独立的 `read_file` 工具负责（通常是文件系统中间件提供），而不是通过 Backend。这使得 Backend 的实现可以非常简单——只需要能写入即可，甚至可以是只写的存储（如某些对象存储的追加模式）。

### 决策四：ToolCallID 作为文件路径标识

**设计**：默认路径 `/large_tool_result/{ToolCallID}`

**理由**：使用 ToolCallID 而非时间戳或 UUID 有几个好处：
1. **幂等性**：相同的工具调用会生成相同的路径，便于调试和重试
2. **可追溯性**：路径直接关联到具体的工具调用
3. **简洁性**：不需要额外的 ID 生成逻辑

## 边界情况与注意事项

### 必须提供 read_file 工具

文档中有明确的 NOTE 强调：使用卸载功能时，**必须**为 Agent 提供读取卸载内容的工具。否则 LLM 将看到摘要但无法获取原始数据。可以选择：
- 使用文件系统中间件（自带 read_file 工具）
- 自己实现一个读取同一 Backend 的 read_file 工具

### Token 估算的不准确性

字符数/4 是一个粗略估算，对于以下内容可能不准确：
- 非英文文本（中文通常 1 个字符对应 1-2 个 token）
- 特殊格式（JSON、代码可能有不同的 token 密度）

如果 token 计数准确性对业务很重要，应提供自定义的 `TokenCounter` 函数。

### 清除策略不会清除 ExcludeTools 中的工具结果

即使触发清除条件，`ExcludeTools` 列表中的工具结果也会被保留。这个列表应该谨慎使用，因为保留过多工具结果可能导致 token 预算无法有效控制。

### 路径生成器的线程安全

`PathGenerator` 函数在每次卸载时被调用。如果使用共享状态（如计数器、缓存），需要确保线程安全。建议使用纯函数或使用 context 传递的状态。

### 与文件系统中间件的关系

文档中有一个重要的 NOTE：如果使用文件系统中间件，工具结果卸载功能**已经默认包含**。这种情况下不需要单独配置此中间件。如果确实不需要卸载功能，可以设置 `Config.WithoutLargeToolResultOffloading = true`。

## 相关模块参考

- [clear_tool_result_policy](adk-middlewares-reduction-clear-tool-result-policy.md) - 清除策略实现
- [large_tool_result_offloading](adk-middlewares-reduction-large-tool-result-offloading.md) - 卸载策略实现
- [filesystem_backend_core](adk-filesystem-backend-core.md) - 文件系统后端实现
- [filesystem_tool_middleware](adk-middlewares-filesystem-filesystem.md) - 文件系统中间件（包含 read_file 工具）