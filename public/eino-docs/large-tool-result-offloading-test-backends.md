# 大型工具结果卸载测试后端 (large_tool_result_offloading_test_backends)

## 模块概述

**这个模块是做什么的？**

在 AI Agent 系统中，工具（Tool）执行后返回的结果会作为上下文发送给 LLM。当工具返回超大型结果（如读取大文件、数据库查询结果等）时，会迅速耗尽 LLM 的上下文窗口，导致系统无法正常工作。

`large_tool_result_offloading_test_backends` 模块是 `large_tool_result_offloading` 功能的**测试模块**，它提供了两类测试用后端（`mockBackend` 和 `failingBackend`）以及完整的测试用例，用于验证大型工具结果卸载机制的 correctness（正确性）。

**为什么需要这个模块？**

直接使用真实文件系统进行测试会带来几个问题：测试会受限于磁盘空间和 I/O 速度，测试之间可能产生状态污染，且难以模拟各种错误场景。这个测试模块通过提供**内存模拟后端**，让测试变得快速、可靠且易于控制。

---

## 架构与数据流

### 核心组件

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          工具调用流程                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Agent Request                                                         │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐   │
│   │ ToolInput   │────▶│ Tool Middleware  │────▶│ Tool Endpoint    │   │
│   │ (name,      │     │ (Offloading      │     │ (实际工具实现)    │   │
│   │  call_id,   │     │  Wrapper)        │     │                  │   │
│   │  params)    │     └────────┬─────────┘     └────────┬─────────┘   │
│   └─────────────┘              │                        │              │
│                               │                        ▼              │
│                               │               ┌──────────────────┐     │
│                               │               │ ToolOutput       │     │
│                               │               │ (result string)  │     │
│                               │               └────────┬─────────┘     │
│                               │                        │              │
│                               ▼                        │              │
│                    ┌──────────────────┐               │              │
│                    │ handleResult()   │◀──────────────┘              │
│                    │ (大小检查逻辑)     │                                │
│                    └────────┬─────────┘                                │
│                             │                                          │
│              ┌──────────────┼──────────────┐                          │
│              │              │              │                          │
│              ▼              ▼              ▼                          │
│      ┌────────────┐  ┌────────────┐  ┌────────────┐                  │
│      │ 结果 < 阈值 │  │ 结果 >= 阈值 │  │ 路径生成    │                  │
│      │ 直接返回   │  │ 写入后端   │  │ 失败       │                  │
│      └────────────┘  └────────────┘  └────────────┘                  │
│                             │              │                          │
│                             ▼              ▼                          │
│                    ┌──────────────────┐  │                            │
│                    │ 返回摘要消息     │  │                            │
│                    │ (含文件路径)    │◀─┘                            │
│                    └────────┬─────────┘                               │
│                             │                                          │
│                             ▼                                          │
│                      LLM Context                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 测试后端角色

本模块提供的两个测试后端扮演着"模拟真实存储"的角色：

1. **mockBackend（模拟正常后端）**
   - 内部使用 Go map 模拟文件系统
   - `Write` 操作将内容存储在内存中
   - 可通过检查 map 内容验证写入是否成功

2. **failingBackend（模拟故障后端）**
   - 可配置返回特定错误
   - 用于验证错误处理逻辑是否正确

---

## 组件深度解析

### mockBackend 结构

```go
type mockBackend struct {
    files map[string]string
}
```

**设计意图**：`mockBackend` 是一个**内存中的虚拟文件系统**。它完全避免了对真实磁盘的 I/O 操作，使测试能够：

- **快速执行**：内存操作比磁盘 I/O 快几个数量级
- **隔离运行**：测试之间无共享状态，不会互相干扰
- **精确验证**：通过检查 `files` map 可以精确确认写入的内容和路径

**核心方法**：
- `Write(context.Context, *filesystem.WriteRequest) error`：将内容写入 map，key 为文件路径

### failingBackend 结构

```go
type failingBackend struct {
    writeErr error
}
```

**设计意图**：`failingBackend` 用于模拟**存储后端故障**场景。在生产环境中，存储服务可能因各种原因失败（权限问题、磁盘满、网络超时等），这个测试后端确保系统能正确处理这些失败情况。

**核心方法**：
- `Write`：当 `writeErr` 不为 nil 时返回该错误，否则成功

### 测试用例分析

#### 1. 小结果直接通过 (TestToolResultOffloading_SmallResult)

验证当工具结果小于阈值时，middleware 不干预结果，直接传递给下游。

```
输入: "This is a small result" (17 字符)
阈值: 100 tokens (≈ 400 字符)
预期: 结果保持不变，后端无文件写入
```

#### 2. 大结果触发卸载 (TestToolResultOffloading_LargeResult)

验证当工具结果超过阈值时，系统执行完整卸载流程：
- 将原始结果写入后端存储
- 返回包含文件路径的摘要消息
- 摘要消息包含原始内容的前 10 行预览

```
输入: 10行重复文本 (~300+ 字符)
阈值: 10 tokens (≈ 40 字符)
预期: 
  - 后端写入成功
  - 返回消息包含 "Tool result too large"
  - 返回消息包含 call ID 和文件路径
```

#### 3. 自定义路径生成器 (TestToolResultOffloading_CustomPathGenerator)

验证 `PathGenerator` 配置项允许自定义文件存储路径。这是生产环境中的常见需求——不同的工具可能需要存储到不同的目录。

#### 4. 路径生成失败 (TestToolResultOffloading_PathGeneratorError)

验证当 `PathGenerator` 返回错误时，错误能正确向上传播，不会有部分状态残留。

#### 5. 端点执行失败 (TestToolResultOffloading_EndpointError)

验证 middleware 不会吞掉工具执行过程中的错误，错误应透明传播。

#### 6. 默认 Token 限制 (TestToolResultOffloading_DefaultTokenLimit)

验证当 `TokenLimit` 设为 0 时，系统使用默认值 20000 tokens（约 80000 字符）。

#### 7. 流式处理 (TestToolResultOffloading_Stream)

验证系统同时支持同步（Invokable）和流式（Streamable）工具端点。流式场景下，middleware 需要先**完整消费流**再进行大小判断。

#### 8. 流式端点错误 (TestToolResultOffloading_StreamError)

验证流式端点的错误处理逻辑。

#### 9. 后端写入失败 (TestToolResultOffloading_BackendWriteError)

验证当后端写入失败时，错误正确传播，不返回部分成功的摘要消息。

#### 10. 工具消息格式化 (TestFormatToolMessage)

验证摘要消息的格式化逻辑：
- 最多显示前 10 行
- 每行添加行号前缀
- 单行超过 1000 字符时截断
- 正确处理 Unicode 字符

#### 11. 流式数据拼接 (TestConcatString)

验证将 `schema.StreamReader` 拼接为完整字符串的辅助函数，包含对 nil 流的错误处理。

---

## 依赖分析

### 上游依赖（谁调用这个模块）

这个模块是被 `large_tool_result_offloading.go` 调用的测试套件。从模块树来看：

```
adk_middlewares_and_filesystem
  └── generic_tool_result_reduction
        ├── reduction_tool_result_contracts  (接口定义)
        ├── large_tool_result_offloading      (实际实现)
        └── large_tool_result_offloading_test_backends (本模块)
```

### 下游依赖（这个模块调用什么）

根据代码分析，本模块依赖以下外部组件：

| 依赖 | 用途 |
|------|------|
| `github.com/cloudwego/eino/adk/filesystem` | `WriteRequest` 结构定义 |
| `github.com/cloudwego/eino/compose` | `ToolInput`, `ToolOutput`, `StreamToolOutput` 类型 |
| `github.com/cloudwego/eino/schema` | `StreamReaderFromArray` 用于创建测试用流 |

### 关键数据契约

**Backend 接口**（定义在 `tool_result.go`）：

```go
type Backend interface {
    Write(context.Context, *filesystem.WriteRequest) error
}
```

这是**极简接口设计**的典范——只暴露一个 `Write` 方法。这带来几个好处：
- 易于实现：任何能写入数据的存储都可以作为 Backend
- 易于测试：mock 实现只需实现一个方法
- 灵活扩展：生产环境可以接入 S3、OSS、HDFS 等

---

## 设计决策与权衡

### 1. Token 计算：简单启发式 vs 精确计数

**选择**：使用 `字符数 / 4` 作为 token 估算

```go
// large_tool_result.go 第 127 行
if t.counter(schema.ToolMessage(result, input.CallID, ...)) > t.tokenLimit*4
```

**权衡分析**：
- **优点**：计算速度快，无需额外依赖
- **缺点**：对于不同语言和内容类型，估算精度不同（英文约 4 字符/token，中文约 1-2 字符/token）

这是典型的**性能 vs 精度**权衡。在高频调用的 middleware 中，引入完整的 token 计数器（如 tiktoken）会增加显著开销。

### 2. 摘要消息格式：信息量 vs 简洁

**选择**：摘要消息包含文件路径、LLM 可用的读取工具名、原始内容前 10 行预览

```go
const tooLargeToolMessage = `Tool result too large, the result of this tool call {tool_call_id} 
was saved in the filesystem at this path: {file_path}
You can read the result from the filesystem by using the '{read_file_tool_name}' tool...
Here are the first 10 lines of the result:
{content_sample}`
```

**设计考量**：
- 提供文件路径：让 LLM 知道去哪里读取
- 提供工具名：让 LLM 知道用什么工具
- 提供内容预览：让 LLM 立即能看到部分内容，可能不需要完整读取

### 3. 流式处理：先聚合再处理

**选择**：流式端点先完整消费流，再进行大小判断

```go
// large_tool_result.go 第 114-118 行
output, err := endpoint(ctx, input)
result, err := concatString(output.Result)  // 先消费整个流
result, err = t.handleResult(ctx, result, input)  // 再处理
```

**权衡分析**：
- **代价**：需要等待整个流完成，无法实现边读边卸载
- **收益**：逻辑统一，无需为流式场景单独设计协议

这种设计在"工具结果"场景下是合理的，因为工具结果通常在执行完成后才返回，不存在真正的"流式生成"场景。

### 4. 默认路径生成：约定优于配置

**选择**：提供默认路径 `/large_tool_result/{ToolCallID}`

```go
if offloading.pathGenerator == nil {
    offloading.pathGenerator = func(ctx context.Context, input *compose.ToolInput) (string, error) {
        return fmt.Sprintf("/large_tool_result/%s", input.CallID), nil
    }
}
```

**权衡分析**：
- **优点**：降低使用门槛，大多数场景无需配置
- **缺点**：可能与生产环境的存储策略冲突（可通过配置覆盖）

---

## 使用指南与常见陷阱

### 集成到 Agent

本模块测试的功能通过 `NewToolResultMiddleware` 暴露给用户：

```go
// 完整配置示例
middleware, err := reduction.NewToolResultMiddleware(ctx, &reduction.ToolResultConfig{
    Backend:               myBackend,           // 必须提供
    OffloadingTokenLimit:  20000,               // 默认值
    ReadFileToolName:      "read_file",         // 默认值
    PathGenerator:         customPathGenerator, // 可选
})
```

**重要**：使用 offloading 功能时，必须同时提供 **read_file 工具**，否则 LLM 将无法读取被卸载的内容。

### 测试中的使用方式

如果你需要为自定义 Backend 编写测试，可以参考本模块的模式：

```go
// 1. 创建 mock backend
backend := newMockBackend()

// 2. 创建配置
config := &toolResultOffloadingConfig{
    Backend:    backend,
    TokenLimit: 10, // 小值便于触发 offloading
}

// 3. 创建 middleware
middleware := newToolResultOffloading(ctx, config)

// 4. 包装端点并执行
wrappedEndpoint := middleware.Invokable(yourEndpoint)
output, err := wrappedEndpoint(ctx, input)

// 5. 验证结果
// - 检查 output.Result 是否为摘要消息
// - 检查 backend.files 是否包含预期内容
```

### 常见陷阱

#### 陷阱 1：忘记提供 read_file 工具

**症状**：LLM 收到"Tool result too large"消息但无法读取内容，系统陷入空转

**解决**：确保在使用 offloading 时，Agent 配置包含 filesystem middleware 或自定义的 read_file 工具

#### 陷阱 2：Token 估算不准确导致误卸载

**症状**：小结果被误判为大结果并触发 offloading

**解决**：对于中文内容，考虑自定义 `TokenCounter` 使用更精确的计数方式

#### 陷阱 3：流式场景未完整消费

**症状**：流式端点的 offloading 不工作

**解决**：确保在调用 middleware 的 Streamable 之前，上游已正确创建 StreamReader

#### 陷阱 4：路径冲突

**症状**：相同 call_id 的多次调用互相覆盖

**解决**：确保 PathGenerator 生成唯一路径，或在 Backend 实现层面处理冲突

---

## 相关模块

- [large-tool-result-offloading](./large-tool-result-offloading.md) - 实际卸载逻辑实现
- [tool-result](./tool-result.md) - 工具结果中间件的顶层接口和配置
- [filesystem-backend-core](../filesystem_backend_core.md) - 真实文件系统后端实现
- [filesystem-tool-middleware](../filesystem_tool_middleware.md) - 提供 read_file 工具的文件系统中间件