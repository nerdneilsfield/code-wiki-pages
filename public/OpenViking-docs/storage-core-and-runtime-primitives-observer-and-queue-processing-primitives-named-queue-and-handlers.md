# Named Queue 与处理器模块

> 本文档面向刚加入团队的高级工程师。你能读懂代码，但我需要解释设计意图、架构角色，以及那些不那么显而易见的选择背后的"为什么"。

## 1. 这个模块解决了什么问题？

想象一下你需要处理这样一类任务：用户上传一份文档，系统需要为它生成向量嵌入（embedding），然后存入向量数据库。这事儿不能同步做——用户可不想等待向量生成完成才看到"上传成功"。但你也不能随便找个后台线程就扔进去，你需要：

1. **可靠的持久化** — 任务不能因为进程重启就丢失
2. **可追踪的状态** — 队列里有多少待处理？处理成功了多少？有没有错误？
3. **可扩展的处理能力** — embedding 生成可能很慢，需要并发处理；语义分析可能需要调用 LLM，更慢
4. **可插拔的业务逻辑** — embedding 队列和语义分析队列的處理邏輯完全不同，但底层队列机制应该复用

`named_queue_and_handlers` 模块正是为解决这些问题而设计的。它在 AGFS（一种类文件系统抽象）之上构建了**具名队列**抽象，提供入队钩子（EnqueueHook）和出队处理器（DequeueHandler）两扩展点，让业务逻辑可以很方便地插入队列生命周期中。

## 2. 核心抽象与心智模型

把这个模块想象成一个**持久化的任务收发室**：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        QueueManager                                  │
│  ┌──────────────────┐              ┌──────────────────┐             │
│  │  EmbeddingQueue  │   Worker     │  SemanticQueue   │   Worker    │
│  │    (具名队列)     │ ─────────▶  │    (具名队列)     │ ─────────▶ │
│  └──────────────────┘              └──────────────────┘             │
│           │                                │                         │
│           ▼                                ▼                         │
│  ┌──────────────────┐              ┌──────────────────┐             │
│  │TextEmbedding    │              │  Semantic        │             │
│  │Handler          │              │  Processor       │             │
│  │(出队处理器)       │              │  (出队处理器)     │             │
│  └──────────────────┘              └──────────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

**三个核心概念：**

1. **NamedQueue（具名队列）** — 队列本身，负责消息的持久化存取和状态追踪。就像收发室里的一个柜子，有自己的名字（"Embedding" 或 "Semantic"）。

2. **EnqueueHookBase（入队钩子）** — 消息入队前的拦截器。你可以在这里做数据转换、验证、甚至拒绝消息入队。这是一种**横切关注点**的模式，把"入队前必须做什么"和队列本身解耦。

3. **DequeueHandlerBase（出队处理器）** — 消息出队后的业务逻辑。这是真正干事儿的地方——调用 embedding 服务、写向量数据库、调用 LLM 生成摘要。处理器通过回调函数向队列报告成功或失败，队列据此更新统计状态。

**为什么用回调而不是异常？** 
在后台 worker 的工作循环里，异常传播路径不清晰，而且一个消息处理失败不应该导致整个 worker 崩溃。回调模式让处理逻辑可以优雅地报告结果，队列负责维护「处理中/已成功/已失败」的计数。

## 3. 组件详解

### 3.1 QueueError 与 QueueStatus

```python
@dataclass
class QueueError:
    timestamp: datetime
    message: str
    data: Optional[Dict[str, Any]] = None

@dataclass
class QueueStatus:
    pending: int = 0      # 队列中等待处理的消息数
    in_progress: int = 0  # 正在处理的消息数
    processed: int = 0    # 已成功处理的消息数
    error_count: int = 0  # 累计错误数
    errors: List[QueueError] = field(default_factory=list)
```

这两个数据类是对队列状态的**完整描述**。注意 `errors` 列表有上限（MAX_ERRORS = 100），这是为了防止长期运行的服务累积过多错误记录导致内存溢出。

### 3.2 EnqueueHookBase

```python
class EnqueueHookBase(abc.ABC):
    @abc.abstractmethod
    async def on_enqueue(self, data: Union[str, Dict[str, Any]]) -> Union[str, Dict[str, Any]]:
        """在消息入队前调用，可以修改数据或执行验证"""
        return data
```

这个抽象类允许你在消息写入队列之前做最后一公里处理。典型用例：
- 将复杂对象序列化为 JSON 字符串
- 添加时间戳、trace ID 等元数据
- 验证数据格式，不合格则抛异常阻止入队

**设计意图**：把"数据预处理"从队列核心逻辑中剥离出来，通过继承扩展而非修改源码。

### 3.3 DequeueHandlerBase

```python
class DequeueHandlerBase(abc.ABC):
    _success_callback: Optional[Callable[[], None]] = None
    _error_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None

    @abc.abstractmethod
    async def on_dequeue(self, data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """消息出队后的业务处理，返回 None 表示丢弃该消息"""
        if not data:
            return None
        return data
```

**为什么返回 Optional[Dict[str, Any]]？**
这允许处理器在两种情况下返回有意义的值：
- 返回原始数据（或修改后的数据）→ 传递给下一个处理环节
- 返回 `None` → 表示"这个消息处理完了，不需要往下传"

处理器通过 `report_success()` 和 `report_error()` 向队列报告结果，这是**观察者模式**的变体——处理器是队列状态的观察者。

### 3.4 NamedQueue

这是核心类，封装了所有队列操作：

```python
class NamedQueue:
    def __init__(
        self,
        agfs: "AGFSClient",  # 底层存储抽象
        mount_point: str,    # 队列挂载点，如 "/queue"
        name: str,           # 队列名称，如 "Embedding"
        enqueue_hook: Optional[EnqueueHookBase] = None,
        dequeue_handler: Optional[DequeueHandlerBase] = None,
    ):
```

**关键方法：**

| 方法 | 职责 | 备注 |
|------|------|------|
| `enqueue(data)` | 写消息到队列 | 如果设置了 hook，会先调用 `on_enqueue` |
| `dequeue()` | 读取并移除一条消息，触发 handler | 消息会被标记为"处理中" |
| `dequeue_raw()` | 读取并移除消息，**不**触发 handler | 用于并发处理场景 |
| `process_dequeued(data)` | 在外部调用 handler 处理已取出的消息 | 调用者需要先手动调用 `_on_dequeue_start()` |
| `peek()` | 查看队首消息但不移除 | 用于调试或健康检查 |
| `size()` | 获取队列长度 | 直接读取 AGFS 的 size 文件 |
| `clear()` | 清空队列 | 向 AGFS 的 clear 文件写空字节 |
| `get_status()` | 获取完整状态快照 | 返回包含 pending/in_progress/processed/error_count 的 QueueStatus |

**状态追踪机制**：

```python
def _on_dequeue_start(self) -> None:
    with self._lock:
        self._in_progress += 1

def _on_process_success(self) -> None:
    with self._lock:
        self._in_progress -= 1
        self._processed += 1

def _on_process_error(self, error_msg: str, data: Optional[Dict[str, Any]] = None) -> None:
    with self._lock:
        self._in_progress -= 1
        self._error_count += 1
        self._errors.append(QueueError(...))
```

使用 `threading.Lock` 保证多线程访问时的原子性。注意：这里用的是**同步锁**而非 `asyncio.Lock`，因为状态更新是在 worker 线程中进行的，而队列操作本身是异步的。

**延迟初始化**：

```python
async def _ensure_initialized(self):
    if not self._initialized:
        try:
            self._agfs.mkdir(self.path)
        except Exception as e:
            if "exist" not in str(e).lower():
                logger.warning(f"[NamedQueue] Failed to ensure queue {self.name}: {e}")
        self._initialized = True
```

队列目录在第一次操作时才创建。这里有个微妙的细节：捕获异常后检查 `"exist" in str(e).lower()` 是因为 AGFS 客户端对"目录已存在"的错误处理不一致，有些实现会抛异常，有些不会。

## 4. 数据流分析

### 4.1 Embedding 处理流水线

```
用户代码                           QueueManager                      后台 Worker
   │                                   │                                │
   ├───context.to_dict()──────────────▶│                                │
   │                                   ├── EmbeddingMsgConverter       │
   │                                   │   (转换为 EmbeddingMsg)        │
   │                                   ├── embedding_queue.enqueue()   │
   │                                   │   (写入 AGFS)                  │
   │                                   │                                │
   │                                   │◀───────────────────────────────│
   │                                   │   loop: dequeue_raw()          │
   │                                   │   _on_dequeue_start()          │
   │                                   │   process_dequeued(data)       │
   │                                   │   (调用 TextEmbeddingHandler)  │
   │                                   │                                │
   │                                   │   ┌────────────────────────┐   │
   │                                   │   │ TextEmbeddingHandler   │   │
   │                                   │   │ 1. 解析 EmbeddingMsg   │   │
   │                                   │   │ 2. 调用 embedder.embed │   │
   │                                   │   │ 3. 写入向量数据库       │   │
   │                                   │   │ 4. report_success()    │   │
   │                                   │   └────────────────────────┘   │
   │                                   │                                │
```

关键点：
1. **入队端**：消息先被转换为 `EmbeddingMsg` 对象（包含 message 和 context_data），然后入队
2. **出队端**：Worker 循环从队列取消息，调用 handler 处理
3. **状态流转**：`pending` → `in_progress` → (`processed` 或 `error_count++`)

### 4.2 并发处理场景

在 `QueueManager._worker_async_concurrent` 中，你会看到这样的模式：

```python
# 先取消息
data = await queue.dequeue_raw()
# 再手动标记"处理中"
queue._on_dequeue_start()
# 最后异步处理
task = asyncio.create_task(process_one(data))
```

**为什么不用 `dequeue()` 一步到位？**
因为 `dequeue()` 会同步调用 handler，而这里需要并发。`dequeue_raw()` 取消息但不做处理，`process_dequeued()` 负责调用 handler。手动调用 `_on_dequeue_start()` 是为了保持状态一致性——如果异步任务还没启动，队列大小已经是 0 了，但 in_progress 还是 0，这会造成状态不一致。

## 5. 设计决策与权衡

### 5.1 为什么不用消息队列中间件（如 RabbitMQ、Kafka）？

看代码你会发现，NamedQueue 是基于 AGFS（即一个类文件系统的存储抽象）实现的，而不是现成的消息队列中间件。

**理由**：
1. **部署简化** — 不需要额外部署和维护消息队列服务
2. **故障恢复** — AGFS 本身是持久化的，进程重启后队列内容仍在
3. **与现有存储层统一** — 项目已经用 AGFS 做文件存储，在此基础上构建队列复用已有基础设施

**代价**：
- 性能不如专业消息队列（没有复制、分区、事务等特性）
- 不支持多消费者订阅同一队列（虽然本系统不需要）

### 5.2 同步锁 vs 异步锁

状态更新使用 `threading.Lock` 而非 `asyncio.Lock`：

```python
self._lock = threading.Lock()
```

这看起来有点奇怪——整个系统是异步的，为什么用同步锁？

**原因**：状态更新发生在 worker 线程中，而这些线程是 `threading.Thread` 而非 `asyncio` 任务。如果用 `asyncio.Lock`，从同步线程中调用会出问题。另一种方案是让 worker 也全用 asyncio 任务，但那样会增加复杂度。当前方案是一个实用的权衡。

### 5.3 回调 vs 异常

处理器通过回调报告结果，而非抛出异常：

```python
def report_error(self, error_msg: str, data: Optional[Dict[str, Any]] = None) -> None:
    if self._error_callback:
        self._error_callback(error_msg, data)
```

**权衡**：
- 异常传播需要显式 try/catch，容易遗漏
- 回调让每个消息处理的结果明确可追踪，适合后台 worker 的"永动机"模式
- 代价是调用链不清晰，需要阅读代码才能知道 report_* 的副作用

### 5.4 错误列表上限

```python
MAX_ERRORS = 100
if len(self._errors) > self.MAX_ERRORS:
    self._errors = self._errors[-self.MAX_ERRORS:]
```

这是为了防止内存泄漏——长期运行的服务可能产生大量错误，如果不做限制，错误列表会无限增长。

## 6. 使用指南

### 6.1 创建自定义队列

```python
from openviking.storage.queuefs.named_queue import NamedQueue, EnqueueHookBase, DequeueHandlerBase

class MyEnqueueHook(EnqueueHookBase):
    async def on_enqueue(self, data):
        # 添加时间戳
        data["enqueued_at"] = datetime.now().isoformat()
        return data

class MyDequeueHandler(DequeueHandlerBase):
    async def on_dequeue(self, data):
        # 业务逻辑
        result = await process(data)
        if result:
            self.report_success()
            return result
        else:
            self.report_error("Processing failed", data)
            return None

# 创建队列
queue = NamedQueue(
    agfs=agfs_client,
    mount_point="/queue",
    name="my_queue",
    enqueue_hook=MyEnqueueHook(),
    dequeue_handler=MyDequeueHandler(),
)

# 使用
await queue.enqueue({"task": "something"})
```

### 6.2 通过 QueueManager 使用标准队列

```python
# 初始化 QueueManager 并设置处理器
queue_manager = QueueManager(agfs=agfs_client)
queue_manager.setup_standard_queues(vector_store=vector_index_backend)

# 直接入队
await queue_manager.enqueue("Embedding", {
    "message": "要向量化的文本",
    "context_data": {"uri": "viking://user/...", "level": 2}
})

# 检查状态
status = await queue_manager.check_status("Embedding")
print(f"Pending: {status['Embedding'].pending}, Errors: {status['Embedding'].error_count}")
```

## 7. 注意事项与陷阱

### 7.1 AGFS 异常处理

```python
self._agfs.mkdir(self.path)
except Exception as e:
    if "exist" not in str(e).lower():
        logger.warning(...)
```

AGFS 客户端对"目录已存在"的错误处理不一致。有些版本抛异常带 "exist"，有些不带。如果你要继承这个类或修改初始化逻辑，注意这个隐式假设。

### 7.2 并发调用时的状态一致性

在使用 `dequeue_raw()` + `process_dequeued()` 的并发模式时，**必须**在创建异步任务之前调用 `_on_dequeue_start()`：

```python
# ✅ 正确顺序
queue._on_dequeue_start()  # 先标记
task = asyncio.create_task(process_one(data))

# ❌ 错误顺序——会导致 in_progress 计数不准确
task = asyncio.create_task(process_one(data))
queue._on_dequeue_start()  # 任务已经开始了！
```

### 7.3 handler 返回 None 的语义

`on_dequeue` 返回 `None` 有两种含义：
1. 消息处理成功，但不需要传递给下游（"消费掉了"）
2. 消息处理失败或被丢弃

调用方需要根据上下文判断是哪种情况。如果想明确区分，建议返回带有状态的包装对象。

### 7.4 队列生命周期

NamedQueue 需要在多线程/多异步任务环境下工作，初始化后不要轻易修改 `enqueue_hook` 和 `dequeue_handler`，否则可能导致状态不一致。

### 7.5 错误累积

虽然有 MAX_ERRORS 上限，但如果错误产生速度远大于处理速度（例如外部服务完全不可用），错误列表仍会快速达到上限，导致老错误被挤出。这是**有意的设计**——优先保证服务可用，错误信息只是调试辅助。

## 8. 关联模块

- **[队列管理器](storage-core-and-runtime-primitives-observer-and-queue-processing-primitives-queue-manager.md)** — 管理多个 NamedQueue 的生命周期，启动 worker 线程
- **[Embedding 队列](storage-core-and-runtime-primitives-observer-and-queue-processing-primitives-embedding-queue.md)** — NamedQueue 的子类，专门处理 EmbeddingMsg
- **[语义队列](storage-core-and-runtime-primitives-observer-and-queue-processing-primitives-semantic-queue.md)** — NamedQueue 的子类，专门处理 SemanticMsg
- **[基础观察者](storage-core-and-runtime-primitives-observer-and-queue-processing-primitives-base-observer.md)** — 存储系统观察者抽象，队列状态可通过观察者接口查询
- **[Embedding 消息转换器](storage-core-and-runtime-primitives-observer-and-queue-processing-primitives-embedding-msg-converter.md)** — 将 Context 对象转换为 EmbeddingMsg 的工具

## 9. 小结

这个模块的核心价值在于**把"异步任务队列"的通用机制和"具体业务处理"解耦**。通过 EnqueueHook 和 DequeueHandler 两个扩展点，你可以：
- 在入队前做任何数据转换
- 在出队后做任何业务处理
- 全程追踪队列的健康状态

它不是一个通用的消息队列库，而是针对"后台异步处理 embedding 和语义分析"这个特定场景的实用方案。理解这一点，就能判断什么时候复用它，什么时候需要另外的方案。