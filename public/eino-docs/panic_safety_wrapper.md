# panic_safety_wrapper（`internal/safe/panic.go`）技术深潜

`panic_safety_wrapper` 这个模块做的事情很“小”，但在工程可靠性上非常关键：它把原本会“炸掉调用栈”的 `panic` 信息，包装成一个普通 `error`，并且把 stack trace 一起带出来。你可以把它理解成给 Go 的 `panic` 装了一个“黑匣子”——事故发生后不再只有“坠机了”这条消息，而是有事故描述（`info`）和飞行记录（`stack`），让上层框架可以继续按照错误链路处理，而不是直接崩溃。

---

## 1. 这个模块要解决什么问题？

在 Go 里，`panic` 和 `error` 是两条不同的失败通道。大部分业务框架（回调系统、图执行引擎、工具调用链）都围绕 `error` 做传播、重试、日志、观测；而 `panic` 默认是“非本地中断”，如果没有 `recover`，会直接终止当前 goroutine，严重时导致进程退出。**问题不在于 panic 会发生，而在于 panic 一旦发生，系统缺少一个统一、可组合的失败表示。**

`internal.safe.panic.NewPanicErr(info any, stack []byte) error` 的设计意图就是提供这个统一表示：把 `panic` 的原始值和调用栈封装成一个实现了 `error` 接口的对象（`panicErr`），让“异常中断”降级为“可传递错误”。

一个天真的替代方案是直接 `fmt.Errorf("panic: %v", info)`。这看起来够用，但会丢掉最关键的定位信息：调用栈。另一个替代是把 stack 打日志，不放进 error；这样会导致错误对象本身不自描述，跨模块传递时可观测性会断裂。当前实现选择把两者绑定到一个 error 里，优先保证诊断完整性。

---

## 2. 心智模型：把 panic “驯化”为 error 的适配层

可以把这个模块想成一个 **协议转换器（adapter）**：

- 输入侧是“panic 世界”（任意类型的 `info any` + 栈快照 `[]byte`）
- 输出侧是“error 世界”（符合 `error` 接口，可被上游统一处理）

这个转换器本身非常薄，不负责 `recover`，也不负责采集 stack；它只做**结构化封装**和**可读格式化**。换句话说，它是 panic-safe 方案中的“数据载体层”，不是“控制流拦截层”。

---

## 3. 架构与数据流

```mermaid
flowchart LR
    A[Caller recover boundary] --> B[panic info]
    B --> C[stack bytes]
    C --> D[NewPanicErr]
    D --> E[panicErr error object]
    E --> F[Error string]
    F --> G[log and upper error pipeline]
```

上图里，真正属于本模块的是 `D -> E -> F` 这一段：

1. 调用方在 `recover` 后拿到 panic 值（任意类型）。
2. 调用方采集 stack（通常是 `[]byte`）。
3. 调用 `NewPanicErr(info, stack)` 返回 `error`。
4. 上层把这个 `error` 当普通错误传播。
5. 当日志或错误呈现需要字符串时，触发 `panicErr.Error()`，输出包含 `info` 与 `stack` 的文本。

### 模块的架构角色

它是一个**底层可靠性基础件**，角色更接近“错误语义适配器”，而不是业务编排器。它不参与调度、不维护状态机、不依赖框架上下文，因此复用成本很低。

---

## 4. 组件深潜

### `type panicErr struct`

`panicErr` 是未导出结构体，字段如下：

- `info any`：panic 原始负载。之所以用 `any`，是因为 `panic` 在 Go 中允许抛出任意类型值。
- `stack []byte`：栈信息原文（字节切片）。保留 `[]byte` 而不是提前转 `string`，避免在创建时做不必要分配；只有在 `Error()` 被调用时才转换。

这个结构体不导出，意味着外部只能通过构造函数拿到 `error` 接口，不能依赖内部字段布局。**这是刻意收口：保护内部表示，避免未来重构时 API 破坏。**

### `func (p *panicErr) Error() string`

实现：

```go
return fmt.Sprintf("panic error: %v, \nstack: %s", p.info, string(p.stack))
```

这里有两个设计点：

第一，`info` 用 `%v`，意味着对任意 panic 值都能尽量打印可读内容，不强制类型断言。

第二，`stack` 原样渲染成字符串，确保调试时看到完整调用路径。它把“事件描述 + 现场证据”放在同一条错误文本里，便于日志系统或回调链路直接消费。

### `func NewPanicErr(info any, stack []byte) error`

`NewPanicErr` 是模块唯一导出入口。它返回 `error` 而不是 `*panicErr`，这是典型的“面向接口暴露、面向实现隐藏”策略：

- 调用方只需要把它当错误处理；
- 维护者可以在不破坏调用侧的前提下调整内部实现（例如将来添加更多元数据字段）。

---

## 5. 依赖分析（基于现有源码可确认的信息）

从 `internal/safe/panic.go` 可以严格确认的依赖关系很简单：

- 本模块调用：Go 标准库 `fmt`（用于格式化 `Error()` 字符串）。
- 本模块被谁调用：在当前提供的组件代码片段里**没有直接展示**调用点；可确定的是它被设计为供外层 `recover` 逻辑使用。

因此，这个模块的显式数据契约是：

- 输入：`info any`、`stack []byte`
- 输出：`error`（其文本语义固定包含 panic 信息和栈）

隐式契约是：

- `stack` 应该是可读栈文本字节；否则 `Error()` 输出可读性会下降。
- 调用方应在合适边界（goroutine、任务、回调入口）做 `recover`，否则 `NewPanicErr` 没机会被调用。

---

## 6. 设计取舍与背后原因

### 简洁性 vs. 扩展性

当前实现极简：一个结构体、一个构造函数、一个 `Error()`。这让它几乎没有学习成本，也几乎不可能引入复杂 bug。代价是语义扩展较少，比如没有内建分类码、没有原始类型访问器。

对底层安全模块来说，这种取舍合理：越底层越应稳定、可预测、少策略。

### 性能 vs. 诊断完整性

`Error()` 中把 `[]byte` 转成 `string` 会有一次转换成本，但换来完整 stack 的携带能力。该成本通常发生在错误路径，且远小于故障排查收益，因此偏向正确性与可观测性。

### 解耦 vs. 语义可识别性

返回 `error` 提高了解耦，但也意味着上层如果想“识别是否 panic 包装错误”，目前没有导出类型可做类型断言。这是一个刻意边界：模块优先保证统一错误处理，而不是鼓励上层耦合内部类型。

---

## 7. 使用方式与示例

一个典型用法是在边界函数中兜底 `panic`：

```go
import (
    "runtime/debug"

    "your/module/internal/safe"
)

func runSafely(fn func() error) (err error) {
    defer func() {
        if r := recover(); r != nil {
            err = safe.NewPanicErr(r, debug.Stack())
        }
    }()

    return fn()
}
```

这里 `safe.NewPanicErr` 不负责 `recover`，也不负责 `debug.Stack()`；它只负责把两者组合成统一 `error`。这种职责分离让调用方可以按需替换 stack 采样策略。

---

## 8. 新贡献者最该注意的点（Gotchas）

第一，不要把这个模块误解成“自动防 panic”。它不会拦截控制流，必须由外层显式 `defer + recover` 才生效。

第二，`panicErr` 是未导出类型。你不能也不该在外部依赖其具体字段；把它当普通 `error` 使用才是正确姿势。

第三，`info any` 可能是任何类型，甚至是复杂对象。`%v` 的输出依赖该对象的格式化行为，日志内容不一定稳定。若业务有审计要求，调用侧应在 `recover` 处先做脱敏/规范化。

第四，`stack []byte` 的质量完全取决于调用方传入内容。传空切片不会报错，但会让错误诊断价值显著下降。

---

## 9. 可演进方向（在不破坏当前契约前提下）

在保持 `NewPanicErr(info, stack) error` 这个稳定入口不变的情况下，可以考虑：

- 增加辅助判断函数（例如“是否为 panic 包装错误”）来改善上层分类处理能力；
- 提供结构化字段导出策略（在不泄漏内部实现的前提下）以便指标系统做维度统计；
- 增加可选截断策略，防止极端长 stack 造成日志膨胀。

这些都属于“增强可运营性”，不是当前模块成立的必要条件。

---

## 10. 参考与关联模块

这个模块位于 Internal Utilities 族中，关注点是故障安全与错误语义适配。可结合以下文档理解整体内部工具层设计风格：

- [generic_helpers](generic_helpers.md)
- [Schema Stream](Schema%20Stream.md)
- [Compose Graph Engine](Compose%20Graph%20Engine.md)

如果你在这些上层模块里看到统一 `error` 传播链路，可以把 `panic_safety_wrapper` 理解为它们在异常路径上的“最薄底座”。
