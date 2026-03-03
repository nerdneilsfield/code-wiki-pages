# 第三章：数据如何流动——主机-内核流水线与 OpenCL 运行时

> **本章学习目标：** 追踪数据从 CPU 主机内存出发，穿越 PCIe 总线和 DMA 引擎，进入 FPGA 内核，再返回主机的完整旅程。沿途你将认识 OpenCL 缓冲区、命令队列、乒乓缓冲，以及计时测量的方法。

---

## 3.1 大局观：为什么数据搬运是个难题？

想象你在一家大型餐厅工作。厨房（FPGA）里有一位超级厨师，能同时炒十道菜；但食材仓库（CPU 内存）在楼上，每次取货都要走一段楼梯（PCIe 总线）。如果厨师每炒完一道菜才去取下一批食材，楼梯就成了瓶颈——厨师大部分时间都在等待，而不是在炒菜。

这就是 FPGA 加速系统面临的核心挑战：**计算速度远快于数据搬运速度**。本章要学的，就是如何让"取货"和"炒菜"同时进行，让厨师永远不闲着。

```mermaid
graph TD
    A[CPU 主机内存<br/>食材仓库] -->|PCIe 总线<br/>楼梯| B[FPGA 片上内存<br/>厨房备料台]
    B --> C[FPGA 计算内核<br/>超级厨师]
    C --> D[结果写回片上内存<br/>出菜台]
    D -->|PCIe 总线<br/>楼梯| E[CPU 主机内存<br/>餐桌]

    style A fill:#e8f4f8
    style E fill:#e8f4f8
    style C fill:#fff3cd
    style B fill:#f0f0f0
    style D fill:#f0f0f0
```

这张图展示了数据的完整旅程：从 CPU 内存出发，经过 PCIe 总线到达 FPGA 片上内存，再由计算内核处理，最后原路返回。每一段都有代价，我们的目标是让这些代价尽量重叠、互相隐藏。

---

## 3.2 OpenCL：FPGA 加速的"通用语言"

在深入数据流之前，我们需要认识一个关键角色：**OpenCL（Open Computing Language）**。

把 OpenCL 想象成一个**翻译官**。你的 C++ 程序说的是"CPU 语言"，FPGA 说的是"硬件语言"，OpenCL 站在中间，把你的指令翻译成 FPGA 能理解的操作。它定义了一套标准词汇：

- **Context（上下文）**：整个加速系统的"工作空间"，包含设备、内存、程序等所有资源
- **CommandQueue（命令队列）**：你向 FPGA 发送指令的"传送带"，指令按顺序（或乱序）执行
- **Buffer（缓冲区）**：在主机和设备之间共享的"货箱"，数据装在里面传输
- **Kernel（内核）**：运行在 FPGA 上的"程序单元"，就是真正干活的那个函数

```mermaid
classDiagram
    class OpenCLContext {
        +Platform platform
        +Device device
        +Program program
        +createBuffer()
        +createKernel()
    }

    class CommandQueue {
        +enqueueWriteBuffer()
        +enqueueTask()
        +enqueueReadBuffer()
        +finish()
    }

    class Buffer {
        +size_t size
        +flags flags
        +host_ptr host_ptr
    }

    class Kernel {
        +setArg()
        +execute()
    }

    OpenCLContext "1" --> "1..*" CommandQueue : creates
    OpenCLContext "1" --> "1..*" Buffer : manages
    OpenCLContext "1" --> "1..*" Kernel : compiles
    CommandQueue --> Buffer : transfers
    CommandQueue --> Kernel : launches
```

这张类图展示了 OpenCL 各组件的关系：Context 是总管，它创建并管理 CommandQueue、Buffer 和 Kernel。CommandQueue 负责实际的数据传输和内核启动。

---

## 3.3 数据旅程第一站：OpenCL 缓冲区的创建

数据上路之前，需要先准备好"货箱"——OpenCL Buffer。

想象你要寄一个包裹：你需要先找一个合适的箱子（分配内存），把东西装进去（填充数据），然后贴上地址标签（告诉系统这个箱子要去哪里）。OpenCL Buffer 就是这个箱子。

在 gzip 压缩加速库的代码中，缓冲区创建是这样工作的：

```mermaid
flowchart TD
    A[应用程序调用 compress] --> B{选择内存模式}
    B -->|传统模式| C[cl::Buffer 创建设备端内存<br/>CL_MEM_READ_WRITE]
    B -->|Slave Bridge 零拷贝| D[cl::Buffer 使用主机内存<br/>CL_MEM_EXT_HOST_ONLY]
    C --> E[主机内存 → 设备内存<br/>需要显式拷贝]
    D --> F[主机内存直接映射<br/>无需拷贝]
    E --> G[内核可以访问数据]
    F --> G
```

**传统模式**就像快递：你把东西装箱，快递员（DMA 引擎）把箱子从你家（主机内存）搬到目的地（FPGA 片上内存），然后 FPGA 才能使用。

**Slave Bridge 零拷贝模式**就像外卖员直接来你家取菜：FPGA 通过 PCIe 直接读取主机内存，省去了中间的搬运步骤。这需要特殊的硬件支持（如 Alveo U50/U280），但延迟可以降低 5-10 倍。

---

## 3.4 数据旅程第二站：命令队列与数据迁移

有了货箱，下一步是把货箱送上"传送带"——CommandQueue。

```mermaid
sequenceDiagram
    participant App as 应用程序
    participant CQ as CommandQueue
    participant DMA as DMA 引擎
    participant FPGA as FPGA 内核

    App->>CQ: enqueueMigrateMemObjects(H2D)<br/>把数据从主机搬到设备
    CQ->>DMA: 触发 DMA 传输
    DMA-->>FPGA: 数据到达片上内存
    App->>CQ: enqueueTask(kernel)<br/>启动内核
    CQ->>FPGA: 内核开始执行
    FPGA-->>CQ: 内核完成信号
    App->>CQ: enqueueMigrateMemObjects(D2H)<br/>把结果从设备搬回主机
    CQ->>DMA: 触发反向 DMA 传输
    DMA-->>App: 结果回到主机内存
```

这个时序图展示了一次完整的"顺序执行"流程：先搬数据进去（H2D，Host to Device），再启动内核，等内核跑完，再把结果搬回来（D2H，Device to Host）。

注意这里的关键词：**enqueue（入队）**。你不是直接执行这些操作，而是把它们放进队列，让 OpenCL 运行时按顺序执行。这就像你在超市收银台排队——你把商品放上传送带，收银员（运行时）按顺序处理。

---

## 3.5 数据旅程的核心挑战：顺序执行的浪费

顺序执行有一个致命问题：**FPGA 在等数据时是空闲的，数据在传输时 FPGA 也是空闲的**。

用餐厅的比喻：厨师炒完一道菜，等服务员端走，再等新食材送来，才能开始炒下一道。这中间有大量等待时间。

```mermaid
graph TD
    subgraph Sequential[顺序执行 - 效率低]
        S1[传输数据块1 H2D] --> S2[内核处理块1]
        S2 --> S3[传输结果1 D2H]
        S3 --> S4[传输数据块2 H2D]
        S4 --> S5[内核处理块2]
        S5 --> S6[传输结果2 D2H]
    end

    subgraph Timeline[时间轴]
        T1[时间 0] --> T2[时间 3T] --> T3[时间 6T]
    end
```

在顺序模式下，处理 N 个数据块需要 3N 个时间单位（每块：传输进 + 计算 + 传输出）。FPGA 的利用率只有 33%。

---

## 3.6 解决方案：乒乓缓冲（Ping-Pong Buffering）

这就是**乒乓缓冲**登场的时刻。

想象一个更聪明的餐厅：有两个备料台（两组缓冲区）。当厨师在用备料台 A 的食材炒菜时，助手已经在往备料台 B 装下一批食材了。厨师炒完 A 的菜，立刻切换到 B，助手再去补充 A。两个台子交替使用，厨师永远不用等待。

```mermaid
flowchart TD
    subgraph PingPong[乒乓缓冲执行流程]
        direction TB
        
        subgraph Round1[第一轮]
            A1[写线程: 传输块1 到 Buffer-A] 
            B1[内核: 处理 Buffer-A 中的块1]
            C1[读线程: 从 Buffer-A 取结果1]
        end
        
        subgraph Round2[第二轮 - 与第一轮重叠]
            A2[写线程: 传输块2 到 Buffer-B]
            B2[内核: 处理 Buffer-B 中的块2]
            C2[读线程: 从 Buffer-B 取结果2]
        end
        
        A1 --> B1 --> C1
        A2 --> B2 --> C2
        A1 -.->|同时进行| A2
        B1 -.->|同时进行| B2
    end
```

乒乓缓冲的核心思想：**用空间换时间**。多准备一组缓冲区，让数据传输和计算同时进行，互相隐藏延迟。

在 gzip 压缩库中，这个模式被称为 **Overlap 模式**，通过三个独立线程实现：
- **写线程（`_enqueue_writes`）**：持续把新数据送进 FPGA
- **内核线程**：持续处理数据
- **读线程（`_enqueue_reads`）**：持续把结果取回来

---

## 3.7 深入 gzip 压缩库：Overlap 模式的实现

让我们用 gzip 压缩库的真实代码来理解这个流程。

```mermaid
sequenceDiagram
    participant App as 应用程序
    participant MM as memoryManager<br/>缓冲区池
    participant WT as 写线程<br/>_enqueue_writes
    participant Kernel as FPGA 内核
    participant RT as 读线程<br/>_enqueue_reads

    App->>MM: 请求缓冲区
    MM-->>App: 返回空闲缓冲区 buf_A
    App->>App: memcpy 数据到 buf_A
    App->>WT: 提交 buf_A

    WT->>Kernel: enqueueMigrateMemObjects(buf_A, H2D)
    WT->>Kernel: enqueueTask(compressKernel, buf_A)
    
    Note over App,MM: 同时，应用程序继续准备下一块数据
    App->>MM: 请求缓冲区
    MM-->>App: 返回空闲缓冲区 buf_B
    App->>WT: 提交 buf_B
    WT->>Kernel: enqueueMigrateMemObjects(buf_B, H2D)

    Kernel-->>RT: buf_A 处理完成事件
    RT->>RT: enqueueMigrateMemObjects(buf_A, D2H)
    RT->>MM: 归还 buf_A 到空闲池
    RT->>App: 通知结果可读
```

这个时序图展示了 Overlap 模式的精髓：写线程、内核、读线程三者并行工作，通过 `memoryManager` 的缓冲区池协调资源。

### memoryManager：缓冲区池的工作原理

`memoryManager` 就像一个**货箱租赁公司**：

- 维护两个队列：`freeBuffers`（空闲货箱）和 `busyBuffers`（使用中的货箱）
- 当你需要缓冲区时，从 `freeBuffers` 取一个
- 用完后归还到 `freeBuffers`，供下次使用
- 如果空闲队列为空，等待直到有货箱归还

```mermaid
graph TD
    subgraph Pool[memoryManager 缓冲区池]
        Free[freeBuffers 队列<br/>空闲货箱]
        Busy[busyBuffers 队列<br/>使用中货箱]
    end

    App[应用程序] -->|createBuffer 取货箱| Free
    Free -->|分配| App
    App -->|装载数据| WT[写线程]
    WT -->|提交给内核| Kernel[FPGA 内核]
    Kernel -->|完成回调| RT[读线程]
    RT -->|getBuffer 归还| Free
    Kernel -.->|执行期间| Busy
```

这个设计的妙处在于：缓冲区被**循环复用**，避免了频繁的内存分配和释放，同时通过队列机制自然地实现了流量控制——如果 FPGA 处理速度跟不上，`freeBuffers` 会耗尽，应用程序自动等待，不会把 FPGA 淹没。

---

## 3.8 数据格式转换：data_mover_runtime 的角色

在数据进入 FPGA 之前，还有一个常被忽视的步骤：**格式转换**。

FPGA 内核期望的数据格式往往不是人类友好的文本，而是固定宽度的二进制位流。`data_mover_runtime` 模块就是这个"翻译官"。

想象你要把一份菜谱（文本数据）转换成机器人厨师能读懂的指令码（二进制格式）：

```mermaid
flowchart LR
    A[文本文件<br/>1.0<br/>2.5<br/>3.14] -->|read_type 读取| B[C++ 浮点数<br/>float: 1.0f<br/>float: 2.5f<br/>float: 3.14f]
    B -->|get_bits 提取位模式| C[无符号整数<br/>0x3f800000<br/>0x40200000<br/>0x4048f5c3]
    C -->|打包成 AXI 宽度| D[128位十六进制字符串<br/>0x4048f5c340200000<br/>3f800000...]
    D -->|写入文件| E[FPGA 可直接消费<br/>的输入数据]
```

这个流程展示了 `data_mover_runtime` 的核心工作：把人类可读的浮点数文本，转换成 FPGA AXI 总线能直接消费的固定宽度十六进制位流。

### 关键技术：类型双关（Type Punning）

`get_bits()` 函数使用了一个巧妙的技巧——**union 类型双关**：

```cpp
// 把 float 的内存表示直接读作 uint32_t
uint32_t get_bits(float v) {
    union { float f; uint32_t u; } u;
    u.f = v;
    return u.u;  // 同样的 32 位，换一种解读方式
}
```

这就像同一张纸，从正面看是一幅画（浮点数 1.0），从背面看是一串数字（0x3F800000）。内存里的比特没有变，只是换了一种解读方式。

---

## 3.9 完整数据流：从应用到 FPGA 再回来

现在我们把所有环节串联起来，看一次完整的 gzip 压缩请求的生命周期：

```mermaid
flowchart TD
    subgraph HostApp[主机应用层]
        A1[应用程序调用 compress<br/>传入原始数据]
        A2[gzipBase::add_header<br/>生成 Gzip 文件头]
        A3[compress_buffer<br/>分割为 1MB 数据块]
    end

    subgraph MemMgr[内存管理层]
        B1[memoryManager::createBuffer<br/>从池中获取对齐缓冲区]
        B2[std::memcpy<br/>数据复制到缓冲区]
    end

    subgraph OCLLayer[OpenCL 调度层]
        C1[setKernelArgs<br/>设置内核参数]
        C2[enqueueMigrateMemObjects H2D<br/>触发 DMA 上传]
        C3[enqueueTask<br/>启动压缩内核]
        C4[enqueueMigrateMemObjects D2H<br/>触发 DMA 下载]
    end

    subgraph FPGAKernel[FPGA 内核层]
        D1[xilCompressKernel<br/>LZ77 压缩算法]
        D2[CRC32 校验和计算<br/>硬件加速]
    end

    subgraph ResultLayer[结果处理层]
        E1[event_compress_cb<br/>OpenCL 完成回调]
        E2[memcpy 结果到输出缓冲区]
        E3[gzipBase::add_footer<br/>追加校验和与文件大小]
    end

    A1 --> A2 --> A3 --> B1 --> B2
    B2 --> C1 --> C2 --> C3
    C3 --> D1 --> D2
    D2 --> C4 --> E1 --> E2 --> E3
```

这张流程图展示了数据的完整旅程，分为五个层次：

1. **主机应用层**：接收原始数据，添加 Gzip 格式头部，分割成适合 FPGA 处理的数据块
2. **内存管理层**：从缓冲区池获取对齐内存，把数据复制进去
3. **OpenCL 调度层**：设置内核参数，触发 DMA 传输，启动内核，等待结果
4. **FPGA 内核层**：真正的压缩计算发生在这里，同时计算 CRC32 校验和
5. **结果处理层**：通过回调函数收集结果，追加 Gzip 文件尾部

---

## 3.10 数据库查询中的多线程队列：GQE 的例子

乒乓缓冲的思想不只用于压缩，在数据库查询加速（GQE，General Query Engine）中同样关键。

GQE 的 L3 层使用了更复杂的**多线程队列**架构：

```mermaid
graph TD
    subgraph GQE_L3[GQE L3 执行引擎]
        subgraph InputThread[输入线程组]
            IT1[数据分片线程 1]
            IT2[数据分片线程 2]
        end

        subgraph TaskQueue[任务队列]
            TQ[线程安全任务队列<br/>Task Queue]
        end

        subgraph WorkerThread[工作线程组]
            WT1[FPGA 工作线程 1<br/>CommandQueue A]
            WT2[FPGA 工作线程 2<br/>CommandQueue B]
        end

        subgraph OutputThread[输出线程组]
            OT1[结果合并线程]
        end
    end

    IT1 -->|提交任务| TQ
    IT2 -->|提交任务| TQ
    TQ -->|分发任务| WT1
    TQ -->|分发任务| WT2
    WT1 -->|完成结果| OT1
    WT2 -->|完成结果| OT1
```

这个架构就像一个**流水线工厂**：输入线程负责把大表切成小片（分片），任务队列负责调度，工作线程各自持有一个 CommandQueue 独立操作 FPGA，输出线程负责把结果拼回来。

多个 CommandQueue 的好处是：每个工作线程可以独立地向 FPGA 发送命令，互不干扰，最大化 FPGA 的利用率。

---

## 3.11 计时测量：如何知道哪里最慢？

优化之前，你需要知道时间花在哪里。Vitis Libraries 提供了两种计时方式：

```mermaid
graph TD
    subgraph WallClock[方式一：墙钟时间 Wall-Clock]
        W1[std::chrono::high_resolution_clock::now<br/>记录开始时间]
        W2[执行操作...]
        W3[std::chrono::high_resolution_clock::now<br/>记录结束时间]
        W4[计算差值 = 端到端延迟<br/>包含所有开销]
        W1 --> W2 --> W3 --> W4
    end

    subgraph OCLEvent[方式二：OpenCL 事件计时]
        E1[创建 cl::Event 对象]
        E2[enqueueTask 传入 event 参数]
        E3[q.finish 等待完成]
        E4[event.getProfilingInfo<br/>CL_PROFILING_COMMAND_START<br/>CL_PROFILING_COMMAND_END]
        E5[计算差值 = 纯内核执行时间<br/>不含传输开销]
        E1 --> E2 --> E3 --> E4 --> E5
    end
```

**墙钟时间**就像用秒表计时：从你按下"开始"到按下"停止"，包含了所有的等待、传输、计算时间。适合测量用户感受到的端到端延迟。

**OpenCL 事件计时**就像给内核装了一个精密的内置计时器：只记录内核在 FPGA 上真正运行的时间，排除了数据传输和调度的干扰。适合分析纯计算性能。

在量化金融引擎（如 Hull-White 利率模型）的基准测试中，代码同时使用两种方式：

```mermaid
sequenceDiagram
    participant App as 应用程序
    participant CQ as CommandQueue
    participant FPGA as FPGA 内核

    Note over App: 记录墙钟开始时间 t_start
    App->>CQ: enqueueMigrateMemObjects H2D
    App->>CQ: enqueueTask kernel event_kernel
    CQ->>FPGA: 内核开始执行
    Note over FPGA: OpenCL 内部记录 COMMAND_START
    FPGA-->>CQ: 内核完成
    Note over FPGA: OpenCL 内部记录 COMMAND_END
    App->>CQ: enqueueMigrateMemObjects D2H
    App->>CQ: q.finish 等待全部完成
    Note over App: 记录墙钟结束时间 t_end
    App->>App: 墙钟时间 = t_end - t_start
    App->>App: 内核时间 = COMMAND_END - COMMAND_START
```

两种时间的差值，就是数据传输和调度的开销。如果这个差值很大，说明 PCIe 传输是瓶颈；如果差值很小，说明计算本身是瓶颈。

---

## 3.12 Slave Bridge：零拷贝的终极优化

对于延迟极度敏感的场景，Vitis Libraries 支持 **Slave Bridge** 模式——让 FPGA 直接读写主机内存，完全跳过 DMA 拷贝。

```mermaid
flowchart TD
    subgraph Traditional[传统模式]
        T1[主机内存<br/>原始数据] -->|memcpy| T2[对齐缓冲区]
        T2 -->|DMA 拷贝| T3[FPGA 片上内存]
        T3 --> T4[内核处理]
        T4 -->|DMA 拷贝| T5[FPGA 片上内存<br/>结果]
        T5 -->|DMA 拷贝| T6[主机内存<br/>结果]
    end

    subgraph SlaveBridge[Slave Bridge 零拷贝模式]
        S1[主机内存<br/>原始数据] -->|PCIe 直接访问| S2[内核处理]
        S2 -->|PCIe 直接写回| S3[主机内存<br/>结果]
    end

    style Traditional fill:#ffe0e0
    style SlaveBridge fill:#e0ffe0
```

传统模式需要三次数据拷贝（主机→对齐缓冲区→FPGA→FPGA→主机），而 Slave Bridge 模式只需要 FPGA 通过 PCIe 直接访问主机内存，延迟降低 5-10 倍。

代价是：需要特定硬件支持（Alveo U50/U280），且内存必须严格对齐（4KB 边界）。

---

## 3.13 把所有概念串联：一张完整的架构图

```mermaid
graph TD
    subgraph HostSide[主机端 CPU]
        APP[应用程序代码]
        
        subgraph OCLRuntime[OpenCL 运行时]
            CTX[Context 上下文]
            CQ1[CommandQueue 1<br/>写数据]
            CQ2[CommandQueue 2<br/>读数据]
        end
        
        subgraph MemPool[内存管理]
            BUF_A[Buffer A<br/>乒]
            BUF_B[Buffer B<br/>乓]
        end
        
        subgraph Threads[线程模型]
            WT[写线程<br/>持续上传]
            RT[读线程<br/>持续下载]
        end
    end
    
    subgraph PCIe[PCIe 总线]
        DMA[DMA 引擎<br/>数据搬运工]
    end
    
    subgraph FPGASide[FPGA 设备端]
        subgraph OnChipMem[片上内存 HBM/DDR]
            IBUF[输入缓冲区]
            OBUF[输出缓冲区]
        end
        
        subgraph Kernels[计算内核]
            K1[压缩内核 CU1]
            K2[压缩内核 CU2]
        end
    end
    
    APP --> CTX
    CTX --> CQ1
    CTX --> CQ2
    WT --> CQ1
    RT --> CQ2
    BUF_A --> WT
    BUF_B --> WT
    CQ1 --> DMA
    DMA --> IBUF
    IBUF --> K1
    IBUF --> K2
    K1 --> OBUF
    K2 --> OBUF
    OBUF --> DMA
    DMA --> CQ2
    CQ2 --> RT
    RT --> BUF_A
    RT --> BUF_B
```

这张完整的架构图展示了所有组件如何协同工作：

- **主机端**：应用程序通过 OpenCL 运行时管理两个 CommandQueue（一个专门写数据，一个专门读数据），配合乒乓缓冲区（Buffer A 和 B）实现流水线
- **PCIe 总线**：DMA 引擎是数据搬运的执行者，负责主机内存和 FPGA 片上内存之间的高速传输
- **FPGA 设备端**：片上内存（HBM/DDR）作为数据暂存区，多个计算单元（CU）并行处理数据

---

## 3.14 常见陷阱与最佳实践

学完了原理，让我们看看实际开发中最容易踩的坑：

```mermaid
graph TD
    subgraph Pitfalls[常见陷阱]
        P1[陷阱1: Slave Bridge<br/>先写后 Map<br/>数据不会到达设备]
        P2[陷阱2: 事件回调<br/>在独立线程执行<br/>对象可能已销毁]
        P3[陷阱3: 校验和状态<br/>多次调用间累积<br/>多线程共享会混乱]
        P4[陷阱4: 4GB 限制<br/>解压缩输出超限<br/>触发 ZIP BOMB 保护]
        P5[陷阱5: HBM Bank<br/>随机选择导致<br/>间歇性内存错误]
    end

    subgraph BestPractices[最佳实践]
        B1[先 enqueueMapBuffer<br/>再写数据]
        B2[用 busyBuffers 队列<br/>延长对象生命周期]
        B3[每个并发流<br/>独立的 gzipOCLHost 实例]
        B4[检查 max_outbuf_size<br/>默认 20 倍压缩比]
        B5[使用 aligned_allocator<br/>保证 4KB 对齐]
    end

    P1 --> B1
    P2 --> B2
    P3 --> B3
    P4 --> B4
    P5 --> B5
```

**陷阱 1：Slave Bridge 的"先写后 Map"**

在 Slave Bridge 模式下，你必须先调用 `enqueueMapBuffer` 获取有效的主机指针，再往里写数据。如果你先写数据再 Map，数据不会到达设备——就像你先把东西放进一个还没打开的箱子，当然放不进去。

**陷阱 2：事件回调的生命周期**

OpenCL 的完成回调函数在独立的 OpenCL 线程中执行。如果你的缓冲区对象在回调触发前就被销毁了，回调函数访问的是悬空指针，程序会崩溃。`memoryManager` 通过 `busyBuffers` 队列延长缓冲区的生命周期来解决这个问题。

**陷阱 3：校验和状态的隐式累积**

CRC32/Adler32 校验和在 FPGA 内核中计算，状态在多次调用间累积。如果多个线程共享同一个 `gzipOCLHost` 实例，校验和状态会互相干扰。**每个并发压缩流必须有独立的实例**。

---

## 3.15 本章小结：数据旅程的关键里程碑

```mermaid
graph LR
    A[CPU 主机内存<br/>数据出发地] -->|1. 格式转换<br/>data_mover_runtime| B[对齐缓冲区<br/>OpenCL Buffer]
    B -->|2. DMA 上传<br/>enqueueMigrateMemObjects H2D| C[FPGA 片上内存<br/>HBM/DDR]
    C -->|3. 内核计算<br/>enqueueTask| D[FPGA 计算结果<br/>片上内存]
    D -->|4. DMA 下载<br/>enqueueMigrateMemObjects D2H| E[CPU 主机内存<br/>结果到达]

    F[乒乓缓冲<br/>让步骤 1-4 重叠] -.->|优化| B
    G[Slave Bridge<br/>跳过 DMA 拷贝] -.->|极致优化| C
    H[OpenCL 事件计时<br/>精确测量内核时间] -.->|测量| D
```

本章我们追踪了数据从 CPU 到 FPGA 再回来的完整旅程，学到了：

1. **OpenCL 是桥梁**：Context、CommandQueue、Buffer、Kernel 四个核心概念构成了主机-设备通信的基础
2. **顺序执行效率低**：数据传输和计算串行进行，FPGA 利用率只有 33%
3. **乒乓缓冲是关键**：用多组缓冲区让传输和计算重叠，FPGA 利用率接近 100%
4. **memoryManager 是协调者**：通过缓冲区池实现资源复用和流量控制
5. **Slave Bridge 是终极优化**：让 FPGA 直接访问主机内存，彻底消除 DMA 拷贝开销
6. **两种计时方式各有用途**：墙钟时间测端到端延迟，OpenCL 事件计时测纯内核性能

下一章，我们将深入硬件连接层，学习如何通过 `.cfg` 配置文件把内核的 AXI 端口映射到物理 HBM/DDR 内存 Bank，理解为什么内存拓扑对性能至关重要。

---

> **动手练习：** 如果你有 Xilinx Alveo 开发板，可以尝试运行 `data_compression/L2/demos/gzip` 目录下的示例，用 `-overlap` 和不加该参数两种模式分别运行，对比吞吐量的差异。你会直观地看到乒乓缓冲带来的性能提升。