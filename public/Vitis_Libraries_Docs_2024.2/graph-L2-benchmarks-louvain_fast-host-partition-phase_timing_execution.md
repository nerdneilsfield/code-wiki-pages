# Phase Timing Execution 模块技术深度解析

## 一句话概括

本模块是 **Louvain 社区发现算法的 FPGA 异构计算 orchestrator（编排器）**，负责将图数据的多层聚类计算（Multi-phase clustering）在 CPU 主机与 FPGA 加速器之间进行任务调度、内存管理、时序采集与结果汇总。想象它是一个**交响乐指挥**——左手协调 FPGA 的高速并行计算，右手管理 CPU 的数据预处理与后处理，确保每个"乐章"（phase）精确衔接。

---

## 问题空间：为什么需要这个模块？

### 原始问题的复杂性

Louvain 算法用于在大型图中发现社区结构（community structure），其核心挑战在于：

1. **计算密集性**：每次迭代需要遍历所有边计算 modularity（模块度）增益
2. **多层收敛**：算法通过多层图收缩（graph coarsening）逐步收敛，每一层称为一个 **phase**
3. **数据依赖性**：下一 phase 的输入依赖于上一 phase 的社区划分结果

### 为什么异构计算（FPGA + CPU）？

对于千万级边的大规模图，纯 CPU 实现面临内存带宽瓶颈和串行计算限制。FPGA 提供：
- **大规模并行**：可同时处理数百个顶点的邻居遍历
- **定制数据通路**：针对 CSR（Compressed Sparse Row）图格式的流水线优化
- **低功耗高密度计算**：相比 GPU 更适合数据中心部署

### 本模块的核心职责

在 FPGA 加速 Louvain 算法中，需要解决以下工程难题：

1. **内存墙问题**：图数据通常超出 FPGA 片上内存，必须通过 DDR/HBM 进行主机-设备数据传输
2. **双向数据流**：每个 phase 需要 **Prep**（主机准备数据）→ **FPGA 计算** → **Post**（主机解析结果）的闭环
3. **时序精确测量**：需要区分数据传输时间、FPGA 计算时间、图重构时间，用于性能调优
4. **动态图收缩**：每一 phase 后图规模变化，需要重新分配 buffer 或复用已分配内存

---

## 架构全景与数据流

### 模块定位

```
┌─────────────────────────────────────────────────────────────────┐
│                    Louvain Algorithm Orchestration               │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │   Phase 1    │───▶│   Phase 2    │───▶│   Phase N    │     │
│  │  (Original   │    │  (Contracted │    │  (Converged  │     │
│  │    Graph)    │    │    Graph)    │    │   Graph)     │     │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘     │
│         │                 │                                     │
│    ┌────▼─────────────────▼────┐                               │
│    │  Phase Timing Execution   │  ◄── 本模块职责               │
│    │  (本模块核心功能)          │                               │
│    └────┬────────────────┬─────┘                               │
│         │                │                                      │
│    ┌────▼────┐      ┌────▼────┐                                 │
│    │   CPU   │      │   FPGA  │                                 │
│    │  Host   │◄────▶│  Kernel │                                 │
│    │  Logic  │      │ Compute │                                 │
│    └─────────┘      └─────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流时序图

```
Time ───────────────────────────────────────────────────────────▶

CPU Host Side:        ┌──────────┐  ┌──────────┐  ┌──────────┐
Prep Phase            │  Prep    │  │  Prep    │  │  Prep    │
(Data Init)           │ Phase N  │  │ Phase N+1│  │ Phase N+2│
                      └────┬─────┘  └────┬─────┘  └────┬─────┘
                           │             │             │
                      ┌────▼─────┐  ┌────▼─────┐  ┌────▼─────┐
Transfer H→D          │ Write    │  │ Write    │  │ Write    │
(PCIe/DDR)            │  Buffer  │  │  Buffer  │  │  Buffer  │
                      └────┬─────┘  └────┬─────┘  └────┬─────┘
                           │             │             │
┌──────────────────────────┼─────────────┼─────────────┼──────────────┐
│ FPGA Kernel              │  ┌───────┐  │  ┌───────┐  │  ┌───────┐     │
│ (Parallel Compute)       └──┤Compute├─▶┤Compute├─▶┤Compute├─────┤
│ (Louvain Iteration)         │Phase N│   │Phase N+1   │Phase N+2│     │
│                             └───┬───┘   └───┬───┘   └───┬───┘     │
└─────────────────────────────────┼───────────┼───────────┼───────────┘
                                  │           │           │
                      ┌───────────▼───┐  ┌────▼─────┐  ┌────▼─────┐
Transfer D→H          │   Read        │  │  Read    │  │  Read    │
(PCIe/DDR)            │   Buffer      │  │  Buffer  │  │  Buffer  │
                      └───────┬───────┘  └────┬─────┘  └────┬─────┘
                              │               │             │
CPU Host Side:      ┌─────────▼───────┐  ┌────▼─────┐  ┌────▼─────┐
Post Phase          │   Post-Process  │  │  Post    │  │  Post    │
(Result Analysis    │   (Parse C,     │  │  Phase   │  │  Phase   │
 & Graph Build)    │    Rebuild G)   │  │  N+1     │  │  N+2     │
                    └─────────────────┘  └──────────┘  └──────────┘
```

### 关键组件职责

| 组件类别 | 核心结构/函数 | 职责描述 |
|---------|--------------|---------|
| **内存管理层** | `KMemorys_host` / `KMemorys_clBuff` | 主机端与设备端缓冲区管理，包括 CSR 图数据、颜色数组、社区 ID 等 |
| **内存管理(Prune)** | `KMemorys_host_prune` / `KMemorys_clBuff_prune` | 扩展版本，支持剪枝(Prune)优化的额外标志位(flag/flagUpdate) |
| **Phase 执行流** | `ConsumingOnePhase` / `ConsumingOnePhase_prune` | 单个 Phase 的完整执行：准备数据→FPGA计算→读取结果 |
| **后处理** | `PhaseLoop_CommPostProcessing` / `_par` / `_par_prune` | 社区 ID 重映射、图重构、下一 Phase 准备 |
| **缓冲区映射** | `PhaseLoop_MapHostBuff` / `PhaseLoop_MapClBuff` | OpenCL 缓冲区创建与内存对齐处理 |
| **初始化** | `PhaseLoop_UsingFPGA_Prep_Init_buff_host` / `_prune` | 将 CSR 图数据、颜色数组等拷入主机缓冲区 |
| **结果读取** | `PhaseLoop_UsingFPGA_Prep_Read_buff_host` / `_prune` | 从缓冲区读取 FPGA 计算结果（社区 ID、迭代次数、modularity） |
| **内核设置** | `PhaseLoop_UsingFPGA_1_KernelSetup` / `_prune` | OpenCL kernel 参数绑定与输入输出缓冲区设置 |
| **数据流控制** | `PhaseLoop_UsingFPGA_2_DataWriteTo` / `_3_KernelRun` / `_4_DataReadBack` / `_5_KernelFinish` | OpenCL 命令队列操作：写数据、执行 kernel、读结果、同步 |
| **报告输出** | `PrintReport_MultiPhase` / `PrintReport_MultiPhase_2` | 多 Phase 执行统计报告（时间分解、modularity 变化、迭代次数） |
| **顶层控制** | `runLouvainWithFPGA_demo_par_core` / `_prune` | 完整的 FPGA 加速 Louvain 算法执行流程（多 Phase 循环） |
| **通用入口** | `LouvainGLV_general` / `LouvainGLV_general_batch_thread` | 支持多设备、多线程批处理的通用 Louvain 计算接口 |

---

## 核心设计决策与权衡

### 1. FPGA 与 CPU 的混合执行策略

**设计选择**：采用 **"阈值触发的异构执行"** 策略——当图规模大于 `opts_minGraphSize` 且启用着色优化时，使用 FPGA 加速；否则回退到 CPU 并行计算。

**权衡分析**：
- **优势**：对于小规模图避免了 FPGA 启动开销（PCIe 传输、kernel 初始化）；对于大规模图充分利用 FPGA 并行性
- **代价**：需要维护两套代码路径（`PhaseLoop_UsingFPGA_*` 和 `PhaseLoop_UsingCPU`），增加测试复杂度
- **关键假设**：FPGA 加速比 > PCIe 传输开销 + FPGA 初始化时间，这一假设在超大规模图上成立

### 2. 双 Buffer 内存管理模型

**设计选择**：显式分离 **Host Buffer**（`KMemorys_host`）和 **Device Buffer**（`KMemorys_clBuff`），通过 `cl_mem_ext_ptr_t` 进行内存映射。

**权衡分析**：
- **优势**：
  - 细粒度控制内存对齐（`aligned_alloc` 确保页对齐）
  - 支持零拷贝（Zero-copy）或显式拷贝两种模式
  - 通过 `XCL_MEM_TOPOLOGY` 精确控制 DDR/HBM 内存 bank 分配
- **代价**：
  - 手动内存管理带来泄漏风险（虽有 `freeMem()` 方法，但依赖调用者正确使用）
  - 代码冗长（每个 buffer 需显式创建、映射、释放）
- **关键约束**：`MAXNV` (64M) 限制了单张图的最大顶点数，超出需分块处理

### 3. Phase 级流水线与全局同步

**设计选择**：采用 **Phase-level 粗粒度同步**——每个 Phase 内部 FPGA 计算是异步的（OpenCL out-of-order queue），但 Phase 之间严格串行（必须完成图重构才能进入下一 Phase）。

**权衡分析**：
- **优势**：
  - 简化了数据依赖性管理（社区 ID 重映射必须在下一 phase 计算前完成）
  - 每个 Phase 可独立选择执行设备（FPGA 或 CPU）
- **代价**：
  - 无法重叠 Phase N 的图重构与 Phase N+1 的数据准备（潜在的流水线气泡）
  - 对于快速收敛的图（少量 Phases），启动开销占主导
- **关键洞察**：Louvain 算法本身具有内在的顺序依赖性（下一层图由上一层社区划分构建），因此粗粒度同步是自然选择

### 4. Ghost Vertex 与分区支持

**设计选择**：通过 `hasGhost` 标志和 `_par` 后缀函数支持分布式图分区（Ghost vertices），在 `PhaseLoop_CommPostProcessing_par` 中处理跨分区社区 ID 映射。

**权衡分析**：
- **优势**：支持超大规模图（单设备内存放不下）的分区并行计算
- **代价**：
  - 引入额外的内存开销（`NVl` 局部顶点 vs `NV` 全局顶点）
  - 社区 ID 重映射复杂度增加（需处理 Ghost 到 Master 的映射）
  - 代码路径分裂（`_par` vs 非 `_par` 版本）
- **关键细节**：`CreateM` 函数处理负值标记的特殊顶点（`M_orig[i] < 0`），这是分区算法的残留标记

### 5. 时序采集的侵入式设计

**设计选择**：在关键路径上密集插入 `omp_get_wtime()` 调用和 OpenCL profiling event，精确测量 E2E（End-to-End）、Kernel execution、Data transfer、Graph building 的时间占比。

**权衡分析**：
- **优势**：
  - 提供细粒度的性能瓶颈定位（可区分是 PCIe 带宽瓶颈还是 FPGA 计算瓶颈）
  - 支持多 Phase 的历史数据追踪（`eachTimeE2E_2[MAX_NUM_PHASE]` 数组）
- **代价**：
  - 侵入式代码（几乎每个函数都有 `time1 = omp_get_wtime()`），降低可读性
  - 高频系统调用（`omp_get_wtime` 通常是 `rdtsc` 指令，开销低但非零）
  - 额外的内存开销存储时序统计数组
- **工程权衡**：选择**始终开启 profiling**（而非条件编译），因为 Louvain 是计算密集型（秒级到分钟级），微妙级的计时开销可忽略，但带来的可观测性价值巨大

---

## 核心组件深度解析

### `timeval` 结构体 —— 微秒级时序基准

```cpp
struct timeval {
    long tv_sec;   // 秒
    long tv_usec;  // 微秒
};
```

这是 POSIX 标准时间结构，配合 `gettimeofday()` 使用。在模块中用于测量 E2E（End-to-End）时间：

```cpp
struct timeval tstartE2E, tendE2E;
gettimeofday(&tstartE2E, 0);
// ... FPGA execution ...
gettimeofday(&tendE2E, 0);
int exec_timeE2E = diff(&tendE2E, &tstartE2E); // 微秒级精度
```

**设计意图**：OpenCL profiling 只能测量 Kernel 执行时间，而 `timeval` 提供了包含 PCIe 传输、kernel 启动开销的完整 E2E 视角。

---

### `ConsumingOnePhase` —— Phase 执行的闭包封装

这是模块最核心的**高阶函数**之一，将单个 Phase 的 FPGA 执行流程封装为可重用的执行单元：

```cpp
void ConsumingOnePhase(
    GLV* pglv_iter,                    // 当前 Phase 的图数据
    double opts_C_thresh,              // 社区阈值参数
    KMemorys_clBuff& buff_cl,          // FPGA 设备缓冲区
    KMemorys_host& buff_host,          // 主机端缓冲区
    cl::Kernel& kernel_louvain,        // OpenCL kernel 对象
    cl::CommandQueue& q,               // OpenCL 命令队列
    int& eachItrs,                     // 输出：本 Phase 迭代次数
    double& currMod,                   // 输出：当前 modularity
    double& eachTimeInitBuff,          // 输出：buffer 初始化时间
    double& eachTimeReadBuff           // 输出：buffer 读取时间
);
```

**执行流水线（5 阶段）**：

```
Host Buffer Prep (PhaseLoop_UsingFPGA_Prep_Init_buff_host)
           │
           ▼
Kernel Setup (PhaseLoop_UsingFPGA_1_KernelSetup)
           │
           ▼
Data H→D Transfer (PhaseLoop_UsingFPGA_2_DataWriteTo)
           │
           ▼
FPGA Execution (PhaseLoop_UsingFPGA_3_KernelRun)
           │
           ▼
Data D→H Transfer (PhaseLoop_UsingFPGA_4_DataReadBack)
           │
           ▼
Synchronization (PhaseLoop_UsingFPGA_5_KernelFinish)
           │
           ▼
Result Parsing (PhaseLoop_UsingFPGA_Prep_Read_buff_host)
```

**设计模式**：这实际上是 **Template Method 模式** 的 C++ 实现——固定的 5 步流程，但具体 buffer 映射、kernel 参数设置由外部函数提供。

---

### `PhaseLoop_CommPostProcessing` 家族 —— 图重构与社区传播

这组函数处理 Phase 之间的**状态转换**，是算法正确性的关键：

**标准版本** (`PhaseLoop_CommPostProcessing`):
- 输入：当前图的社区划分 `C` (每个顶点所属的社区 ID)
- 处理：
  1. `renumberClustersContiguously`：将社区 ID 重映射为连续的 0..k 范围
  2. `PhaseLoop_UpdatingC_org`：更新原始图的社区归属（追踪社区层次结构）
  3. `buildNextLevelGraphOpt`：构建收缩图（每个社区成为新图的单个顶点）
- 输出：下一 phase 的新图 `Gnew` 和重置的社区数组 `C`

**分区版本** (`_par` 后缀)：
- 针对分布式图分区场景，处理 **Ghost 顶点**（跨分区的镜像顶点）
- 额外处理 `M` 数组（标记特殊顶点）和 `NVl`（局部顶点数）
- 使用 `renumberClustersContiguously_ghost` 处理跨分区社区 ID 一致性

**剪枝版本** (`_par_prune` 后缀)：
- 在分区版本基础上增加 **Prune（剪枝）优化**，跳过无变化的社区计算
- 利用 `flag` 和 `flagUpdate` 数组标记活跃顶点，减少 FPGA 计算量

**关键数据结构转换**：

```
Phase N:                    Phase N+1:
┌─────────────┐           ┌─────────────────┐
│  G (Graph)  │ ────────▶ │  Gnew (Graph)   │
│  NV vertices│  contract │  NC vertices    │
│  NE edges   │           │  NE' edges      │
└─────────────┘           └─────────────────┘
       │                          │
       ▼                          ▼
┌─────────────┐           ┌─────────────────┐
│  C (long[]) │           │  C (reset to -1)│
│  size NV    │           │  size NC        │
│  cluster ID │           │  cluster ID     │
└─────────────┘           └─────────────────┘
```

---

### Buffer 管理：主机-设备内存契约

本模块使用 **显式双 buffer 架构** 管理 FPGA 加速器内存，这是性能优化的关键。

**内存布局策略**：

```cpp
// 主机端缓冲区 (KMemorys_host)
struct KMemorys_host {
    // Config 区域 (4-8 个 64-bit 字)
    int64_t* config0;    // [0]=vertexNum, [1]=numColors, [2]=iterations, [3]=edgeNum
    DWEIGHT* config1;    // [0]=opts_C_thresh, [1]=currMod
    
    // CSR 图结构 (只读)
    int* offsets;        // size: NV + 1 (CSR 行指针)
    int* indices;        // size: NE_mem_1 (CSR 列索引，分块存储)
    int* indices2;       // size: NE_mem_2 (第二块，当 NE > MAXNV 时使用)
    float* weights;      // size: NE_mem_1 (边权重)
    float* weights2;     // size: NE_mem_2
    
    // 算法状态 (读写)
    int* cidPrev;        // size: NV (前一次迭代的社区 ID)
    int* cidCurr;        // size: NV (当前迭代的社区 ID)
    int* cidSizePrev;    // size: NV (社区大小)
    float* totPrev;      // size: NV (社区总权重)
    // ... (其他状态数组)
    
    // 着色优化 (可选)
    int* colorAxi;       // size: NV (顶点颜色，用于无冲突并行)
    int* colorInx;
};
```

**内存拓扑映射**（关键性能优化）：

代码中通过 `XCL_MEM_TOPOLOGY` 显式指定每个 buffer 对应的 DDR/HBM bank：

```cpp
// DDR bank 分配策略（针对 Alveo U280/U50 等平台）
mext_in[0] = {(unsigned int)(4) | XCL_MEM_TOPOLOGY, buff_host.config0, 0};  // DDR[4]
mext_in[2] = {(unsigned int)(4) | XCL_MEM_TOPOLOGY, axi_offsets, 0};         // DDR[4]
mext_in[3] = {(unsigned int)(0) | XCL_MEM_TOPOLOGY, axi_indices, 0};       // DDR[0]
mext_in[4] = {(unsigned int)(2) | XCL_MEM_TOPOLOGY, axi_weights, 0};       // DDR[2]
// ... indices2/weights2 使用 DDR[1]/DDR[3]
```

**设计意图**：
- **Bank 并行**：offsets/indices/weights 分离到不同 DDR bank，最大化内存并行带宽
- **NUMA 感知**：config 和 offsets（小数据、频繁访问）放在同一 bank，减少跨 bank 延迟
- **HBM 适配**：在 HBM 平台（如 U50）上，这种显式拓扑映射能利用 HBM 的高带宽特性

**内存容量边界**：

```cpp
// 容量限制常量（通常在 defs.h 中定义）
#define MAXNV (1 << 26)  // 64M 顶点（限制 offsets 数组大小）
#define MAXNE (1 << 28)  // 256M 边（限制 indices/weights 大小）

// 动态分块策略（处理超大图）
long NE_mem = NE_max * 2;           // 无向图存储为双向边
long NE_mem_1 = min(NE_mem, MAXNV); // 第一块（最大 64M）
long NE_mem_2 = NE_mem - NE_mem_1;  // 剩余部分（如果 NE > 64M）
```

**关键约束**：
- 单块 indices/weights 最大 64M（256MB / sizeof(int)），超大图必须启用 `indices2/weights2` 分块
- 顶点数 `NV` 必须小于 64M（`offsets` 数组大小限制）
- 这些限制来自 FPGA 内核的地址宽度设计（26-bit 地址总线）

---

## 时序采集架构

本模块内置了**纳秒级精度的分层时序采集系统**，用于性能剖析和瓶颈定位。

### 时序层级结构

```
Total Execution Time (totTimeAll)
├── Pre-Processing (timePrePre)
│   ├── Device Detection (timePrePre_dev)
│   ├── XCLBIN Loading (timePrePre_xclbin)
│   └── Buffer Mapping (timePrePre_buff)
│
├── Phase Loop (eachTimePhase[MAX_NUM_PHASE])
│   ├── FPGA E2E Time (eachTimeE2E_2[phase])
│   │   ├── Buffer Init (eachTimeInitBuff)
│   │   ├── Data H→D Transfer (implicit in E2E)
│   │   ├── FPGA Kernel Execution (from CL_PROFILING)
│   │   ├── Data D→H Transfer (implicit in E2E)
│   │   └── Buffer Read (eachTimeReadBuff)
│   │
│   └── Post-Processing (eachTimeReGraph[phase])
│       ├── Renumber Clusters (eachNum)
│       ├── Update C_org (eachC)
│       ├── Create M (eachM)
│       ├── Build Next Graph (eachBuild)
│       └── Set GLV (eachSet)
│
└── Post-Processing (timePostPost)
    └── Feature Push (timePostPost_feature)
```

### 关键时序测量技术

**1. CPU 端 Wall-Clock 时间（微秒级）**：

```cpp
// 使用 OpenMP 的 omp_get_wtime()（微秒级精度）
double time1 = omp_get_wtime();
// ... 被测代码 ...
double elapsed = omp_get_wtime() - time1;
```

适用场景：主机端代码段（buffer 初始化、图重构等）。

**2. E2E 时间（微秒级，绝对时间戳）**：

```cpp
// 使用 POSIX gettimeofday（微秒级 wall-clock）
struct timeval tstartE2E, tendE2E;
gettimeofday(&tstartE2E, 0);
// ... FPGA 完整执行流程 ...
gettimeofday(&tendE2E, 0);
int exec_timeE2E = diff(&tendE2E, &tstartE2E); // 微秒
```

适用场景：测量包含 PCIe 传输、kernel 执行、数据回传的完整 FPGA 调用周期。

**3. FPGA Kernel 纯执行时间（纳秒级）**：

```cpp
// 使用 OpenCL Profiling Events（纳秒级精度）
std::vector<std::vector<cl::Event>> kernel_evt1(1);
kernel_evt1[0].resize(1);

// enqueue kernel 时关联 event
q.enqueueTask(kernel_louvain, &kernel_evt0[0], kernel_evt1[0].data());

// kernel 完成后读取 profiling 信息
unsigned long timeStart, timeEnd;
kernel_evt1[0][0].getProfilingInfo(CL_PROFILING_COMMAND_START, &timeStart);
kernel_evt1[0][0].getProfilingInfo(CL_PROFILING_COMMAND_END, &timeEnd);
unsigned long exec_time0 = (timeEnd - timeStart) / 1000.0; // 转换为微秒
```

适用场景：精确测量 FPGA 内核实际执行时间（不包含 PCIe 传输），用于计算"纯加速比"。

### 时序数据的消费与展示

采集的时序数据通过两个主要报告函数输出：

**1. `PrintReport_MultiPhase` —— 宏观性能摘要**：
- 总 Phase 数、总迭代次数、最终社区数
- 每 Phase 的 E2E 时间、modularity、迭代次数
- 总聚类时间、总图构建时间、总着色时间

**2. `PrintReport_MultiPhase_2` —— 细粒度时间分解**：
- Buffer 初始化时间（`totTimeInitBuff`）
- Buffer 读取时间（`totTimeReadBuff`）
- 图重构时间（`totTimeReGraph`）
- 子阶段分解：`eachNum`（重编号）、`eachC`（更新 C_org）、`eachBuild`（建图）、`eachSet`（设置 GLV）

这些报告对于**性能调优**至关重要：如果 `totTimeInitBuff` 占主导，说明 PCIe 传输是瓶颈；如果 `totTimeReGraph` 占主导，说明图重构算法需要优化。

---

## 新贡献者必读：陷阱与契约

### 1. 内存所有权与生命周期契约

**严格的三方所有权模型**：

| 资源 | 分配者 | 所有者 | 释放者 | 生命周期 |
|-----|-------|-------|-------|---------|
| `KMemorys_host` 成员 (offsets, indices, etc.) | `PhaseLoop_MapHostBuff` | `KMemorys_host` 实例 | `KMemorys_host::freeMem()` | 从 `UsingFPGA_MapHostClBuff` 到 `runLouvainWithFPGA_demo_par_core` 结束 |
| `KMemorys_clBuff` 成员 (cl::Buffer) | `PhaseLoop_MapClBuff` | `KMemorys_clBuff` 实例 | 自动（cl::Buffer RAII） | 同 host buffer |
| `GLV` 实例 | `CloneSelf` | 调用者（如 `LouvainGLV_general`） | 调用者负责 delete | 跨多个 Phase 存活 |
| `graphNew` (G->edgeList, G->edgeListPtrs) | `buildNextLevelGraphOpt` | 当前 `GLV` | 后处理时 `free(G->edgeList)` 等 | 单 Phase 内 |

**关键契约**：

1. **Double-Free 风险**：`PhaseLoop_CommPostProcessing` 会 `free(G->edgeList)` 和 `free(G)`，但仅释放旧图结构；`GLV` 容器本身由调用者管理。严禁在 `PhaseLoop_CommPostProcessing` 外重复释放。

2. **Buffer 泄漏风险**：`KMemorys_host` 的析构**不会**自动调用 `freeMem()`，必须在 `runLouvainWithFPGA_demo_par_core` 结束时显式调用 `buff_host.freeMem()`。

3. **RAII 边界**：`KMemorys_clBuff` 使用 `cl::Buffer`（OpenCL C++ Wrapper），其析构自动释放设备内存；但 `KMemorys_host` 使用裸指针（`int*`, `float*` 等），必须手动管理。

### 2. OpenCL 命令队列与事件依赖

**严格的 Event 链式依赖**：

```cpp
// 错误示范：缺少 event 依赖，可能导致数据竞争
q.enqueueWriteBuffer(buff_cl.db_config0, ...);  // 异步执行
q.enqueueTask(kernel_louvain, ...);              // 可能 config0 还没写完就启动 kernel！

// 正确做法：使用 event 建立依赖链
std::vector<cl::Event> kernel_evt0(1);  // 标记 Write 完成
std::vector<cl::Event> kernel_evt1(1); // 标记 Kernel 完成

q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &kernel_evt0[0]);           // Write
q.enqueueTask(kernel_louvain, &kernel_evt0, &kernel_evt1[0]);               // Kernel (依赖 Write)
q.enqueueMigrateMemObjects(ob_out, 1, &kernel_evt1[0], nullptr);            // Read (依赖 Kernel)
```

**关键契约**：

1. **Out-of-Order Queue 风险**：代码使用 `CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE`，这意味着命令默认**不按入队顺序执行**。必须通过 `cl::Event` 显式指定依赖关系，否则会出现先启动 kernel 后传输数据的竞态条件。

2. **Profiling 精度要求**：要获得精确的 kernel 执行时间，必须：
   - 创建 Queue 时启用 `CL_QUEUE_PROFILING_ENABLE`
   - 使用 `enqueueTask` 而非 `enqueueNDRangeKernel`（Louvain kernel 是单工作项的流水线设计）
   - 通过 `cl::Event::getProfilingInfo(CL_PROFILING_COMMAND_START/END)` 读取时间戳

3. **Memory Consistency**：`enqueueMigrateMemObjects` 使用 `CL_MIGRATE_MEM_OBJECT_HOST` (1) 和 `CL_MIGRATE_MEM_OBJECT_CONTENT_UNDEFINED` (0) 标志，明确区分设备→主机和主机→设备的数据流向。

### 3. 图规模动态变化与 Buffer 重分配

**动态图收缩的边界条件**：

Louvain 算法每一 Phase 都会减少顶点数（社区收缩），但边数可能增加或减少。代码在 `runLouvainWithFPGA_demo_par_core` 中处理这种情况：

```cpp
// 检查当前图是否超出预分配 buffer 容量
if (NE_max < pglv_iter->G->numEdges) {
    printf("WARNING: ReMapBuff as %d < %d \n", NE_max, pglv_iter->G->numEdges);
    NE_max = pglv_iter->G->numEdges;
    
    // 重新计算分块大小
    long NE_mem = NE_max * 2;
    long NE_mem_1 = NE_mem < (MAXNV) ? NE_mem : (MAXNV);
    long NE_mem_2 = NE_mem - NE_mem_1;
    
    // 释放旧 buffer 并重新分配
    buff_host.freeMem();
    UsingFPGA_MapHostClBuff(pglv_iter->G->numVertices, NE_mem_1, NE_mem_2, context, buff_host, buff_cl);
}
```

**关键契约**：

1. **容量保守估计**：初始 `NE_max = NE_orig`（原始图边数），但社区收缩可能导致边数增加（最坏情况 $O(N^2)$，虽然 Louvain 通常收敛时边数减少）。代码采用**乐观分配+动态扩容**策略。

2. ** costly 重分配**：`ReMapBuff` 涉及 `freeMem()` 和重新 `cl::Buffer` 构造，代价高昂（需重新分配 DDR 物理内存）。因此仅在边数确实超过 `NE_max` 时才触发。

3. **分块连续性假设**：即使发生重分配，`NE_mem_1` 和 `NE_mem_2` 的分块逻辑保持不变（第一块最大 64M），FPGA kernel 无需重新编译。

### 4. 精度与溢出的数值陷阱

**Modularity 计算的数值稳定性**：

Louvain 算法的核心指标是 modularity $Q$，其计算涉及浮点累加：

$$Q = \frac{1}{2m} \sum_{ij} \left( A_{ij} - \frac{k_i k_j}{2m} \right) \delta(c_i, c_j)$$

代码中使用 `double` 存储 `currMod` 和 `opts_C_thresh`（阈值），但在 FPGA 端使用 `float`（`DWEIGHT` 通常映射到 `float`）进行计算。

**关键契约**：

1. **精度损失风险**：`float` 只有 24-bit 尾数（约 7 位十进制精度），对于边权重大或社区内部边密集的图，$k_i k_j / 2m$ 项可能产生 catastrophic cancellation（灾难性抵消），导致 modularity 计算误差。

2. **收敛阈值敏感性**：`opts_threshold`（默认约 $10^{-4}$ 到 $10^{-6}$）用于判断算法是否收敛。由于 FPGA 使用 `float`，当真实 modularity 增益接近阈值时，可能出现 CPU（double）判断为收敛但 FPGA（float）认为未收敛的不一致性。

3. **负权重边处理**：代码中 `M` 数组（标记数组）使用 `long*` 并允许负值（`M_orig[i] < 0`）标记特殊顶点。这要求调用者保证 `M` 的初始化，否则 `CreateM` 可能产生未定义行为。

---

## 使用模式与扩展指南

### 典型调用序列

```cpp
// 1. 准备原始图数据
graphNew* G = loadGraph("/path/to/edges.txt");
long* C_orig = (long*)malloc(G->numVertices * sizeof(long));

// 2. 配置参数
char* xclbinPath = "/path/to/kernel.xclbin";
bool opts_coloring = true;        // 启用着色优化
long opts_minGraphSize = 10000;   // 图小于此阈值使用 CPU
double opts_threshold = 1e-6;     // 收敛阈值
double opts_C_thresh = 0.001;     // 社区合并阈值
int numThreads = 16;              // CPU 线程数

// 3. 执行 FPGA 加速 Louvain
runLouvainWithFPGA_demo(
    G, C_orig, xclbinPath, 
    opts_coloring, opts_minGraphSize,
    opts_threshold, opts_C_thresh,
    numThreads
);

// 4. 结果在 C_orig 中：C_orig[i] 表示顶点 i 所属的社区 ID
```

### 批处理模式（多设备并行）

对于多张 FPGA 卡或多图并行处理，使用 `LouvainGLV_general_batch_thread`：

```cpp
// 准备多个子图（通过图分区算法预先划分）
GLV* par_src[NUM_PARTITIONS];
GLV* par_lved[NUM_PARTITIONS];
double timeLv[NUM_PARTITIONS];

// 在多个线程中并行处理（每个线程绑定一张 FPGA 卡）
LouvainGLV_general_batch_thread(
    hasGhost,        // 是否使用 ghost 顶点
    MD_NORMAL,       // 模式：标准或剪枝
    id_dev,          // 设备 ID
    id_glv,          // 全局 GLV ID 起始
    num_dev,         // 总设备数
    num_par,         // 总分区数
    timeLv,          // 输出：每个分区的执行时间
    par_src,         // 输入：源 GLV 数组
    par_lved,        // 输出：结果 GLV 数组
    xclbinPath,      // xclbin 路径
    numThreads, minGraphSize, threshold, C_threshold,
    isParallel, numPhase
);
```

### 扩展点：自定义后处理逻辑

若需在 Phase 之间插入自定义逻辑（如社区质量评估、动态阈值调整），可修改 `PhaseLoop_CommPostProcessing` 的调用点：

```cpp
// 在 runLouvainWithFPGA_demo_par_core 的主循环中
while (!isItrStop) {
    // ... FPGA 执行 ...
    
    // 标准后处理（可在此前后插入钩子）
    eachTimeReGraph[phase - 1] = PhaseLoop_CommPostProcessing(
        pglv_orig, pglv_iter, numThreads, ...
    );
    
    // 扩展点：自定义社区分析
    if (custom_analysis_enabled) {
        analyzeCommunityQuality(pglv_iter->C, pglv_iter->NV);
        adjustThresholdDynamically(&opts_threshold, currMod);
    }
    
    // ... 收敛判断 ...
}
```

---

## 依赖关系与模块边界

### 上游依赖（本模块调用谁）

| 依赖模块 | 依赖内容 | 用途 |
|---------|---------|-----|
| `partition_graph_state_structures` | `GLV`, `graphNew` 结构定义 | 图数据容器 |
| `partition_phase_timing_and_metrics` | `ParLV`（包含本模块所在文件） | 分区 Louvain 数据结构 |
| `louvain_modularity_execution_and_orchestration` | `xilinxlouvain.hpp` | FPGA kernel 参数定义 |
| `graph_analytics_and_partitioning/l2_graph_preprocessing_and_transforms` | `buildNextLevelGraphOpt` | 图收缩重构算法 |
| `graph_analytics_and_partitioning/l2_graph_preprocessing_and_transforms` | `renumberClustersContiguously` | 社区 ID 重编号 |
| OpenCL 运行时 | `cl::Context`, `cl::Buffer`, `cl::Kernel` | FPGA 设备交互 |
| OpenMP | `omp_get_wtime()`, `#pragma omp parallel` | CPU 端并行与时间测量 |

### 下游依赖（谁调用本模块）

| 调用者 | 调用入口 | 场景 |
|-------|---------|-----|
| `community_detection_louvain_partitioning/louvain_modularity_execution_and_orchestration` | `runLouvainWithFPGA_demo` | 单图 FPGA 加速 |
| `community_detection_louvain_partitioning/partition_phase_timing_and_metrics/parlv_orchestration` | `LouvainGLV_general` | 通用 Louvain 接口 |
| 外部基准测试框架 | `LouvainGLV_general_batch_thread` | 多图批处理基准测试 |

### 数据契约边界

**输入契约**（调用本模块前必须保证）：
1. `G->numVertices < MAXNV` (64M) 且 `G->numEdges < MAXNE` (256M)
2. `G->edgeListPtrs` 和 `G->edgeList` 已分配且符合 CSR 格式（`offsets` 为 `long*`，`edgeList` 为 `edge*`）
3. `C_orig` 数组已分配，大小为 `G->numVertices * sizeof(long)`
4. `opts_xclbinPath` 指向有效的 Xilinx FPGA 二进制文件（`.xclbin`）
5. 如果 `opts_coloring == true`，`colors` 数组已分配（本模块内部分配在 `PhaseLoop_UsingFPGA_Prep` 中）

**输出契约**（本模块保证的输出状态）：
1. `C_orig[i]` 包含顶点 `i` 的最终社区 ID（范围 `0` 到 `numClusters-1`）
2. `prevMod` 包含最终 modularity 值（收敛时的模块度）
3. `phase` 包含执行的总 Phase 数
4. 如果使用了 FPGA（`opts_coloring && numVertices > opts_minGraphSize`），`totTimeE2E` 包含总 FPGA 执行时间（微秒）
5. 所有中间分配的 `KMemorys_host` 和 `KMemorys_clBuff` 在 `runLouvainWithFPGA_demo_par_core` 返回前被正确释放（通过 `buff_host.freeMem()`）

**副作用警告**：
- `PhaseLoop_CommPostProcessing` 会**释放输入图** `G` 的边数据（`free(G->edgeListPtrs); free(G->edgeList); free(G);`），但将新图 `Gnew` 通过指针赋值回传给调用者。调用者**不得**再使用旧的 `G` 指针。
- `PhaseLoop_UpdatingC_org` 会修改 `C_orig` 数组，这是**破坏性更新**，调用前若需保留原始社区划分需自行拷贝。

---

## 性能优化要点

### 1. DDR Bank 交错访问

如前所述，代码通过 `XCL_MEM_TOPOLOGY` 将不同 buffer 显式映射到不同 DDR bank。在多 FPGA 卡（如 U280 的 4 个 DDR）场景下，这种显式拓扑映射允许：
- **并行访问**：`offsets`（Bank 4）、`indices`（Bank 0）、`weights`（Bank 2）可同时被 FPGA 内核访问，理论带宽提升 3 倍
- **避免 Bank 冲突**：确保高访问频率的 buffer（如 `cidPrev/cidCurr` 状态数组）分散在不同 bank

### 2. Double Buffering 潜力

当前实现是**单缓冲**——每个 Phase 需要等待 FPGA 完成才能开始下一 Phase 的数据准备。理论上可实现 **Double Buffering**：
- 准备 Phase N+1 的数据同时，Phase N 的 FPGA 计算并行进行
- 挑战：Louvain 的 Phase N+1 依赖 Phase N 的社区划分结果，数据依赖性导致难以完全流水线化
- 部分优化：可在 FPGA 计算的同时，CPU 并行执行下一图的预处理（批处理场景 `LouvainGLV_general_batch_thread`）

### 3. 剪枝(Prune)策略的收益

`prune` 版本（`_prune` 后缀函数）通过 `flag` 数组标记"活跃社区"，FPGA kernel 仅处理标记为变化的顶点。收益取决于图的动态性：
- **高动态图**（社区快速合并）：剪枝率可达 80%+，显著减少 FPGA 计算量
- **低动态图**（社区稳定）：`flag` 维护开销可能抵消收益
- **自适应阈值**：代码通过 `opts_C_thresh` 控制剪枝激进程度，需针对具体数据集调优

---

## 参考资料与延伸阅读

- **Louvain 算法论文**：Blondel, V.D. et al. "Fast unfolding of communities in large networks." *J. Stat. Mech.* 2008
- **FPGA 加速图计算**：Zhang et al. "CAGRA: A Configurable Accelerator for Graph Analytics on FPGAs." *FPGA 2022*
- **OpenCL Profiling**：Xilinx UG1393 "Vitis Application Acceleration Development Flow"
- **CSR 图格式**：Saad, Y. "Iterative Methods for Sparse Linear Systems", Chapter 3

---

*文档版本：基于 `louvainPhase.cpp` 代码分析，涵盖 `timeval` 结构体及所有 Phase timing execution 相关函数。*