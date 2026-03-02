# Chapter 4：数据在 Kernel 内部如何并行处理

在第 3 章我们讲了“门口怎么进出货”（AXI、Stream、控制寄存器）。  
这一章我们走进“工厂车间内部”，看货物怎么被**并行加工**。

---

## 4.1 先有一个总心智模型：一条路变成立交桥

**Imagine** 你在经营一家外卖厨房。  
如果只有一个灶台，订单只能排队。  
FPGA + HLS 的目标，就是把一个灶台变成“多灶台 + 传送带 + 分区冰箱”。

- **吞吐量（Throughput）**：单位时间做完多少份菜。  
- **延迟（Latency）**：一份菜从下单到出餐要多久。  
- **启动间隔（Initiation Interval, II）**：两份菜“开始制作”的时间间隔（按时钟周期算）。II=1 最理想，表示每拍都能开新工单。

```mermaid
graph TD
    A[Kernel内部并行] --> B[循环流水线 Pipeline]
    A --> C[函数并发 Dataflow]
    A --> D[存储分区 Array Partition]
    B --> B1[更低II]
    C --> C1[多任务同时跑]
    D --> D1[并行读写不打架]
    B1 --> E[吞吐量提升]
    C1 --> E
    D1 --> E
```

这张图可以理解成“并行性能三件套”。  
`Pipeline` 像装配线，`Dataflow` 像多工位协作，`Array Partition` 像把一个大仓库拆成多个小仓库，避免大家抢同一个门。

---

## 4.2 循环如何变成流水线（Pipeline）

**Think of it as** 汽车工厂。  
不是一辆车做完再做下一辆，而是 A 工位焊接时，B 工位同时给上一辆喷漆。

```mermaid
sequenceDiagram
    participant L as 普通循环
    participant P as 流水线循环
    participant C as 时钟周期

    C->>L: 周期1 执行迭代0(全部步骤)
    C->>L: 周期2 执行迭代1(全部步骤)
    C->>L: 周期3 执行迭代2(全部步骤)

    C->>P: 周期1 迭代0-阶段A
    C->>P: 周期2 迭代0-阶段B + 迭代1-阶段A
    C->>P: 周期3 迭代0-阶段C + 迭代1-阶段B + 迭代2-阶段A
```

上面左边是“串行做完整个迭代”，右边是“阶段重叠”。  
当管线灌满后，你会看到几乎每个周期都有新结果在推进，这就是 II 降低带来的吞吐收益。

---

## 4.3 为什么“完美循环”更容易跑快

**完美循环（Perfect Loop）** 用白话说，就是循环结构很规整，像整齐的货架。  
没有多余分支、没有乱跳逻辑，HLS 更容易排产。

```mermaid
classDiagram
    class 循环形态 {
      完美循环: 结构规整
      不完美循环: 含额外分支/语句
    }
    class HLS调度 {
      依赖分析
      阶段切分
      II估算
    }
    class 结果 {
      更低II
      更稳定时序
    }

    循环形态 --> HLS调度
    HLS调度 --> 结果
```

你可以把它类比成 SQL 查询优化。  
规则、可预测的查询（像完美循环）更容易被数据库做高效执行计划。  
不规则的分支（像不完美循环）也能跑，但优化空间会变窄。

---

## 4.4 内存墙：数组分区（Array Partition）怎么破

**Array Partition（数组分区）** 是把一个数组拆成多个“bank（存储分片）”。  
**Imagine** 一个超市只有一个收银台，队伍必堵。分成 8 个收银台后，结账速度暴涨。

```mermaid
graph TD
    A[未分区数组] --> B[单Bank]
    B --> C[每周期最多1次访问]
    D[分区数组] --> E[Bank0]
    D --> F[Bank1]
    D --> G[Bank2]
    D --> H[Bank3]
    E --> I[同周期并行访问]
    F --> I
    G --> I
    H --> I
```

这张图表示：  
不分区时，循环即使想并行，也会卡在“同一时刻只能读一个元素”。  
分区后，多个计算单元可以同拍拿不同数据，像多车道高速。

```mermaid
flowchart TD
    A[需要并行访问数组吗?] -->|否| B[先不分区 节省资源]
    A -->|是| C[访问模式是什么?]
    C -->|连续块| D[Block分区]
    C -->|跨步访问| E[Cyclic分区]
    C -->|小数组+高并发| F[Complete分区]
    D --> G[验证资源与时序]
    E --> G
    F --> G
```

这就是一个实战决策树。  
`Complete` 像“人人一把专属钥匙”，最快但最费资源。  
`Block/Cyclic` 像“合理分组排队”，性能和资源更平衡。

---

## 4.5 函数如何并发：DATAFLOW 像多服务微架构

`#pragma HLS DATAFLOW` 可以理解成：  
把一个大函数拆成多个常驻小工位，用 FIFO（先进先出队列）传数据。

这很像 Node.js + 消息队列，或者像 Kafka 流处理：上游产出、下游消费，彼此解耦。

```mermaid
graph TD
    A[funcA:拆分] --> B[FIFO c1]
    A --> C[FIFO c2]
    B --> D[funcB]
    C --> E[funcC]
    D --> F[FIFO c3]
    E --> G[FIFO c4]
    F --> H[funcD:汇合]
    G --> H
```

这是经典“菱形（diamond）”拓扑。  
`funcB` 和 `funcC` 没依赖，所以能并发跑。  
`funcD` 像网关服务，等两路结果齐了再合并输出。

```mermaid
sequenceDiagram
    participant A as Producer
    participant Q as FIFO
    participant D as Consumer

    A->>Q: write data0
    A->>Q: write data1
    A->>Q: write data2 (若满则阻塞)
    D->>Q: read data0
    D->>Q: read data1
    Q-->>A: 有空位,继续写
```

这个时序图展示了**反压（Backpressure）**：  
下游慢了，上游会被 FIFO“顶住”。  
反压不是 bug，而是硬件里很重要的自动限流机制。

---

## 4.6 数据驱动任务：`hls::task` 像常驻后台 Worker

`hls::task` 可以看作硬件里的“后台线程”，一直在线处理。  
**You can picture this as** 前端里的 Web Worker：主流程不卡，任务异步并发。

```mermaid
classDiagram
    class 控制驱动_DATAFLOW{
      函数调用式
      调度粒度较粗
    }
    class 数据驱动_hls_task{
      常驻任务
      令牌级调度
    }
    class 通道_hls_stream{
      FIFO握手
      阻塞读写
    }

    控制驱动_DATAFLOW --> 通道_hls_stream
    数据驱动_hls_task --> 通道_hls_stream
```

简单说：  
传统 DATAFLOW 像“按批次发车”。  
`hls::task` 像“地铁到站即走”，更适合持续流数据（视频流、包流）。

---

## 4.7 组合拳：怎么把 II 压下去

不要只开一个 pragma。  
高性能通常是“存储 + 流水 + 任务”三者配合。

```mermaid
flowchart TD
    A[基线版本 C仿真通过] --> B[看报告 找瓶颈]
    B --> C{瓶颈类型}
    C -->|访存冲突| D[数组分区/重排]
    C -->|循环调度慢| E[Pipeline/Unroll]
    C -->|阶段串行| F[Dataflow/task化]
    D --> G[再次综合看II和资源]
    E --> G
    F --> G
    G --> H{达标?}
    H -->|否| B
    H -->|是| I[收敛并固化配置]
```

这条流程像调接口性能。  
先 profiling，再对症下药，不要“盲目 all-in 优化”。

---

## 4.8 本章小结（你现在应该会什么）

你现在应该建立了这套直觉：

1. **Pipeline**：让循环像装配线重叠执行，目标是 II 更小。  
2. **Array Partition**：让内存像多收银台，减少抢端口。  
3. **Dataflow / task**：让函数像微服务并发，用 FIFO 解耦。  
4. 三者组合，才能把 Kernel 内部从“单车道”升级成“立体交通网”。

下一章我们会讲：  
同样是 C++，为什么有些写法“天生好综合”，有些写法会把资源和时序拖垮。