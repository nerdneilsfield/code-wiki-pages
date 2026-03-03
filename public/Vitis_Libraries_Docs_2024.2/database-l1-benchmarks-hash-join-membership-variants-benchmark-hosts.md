# Hash Join Membership Variants Benchmark Hosts

## 一句话概括

这是一个为 **Xilinx FPGA 加速卡** 设计的 **高性能 Hash Join 基准测试主机端** 实现，专门用于验证 **半连接（Semi-Join）** 和 **反连接（Anti-Join）** 两种集合成员关系查询的硬件加速方案。它通过 **OpenCL/XRT** 与 FPGA 内核通信，采用 **双缓冲（Double Buffering）** 和 **流水线执行** 技术实现 CPU 与 FPGA 的高效协同。

---

## 问题空间与设计动机

### 数据库连接操作的挑战

在数据分析领域，**连接（Join）** 是最消耗资源的操作之一。传统 CPU 实现面临以下瓶颈：

1. **内存带宽限制**：大表扫描时，CPU 缓存命中率低，频繁访问主存
2. **分支预测失败**：Hash 表探测时的条件分支难以预测
3. **指令级并行受限**：数据依赖性限制了 CPU 流水线效率

### 半连接与反连接的特殊性

与常规内连接（Inner Join）不同：

- **半连接（Semi-Join）**：只关心**是否存在**匹配（即集合成员关系），不需要返回右表数据，也不需要处理一对多匹配。典型场景如 TPC-H Q5："找到在特定日期范围内有订单的客户"。
  
- **反连接（Anti-Join）**：关心**是否不存在**匹配，即左表记录在右表中**没有**对应项。典型场景如："找到没有任何订单的客户"。

这两种操作可以简化为**集合成员资格测试（Membership Test）**，比完整 Join 更高效，因为：
1. 不需要构建完整的 Hash Map（只需 Bloom Filter 或简单 Hash Set）
2. 不需要处理匹配后的数据拼接
3. 可以尽早终止探测（Semi-Join 找到第一个匹配即可）

### 为什么选择 FPGA 加速？

- **细粒度流水线**：FPGA 可以实现深度流水线，每个周期处理一个元组
- **高内存带宽**：HBM（High Bandwidth Memory）提供 TB/s 级带宽
- **定制数据通路**：根据 Semi-Join/Anti-Join 的特定逻辑定制硬件，去除不必要的通用性开销
- **确定性延迟**：硬件实现避免了 CPU 的分支预测和缓存不确定性

---

## 心智模型：如何理解这个系统

### 类比：高效的工厂流水线

想象一个**自动化工厂**生产两种特殊零件（Semi-Join 和 Anti-Join 查询）：

- **原材料仓库（Host Memory）**：存放原始表数据（Lineitem 和 Orders 表）
- **装卸码头（PCIe + XRT）**：卡车通过高速公路（PCIe Gen3/Gen4）运送原材料到工厂，每次运送大批量的集装箱（Buffer）
- **工厂车间（FPGA Kernel）**：里面有 8 条并行生产线（PU_NM = 8 Processing Units），每条线都有：
  - **装配站（Hash Table Builder）**：用小零件（Orders 表）构建查找表
  - **检测站（Probe & Match）**：检查大零件（Lineitem 表）是否在查找表中
- **成品仓库（Result Buffer）**：存放最终的计算结果（聚合值）
- **调度中心（Host Controller）**：聪明的生产经理（Main Loop），使用**双班制（Double Buffering）**：
  - 当 A 班工人使用一批原材料时，B 班工人准备下一批
  - 这样工厂永不停工，实现**零空闲时间（Zero Idle Time）**

### 核心抽象层

| 抽象层 | 对应代码概念 | 职责 |
|--------|-------------|------|
| **查询层** | TPC-H Q5 (Semi-Join), Anti-Join Pattern | 定义业务逻辑：什么条件下算匹配 |
| **数据层** | `col_l_orderkey`, `col_o_orderkey` | 列式存储，内存对齐（`aligned_alloc`） |
| **控制层** | OpenCL/XRT API (`cl::Buffer`, `cl::Kernel`) | 管理设备上下文、内存映射、命令队列 |
| **调度层** | Main Loop with Events (`write_events`, `kernel_events`, `read_events`) | 实现流水线：Write → Kernel → Read |
| **验证层** | `get_golden_sum()`, `print_buf_result()` | CPU 参考实现，结果校验 |

---

## 关键设计决策与权衡

### 1. 双缓冲 vs 三缓冲

**选择**：使用**双缓冲（Ping-Pong）**

**权衡分析**：

| 方案 | 延迟隐藏 | 内存占用 | 复杂度 | 适用场景 |
|------|---------|---------|--------|---------|
| **双缓冲** | 良好 | 2x 输入数据 | 低 | 传输时间 < 计算时间 |
| **三缓冲** | 更好 | 3x 输入数据 | 中 | 传输与计算波动大 |
| **单缓冲** | 无 | 1x 输入数据 | 最低 | 纯同步执行 |

**为何选择双缓冲**：
- 在 PCIe Gen3 x16 上，传输 100MB 数据约需 2-3ms
- FPGA 内核处理相同数据量约需 5-10ms
- 传输时间 < 计算时间，双缓冲足以完全隐藏传输延迟
- 三缓冲增加的 50% 内存占用（从 2x 到 3x）带来的收益边际递减

### 2. HBM 内存分配策略

**选择**：使用 **8 个 HBM Bank 分别绑定到 8 个处理单元（PU）**

**权衡分析**：

| 策略 | 带宽利用率 | 冲突概率 | 扩展性 | 复杂度 |
|------|-----------|---------|--------|--------|
| **独占 Bank** | 理论峰值 | 零冲突 | 受限于 HBM bank 数 | 低 |
| **共享 Bank** | 竞争下降 | 随 PU 数增加 | 可超配 | 中（需仲裁） |
| **DDR 回退** | 更低 | N/A | 无限 | 低 |

**为何选择独占策略**：
- 该设计面向 **U50/U280 等 HBM 器件**，提供 8-32 个 HBM bank
- Hash Join 是**内存带宽密集型**操作，HBM 提供 460GB/s 以上带宽
- 多个 PU 共享一个 HBM bank 会导致**行缓冲区冲突（Row Buffer Conflict）**，严重降低有效带宽
- 该设计假设每个 PU 的数据已经通过**哈希分区（Hash Partitioning）**预处理，每个 PU 只访问自己的分区

### 3. 同步 vs 异步验证

**选择**：使用 **OpenCL 事件回调进行异步结果验证**

**权衡分析**：

| 方案 | 主机 CPU 占用 | 延迟敏感性 | 调试便利性 | 适用场景 |
|------|-------------|-----------|-----------|---------|
| **异步回调** | 低（事件驱动） | 无阻塞 | 中（需追踪回调） | 生产基准测试 |
| **同步等待** | 高（轮询/阻塞） | 阻塞 | 高（顺序执行） | 调试/开发 |
| **后台线程** | 中（线程调度） | 低 | 中 | 复杂验证逻辑 |

**为何选择异步回调**：
- 基准测试需要**最大化吞吐量**，任何主机端阻塞都会降低有效带宽
- OpenCL 事件回调由 **XRT 运行时**驱动，不占用主机 CPU 轮询
- 验证逻辑简单（数值比较），适合在回调上下文中快速执行
- 保留了**每个重复迭代的独立验证**，可以检测间歇性错误

**潜在风险与缓解**：
- **回调顺序**：OpenCL 不保证回调按事件提交顺序执行（仅保证事件完成顺序）。代码通过 `cbd_ptr[i]` 的索引访问避免了顺序依赖。
- **堆栈限制**：回调在 XRT 线程上下文中执行，堆栈有限。代码避免了大数组分配，仅使用指针解引用。
- **线程安全**：`ret` 计数器通过 `int*` 传递，回调中执行 `(*(d->r))++`。这是**非原子操作**，但模块假设**单命令队列（单线程 XRT 调度）**，因此无需原子操作。

---

## 子模块概览

本模块包含两个独立的基准测试子模块，分别验证两种集合成员关系操作：

### hash_semi_join

**职责**：实现 **TPC-H Query 5** 的 Semi-Join 变体，验证"存在性"查询的硬件加速。

**核心逻辑**：
- Semi-Join 逻辑：订单日期在 1994 年内的订单的 lineitem
- 使用 `unordered_map` 构建 CPU 端黄金参考
- FPGA 内核通过 `hashjoinkernel.hpp` 接口通信
- 支持 `orderdate` 范围过滤（1994 年数据）

### hash_anti_join

**职责**：实现 **Anti-Join** 变体，验证"不存在性"查询的硬件加速。

**核心逻辑**：
- Anti-Join 逻辑：没有对应订单的 lineitem
- 使用 `unordered_multimap` 支持重复键（Anti-Join 场景）
- 通过 `equal_range` 检查键是否存在
- FPGA 内核接口为 `join_kernel`，与 Semi-Join 不同
- 使用 HBM 内存分配（`XCL_BANK(n)`），支持 8 个 PU 并行

---

## 跨模块依赖

本模块在系统中依赖以下外部组件：

### 上游依赖（输入）

| 依赖项 | 关系 | 说明 |
|--------|------|------|
| `table_dt.hpp` | 编译依赖 | 定义 TPC-H 数据类型（`KEY_T`, `MONEY_T`, `DATE_T` 等） |
| `hashjoinkernel.hpp` / `join_kernel.hpp` | 编译依赖 | FPGA 内核接口定义，声明 `join_kernel` 函数签名 |
| `utils.hpp` | 编译依赖 | 工具函数（如 `tvdiff`, `generate_data`） |
| `xcl2.hpp` | 运行时依赖 | Xilinx XRT OpenCL 封装库，提供 `get_xil_devices`, `import_binary_file` 等 |
| `xf_utils_sw/logger.hpp` | 运行时依赖 | Xilinx 软件日志工具，统一测试通过/失败输出格式 |
| `kernel.xclbin` | 运行时依赖 | FPGA 比特流文件，由 Vitis 编译生成 |

### 下游依赖（输出）

| 依赖项 | 关系 | 说明 |
|--------|------|------|
| 系统测试框架 | 被依赖 | 本模块的测试结果被上层 CI/CD 系统收集，用于回归测试 |
| 性能基准报告 | 被依赖 | 生成的执行时间数据用于生成性能基准对比报告 |

---

## 新贡献者指南：陷阱与注意事项

### 1. HLS 测试模式 vs FPGA 执行模式

代码中大量使用了 `#ifdef HLS_TEST` 条件编译，这是为了支持两种运行模式：

```cpp
#ifdef HLS_TEST
    // 模式 A：纯 C++ 仿真，直接调用 kernel 函数
    join_kernel(...);
#else
    // 模式 B：真实 FPGA 执行，使用 OpenCL API
    q.enqueueTask(kernel0, ...);
#endif
```

**陷阱**：
- 在 HLS_TEST 模式下，`join_kernel` 是纯软件函数，不经过 PCIe，数据直接传递指针
- 在真实模式下，所有数据必须通过 `cl::Buffer` 和 `enqueueMigrateMemObjects` 传输
- **切勿**在 HLS_TEST 模式下调用 `xcl::get_xil_devices()`，这会导致链接错误

### 2. 双缓冲索引的奇偶逻辑

```cpp
int use_a = i & 1;  // i 为偶数时用 A，奇数时用 B
```

**陷阱**：
- 这个简单的位运算决定了整个流水线的正确性
- 如果错误地写成 `i % 2`，在负数情况下行为不同（虽然这里 i 是非负的）
- 更隐蔽的 bug：如果 `num_rep` 是奇数，最后一次迭代后，**下一次循环会使用已释放的缓冲区**（虽然没有下一次循环，但在扩展代码时要注意）

### 3. 事件依赖链的正确构建

```cpp
// 当前写入依赖前前次的读取完成（确保缓冲区空闲）
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
}
```

**陷阱**：
- `i - 2` 不是 `i - 1`！这是因为每个缓冲区（A 或 B）需要完整经历 Write → Kernel → Read 三个步骤后才能再次被写入。
- 如果错误地使用 `i - 1`，会导致**读写竞争（Read-After-Write Hazard）**，FPGA 还在读取缓冲区的同时 CPU 开始写入新数据，导致数据损坏。
- 可以通过添加 `clFinish()` 调试验证依赖是否正确，但这会严重降低性能。

### 4. 内存对齐与 DMA 要求

```cpp
// 正确：使用 aligned_alloc 分配页对齐内存
KEY_T* col_l_orderkey = aligned_alloc<KEY_T>(l_depth);

// 错误：使用标准 malloc（仅在 HLS_TEST 模式下工作）
// KEY_T* col_l_orderkey = (KEY_T*)malloc(sizeof(KEY_T) * l_depth);
```

**陷阱**：
- **零拷贝 DMA** 要求主机内存必须是**页对齐**的（通常 4KB 对齐）。`aligned_alloc` 保证这一点，而 `malloc` 不保证。
- 如果使用未对齐的内存，XRT 驱动会自动分配一个内部对齐的缓冲区，然后**在每次传输时执行额外的内存拷贝**。这会显著降低 PCIe 有效带宽（从 ~12GB/s 降至 ~3GB/s）。
- 仅在 `HLS_TEST` 模式下，因为没有真实的 DMA 传输，可以使用 `malloc`。

### 5. 命令队列配置的性能影响

```cpp
// 高性能配置：启用乱序执行和分析（生产环境）
cl::CommandQueue q(context, device,
    CL_QUEUE_PROFILING_ENABLE | CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE, &err);

// 调试配置：顺序执行，便于追踪问题（开发环境）
// cl::CommandQueue q(context, device, 0, &err);
```

**陷阱**：
- `CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE` 允许 OpenCL 运行时**乱序执行**不依赖的命令。这是实现流水线重叠（传输与计算重叠）的关键。
- 如果**未启用**此标志，所有命令将**顺序执行**，即使它们之间没有显式依赖关系。这将导致流水线无法重叠，性能下降 2-3 倍。
- `CL_QUEUE_PROFILING_ENABLE` 启用性能分析（`clGetEventProfilingInfo`），用于测量内核执行时间。这在生产环境中可以禁用，以减少轻微的开销。

---

## 总结

`hash_join_membership_variants_benchmark_hosts` 模块是一个**生产级 FPGA 基准测试框架**，展示了如何高效地将 CPU 主机端与 FPGA 加速器协同工作。其核心设计思想包括：

1. **流水线化（Pipelining）**：通过双缓冲和事件驱动调度，实现 CPU-FPGA 零空闲协作
2. **内存优化（Memory Optimization）**：使用 HBM 独占 bank 策略和零拷贝 DMA，最大化内存带宽利用率
3. **可验证性（Verifiability）**：每个 FPGA 结果都与 CPU 黄金参考进行比对，确保硬件正确性
4. **可扩展性（Scalability）**：通过 PU 并行和 HBM bank 分区，支持从 U50 到 U280 的不同规模器件

对于新加入团队的工程师，建议从理解**事件依赖链**和**双缓冲机制**入手，这是整个系统性能的核心所在。同时，务必区分 **HLS_TEST** 和真实 FPGA 模式下的代码路径，避免在仿真模式下调用真实 XRT API 导致链接错误。

