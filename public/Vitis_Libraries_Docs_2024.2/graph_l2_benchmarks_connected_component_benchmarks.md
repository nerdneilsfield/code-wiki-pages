# connected_component_benchmarks 模块技术深潜

> **阅读对象**: 刚加入团队的资深工程师 — 假设你能读懂代码，但需要理解设计意图、架构角色和非显而易见选择背后的"为什么"。

---

## 1. 这个模块解决什么问题？

### 1.1 问题空间：图分析中的连通分量计算

在社交网络分析、生物信息学、推荐系统等领域，**弱连通分量（Weakly Connected Components, WCC）** 是最基础的图分析算法之一。给定一个有向图，WCC 找出所有互相可达的顶点集合 —— 想象一座城市的路网，每个"连通区域"就是一个不需要过桥就能到达的区域。

**计算挑战**:
- **数据规模**: 现实图可能有数十亿顶点、数百亿边
- **访问模式**: 图遍历具有高度不规则的内存访问模式（随机跳变严重）
- **迭代特性**: WCC 需要多轮迭代直到收敛，每轮都要扫描活跃边

### 1.2 为什么需要 FPGA 加速？

传统 CPU 实现受限于：
1. **内存带宽瓶颈**: 图遍历是内存带宽密集型，但 CPU 的缓存层次对随机访问不友好
2. **指令开销**: 每次边处理需要大量指令，而图计算的控制流简单、数据量大
3. **并行度受限**: CPU 的线程级并行在细粒度同步场景下开销巨大

FPGA 优势：
- **定制数据通路**: 可为图遍历专门设计内存访问模式
- **高内存带宽**: Alveo 卡的 HBM/DDR 提供远超 CPU 的峰值带宽
- **流水线并行**: 可同时处理数百条边，隐藏内存延迟

### 1.3 本模块的定位

`connected_component_benchmarks` 是 Xilinx **xf_graph** 图分析库的一部分，提供：
- **WCC Kernel**: 高度优化的 FPGA 加速器，实现标记-传播式 WCC 算法
- **Host 基准测试框架**: 完整的测试和性能评估环境
- **多平台支持**: 适配 Alveo U200/U250 (DDR) 和 U50 (HBM) 不同内存架构

---

## 2. 心智模型：如何理解这个模块？

### 2.1 类比：流水线上的分拣系统

想象一个**智能分拣流水线**处理包裹（图的边）：

- **入口缓冲区**: 所有待处理的边排队进入（输入 CSR 格式数据）
- **分拣工位**: 多个并行工位同时读取包裹信息，判断它属于哪个"连通区域"（FPGA pipeline stages）
- **区域标记板**: 记录每个顶点的当前区域归属，可能会被不断更新（parent array）
- **迭代循环**: 一轮分拣后，仍有包裹需要重新分类（未收敛），流水线重新启动
- **出口校验**: 最终结果与标准答案对比验证

### 2.2 核心抽象层

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Host Application                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
│  │ CSR Loader  │  │  Timing     │  │  Golden Result Comparator   │ │
│  │ (Graph I/O) │  │  Profiler   │  │  (Validation)               │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────────────┘ │
│         │                │                                          │
│         └────────────────┴──────────────────────────────────────────┤
│                            OpenCL/XRT Runtime                     │
├─────────────────────────────────────────────────────────────────────┤
│                         FPGA Kernel (wcc_kernel)                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    WCC Algorithm Pipeline                     │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │ │
│  │  │  Edge   │  │  Parent │  │  Queue  │  │  Convergence    │  │ │
│  │  │  Scan   │→ │  Update │→ │  Mgmt   │→ │  Detection      │  │ │
│  │  │         │  │         │  │         │  │                 │  │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 关键数据结构

| 结构 | 作用 | 所在位置 |
|------|------|----------|
| `offset32` / `column32` | CSR 格式的图邻接表 | Host 内存 → FPGA DDR/HBM |
| `result32` | 每个顶点的连通分量标签 | FPGA → Host |
| `queue` | BFS/传播队列 | FPGA 内部 |
| `offset32Tmp1/2` | 双缓冲临时数组 | FPGA 内部 |
| `column32G2`, `offset32G2` | 列索引和偏移的副本 | FPGA 内部 |

---

## 3. 数据流：关键操作的端到端追踪

### 3.1 启动流程（Host 侧）

```cpp
// 1. 命令行参数解析 - 获取 xclbin 路径和输入文件
ArgParser parser(argc, argv);
parser.getCmdOption("-xclbin", xclbin_path);
parser.getCmdOption("-o", offsetfile);   // CSR 偏移文件
parser.getCmdOption("-c", columnfile);   // CSR 列索引文件
parser.getCmdOption("-g", goldenfile);   // 标准结果文件
```

**设计意图**: 支持灵活的测试配置，便于回归测试和性能基准测试。

### 3.2 图数据加载（CSR 解析）

```cpp
// 2. 读取 offset 文件（CSR 行指针）
std::fstream offsetfstream(offsetfile.c_str(), std::ios::in);
offsetfstream.getline(line, sizeof(line));
std::stringstream numOdata(line);
numOdata >> numVertices;  // 第一行是顶点数

// 分配对齐内存（FPGA DMA 要求）
ap_uint<32>* offset32 = aligned_alloc<ap_uint<32> >(numVertices + 1);

// 读取每个顶点的邻接表起始偏移
while (offsetfstream.getline(line, sizeof(line))) {
    std::stringstream data(line);
    data >> offset32[index];
    index++;
}
```

**设计意图**: 
- 使用 **CSR（Compressed Sparse Row）** 格式：O(V+E) 空间复杂度，高效存储稀疏图
- `aligned_alloc` 确保 4KB 对齐，满足 FPGA DMA 传输要求
- `ap_uint<32>` 作为 Xilinx 的任意精度整数类型，保证主机与 FPGA 数据宽度一致

### 3.3 内存分配策略

```cpp
// 3. 分配所有必需的缓冲区
ap_uint<32>* column32G2 = aligned_alloc<ap_uint<32> >(numEdges);      // 列索引副本
ap_uint<32>* offset32G2 = aligned_alloc<ap_uint<32> >(numVertices + 1); // 偏移副本
ap_uint<32>* offset32Tmp1 = aligned_alloc<ap_uint<32> >(numVertices + 1); // 临时缓冲1
ap_uint<32>* offset32Tmp2 = aligned_alloc<ap_uint<32> >(numVertices + 1); // 临时缓冲2
ap_uint<32>* queue = aligned_alloc<ap_uint<32> >(numVertices);          // 工作队列
ap_uint<32>* result32 = aligned_alloc<ap_uint<32> >(numVertices);      // 最终结果
```

**内存所有权模型**:
- **分配者**: Host (`main.cpp`) 通过 `aligned_alloc` 分配
- **所有者**: Host 负责整个生命周期，直到 `free()`（代码中未显式释放，依赖进程退出）
- **借用者**: 
  - OpenCL Buffer 对象通过 `CL_MEM_USE_HOST_PTR` 借用主机指针
  - FPGA Kernel 通过 DMA 访问这些缓冲区

**双缓冲设计** (`offset32Tmp1/2`, `column32G2`, `offset32G2`):
- 允许 FPGA kernel 使用 ping-pong 缓冲策略
- 一轮迭代写入 buffer A，下一轮从 buffer B 读取，避免读写冲突

### 3.4 FPGA 平台初始化

```cpp
// 4. 初始化 OpenCL/XRT 环境
std::vector<cl::Device> devices = xcl::get_xil_devices();
cl::Device device = devices[0];
cl::Context context(device, NULL, NULL, NULL, &err);
cl::CommandQueue q(context, device, 
    CL_QUEUE_PROFILING_ENABLE | CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE, &err);

// 加载 xclbin
cl::Program::Binaries xclBins = xcl::import_binary_file(xclbin_path);
cl::Program program(context, devices, xclBins, NULL, &err);
cl::Kernel wcc(program, "wcc_kernel");
```

**设计意图**:
- **多平台抽象**: 使用 Xilinx 的 `xcl2` 工具库，屏蔽不同 Alveo 卡的硬件差异
- **性能分析**: `CL_QUEUE_PROFILING_ENABLE` 启用内核执行时间的精确测量
- **乱序执行**: `CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE` 允许命令队列优化调度

### 3.5 内存映射与 Buffer 创建

```cpp
// 5. 创建扩展内存指针（指定 bank 分配）
cl_mem_ext_ptr_t mext_o[8];
mext_o[0] = {2, column32, wcc()};       // bank 2
mext_o[1] = {3, offset32, wcc()};        // bank 3
mext_o[2] = {5, column32G2, wcc()};      // bank 5
mext_o[3] = {6, offset32G2, wcc()};      // bank 6
mext_o[4] = {7, offset32Tmp1, wcc()};    // bank 7
mext_o[5] = {8, offset32Tmp2, wcc()};    // bank 8
mext_o[6] = {10, queue, wcc()};          // bank 10
mext_o[7] = {12, result32, wcc()};        // bank 12

// 创建 OpenCL Buffer 对象（使用主机指针）
cl::Buffer column32G1_buf = cl::Buffer(context, 
    CL_MEM_EXT_PTR_XILINX | CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
    sizeof(ap_uint<32>) * numEdges, &mext_o[0]);
// ... 类似创建其他 buffer
```

**设计意图**:
- **Bank 亲和性**: 通过 `cl_mem_ext_ptr_t` 的 bank 编号（2,3,5,6,7,8,10,12），将不同缓冲区分散到多个 HBM/DDR bank，最大化带宽利用率
- **零拷贝**: `CL_MEM_USE_HOST_PTR` 避免主机与设备间的显式内存拷贝，FPGA DMA 直接访问主机内存
- **可扩展内存指针**: `CL_MEM_EXT_PTR_XILINX` 是 Xilinx 扩展，允许指定内存 bank 拓扑

### 3.6 内核启动与执行流水线

```cpp
// 6. 数据迁移：主机 → FPGA
std::vector<cl::Memory> ob_in;
ob_in.push_back(column32G1_buf);
ob_in.push_back(offset32G1_buf);
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);

// 7. 设置内核参数并启动
wcc.setArg(0, numEdges);
wcc.setArg(1, numVertices);
wcc.setArg(2, column32G1_buf);   // 输入：列索引
wcc.setArg(3, offset32G1_buf);  // 输入：行偏移
wcc.setArg(4, column32G2_buf);   // 双缓冲：列副本
wcc.setArg(5, column32G2_buf);   // （注：参数4/5相同，ping-pong逻辑）
wcc.setArg(6, offset32G2_buf);   // 双缓冲：偏移副本
wcc.setArg(7, offset32Tmp1_buf); // 临时缓冲1
wcc.setArg(8, offset32Tmp2_buf); // 临时缓冲2
wcc.setArg(9, queue_buf);        // 工作队列
wcc.setArg(10, queue_buf);       // （ping-pong）
wcc.setArg(11, result_buf);      // 输出结果
wcc.setArg(12, result_buf);      // （ping-pong）

// 启动内核（依赖写事件完成）
q.enqueueTask(wcc, &events_write, &events_kernel[0]);

// 8. 结果回传：FPGA → 主机
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);
q.finish();
```

**设计意图**:
- **事件链依赖**: `events_write` → `events_kernel` → `events_read` 形成流水线，内核启动等待数据传输完成，结果回传等待内核完成
- **双缓冲参数**: 注意某些参数（如 4/5、10/11、12/13）传入相同的 buffer，这是 WCC kernel 内部 ping-pong 逻辑的一部分
- **同步边界**: `q.finish()` 阻塞直到整个流水线完成，确保结果可用

### 3.7 结果验证

```cpp
// 9. 加载标准答案
std::vector<int> gold_result(numVertices, -1);
std::fstream goldenfstream(goldenfile.c_str(), std::ios::in);

while (goldenfstream.getline(line, sizeof(line))) {
    std::stringstream data(line);
    data >> tmp[0];  // 顶点 ID
    data >> tmp[1];  // 所属连通分量标签
    gold_result[tmpi[0] - 1] = tmpi[1];
}

// 10. 逐顶点验证
int errs = 0;
for (int i = 0; i < numVertices; i++) {
    if (result32[i].to_int() != gold_result[i] && gold_result[i] != -1) {
        std::cout << "Mismatch-" << i + 1 << ":\tsw: " << gold_result[i] 
                  << " -> " << "hw: " << result32[i] << std::endl;
        errs++;
    }
}
```

**设计意图**:
- **端到端验证**: 不仅验证 kernel 执行完成，更验证算法正确性
- **容错处理**: 跳过 `gold_result[i] == -1` 的顶点（标准答案缺失），允许部分验证
- **详细诊断**: 输出每个不匹配顶点的预期值与实际值，便于调试

---

## 4. 架构与依赖关系

### 4.1 模块在系统中的位置

```
graph_analytics_and_partitioning/
└── l2_connectivity_and_labeling_benchmarks/
    ├── connected_component_benchmarks   ← 本模块 (WCC)
    ├── label_propagation_benchmarks
    ├── maximal_independent_set_benchmarks
    └── strongly_connected_component_benchmarks
```

**同级模块关系**:
- [label_propagation_benchmarks](graph_l2_benchmarks_label_propagation_benchmarks.md): 标签传播算法，同样用于社区发现
- [maximal_independent_set_benchmarks](graph_l2_benchmarks_maximal_independent_set_benchmarks.md): 最大独立集，不同的图计算问题
- [strongly_connected_component_benchmarks](graph_l2_benchmarks_strongly_connected_component_benchmarks.md): 强连通分量，比 WCC 更严格的连通性定义

### 4.2 硬件平台支持矩阵

| 平台 | 内存类型 | 配置文件 | 特点 |
|------|----------|----------|------|
| Alveo U200/U250 | DDR4 | `conn_u200_u250.cfg` | 大容量(64GB+)，带宽适中 |
| Alveo U50 | HBM2 | `conn_u50.cfg` | 高带宽(460GB/s)，容量适中(8GB) |

**设计权衡**: U50 的 HBM 提供更高带宽但 bank 结构更复杂（32个 pseudo bank），配置文件使用 bank 区间（如 `HBM[0:1]`）来分散访问。

---

## 5. 设计权衡与决策分析

### 5.1 内存架构：统一 vs. 分散

**决策**: 使用多个独立的 AXI 端口（`m_axi_gmem0_0` 到 `m_axi_gmem0_10`），每个映射到不同的 DDR/HBM bank。

**权衡分析**:

| 方案 | 优势 | 劣势 | 本模块选择 |
|------|------|------|-----------|
| 单端口统一内存 | 编程简单，无 bank 冲突 | 带宽受限，成为瓶颈 | ❌ |
| 多端口分散内存 | 聚合带宽高，并行访问无冲突 | 需要显式管理 bank 亲和性，代码复杂 | ✅ |

**为什么这样选择**:
- WCC 算法需要同时访问：原图结构（offset/column）、双缓冲副本、临时数组、队列、结果数组
- 这些访问模式相互独立，分散到不同 bank 可实现真正的并行内存访问
- 配置文件（`.cfg`）将逻辑端口绑定到物理 bank，实现硬件级优化

### 5.2 同步模型：阻塞 vs. 流水线

**决策**: 使用 OpenCL 事件链（`events_write` → `events_kernel` → `events_read`）实现流水线，但每轮迭代阻塞等待（`q.finish()`）。

**为什么这样选择**:
- **迭代间依赖**: WCC 是迭代收敛算法，第 N 轮结果依赖于第 N-1 轮，无法跨迭代流水线
- **单轮内部流水线**: 在单次迭代内，数据传输、内核执行、结果回传形成三级流水线
- **简洁性优先**: 相比复杂的异步回调机制，阻塞模型更易理解和调试

**改进空间**: 如果未来实现异步迭代（overlap kernel N with transfer N+1），需要修改算法为"多副本乒乓"模式。

### 5.3 数据精度：32-bit vs. 任意精度

**决策**: 使用 `ap_uint<32>` 作为核心数据类型，而非 `ap_uint<512>` 的宽向量。

**为什么这样选择**:
- **随机访问友好**: WCC 涉及大量随机索引访问（`offset[v]`、`column[e]`），32-bit 粒度匹配算法需求
- **内存带宽效率**: 虽然 `ap_uint<512>` 可在单次传输中提供更多数据，但 WCC 的随机访问模式无法有效利用宽向量
- **资源权衡**: 512-bit 数据通路消耗更多 FPGA 资源（LUT、FF、DSP），而这些资源更适合用于增加并行 pipeline stage

**例外情况**: 在 HLS 测试模式（`HLS_TEST` 定义）下，代码使用 `ap_uint<512>*` 强制转换，这是因为 HLS 仿真环境要求特定的接口宽度。

### 5.4 错误处理：验证 vs. 容错

**决策**: 采用"验证优先，容错为辅"策略 —— 严格的 golden 结果比对，但允许部分顶点缺失。

**代码体现**:
```cpp
if (index - 1 != numVertices) {
    std::cout << "Warning: Some nodes are missing in the golden file..." << std::endl;
}
// 验证时跳过 gold_result[i] == -1 的顶点
if (result32[i].to_int() != gold_result[i] && gold_result[i] != -1) { ... }
```

**为什么这样选择**:
- **实用性**: 大规模图的标准结果可能非常大，有时只需要验证子集
- **灵活性**: 允许部分验证在开发调试阶段节省时间
- **核心保障**: 仍然提供逐顶点比对能力，确保正式发布前的完整性

---

## 6. 新贡献者需要注意的陷阱与边缘情况

### 6.1 内存对齐陷阱

**问题**: FPGA DMA 要求 4KB 页对齐，但标准 `malloc` 只保证 8 字节对齐。

**代码中的处理**:
```cpp
ap_uint<32>* offset32 = aligned_alloc<ap_uint<32> >(numVertices + 1);
```

**隐患**: 
- 如果忘记使用 `aligned_alloc`，`cl::Buffer` 创建会失败或出现难以调试的数据损坏
- 缓冲区大小如果不是 4KB 的倍数，最后一次传输可能部分无效

### 6.2 Bank 冲突与带宽瓶颈

**问题**: 即使配置了多 bank，不当的访问模式仍可能导致 bank 冲突。

**配置对比**:
- U200/U250: `sp=wcc_kernel.m_axi_gmem0_0:DDR[0]` — 所有端口映射到同一 DDR 通道
- U50: `sp=wcc_kernel.m_axi_gmem0_0:HBM[0:1]` — 端口跨两个 HBM pseudo bank

**隐患**:
- U50 配置使用 `HBM[a:b]` 语法表示一个逻辑端口跨多个物理 bank，这增加了地址路由复杂性
- 如果 kernel 代码中的访问模式不是 bank-interleaved，可能无法充分利用 HBM 带宽

### 6.3 HLS 测试模式与硬件模式的差异

**条件编译**:
```cpp
#ifndef HLS_TEST
// 硬件模式：OpenCL/XRT 调用
#else
// HLS 仿真模式：直接调用 kernel 函数
wcc_kernel(numEdges, numVertices, (ap_uint<512>*)column32, ...);
#endif
```

**陷阱**:
- HLS 测试模式使用 `ap_uint<512>*` 强制转换，而硬件模式使用 `ap_uint<32>*`
- 如果在 HLS 仿真中误用 32-bit 指针，会导致数据宽度不匹配，仿真结果错误
- 两种模式下的内存分配策略不同（HLS 仿真使用标准分配，硬件需要页对齐）

### 6.4 事件依赖链的时序隐患

**当前实现**:
```cpp
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);
q.enqueueTask(wcc, &events_write, &events_kernel[0]);
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);
```

**陷阱**:
- `events_write` 是 `std::vector<cl::Event>`，但传递给 `enqueueTask` 时被解释为等待列表
- 如果 `events_write` 在 `enqueueTask` 调用前被销毁或修改，会导致未定义行为
- `enqueueMigrateMemObjects` 的 `0` 参数表示 Host→Device，但容易误写成 `CL_MIGRATE_MEM_OBJECT_HOST` 造成方向错误

### 6.5 Golden 结果格式陷阱

**解析代码**:
```cpp
while (goldenfstream.getline(line, sizeof(line))) {
    std::stringstream data(line);
    data >> tmp[0];  // 顶点 ID（1-indexed）
    data >> tmp[1];  // 分量标签
    tmpi[0] = std::stoi(tmp[0]);
    if (index > 0) {
        tmpi[1] = std::stoi(tmp[1]);
        gold_result[tmpi[0] - 1] = tmpi[1];  // 转换为 0-indexed
    }
}
```

**陷阱**:
- Golden 文件使用 **1-indexed** 顶点 ID，但内部数组是 **0-indexed**，转换错误会导致越界
- 第一行是元数据（连通分量数量），被特殊处理（`index > 0`），容易误解析
- 如果 golden 文件包含重复顶点 ID，后出现的会覆盖先出现的，导致静默错误

---

## 7. 依赖关系与跨模块交互

### 7.1 外部依赖

| 依赖 | 类型 | 用途 |
|------|------|------|
| `xcl2.hpp` | Xilinx 运行时库 | Alveo 设备发现、xclbin 加载 |
| `ap_int.h` | Vitis HLS 库 | 任意精度整数类型 (`ap_uint<32>`) |
| `wcc_kernel.hpp` | 本模块内核头 | Kernel 接口定义（未在提供的代码中展示） |
| `utils.hpp` | 本模块工具 | 辅助函数（如 `tvdiff`） |
| `xf_utils_sw/logger.hpp` | Xilinx 通用库 | 结构化日志和计时输出 |

### 7.2 父模块关系

本模块是 [l2_connectivity_and_labeling_benchmarks](graph_l2_connectivity_and_labeling_benchmarks.md) 的子模块，后者提供：
- 通用的图加载和预处理基础设施
- 跨基准测试的统计和报告格式
- 共享的 timing 测量工具（如本模块使用的 `timeval`）

### 7.3 子模块文档

本模块包含以下子模块，详细文档请参见：

| 子模块 | 文档链接 | 内容概述 |
|--------|----------|----------|
| `host_benchmark_application` | [host_benchmark_application.md](graph_analytics_and_partitioning-l2_connectivity_and_labeling_benchmarks-connected_component_benchmarks-host_benchmark_application.md) | 主机端 OpenCL/XRT 应用代码，包括设备初始化、内存管理、内核启动和结果验证的完整流程 |
| `platform_connectivity_configs` | [platform_connectivity_configs.md](graph-l2-benchmarks-connected_component-platform_connectivity_configs.md) | 面向 Alveo U200/U250 和 U50 的 FPGA 连接性配置文件，定义内核端口到物理内存资源的映射策略 |

### 7.4 与相邻模块的对比

| 模块 | 算法 | 收敛特性 | 典型用途 |
|------|------|----------|----------|
| **connected_component_benchmarks** (本模块) | WCC (Weakly Connected Components) | 快速收敛，边遍历为主 | 无向图/弱连通分析 |
| [label_propagation_benchmarks](graph_l2_benchmarks_label_propagation_benchmarks.md) | Label Propagation | 迭代收敛，社区结构 | 社区发现，重叠社区 |
| [strongly_connected_component_benchmarks](graph_l2_benchmarks_strongly_connected_component_benchmarks.md) | SCC (如 Tarjan/Kosaraju) | 多遍遍历，复杂控制流 | 有向图强连通分析 |

**设计洞察**: WCC 比 SCC 实现更简单（无需栈操作或两次遍历），比 Label Propagation 收敛更快（确定性更新而非概率传播），因此作为 L2 连通性基准测试的"入门级"算法。

---

## 8. 关键术语表

| 术语 | 解释 |
|------|------|
| **WCC (Weakly Connected Component)** | 弱连通分量，无向图中互相可达的顶点集合；在有向图中忽略方向后的连通分量 |
| **CSR (Compressed Sparse Row)** | 压缩稀疏行格式，用 `offset[]` 和 `column[]` 两个数组紧凑存储稀疏图邻接表 |
| **xclbin** | Xilinx 编译后的 FPGA 二进制文件，包含可加载到 Alveo 卡的比特流 |
| **HBM (High Bandwidth Memory)** | 高带宽内存，如 HBM2，提供比传统 DDR 更高的带宽（但通常容量较小） |
| **Bank** | 内存 bank，独立的内存访问通道；多 bank 架构允许并行访问不同数据 |
| **HLS (High-Level Synthesis)** | 高层次综合，将 C/C++ 代码编译为 RTL 硬件描述语言 |
| **OpenCL/XRT** | 主机与 FPGA 通信的运行时库，提供设备发现、内存管理、内核启动等功能 |
| **DATAFLOW** | HLS pragma，允许函数/循环以流水线方式并发执行，提高吞吐量 |
| **PIPELINE** | HLS pragma，在循环迭代间实现流水线，目标是 II (Initiation Interval) = 1 |

---

## 9. 总结：给新贡献者的建议

1. **从 HLS 仿真开始**: 定义 `HLS_TEST` 宏，使用纯软件仿真验证算法正确性，无需 FPGA 硬件
2. **理解 CSR 格式**: 这是图分析的通用语言，掌握 offset/column 的语义是理解数据流的基础
3. **关注内存对齐**: 所有 `aligned_alloc` 调用都是必需的，移除它们会导致难以调试的 DMA 错误
4. **学习 Bank 拓扑**: 不同的 Alveo 卡（U200 vs U50）有不同的内存架构，配置文件（`.cfg`）是关键差异点
5. **迭代式调试**: WCC 是收敛算法，如果结果错误，先检查第一轮迭代的输出，再检查多轮收敛逻辑

---

*文档生成时间: 基于模块 `connected_component_benchmarks` 的源代码分析*
*核心组件: `conn_u200_u250.cfg`, `conn_u50.cfg`, `main.cpp`*
