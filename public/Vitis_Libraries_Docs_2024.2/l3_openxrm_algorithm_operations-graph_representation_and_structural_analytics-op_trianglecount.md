# opTriangleCount 子模块技术文档

## 功能概述

`opTriangleCount` 实现了**三角形计数（Triangle Counting）**算法的 FPGA 加速。三角形计数是图分析中的基础结构分析操作，用于统计图中长度为 3 的闭合路径数量（即三元组中三个节点互相连接形成的三角形）。

## 核心概念

### 三角形计数的定义

在无向图 $G=(V, E)$ 中，一个**三角形**是三个节点 $\{u, v, w\}$ 的集合，满足：
$$(u,v) \in E \land (v,w) \in E \land (u,w) \in E$$

三角形计数的目标是计算图中所有这样的三元组数量。

### 算法复杂度

**简单实现**：$O(|V| \cdot d_{max}^2)$，其中 $d_{max}$ 是最大度数。

**本模块的 FPGA 实现**：
- 利用 FPGA 的并行性同时检查多个候选三角形
- 采用边遍历（edge-iterator）或节点遍历（node-iterator）策略的硬件优化版本
- 复杂度仍为 $O(|E| \cdot \bar{d})$，但通过高度并行化实现加速

## 类设计与组件

### opTriangleCount 类结构

```cpp
class opTriangleCount {
private:
    // 硬件配置（静态成员，类级别共享）
    static uint32_t cuPerBoardTriangleCount;  // 每板 CU 数
    static uint32_t dupNmTriangleCount;       // 复制因子
    
    // 实例级别配置
    uint32_t maxCU;       // 最大 CU 数量
    uint32_t deviceNm;    // 设备数量
    
    // 句柄管理
    clHandle* handles;                    // CU 句柄数组
    std::vector<uint32_t> deviceOffset;   // 设备偏移映射
    
    // 任务队列
    std::vector<event<int> > task_queue;  // L3 任务队列

public:
    // 生命周期管理
    void createHandle(openXRM* xrm, clHandle& handle, ...);
    void setHWInfo(uint32_t numDev, uint32_t CUmax);
    void init(openXRM* xrm, std::string kernelName, ...);
    void freeTriangleCount(xrmContext* ctx);
    void cuRelease(xrmContext* ctx, xrmCuResource* resR);
    
    // 计算接口
    int compute(unsigned int deviceID, unsigned int cuID, 
                unsigned int channelID, xrmContext* ctx, ...);
    event<int> addwork(Graph<uint32_t, uint32_t> g, uint64_t& nTriangle);
    
    // 辅助方法
    void bufferInit(clHandle* hds, std::string instanceName0, ...);
    void migrateMemObj(clHandle* hds, bool type, ...);
    int cuExecute(clHandle* hds, cl::Kernel& kernel0, ...);
};
```

### 与 opConvertCsrCsc 的异同

| 特性 | opTriangleCount | opConvertCsrCsc |
|------|-----------------|-------------------|
| **缓冲区数量** | 7 个 | 6 个 |
| **输出数据** | 单个标量 `uint64_t TC` | CSC 格式图数据 |
| **内核参数** | 9 个（含 2 组偏移/索引） | 8 个 |
| **中间结果** | 需要双份偏移/索引缓冲区 | 需要 degree 和 offsetsCSC2 |
| **算法复杂度** | $O(E \cdot \bar{d})$ | $O(E)$ |

## 核心方法详解

### 1. bufferInit() - 三角形计数专用缓冲区配置

```cpp
void opTriangleCount::bufferInit(
    clHandle* hds,
    std::string instanceName0,
    Graph<uint32_t, uint32_t> g,    // 输入图
    uint64_t* TC,                     // 三角形计数结果（输出）
    uint32_t* offsets,                // 临时：偏移数组
    uint32_t* rows,                   // 临时：边数组
    cl::Kernel& kernel0,
    std::vector<cl::Memory>& ob_in,
    std::vector<cl::Memory>& ob_out
);
```

**缓冲区布局（7 个缓冲区）**：

| 索引 | OpenCL 参数 | 缓冲区 | 内容 | 方向 | 大小 |
|------|-------------|--------|------|------|------|
| 0 | `setArg(2)` | `buffer[0]` | `offsets` (CSR) | H→D | `V × sizeof(uint32_t)` |
| 1 | `setArg(3)` | `buffer[1]` | `rows` (CSR indices) | H→D | `E × sizeof(uint32_t)` |
| 2 | `setArg(4)` | `buffer[2]` | `offsets` (CSC 副本) | H→D | `V × sizeof(uint32_t)` |
| 3 | `setArg(5)` | `buffer[3]` | `rows` (CSC indices 副本) | H→D | `E × sizeof(uint32_t)` |
| 4 | `setArg(6)` | `buffer[4]` | 中间偏移数组（设备分配） | 内部 | `V × 2 × sizeof(uint32_t)` |
| 5 | `setArg(7)` | `buffer[5]` | `rows` (另一副本) | H→D | `E × sizeof(uint32_t)` |
| 6 | `setArg(8)` | `buffer[6]` | `TC` (三角形计数结果) | D→H | `sizeof(uint64_t)` |

**关键观察**：

1. **多重索引副本**：`offsets` 和 `rows` 被传递到多个缓冲区（`buffer[0]/[2]` 和 `buffer[1]/[3]/[5]`）。这是因为 FPGA 内核可能采用**多阶段处理**：
   - 阶段 1：使用 CSR 格式遍历边
   - 阶段 2：使用 CSC 格式或双索引进行交叉验证
   - 这种设计允许内核在片上同时保存多种访问模式

2. **设备本地缓冲区**：`buffer[4]` 使用 `CL_MEM_READ_WRITE` 而非 `CL_MEM_USE_HOST_PTR`，说明它是纯设备端工作区，主机不直接访问。

3. **标量输出**：三角形计数结果 `TC` 是一个 64 位整数，体现了结果类型从图数据（大规模数组）到聚合统计（单个值）的转变。

### 2. compute() - 主计算流程

```cpp
int opTriangleCount::compute(
    unsigned int deviceID,    // 设备索引（多 FPGA 场景）
    unsigned int cuID,        // CU 索引（单设备多 CU）
    unsigned int channelID,   // 通道索引（CU 内多通道）
    xrmContext* ctx,          // XRM 上下文
    xrmCuResource* resR,      // XRM 资源描述
    std::string instanceName, // 内核实例名
    clHandle* handles,        // 句柄数组（从 init 传入）
    Graph<uint32_t, uint32_t> g,   // 输入图
    uint64_t* nTriangle       // 输出：三角形数量
);
```

**详细执行流程**：

**阶段 1：定位 CU 句柄（常数时间 O(1)）**
```cpp
// 三维索引到一维数组的映射
cHandle* hds = &handles[
    channelID +                           // 通道维度
    cuID * dupNmTriangleCount +          // CU 维度
    deviceID * dupNmTriangleCount * cuPerBoardTriangleCount  // 设备维度
];
```
这种索引策略允许：
- **设备扩展**：轻松添加更多 FPGA 卡
- **CU 扩展**：每个设备支持多个 CU
- **时间复用**：`dupNm` 允许逻辑上超过物理 CU 数量的并发

**阶段 2：主机端内存分配（关键路径）**
```cpp
// 分配结果缓冲区（64位计数器）
uint64_t* TC = aligned_alloc<uint64_t>(1);

// 分配临时工作区（顶点数组和边数组）
uint32_t* offsets = aligned_alloc<uint32_t>(V * 16);
uint32_t* rows = aligned_alloc<uint32_t>(E * 16);

// 图数据拷贝（从 Graph 结构到连续缓冲区）
for (int i = 0; i < g.nodeNum + 1; ++i) {
    offsets[i] = g.offsetsCSR[i];
}
for (int i = 0; i < g.edgeNum; ++i) {
    rows[i] = g.indicesCSR[i];
}
```

**注意**：使用 `aligned_alloc` 而不是 `malloc`，确保缓冲区满足 FPGA DMA 的对齐要求（通常为 4KB 页对齐）。

**阶段 3：OpenCL 缓冲区设置**
```cpp
// 初始化 OpenCL 缓冲区、内核参数和内存对象
bufferInit(hds, instanceName, g, TC, offsets, rows, kernel0, ob_in, ob_out);
```
详细过程见 `bufferInit()` 章节。

**阶段 4：异步执行流水线**
```cpp
// 创建事件对象用于同步
std::vector<cl::Event> events_write(1);
std::vector<cl::Event> events_kernel(num_runs);
std::vector<cl::Event> events_read(1);

// 第 1 步：主机 → 设备数据传输（异步）
migrateMemObj(hds, 0, num_runs, ob_in, nullptr, &events_write[0]);

// 第 2 步：执行内核（等待传输完成）
int ret = cuExecute(hds, kernel0, num_runs, &events_write, &events_kernel[0]);

// 第 3 步：设备 → 主机结果回传（等待内核完成）
migrateMemObj(hds, 1, num_runs, ob_out, &events_kernel, &events_read[0]);

// 第 4 步：阻塞等待最终结果
events_read[0].wait();
```

**阶段 5：结果提取和清理**
```cpp
// 提取三角形计数结果
nTriangle[0] = TC[0];

// 标记 CU 为可用
hds->isBusy = false;

// 释放主机内存
free(TC);
free(offsets);
free(rows);
```

**返回值**：
- `0`：成功执行
- 非零：错误码（来自 OpenCL 运行时或 XRM）

### 3. addwork() - 异步任务接口

```cpp
event<int> opTriangleCount::addwork(
    Graph<uint32_t, uint32_t> g,    // 输入图
    uint64_t& nTriangle              // 输出引用（将被填充）
);
```

**功能**：将同步的 `compute()` 调用包装为异步任务，通过 L3 框架的任务队列实现并行执行。

**实现**：
```cpp
event<int> opTriangleCount::addwork(Graph<uint32_t, uint32_t> g, uint64_t& nTriangle) {
    return createL3(task_queue[0], &(compute), handles, g, &nTriangle);
}
```

**参数绑定**：
- `task_queue[0]`：任务队列（FIFO）
- `&(compute)`：成员函数指针
- `handles`：CU 句柄数组（传递给 compute）
- `g`, `&nTriangle`：转发给 compute 的参数

**返回值**：`event<int>` 对象，可用于：
- 等待任务完成：`event.wait()`
- 检查返回值：`event.get()`
- 链式依赖：作为其他任务的输入事件

## 内存管理详解

### 内存所有权模型

```
┌─────────────────────────────────────────────────────────────┐
│  主机内存 (Host Memory)                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  堆分配 (malloc/aligned_alloc)                          │  │
│  │  ├── TC[1]            : uint64_t  (结果缓冲区)            │  │
│  │  ├── offsets[V*16]  : uint32_t  (顶点偏移数组)          │  │
│  │  └── rows[E*16]     : uint32_t  (边索引数组)            │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                │
│                            │ clEnqueueMigrateMemObjects     │
│                            ▼                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  页锁定内存 (Pinned/Registered)                         │  │
│  │  └── DMA 直接访问区域 (OpenCL 运行时管理)                 │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │ PCIe DMA
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  设备内存 (FPGA DDR)                                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  OpenCL Buffer Objects (7 buffers)                    │  │
│  │  ├── buffer[0]: offsets (输入)                        │  │
│  │  ├── buffer[1]: rows    (输入)                        │  │
│  │  ├── buffer[2]: offsets副本 (输入)                    │  │
│  │  ├── buffer[3]: rows副本   (输入)                    │  │
│  │  ├── buffer[4]: 中间缓冲区 (设备本地)                  │  │
│  │  ├── buffer[5]: rows副本2  (输入)                    │  │
│  │  └── buffer[6]: TC结果    (输出)                     │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 关键内存操作

**1. 主机内存分配（compute 函数内）**：
```cpp
// 使用 aligned_alloc 确保 4KB 对齐，满足 DMA 要求
uint64_t* TC = aligned_alloc<uint64_t>(1);
uint32_t* offsets = aligned_alloc<uint32_t>(V * 16);
uint32_t* rows = aligned_alloc<uint32_t>(E * 16);
```

**2. OpenCL 缓冲区创建（bufferInit 内）**：
```cpp
// 使用 CL_MEM_USE_HOST_PTR 实现零拷贝（Zero Copy）
hds[0].buffer[0] = cl::Buffer(
    context,
    CL_MEM_EXT_PTR_XILINX | CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
    sizeof(uint32_t) * V,
    &mext_in[0]  // 指向主机内存的扩展指针
);
```

`CL_MEM_USE_HOST_PTR` 是关键：它告诉 OpenCL 运行时直接使用主机内存，而不是在内部分配设备内存并来回拷贝。这要求主机内存必须页对齐（通过 `aligned_alloc` 保证）。

**3. 数据传输（migrateMemObj）**：
```cpp
void opTriangleCount::migrateMemObj(
    clHandle* hds,
    bool type,                    // 0: H2D, 1: D2H
    unsigned int num_runs,
    std::vector<cl::Memory>& ob,  // 内存对象列表
    std::vector<cl::Event>* evIn, // 输入依赖事件
    cl::Event* evOut             // 输出完成事件
) {
    for (int i = 0; i < num_runs; ++i) {
        // type: 0 = CL_MIGRATE_MEM_OBJECT_HOST (H2D)
        // type: 1 = CL_MIGRATE_MEM_OBJECT_CONTENT_UNDEFINED (D2H)
        hds[0].q.enqueueMigrateMemObjects(ob, type, evIn, evOut);
    }
}
```

### 内存生命周期时序

```
时间 ─────────────────────────────────────────────────────────────►

[t0] 调用 compute()
    │
    ├── [t0-t1] 主机内存分配 (aligned_alloc)
    │   ├── TC[1]
    │   ├── offsets[V*16]
    │   └── rows[E*16]
    │
    ├── [t1-t2] 图数据拷贝到主机缓冲区
    │   offsets[i] = g.offsetsCSR[i]
    │   rows[i] = g.indicesCSR[i]
    │
    ├── [t2-t3] bufferInit() - 创建 OpenCL 缓冲区
    │   └── 绑定主机指针到设备缓冲区 (Zero Copy)
    │
    ├── [t3-t4] H2D 迁移 (异步)
    │   └── 数据通过 PCIe DMA 到 FPGA DDR
    │
    ├── [t4-t5] 内核执行
    │   └── TC 内核在 FPGA 上运行
    │
    ├── [t5-t6] D2H 迁移 (异步)
    │   └── 结果 TC[0] 通过 PCIe DMA 回主机
    │
    ├── [t6-t7] 同步等待 events_read[0].wait()
    │
    ├── [t7-t8] 结果提取
    │   nTriangle[0] = TC[0]
    │
    └── [t8-t9] 资源释放 (free)
        ├── TC
        ├── offsets
        └── rows

[t9] compute() 返回
```

## 内核参数详解

### 三角形计数内核参数（9 个参数）

```cpp
// 在 bufferInit() 中设置的内核参数
kernel0.setArg(0, g.nodeNum);        // 节点数量 |V|
kernel0.setArg(1, g.edgeNum);        // 边数量 |E|
kernel0.setArg(2, hds[0].buffer[0]); // 第一组 offsets (CSR)
kernel0.setArg(3, hds[0].buffer[1]); // 第一组 rows (CSR indices)
kernel0.setArg(4, hds[0].buffer[2]); // 第二组 offsets (副本)
kernel0.setArg(5, hds[0].buffer[3]); // 第二组 rows (副本)
kernel0.setArg(6, hds[0].buffer[4]); // 中间偏移数组 (设备本地)
kernel0.setArg(7, hds[0].buffer[5]); // 第三组 rows (副本)
kernel0.setArg(8, hds[0].buffer[6]); // 输出：三角形计数 TC
```

**为什么需要多组 offsets/rows 副本？**

三角形计数算法通常采用**双循环遍历策略**：

```
算法：Edge-Iterator Triangle Counting
────────────────────────────────────────
对于每条边 (u, v) 其中 u < v:
    对于 u 的每个邻居 w:
        如果 w > v 且 (v, w) 是一条边:
            找到一个三角形 (u, v, w)
```

这需要同时：
1. 遍历节点 u 的邻接表（通过 CSR offsets[u] 到 offsets[u+1]）
2. 检查边 (v, w) 是否存在（需要在 CSC 或另一个 CSR 副本中查找）

多组索引缓冲区允许内核同时保存：
- CSR 格式用于出边遍历
- CSC 格式（或 CSR 副本）用于入边检查或反向查找
- 中间结构用于二分查找或哈希表

## 与 opConvertCsrCsc 的对比分析

### 功能差异

| 维度 | opConvertCsrCsc | opTriangleCount |
|------|-----------------|-------------------|
| **核心算法** | CSR → CSC 格式转换 | 三角形计数 |
| **计算复杂度** | $O(\|E\|)$ | $O(\|E\| \cdot \bar{d})$ |
| **输出数据量** | $O(\|V\| + \|E\|)$ 图数据 | $O(1)$ 标量结果 |
| **内存访问模式** | 顺序扫描 + 随机写入 | 随机读取（邻接表遍历） |
| **内核执行时间** | 与边数成正比 | 与边数和平均度数乘积成正比 |

### 代码结构相似性

两个类共享相同的设计模式：

```cpp
// 相同的构造函数/析构函数模式
void init(...);
void freeXXX(xrmContext* ctx);

// 相同的计算流程
int compute(deviceID, cuID, channelID, ..., Graph g, ...);

// 相同的异步接口
event<int> addwork(Graph g, ...);

// 相同的辅助方法
void bufferInit(...);
void migrateMemObj(...);
int cuExecute(...);
```

**设计意图**：这种一致性是**模板方法模式**的应用。虽然具体算法不同（三角形计数 vs 格式转换），但**FPGA 加速的执行流程是固定的**：
1. 准备数据（缓冲区设置）
2. 传输到设备
3. 执行内核
4. 传回结果
5. 清理资源

这种一致性使得：
- 维护者可以更容易理解和修改代码
- 可以抽象出通用的 L3 基类（虽然当前代码是平铺的）
- 测试框架可以复用相同的验证逻辑

## 性能调优建议

### 1. 批处理多个小图

对于小图，PCIe 传输开销可能超过计算收益。考虑在单个内核启动中处理多个图：

```cpp
// 当前：每个图一个内核启动
for (auto& g : small_graphs) {
    tc.addwork(g, result);  // 单独的 PCIe 往返
}

// 优化：批处理（需要修改内核支持）
// 将多个图的边列表连接，添加偏移标记
// 单次内核调用，多次结果输出
```

### 2. 重叠计算与数据传输

利用 `addwork` 的异步特性：

```cpp
// 提交多个任务，不等待
std::vector<event<int>> events;
for (int i = 0; i < num_graphs; ++i) {
    events.push_back(tc.addwork(graphs[i], results[i]));
}

// 同时做其他 CPU 工作...

// 最后统一等待
for (auto& e : events) {
    e.wait();
}
```

### 3. 调整 CU 分配策略

```cpp
// 根据图大小选择 CU 数量
// 小图：使用较少 CU，避免调度开销
// 大图：使用所有可用 CU

void setHWInfo(uint32_t numDev, uint32_t CUmax) {
    // 可以在这里实现动态 CU 选择逻辑
    maxCU = (graph_size < threshold) ? min(CUmax, 4) : CUmax;
}
```

## 总结

`opTriangleCount` 是 Xilinx 图分析加速库中的核心原语，通过 FPGA 实现三角形计数的高性能计算。其设计体现了以下关键原则：

1. **三层架构清晰分离**：L3 编排层（本模块）、L2 内核层、L1 硬件层各司其职
2. **异步流水线最大化吞吐**：数据传输与计算重叠，隐藏 PCIe 延迟
3. **资源池化管理**：XRM + OpenCL 句柄池实现高效的 CU 复用
4. **零拷贝数据传输**：`CL_MEM_USE_HOST_PTR` 避免不必要的数据复制

理解这些设计原则，有助于开发者有效地使用、调试和扩展本模块。
