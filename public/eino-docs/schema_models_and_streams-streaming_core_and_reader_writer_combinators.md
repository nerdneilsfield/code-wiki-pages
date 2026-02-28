# streaming_core_and_reader_writer_combinators 模块技术深度文档

## 1. 问题背景与模块定位

在构建流式处理系统时，开发者经常面临以下挑战：
- 需要在不同组件之间高效传递流式数据
- 需要支持对流的转换、合并、复制等复杂操作
- 需要处理错误传播和资源清理
- 需要在保持性能的同时提供易用的 API

这个模块的核心目标是提供一套**类型安全、可组合、资源安全**的流式数据处理抽象，让开发者能够像操作集合一样操作流，同时保持低开销和高可靠性。

## 2. 核心心智模型

### 2.1 流作为"有类型的通道"

可以把 `Stream` 想象成一个**有类型的传送带**：
- `StreamWriter` 是**传送带的起点**，负责把物品放上去
- `StreamReader` 是**传送带的终点**，负责把物品取下来
- 物品（数据）只能单向流动，从 writer 到 reader
- 传送带可以有缓冲区（capacity），防止物品堆积

### 2.2 组合器作为"传送带转换器"

模块提供的各种组合器（converter、merger、copier）可以看作是**传送带的中间处理站**：
- `StreamReaderWithConvert`：把传送带上的物品从一种类型转换成另一种类型
- `MergeStreamReaders`：把多个传送带合并成一个
- `Copy`：把一个传送带复制成多个，每个都能拿到相同的物品

## 3. 核心组件深度解析

### 3.1 Pipe：流的创建

```go
func Pipe[T any](cap int) (*StreamReader[T], *StreamWriter[T])
```

**设计意图**：创建一个有缓冲的流，连接生产者和消费者。

**内部机制**：
- 创建一个 `stream[T]` 结构体，内部使用 channel 实现
- `stream.items`：存储数据项的缓冲 channel
- `stream.closed`：用于通知发送方接收方已关闭的信号 channel

**为什么使用双 channel 设计**：
- `items` channel 负责数据传输
- `closed` channel 负责控制信号传输
- 这样可以在接收方提前关闭时，优雅地通知发送方停止发送，避免 goroutine 泄漏

### 3.2 StreamWriter：发送方

```go
type StreamWriter[T any] struct {
	stm *stream[T]
}

func (sw *StreamWriter[T]) Send(chunk T, err error) (closed bool)
func (sw *StreamWriter[T]) Close()
```

**设计意图**：提供类型安全的发送接口，同时支持发送错误。

**关键特性**：
- `Send` 方法会先检查流是否已关闭，避免向已关闭的 channel 发送数据
- 支持同时发送数据和错误，这在处理部分成功的流时非常有用
- `Close` 方法只是关闭 `items` channel，通知接收方没有更多数据了

### 3.3 StreamReader：接收方

```go
type StreamReader[T any] struct {
	typ readerType
	// ... 各种具体实现
}

func (sr *StreamReader[T]) Recv() (T, error)
func (sr *StreamReader[T]) Close()
```

**设计意图**：提供统一的接收接口，同时支持多种底层实现。

**多态设计**：
`StreamReader` 是一个**统一的门面**，内部通过 `typ` 字段区分不同的实现：
- `readerTypeStream`：基础的 channel-based 流
- `readerTypeArray`：从数组读取的流
- `readerTypeMultiStream`：合并多个流的流
- `readerTypeWithConvert`：带转换的流
- `readerTypeChild`：复制的子流

**为什么这样设计**：
- 对外提供统一的 API，用户不需要关心底层实现
- 内部可以针对不同场景使用最优的实现
- 方便扩展新的流类型

### 3.4 StreamReaderWithConvert：流转换

```go
func StreamReaderWithConvert[T, D any](
    sr *StreamReader[T], 
    convert func(T) (D, error), 
    opts ...ConvertOption
) *StreamReader[D]
```

**设计意图**：提供类型安全的流转换，同时支持错误处理和过滤。

**关键特性**：
- 转换函数可以返回 `ErrNoValue` 来过滤掉某个元素
- 支持通过 `WithErrWrapper` 包装原始流中的错误
- 转换是**惰性**的，只在调用 `Recv` 时才会执行

**内部机制**：
```go
func (srw *streamReaderWithConvert[T]) recv() (T, error) {
    for {
        out, err := srw.sr.recvAny()
        if err != nil {
            // 处理错误
        }
        t, err := srw.convert(out)
        if err == nil {
            return t, nil
        }
        if !errors.Is(err, ErrNoValue) {
            return t, err
        }
        // 如果是 ErrNoValue，继续循环，跳过这个元素
    }
}
```

### 3.5 Copy：流复制

```go
func (sr *StreamReader[T]) Copy(n int) []*StreamReader[T]
```

**设计意图**：将一个流复制成多个，每个子流都能读取到相同的数据。

**这是模块中最精巧的设计之一**，让我们深入理解：

**问题**：如何在不预先缓存所有数据的情况下，让多个子流都能读取到相同的数据？

**解决方案**：使用一个**共享的链表**来存储已读取的数据项。

```go
type cpStreamElement[T any] struct {
    once sync.Once
    next *cpStreamElement[T]
    item streamItem[T]
}

type parentStreamReader[T any] struct {
    sr *StreamReader[T]
    subStreamList []*cpStreamElement[T]
    closedNum uint32
}
```

**工作原理**：
1. 所有子流共享一个 `parentStreamReader`
2. `parentStreamReader` 维护一个链表，每个节点是 `cpStreamElement`
3. 每个 `cpStreamElement` 使用 `sync.Once` 确保只从原流读取一次
4. 当某个子流读取数据时：
   - 如果当前节点还未填充，它会负责从原流读取并填充
   - 其他子流会等待这个节点填充完成，然后直接读取
5. 所有子流都关闭后，才会关闭原流

**为什么这样设计**：
- 不需要预先缓存所有数据，内存效率高
- 只从原流读取一次，性能好
- 使用 `sync.Once` 确保线程安全
- 引用计数方式管理原流的关闭，避免资源泄漏

### 3.6 MergeStreamReaders：流合并

```go
func MergeStreamReaders[T any](srs []*StreamReader[T]) *StreamReader[T]
```

**设计意图**：将多个流合并成一个，按到达顺序读取数据。

**内部机制**：
- 对于少量流（≤ `maxSelectNum`），使用 `reflect.Select` 或自定义的 `receiveN`
- 对于大量流，使用 `reflect.Select` 动态处理
- 会自动优化：如果所有输入都是数组类型，会直接合并成一个数组流

**关键特性**：
- `MergeNamedStreamReaders` 变体可以追踪哪个源流结束了
- 当某个源流结束时，会返回 `SourceEOF` 错误
- 所有源流都结束后，才会返回最终的 `io.EOF`

## 4. 数据流转分析

让我们追踪一个典型的数据流转场景：

```
创建流 → 发送数据 → 转换数据 → 复制流 → 合并流 → 读取数据
```

### 4.1 完整示例

```go
// 1. 创建流
sr, sw := Pipe[int](3)

// 2. 发送数据（在另一个 goroutine）
go func() {
    defer sw.Close()
    for i := 0; i < 5; i++ {
        sw.Send(i, nil)
    }
}()

// 3. 转换数据：int → string
stringSr := StreamReaderWithConvert(sr, func(i int) (string, error) {
    return fmt.Sprintf("val_%d", i), nil
})

// 4. 复制流
srs := stringSr.Copy(2)

// 5. 合并流（虽然这个例子合并复制的流没什么实际意义）
mergedSr := MergeStreamReaders(srs)

// 6. 读取数据
defer mergedSr.Close()
for {
    val, err := mergedSr.Recv()
    if errors.Is(err, io.EOF) {
        break
    }
    fmt.Println(val)
}
```

### 4.2 数据流图

```
┌─────────────┐
│ StreamWriter│───┐
└─────────────┘   │
                  │
                  ▼
         ┌─────────────────┐
         │  stream (channel)│
         └─────────────────┘
                  │
                  ▼
         ┌───────────────┐
         │ StreamReader  │ (readerTypeStream)
         └───────────────┘
                  │
                  ▼
         ┌───────────────────────┐
         │ streamReaderWithConvert│ (readerTypeWithConvert)
         └───────────────────────┘
                  │
                  ▼
         ┌───────────────────┐
         │ parentStreamReader │
         └───────────────────┘
             │          │
             ▼          ▼
    ┌──────────┐  ┌──────────┐
    │childStream│  │childStream│ (readerTypeChild)
    └──────────┘  └──────────┘
             │          │
             └────┬─────┘
                  ▼
         ┌──────────────────┐
         │ multiStreamReader│ (readerTypeMultiStream)
         └──────────────────┘
                  │
                  ▼
         ┌───────────────┐
         │   Recv()      │
         └───────────────┘
```

## 5. 设计决策与权衡

### 5.1 类型安全 vs 代码复用

**决策**：使用泛型（Go 1.18+）实现类型安全，同时使用接口和类型擦处理多态。

**权衡**：
- ✅ 编译时类型检查，避免运行时错误
- ✅ API 简洁直观
- ❌ 内部实现需要处理类型擦除，增加了复杂度
- ❌ 某些操作（如 `Copy`）需要使用 `any` 类型

### 5.2 Channel-based vs 自定义实现

**决策**：基础流使用 channel 实现，但在特定场景使用自定义实现（如数组流）。

**权衡**：
- ✅ Channel 是 Go 原生的，线程安全，性能好
- ✅ 自定义实现（如数组流）在特定场景下更高效
- ❌ 需要维护多种实现，增加了代码复杂度
- ❌ 需要通过门面模式统一 API

### 5.3 eager vs lazy 求值

**决策**：所有组合器都使用 lazy 求值。

**权衡**：
- ✅ 内存效率高，只在需要时才处理数据
- ✅ 可以提前终止流处理
- ❌ 错误可能在很晚才被发现
- ❌ 需要小心处理 goroutine 泄漏

### 5.4 显式关闭 vs 自动关闭

**决策**：要求显式关闭，但提供 `SetAutomaticClose` 作为备选。

**权衡**：
- ✅ 显式关闭让资源管理更清晰
- ✅ 避免过早关闭导致的错误
- ❌ 用户容易忘记关闭，导致资源泄漏
- ❌ `SetAutomaticClose` 依赖 GC，不可预测

## 6. 依赖关系

### 6.1 被依赖模块

这个模块是一个**基础核心模块**，被系统中许多其他模块依赖：

- [compose_graph_engine](compose_graph_engine.md)：用于图执行时的流式数据传递
- [flow_agents_and_retrieval](flow_agents_and_retrieval.md)：用于 agent 运行时的流式输出
- [adk_runtime](adk_runtime.md)：用于各种运行时的流式处理

### 6.2 依赖模块

这个模块几乎不依赖其他业务模块，只依赖：
- Go 标准库（`errors`, `fmt`, `io`, `reflect`, `runtime`, `sync`, `sync/atomic`）
- `github.com/cloudwego/eino/internal/safe`：用于安全地处理 panic

## 7. 使用指南与最佳实践

### 7.1 基本使用模式

```go
// 创建流
sr, sw := schema.Pipe[string](3)

// 发送数据（通常在另一个 goroutine）
go func() {
    defer sw.Close() // 重要：必须关闭
    for _, item := range items {
        if closed := sw.Send(item, nil); closed {
            // 流已关闭，停止发送
            break
        }
    }
}()

// 接收数据
defer sr.Close() // 重要：必须关闭
for {
    chunk, err := sr.Recv()
    if errors.Is(err, io.EOF) {
        break
    }
    if err != nil {
        // 处理错误
        return err
    }
    // 处理数据
}
```

### 7.2 转换与过滤

```go
// 转换
intSr := StreamReaderFromArray([]int{1, 2, 3})
stringSr := StreamReaderWithConvert(intSr, func(i int) (string, error) {
    return fmt.Sprintf("val_%d", i), nil
})

// 过滤
filteredSr := StreamReaderWithConvert(stringSr, func(s string) (string, error) {
    if s == "val_2" {
        return "", schema.ErrNoValue // 过滤掉
    }
    return s, nil
})
```

### 7.3 合并与复制

```go
// 合并
sr1 := StreamReaderFromArray([]int{1, 2, 3})
sr2 := StreamReaderFromArray([]int{4, 5, 6})
mergedSr := MergeStreamReaders([]*StreamReader[int]{sr1, sr2})

// 复制
sr := StreamReaderFromArray([]int{1, 2, 3})
srs := sr.Copy(2) // sr 现在不可用了

// 使用 srs[0] 和 srs[1]
```

## 8. 陷阱与注意事项

### 8.1 必须关闭 StreamReader 和 StreamWriter

**问题**：忘记关闭会导致 goroutine 泄漏。

**示例**：
```go
// 错误示例
sr, sw := Pipe[string](3)
go func() {
    // 忘记 sw.Close()
}()
// 忘记 sr.Close()
```

**正确做法**：
```go
sr, sw := Pipe[string](3)
go func() {
    defer sw.Close() // 使用 defer
    // ...
}()
defer sr.Close() // 使用 defer
// ...
```

### 8.2 Copy 后原流不可用

**问题**：调用 `Copy` 后，原 StreamReader 会变得不可用。

**示例**：
```go
sr := StreamReaderFromArray([]int{1, 2, 3})
srs := sr.Copy(2)

// 错误：sr 现在不可用了
chunk, err := sr.Recv() // 可能会有问题
```

**正确做法**：
```go
sr := StreamReaderFromArray([]int{1, 2, 3})
srs := sr.Copy(2)

// 只使用 srs[0], srs[1], ...
```

### 8.3 ErrNoValue 只能在转换函数中使用

**问题**：`ErrNoValue` 是一个特殊的错误，只能在 `StreamReaderWithConvert` 的转换函数中使用。

**示例**：
```go
// 错误：在其他地方使用 ErrNoValue
sw.Send("", schema.ErrNoValue) // 这会把错误传递给接收方，而不是过滤

// 正确：只在转换函数中使用
filteredSr := StreamReaderWithConvert(sr, func(s string) (string, error) {
    if s == "" {
        return "", schema.ErrNoValue // 正确使用
    }
    return s, nil
})
```

### 8.4 注意合并流的顺序

**问题**：`MergeStreamReaders` 不保证顺序，数据按到达顺序读取。

**示例**：
```go
sr1 := StreamReaderFromArray([]int{1, 2, 3})
sr2 := StreamReaderFromArray([]int{4, 5, 6})
mergedSr := MergeStreamReaders([]*StreamReader[int]{sr1, sr2})

// 输出可能是 1, 2, 3, 4, 5, 6，也可能是其他顺序
// 取决于内部调度
```

**如果需要保证顺序**：
- 不要使用 `MergeStreamReaders`
- 或者使用 `MergeNamedStreamReaders` 并手动处理顺序

### 8.5 自动关闭不是万能的

**问题**：`SetAutomaticClose` 依赖 GC，不可预测。

**示例**：
```go
sr, sw := Pipe[string](3)
sr.SetAutomaticClose()

// 不要依赖这个，应该显式关闭
// GC 可能不会立即运行
```

**正确做法**：
```go
sr, sw := Pipe[string](3)
defer sr.Close() // 显式关闭
sr.SetAutomaticClose() // 只作为后备
```

## 9. 总结

这个模块是一个设计精巧的流式处理核心，它的主要价值在于：

1. **类型安全**：使用泛型提供编译时类型检查
2. **可组合**：提供丰富的组合器（转换、合并、复制）
3. **资源安全**：通过显式关闭和自动关闭机制避免泄漏
4. **高性能**：针对不同场景使用最优实现
5. **易于使用**：提供简洁直观的 API

理解这个模块的关键是理解它的**多态设计**和**流复制机制**，这两个是最精巧也最容易被误解的部分。
