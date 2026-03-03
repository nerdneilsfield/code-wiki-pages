# Host 基准测试与定时支持子模块

**路径**: `security/L1/benchmarks/hmac_sha1/host/main.cpp`

**核心组件**:
- `timeval` 结构体（用于高精度计时）
- `ArgParser` 类（命令行参数解析）
- `main()` 函数（完整的 OpenCL 主机端流程控制）

---

## 一句话概括

这是 HMAC-SHA1 基准测试的"大脑"，负责管理 Alveo FPGA 卡的 OpenCL 上下文、 orchestrating 四级并行内核的执行、实现乒乓双缓冲以重叠 PCIe 传输与 FPGA 计算，并提供微秒级精度的性能测量与 OpenSSL 黄金参考验证。

---

## 设计哲学：主机端作为"乐团指挥"

在 FPGA 加速系统中，主机端不是简单的"数据搬运工"，而是**全局调度器**。本模块的设计体现了"指挥家"哲学：

### 1. 状态机驱动的执行模型

虽然代码中没有显式的 `switch(state)`，但 `num_rep` 循环中的事件依赖链隐式实现了一个状态机：
- **预热态**（Warmup）：第一批次仅启动写入和内核，无读取依赖
- **稳态**（Steady State）：读-写-执行完全流水线化
- **排空态**（Drain）：最后一批次确保所有结果读回

### 2. 延迟隐藏而非延迟降低

本模块的核心算法不是"让 FPGA 算得更快"，而是"**让 PCIe 传输与 FPGA 计算并行发生**"。通过乒乓缓冲，使得有效吞吐量趋近于 `min(PCIe_bw, FPGA_compute_bw)`，而非 `1 / (1/PCIe_bw + 1/FPGA_compute_bw)`。

### 3. 可重复性与统计置信度

`num_rep` 参数的存在不是为了"多次取平均降低噪声"（虽然也有此效果），而是为了确保**流水线预热完成后的稳态测量**。前几次迭代用于填满 FPGA 流水线，只有后续迭代才是"真实"性能的反映。

---

## 关键组件详解

### 1. ArgParser — 最小 viable 命令行解析

```cpp
class ArgParser {
    std::vector<std::string> mTokens;
public:
    ArgParser(int& argc, const char** argv);
    bool getCmdOption(const std::string option, std::string& value) const;
};
```

**设计意图**: 不引入 `boost::program_options` 或 `getopt_long` 等外部依赖，保持代码在嵌入式/受限环境中的可移植性。使用简单的线性搜索（`std::find`），时间复杂度 O(n)，但对于少量参数（<20）完全可接受。

**隐式契约**: 所有路径参数（`-xclbin`, `-gld`）必须指向有效文件系统位置，无自动路径搜索逻辑。

### 2. 内存分配与对齐 — 零拷贝 DMA 的前提

```cpp
template <typename T>
T* aligned_alloc(std::size_t num) {
    void* ptr = nullptr;
    if (posix_memalign(&ptr, 4096, num * sizeof(T))) throw std::bad_alloc();
    return reinterpret_cast<T*>(ptr);
}
```

**为什么 4096？** 这是 x86_64 架构的标准页大小。Xilinx XRT（Xilinx Runtime）在进行 DMA 传输前，会检查主机缓冲区是否页对齐。如果不对齐，XRT 会分配一个内部页对齐缓冲区，执行额外的 `memcpy`，这将**完全摧毁**乒乓缓冲带来的零拷贝优势。

**内存所有权链**：
1. 主机调用 `aligned_alloc` → 获得页对齐主机内存（ownership: Host）
2. 创建 `cl::Buffer` 传入 `CL_MEM_USE_HOST_PTR` → OpenCL 上下文注册该内存（ownership: Shared）
3. `enqueueMigrateMemObjects` → XRT 锁定页面，建立 DMA 映射（ownership: XRT/FPGA DMA controller）
4. 内核执行完成 → `CL_MIGRATE_MEM_OBJECT_HOST` 释放 DMA 映射（ownership 返回 Host）

### 3. 事件依赖链 — 正确性 vs 性能的走钢丝

```cpp
// Write[i] depends on Read[i-2] (not i-1!)
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
}

// Kernel[i] depends on Write[i]
q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);

// Read[i] depends on all 4 kernels in iteration i
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, &kernel_events[i], &read_events[i][0]);
```

**为什么是 `read_events[i-2]` 而不是 `i-1`？** 这是为了确保**缓冲区生命周期安全**。考虑以下时序：

```
时间 →
迭代 i-1:  [Write i-1][Kernel i-1][Read i-1]
迭代 i:              [Write i][Kernel i][Read i]
```

如果 Write[i] 等待 Read[i-1]，由于内核是 out-of-order 执行，Write[i] 可能在 Kernel[i-1] 完成前就启动，覆盖仍在被 FPGA 读取的缓冲区（DMA 尚未完成）。使用 `Read[i-2]` 确保至少有两个缓冲区的间隔，保证 Ping-Pong 不会冲突。

**性能影响**: 这种保守的依赖链增加了启动延迟（前两次迭代无法完全流水线），但保证了正确性。对于 `num_rep >> 2` 的情况，启动开销可忽略。

### 4. 计时与验证 — 统计严谨性

```cpp
struct timeval start_time, end_time;
gettimeofday(&start_time, 0);
// ... 所有 kernel 执行 ...
q.finish();  // 阻塞直到全部完成
gettimeofday(&end_time, 0);
std::cout << "Total execution time " << tvdiff(&start_time, &end_time) << "us" << std::endl;
```

**为什么选择 `gettimeofday` 而不是 `std::chrono`？** 这是为了与 Xilinx 的 `xf_utils_sw::Logger` 工具链保持一致，同时 `gettimeofday` 在 Linux 上提供微秒级精度（实际精度取决于内核 HZ 设置，通常为 1ms-10ms，但对于秒级测量足够）。

**验证策略**: 使用 OpenSSL 生成的黄金参考（Golden Reference）进行逐位比较。注意这是**离线验证**——先跑完所有批次，然后一次性验证。这种方式适合基准测试，但不适合生产环境的实时错误检测。

```cpp
// 160-bit HMAC 结果比较
if (hb_out_a[i][j * CH_NM + k] != golden) {
    checked = false;
    // ... 详细错误输出 ...
}
```

---

## 性能调优指南

### 识别瓶颈：从 PCIe 到 FPGA

使用以下诊断流程识别性能瓶颈：

1. **PCIe 带宽检查**: 计算理论峰值（Gen3 x16 约 16 GB/s 双向）。如果测量吞吐接近此值，瓶颈在 PCIe，需优化数据打包（减少填充）或迁移到 Gen4。

2. **DDR 带宽检查**: 四个 DDR bank 理论提供约 80 GB/s（取决于具体 Alveo 卡）。如果测量值远低于此，检查 `BURST_LEN` 设置——过短的突发无法有效利用 DDR 行缓冲。

3. **FPGA 计算瓶颈**: 如果 PCIe 和 DDR 都未饱和，可能是 HMAC 内核本身成为瓶颈。检查 HLS 综合报告中的 `II`（Initiation Interval），理想情况应为 1（每周期一个 32-bit 字）。

### 参数空间探索

建议的调优实验：

| 实验 | 变量 | 观察指标 | 预期趋势 |
|------|------|----------|----------|
| 消息大小扫描 | `N_MSG`: 64B → 4KB | 总吞吐 (Gbps) | 小消息受 PCIe 延迟限制，大消息趋近 FPGA 峰值 |
| 批次深度扫描 | `N_TASK`: 1 → 100 | 有效吞吐 | 过小导致启动开销占比大，过大增加延迟 |
| 突发长度扫描 | `BURST_LEN`: 1 → 64 | DDR 带宽利用率 | 越长越好，但受 FIFO 深度限制 |

---

## 常见错误与调试策略

### 错误 1: `CL_OUT_OF_RESOURCES`

**症状**: `enqueueMigrateMemObjects` 或 `enqueueTask` 返回 -5。

**根因**: 
- 可能是四个内核同时启动导致 DDR 内存配额不足（XRT 内存限制）
- 或 `aligned_alloc` 分配的内存超过了巨页（hugepage）配置

**修复**: 
- 检查 `xbutil query` 输出中的 DDR 使用率
- 确保系统配置了足够的巨页：`sysctl vm.nr_hugepages = 4096`

### 错误 2: 验证失败但位差异小

**症状**: `hb_out_a[i][j] != golden`，但十六进制差异仅在低位。

**根因**: 
- 消息填充（padding）逻辑错误，导致 HMAC 处理了额外的填充字节
- 或 `textLength` 字段配置错误，内核读取了超出实际数据长度的内存（读取了未初始化的脏数据）

**调试**: 
- 在 `readIn` 函数中添加 `__print` HLS 指令（仅限仿真）查看实际读取的字节
- 使用 `hexdump` 检查 `-gld` 文件与主机生成的消息数据是否一致

### 错误 3: 性能显著低于预期（< 1 Gbps）

**症状**: 即使消息很大，吞吐也远低于 PCIe 带宽。

**根因**: 
- 使用了 `CL_MEM_ALLOC_HOST_PTR` 而非 `CL_MEM_USE_HOST_PTR`，触发了 XRT 的隐式拷贝
- 或对齐分配失败（`posix_memalign` 返回非零），代码中未检查返回值，导致回退到普通内存
- 或 `num_rep = 2` 太小，启动开销主导了总时间

**调试**: 
- 设置 `XCL_EMULATION_MODE=hw_emu` 并检查 XRT 日志中的内存迁移时间
- 使用 `strace` 跟踪 `posix_memalign` 系统调用

---

## 延伸阅读与参考资料

1. **Xilinx Vitis 安全库文档**: `https://xilinx.github.io/Vitis_Libraries/security/` - 详细了解 `xf::security::hmac` 和 `xf::security::sha1` 的模板参数

2. **Alveo 数据中心加速卡架构**: UG1301 - 理解 DDR 控制器分区与 PCIe 拓扑

3. **HLS 数据流优化指南**: UG1399 - 学习 `dataflow`、`stream` 和 `pipeline` 指令的细微差别

4. **XRT 内存管理**: `https://xilinx.github.io/XRT/master-doc/html/xrt.main.html` - 理解 `CL_MEM_USE_HOST_PTR` 与巨页配置
