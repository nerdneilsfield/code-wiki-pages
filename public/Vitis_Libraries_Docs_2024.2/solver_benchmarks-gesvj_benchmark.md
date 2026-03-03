# gesvj_benchmark 模块深度解析

## 一句话概括

这是一个用于在 Xilinx FPGA 上加速执行 Gesvj（广义奇异值分解，Jacobi 方法）算法的基准测试框架。它不只是简单地"运行一个内核"，而是构建了一个完整的**主机-设备协同工作流**——从矩阵数据生成、内存对齐分配、零拷贝数据传输、到内核流水线执行，再到结果验证和误差分析。

---

## 架构全景：数据流动的旅程

想象一下这个系统就像一条**精密的生产线**：原料（随机矩阵）从一端进入，经过 FPGA 这个"重型机械"加工后，产出三个成品（U、Σ、V），最后在质检环节（数值验证）确认产品合格。

```mermaid
flowchart LR
    A[命令行参数] --> B[矩阵生成器 matGen]
    B --> C[主机对齐内存 aligned_alloc]
    C --> D[OpenCL Buffer 创建]
    D --> E[数据迁移 H2D]
    E --> F[kernel_gesvj_0 执行]
    F --> G[数据迁移 D2H]
    G --> H[数值验证 U*Σ*V^T]
    H --> I[误差报告]
```

### 核心角色分工

| 组件 | 职责 | 关键设计决策 |
|------|------|--------------|
| `ArgParser` | 命令行解析 | 极简实现，只支持 `-key value` 格式，无异常处理 |
| `aligned_alloc` | 内存对齐分配 | 强制 4096 字节对齐，满足 FPGA DMA 要求 |
| `xcl2` / OpenCL API | 设备管理 | 使用 Xilinx 封装库简化板卡发现和二进制加载 |
| `matGen` | 测试数据生成 | 外部工具函数，基于种子生成确定性随机矩阵 |
| `kernel_gesvj_0` | SVD 计算 | 硬件内核，一次调用完成完整分解 |

---

## 核心抽象：理解"对齐"与"零拷贝"

### 内存对齐：为什么必须是 4096？

这是一个常见的陷阱：普通 `malloc` 分配的内存地址可能是任意的，但 FPGA 的 DMA 引擎通常要求**页对齐**（4KB 边界）才能进行直接内存访问。`aligned_alloc` 的实现简单粗暴但有效：

```cpp
template <typename T>
T* aligned_alloc(std::size_t num) {
    void* ptr = nullptr;
    // posix_memalign: 分配 num * sizeof(T) 字节，4096 字节对齐
    if (posix_memalign(&ptr, 4096, num * sizeof(T))) {
        throw std::bad_alloc();  // 对齐分配失败时抛出异常
    }
    return reinterpret_cast<T*>(ptr);
}
```

**关键洞察**：这里的 `4096` 不是随意的，而是与 x86 页大小和 FPGA DMA 控制器的设计相匹配。如果改为 512 或 2048，可能在某些平台上工作，但在其他平台上会失败。

### 零拷贝数据传输：从"复制"到"映射"

传统的高性能计算流程是：
1. 主机分配内存
2. 将数据复制到 PCI-e 设备内存
3. 设备计算
4. 将结果复制回主机

但这个模块采用了**零拷贝（Zero-Copy）** 策略：

```cpp
// 创建 OpenCL Buffer 时，直接关联已分配的主机内存
input_buffer[0] = cl::Buffer(context, 
    CL_MEM_EXT_PTR_XILINX |   // 使用 Xilinx 扩展
    CL_MEM_USE_HOST_PTR |     // 使用主机指针，不分配新设备内存
    CL_MEM_READ_ONLY,          // 只读访问
    sizeof(double) * in_size, 
    &mext_i[0]                 // 指向 cl_mem_ext_ptr_t 的扩展信息
);
```

**设计权衡**：零拷贝减少了内存复制开销，但要求主机内存必须常驻且对齐。如果主机内存被交换到磁盘，DMA 会失败。这是一个典型的**性能 vs 可靠性**权衡——适合确定性 HPC 工作负载，不适合通用多任务环境。

---

## 数据流详解：一次基准测试的完整生命周期

### 阶段 1：参数解析与环境初始化

```cpp
// 默认参数设置，确保即使不输入任何参数也能运行
if (!parser.getCmdOption("-runs", num_str)) {
    num_runs = 1;  // 默认只运行一次
}
if (!parser.getCmdOption("-M", num_str)) {
    dataAM = 4;    // 默认 4x3 矩阵
}
if (!parser.getCmdOption("-N", num_str)) {
    dataAN = 3;
}
if (!parser.getCmdOption("-seed", num_str)) {
    seed = 12;     // 固定种子确保可重复
}
```

**隐含契约**：参数 `-xclbin` 是强制的（虽然代码中检查后会打印 INFO，但后续使用会导致崩溃）。矩阵维度必须满足 `dataAM >= dataAN`（虽然注释中提到对称矩阵的等号限制，但 Gesvj 通常要求行数不小于列数）。

### 阶段 2：OpenCL 上下文与设备管理

```cpp
// 获取 Xilinx 设备列表
std::vector<cl::Device> devices = xcl::get_xil_devices();
cl::Device device = devices[0];  // 选择第一个设备

// 创建上下文和命令队列
cl::Context context(device, NULL, NULL, NULL, &err);
cl::CommandQueue q(context, device, 
    CL_QUEUE_PROFILING_ENABLE |           // 启用性能分析
    CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE, // 允许乱序执行
    &err);
```

**关键配置**：`OUT_OF_ORDER_EXEC_MODE` 允许 OpenCL 运行时更灵活地调度命令，但对于这个单内核基准测试，实际影响有限。`PROFILING_ENABLE` 是后续计时功能的前提。

### 阶段 3：内存分配与缓冲区设置

```cpp
// 计算各缓冲区大小
int out_size_U = dataAM * dataAM;    // U 是 MxM 矩阵
int out_size_V = dataAN * dataAN;    // V 是 NxN 矩阵
int out_size_sigma = dataAN;         // 奇异值向量长度为 N
int in_size = dataAM * dataAN;       // 输入矩阵大小

// 对齐分配主机内存
dataA_svd = aligned_alloc<double>(in_size);
sigma_svd = aligned_alloc<double>(out_size_sigma);
dataU_svd = aligned_alloc<double>(out_size_U);
dataV_svd = aligned_alloc<double>(out_size_V);
```

**内存布局注意事项**：SVD 的输出 U 是 M×M 方阵，V 是 N×N 方阵，Σ 是长度为 N 的向量。这与某些"精简 SVD"实现不同，后者可能输出 M×N 的 U 和 N×N 的 V。代码明确分配了完整的方阵空间，表明硬件内核实现的是完全 SVD。

### 阶段 4：内核执行与计时

```cpp
// 使用 gettimeofday 进行高精度计时
struct timeval tstart, tend;
gettimeofday(&tstart, 0);

// 提交多个内核实例
for (int i = 0; i < num_runs; ++i) {
    q.enqueueTask(kernel_gesvj_0, nullptr, nullptr);
}
q.finish();  // 等待所有任务完成
gettimeofday(&tend, 0);

// 计算执行时间
int exec_time = diff(&tend, &tstart);
std::cout << "INFO: FPGA execution time of " << num_runs << " runs:" 
          << exec_time << " us\n";
```

**计时策略**：使用 `gettimeofday` 而非 OpenCL 事件分析（`clGetEventProfilingInfo`），这意味着测量的是**端到端 wall-clock 时间**（包括驱动开销和 PCIe 延迟），而非纯内核执行时间。这对于系统级基准测试更合适，但对于内核微架构调优会包含噪声。

### 阶段 5：结果验证与误差分析

```cpp
// 重构 A_out = U * Sigma * V^T
transposeMat<double>(dataAN, dataV_svd, dataVT_svd);
MulMat(dataAM, dataAM, dataAN, dataAN, dataU_svd, dataS_svd, dataVT_svd, dataA_out);

// 计算 Frobenius 范数误差
// errA = ||A_original - A_reconstructed||_F
double errA = 0;
for (int i = 0; i < dataAM; i++) {
    for (int j = 0; j < dataAN; j++) {
        errA += (dataA_svd[i * dataAN + j] - dataA_out[i * dataAN + j]) *
                (dataA_svd[i * dataAN + j] - dataA_out[i * dataAN + j]);
    }
}
errA = std::sqrt(errA);

// 阈值判定
if (errA > 0.0001) {
    logger.error(xf::common::utils_sw::Logger::Message::TEST_FAIL);
    return -1;
} else {
    logger.info(xf::common::utils_sw::Logger::Message::TEST_PASS);
    return 0;
}
```

**验证逻辑**：代码通过重构原始矩阵来验证 SVD 的正确性。数学上，如果 $A = U \Sigma V^T$ 成立，那么重构 $A_{out} = U \Sigma V^T$ 应该与原始 $A$ 相等。代码计算的是**Frobenius 范数**（矩阵元素的平方和开根号）作为误差度量。

**阈值解释**：`0.0001` 是一个经验阈值，考虑了双精度浮点数的舍入误差和 Jacobi 方法的迭代收敛精度。对于病态矩阵（条件数很大），这个阈值可能不够严格；对于良态矩阵，应该远小于此值。

---

## 依赖关系与模块交互

### 上游依赖（谁调用它）

此模块是**叶子节点**（在提供的树结构中无子节点），通常由 CI/CD 系统或开发者手动调用：

- **直接调用者**：`make` 或 `cmake` 构建系统，生成可执行文件 `test_gesvj.exe`
- **输入依赖**：
  - `kernel_gesvj_0.xclbin`：Gesvj 算法的 FPGA 比特流文件
  - 命令行参数：`-xclbin`, `-runs`, `-M`, `-N`, `-seed`

### 下游依赖（它调用谁）

| 模块/库 | 作用 | 关键调用点 |
|---------|------|-----------|
| `xcl2.hpp` | Xilinx OpenCL 封装 | `xcl::get_xil_devices()`, `xcl::import_binary_file()` |
| `xf_utils_sw/logger` | 标准化日志 | `logger.logCreateContext()`, `logger.error()` |
| `matrixUtility.hpp` | 矩阵工具 | `matGen()`, `transposeMat()`, `MulMat()` |
| OpenCL ICD | 底层 GPU/FPGA 通信 | `cl::Context`, `cl::CommandQueue`, `cl::Buffer` |
| POSIX (`sys/time.h`) | 高精度计时 | `gettimeofday()` |

### 数据契约

**输入矩阵 `dataA_svd`**：
- 布局：行优先（Row-major）的一维数组，大小为 `dataAM * dataAN`
- 类型：`double`（双精度浮点）
- 生成：由 `matGen` 基于种子确定性生成，确保可复现性

**输出缓冲区**：
- `sigma_svd`：长度为 `dataAN` 的数组，存储降序排列的奇异值
- `dataU_svd`：大小为 `dataAM * dataAM`，左奇异向量矩阵（列正交）
- `dataV_svd`：大小为 `dataAN * dataAN`，右奇异向量矩阵（列正交）

**内存对齐契约**：
- 所有主机内存必须通过 `aligned_alloc` 分配（4096 字节对齐）
- 使用 `CL_MEM_USE_HOST_PTR` 标志，要求 OpenCL 实现直接使用主机内存地址，而非分配设备副本

---

## 关键设计决策与权衡

### 1. 计时策略：`gettimeofday` vs OpenCL Profiling

**选择的方案**：使用 `gettimeofday` 测量 wall-clock 时间。

**权衡分析**：
- **优点**：测量的是端到端延迟，包括 PCIe 传输、驱动开销、调度延迟，反映真实用户体验。
- **缺点**：包含操作系统调度的抖动，不适合微架构级性能分析（如单个内核指令延迟）。
- **替代方案**：OpenCL 事件分析（`CL_QUEUE_PROFILING_ENABLE` + `clGetEventProfilingInfo`）可以提供纯内核执行时间，排除了 PCIe 和调度开销。

**适用性**：对于系统级基准测试和算法比较，端到端时间更有意义；对于内核优化，需要补充使用 OpenCL 分析工具。

### 2. 内存策略：零拷贝 vs 显式复制

**选择的方案**：使用 `CL_MEM_USE_HOST_PTR` 实现零拷贝传输。

**权衡分析**：
- **性能优势**：避免了主机内存到设备内存的显式 `memcpy`，数据通过 DMA 直接访问，减少内存带宽压力。
- **约束条件**：
  - 主机内存必须页对齐（4096 字节），否则 OpenCL 实现可能被迫创建临时副本（导致性能下降且难以调试）。
  - 主机内存必须常驻（不能被交换到磁盘），否则 DMA 会触发页错误。
  - 内存所有权生命周期复杂：OpenCL Buffer 持有指针引用，必须在 Buffer 释放后才能释放主机内存。
- **替代方案**：使用 `CL_MEM_ALLOC_HOST_PTR`（由 OpenCL 分配页对齐内存）或显式 `enqueueWriteBuffer`/`enqueueReadBuffer`（允许任意对齐的主机内存）。

**设计意图**：这是一个 HPC 基准测试，假设独占访问硬件，因此可以接受零拷贝的约束以换取最大带宽。

### 3. 验证策略：重构验证 vs 参考实现比较

**选择的方案**：通过重构 $A = U\Sigma V^T$ 并比较 Frobenius 范数误差来验证正确性。

**权衡分析**：
- **优点**：
  - 不需要外部依赖（如 Intel MKL 或 MATLAB）作为参考实现。
  - 验证的是 SVD 的数学性质本身（正交性和重构性），而非与特定实现的比特级一致性。
- **局限**：
  - 只能检测数值错误，无法检测算法逻辑错误（如 Jacobi 旋转角度计算错误但结果仍满足重构性，这种情况极不可能但理论存在）。
  - 对于病态矩阵（条件数极大），重构误差可能主要反映数值舍入而非算法错误，阈值 `0.0001` 是启发式的。
- **替代方案**：与 CPU 参考实现（如 Eigen、MKL）的结果进行逐元素比较，或使用结构化测试矩阵（如已知 SVD 的单位矩阵、对角矩阵）。

**工程权衡**：基准测试需要在自动化 CI 中快速运行，避免外部依赖，因此自包含的验证是合理选择。

### 4. 错误处理：日志记录 vs 异常传播

**选择的方案**：使用 `xf::common::utils_sw::Logger` 记录成功/失败状态，通过返回码（0 或 -1）指示测试结果。

**权衡分析**：
- **现状**：OpenCL 错误通过 `err` 变量捕获并传递给 `logger.logCreateContext` 等，但如果发生错误，程序继续执行直到崩溃或产生未定义行为（如 `devices[0]` 在设备列表为空时访问越界）。
- **一致性**：混合使用了异常（`std::bad_alloc` 在 `aligned_alloc` 失败时抛出）和错误码（OpenCL C API 风格）。
- **适用性**：对于基准测试，快速失败（fail-fast）是可接受的，但缺乏健壮的异常处理意味着配置错误（如无效 xclbin 路径）会产生难以调试的崩溃。

**改进空间**：对于生产级代码，应在每个 OpenCL 调用后检查 `err`，并在失败时清理已分配资源（OpenCL 对象和主机内存）。

---

## 组件深度解析

### `timeval` 与计时精度

虽然代码中使用了 `struct timeval`，但它来自 `<sys/time.h>` 标准头文件，而非自定义定义。这是 POSIX 标准的高精度时间戳结构：

```cpp
struct timeval {
    time_t      tv_sec;     // 秒
    suseconds_t tv_usec;    // 微秒
};
```

**精度限制**：`gettimeofday` 的精度依赖于操作系统调度器，通常在微秒级（1-10μs），但对于 FPGA 内核执行（通常毫秒级）足够准确。对于纳秒级精度，应使用 `std::chrono::high_resolution_clock` 或 OpenCL 事件分析。

### `aligned_alloc<T>`：模板化的页对齐分配器

这是一个简单但关键的模板函数，确保 OpenCL 零拷贝所需的内存对齐：

**内存所有权模型**：
- **分配者**：`posix_memalign`（底层系统调用）
- **所有者**：调用者（`main` 函数中的指针变量）
- **借用者**：`cl::Buffer` 对象在存在期间借用指针（通过 `CL_MEM_USE_HOST_PTR`）
- **释放责任**：调用者必须使用 `free()`（而非 `delete`）释放，因为 `posix_memalign` 分配的内存需要 `free` 释放。

**风险点**：代码中使用 `aligned_alloc` 分配内存，但没有对应的 `free` 调用（在代码片段中可见），存在内存泄漏。对于短期运行的基准测试可接受，但生产代码需要修复。

### `ArgParser`：极简命令行解析

这是一个轻量级解析器，只支持 `-key value` 格式：

**设计特点**：
- **无异常**：找不到选项时返回 `false`，不抛出异常
- **无类型转换**：所有值作为 `std::string` 返回，调用者负责 `stoi` 转换
- **线性搜索**：使用 `std::find` 在 `mTokens` 中查找，时间复杂度 O(n)，对于少量参数可接受

**使用契约**：调用者必须在 `getCmdOption` 返回 `true` 后才使用 `value` 参数，否则 `value` 保持未定义状态。

### `main` 函数：编排者角色

`main` 函数是这个模块的"总指挥"，它遵循了**资源获取即初始化（RAII）** 的模式，尽管没有使用智能指针，但严格按照声明顺序初始化资源，并在发生错误时依赖进程终止来释放资源（对于基准测试可接受）。

**关键执行阶段**：

1. **参数解析与验证**：设置默认值（4x3 矩阵，1 次运行，种子 12），允许通过命令行覆盖。

2. **OpenCL 环境搭建**：创建上下文、命令队列，加载 xclbin 比特流，实例化内核对象。这是**一次性开销**，不计入内核执行时间。

3. **数据准备**：生成随机矩阵，设置扩展内存指针（`cl_mem_ext_ptr_t`），创建 OpenCL Buffer。这里的关键是 `mext_i[0] = {2, dataA_svd, kernel_gesvj_0()}` 这样的语法，它使用 Xilinx 扩展将主机指针与内核参数索引关联。

4. **数据传输（H2D）**：`enqueueMigrateMemObjects` 将输入数据从主机内存迁移到设备内存。由于使用了零拷贝，这实际上是**映射**操作而非复制。

5. **内核执行**：循环提交 `num_runs` 次内核任务，使用 `finish()` 等待完成。这是**热点路径**，所有优化都指向这里。

6. **数据传输（D2H）**：将结果迁移回主机。

7. **数值验证**：重构矩阵并计算误差，决定返回 0（成功）或 -1（失败）。

---

## 依赖关系与数据契约

### 外部工具函数依赖

代码依赖 `matrixUtility.hpp` 中的三个函数，这些函数在提供的代码片段中未定义：

- `matGen<double>(int rows, int cols, int seed, double* data)`：生成随机矩阵
- `transposeMat<double>(int n, double* src, double* dst)`：矩阵转置
- `MulMat(int M, int K, int N, int L, double* A, double* B, double* C, double* D)`：矩阵乘法（C = A*B，D 可能是临时缓冲区或结果）

**隐含契约**：这些函数必须支持双精度浮点（`double`），并且 `MulMat` 的实现需要处理 $U$（MxM）、$\Sigma$（MxN 对角矩阵，存储为向量）、$V^T$（NxN）的维度匹配。

### Xilinx 特定扩展依赖

代码紧密绑定 Xilinx 的 OpenCL 扩展：

- `CL_MEM_EXT_PTR_XILINX`：启用 `cl_mem_ext_ptr_t` 扩展结构
- `xcl::get_xil_devices()`：发现 Xilinx 设备（Alveo 卡）
- `xcl::import_binary_file()`：加载 `.xclbin` 文件（包含 FPGA 比特流和内核元数据）

**可移植性限制**：此代码只能在安装了 Xilinx Runtime (XRT) 和 Alveo/Versal 硬件的环境中运行。标准 OpenCL 实现（如 Intel、NVIDIA）不支持这些扩展。

---

## 设计权衡与性能考量

### 批处理 vs 单任务提交

代码在 `num_runs > 1` 时采用**批量提交**策略：

```cpp
for (int i = 0; i < num_runs; ++i) {
    q.enqueueTask(kernel_gesvj_0, nullptr, nullptr);
}
q.finish();
```

**权衡分析**：
- **优势**：OpenCL 运行时可以将多个内核调用流水线化（如果内核执行时间长于 PCIe 往返时间），提高设备吞吐量。
- **劣势**：所有任务使用相同的输入数据（`dataA_svd` 在循环外设置），这意味着每次运行计算相同矩阵的 SVD。这对于测量**峰值性能**有效，但不能测试不同数据分布下的性能或数值稳定性。

**改进建议**：如果需要测试不同矩阵的性能，应在循环内调用 `matGen` 生成新数据，但要注意这会引入主机端计算开销，可能影响计时准确性。

### 双精度浮点的性能代价

代码明确使用 `double`（64 位浮点）：

```cpp
dataA_svd = aligned_alloc<double>(in_size);
```

**性能影响**：
- **内存带宽**：双精度占 8 字节，是单精度的两倍，意味着 PCIe 传输时间和设备内存占用都翻倍。
- **计算吞吐量**：FPGA 上双精度乘法通常比单精度慢 2-5 倍，取决于 DSP 片的使用方式。
- **数值精度**：SVD 是数值敏感操作，双精度对于病态矩阵（接近奇异的矩阵）是必要的，单精度可能在迭代过程中丢失正交性。

**设计决策**：这是一个**数值正确性优先于峰值性能**的选择，适合科学计算和工程应用，而非深度学习推理。

---

## 陷阱、边界情况与运维考量

### 常见陷阱

**1. xclbin 路径错误导致段错误**

如果 `-xclbin` 参数未提供或路径错误，`xclBins` 将为空，但代码继续执行 `cl::Program program(context, devices, xclBins, NULL, &err)`，这可能导致未定义行为或后续崩溃。

**防范**：运行前验证 `xclbin_path` 文件存在性。

**2. 矩阵维度不匹配**

Gesvj 算法通常要求 $M \geq N$（行数不小于列数）。如果 `dataAM < dataAN`，内核可能产生未定义结果或挂起。

**防范**：在参数解析后添加断言：
```cpp
if (dataAM < dataAN) {
    std::cerr << "ERROR: Matrix rows M must be >= columns N\n";
    return -1;
}
```

**3. 内存泄漏**

`aligned_alloc` 分配的内存（`dataA_svd`, `sigma_svd` 等）在代码片段中未见对应的 `free()` 调用。虽然进程终止会回收内存，但在长期运行的服务或多次迭代测试中会导致内存耗尽。

**修正**：在 `main` 函数退出前添加：
```cpp
free(dataA_svd);
free(sigma_svd);
free(dataU_svd);
free(dataV_svd);
```

### 数值稳定性边界

**病态矩阵**：如果输入矩阵的条件数很大（接近奇异），Jacobi 方法的收敛速度会变慢，且累积舍入误差可能超过 `0.0001` 的阈值，导致假阴性（测试失败但实现正确）。

**随机种子敏感性**：默认种子 `12` 生成的矩阵可能恰好是良态的。如果更改种子，可能生成病态矩阵导致测试失败。建议增加矩阵条件数检查，或调整误差阈值基于矩阵范数动态计算。

### 运维与部署考量

**硬件依赖**：此模块需要 Xilinx Alveo 加速器卡（U200/U250/U280 等）和 XRT（Xilinx Runtime）驱动。在 Docker 容器中运行时，必须映射 `/dev/xclmgmt` 和 `/dev/xocl` 设备节点。

**环境变量**：运行前需要设置 `XCL_EMULATION_MODE`（如使用仿真模式）或确保 `xclbin` 与目标板卡 shell 版本匹配。版本不匹配会导致加载失败。

---

## 使用指南与示例

### 编译与运行

**依赖**：
- Xilinx Vitis 或 Vivado 工具链
- XRT 2.8+ 驱动
- C++11 兼容编译器

**典型命令行**：

```bash
# 基础运行（使用默认 4x3 矩阵，运行 1 次）
./test_gesvj -xclbin ../kernel_gesvj.xclbin

# 性能测试（1000x1000 矩阵，运行 10 次取平均）
./test_gesvj -xclbin ../kernel_gesvj.xclbin -M 1000 -N 1000 -runs 10 -seed 42

# 小矩阵快速验证
./test_gesvj -xclbin ../kernel_gesvj.xclbin -M 16 -N 8 -runs 100
```

### 输出解读

**成功执行示例**：

```
INFO: Found Device=xilinx_u250_gen3x16_xdma_3_1
INFO: Number of kernel runs: 10
INFO: Matrix Row M: 1000
INFO: Matrix Col N: 1000
INFO: Finish data transfer from host to device
INFO: Finish kernel setup
INFO: Finish kernel execution
INFO: FPGA execution time of 10 runs: 5234567 us
INFO: Average executiom per run: 523456 us
-------------- 
[ PASSED ]
```

**关键指标**：
- **Execution time**：端到端时间，包括内核执行和数据传输（对于零拷贝，主要是内核时间）。
- **Average per run**：单核平均执行时间，用于比较不同矩阵规模的性能。
- **Error value**：如果显示 `[FAILED]`，会打印误差值，若 `errA > 0.0001` 则判定失败。

---

## 总结：给新贡献者的核心建议

1. **内存管理是首要陷阱**：所有 `aligned_alloc` 分配的内存必须用 `free`（不是 `delete`）释放，且必须在 OpenCL Buffer 销毁之后进行。

2. **xclbin 版本匹配**：如果遇到 `CL_INVALID_BINARY` 或程序挂起，首先检查 `xclbin` 文件是否针对当前板卡的 DSA（Device Support Archive）版本编译。

3. **矩阵维度约束**：始终确保 $M \geq N$。如果需要处理 "瘦" 矩阵（$M < N$），应在调用前转置矩阵，并在结果中相应地交换 $U$ 和 $V$ 的角色。

4. **计时解读**：`gettimeofday` 测量的是 wall-clock 时间，包含操作系统调度抖动。如果需要纯内核执行时间，应改用 OpenCL 事件分析 API。

5. **数值调试**：如果测试失败（误差 > 0.0001），首先检查矩阵条件数。尝试使用单位矩阵（`M=N`，对角线为 1）作为输入，如果这仍然失败，说明硬件内核或数据传输有问题；如果通过，说明原始矩阵过于病态。

6. **扩展路径**：如果要测试不同数据类型（如 `float` 或 `half`），需要修改 `aligned_alloc<double>` 为 `aligned_alloc<float>`，并确保 `xclbin` 也是对应类型编译的。混合类型会导致未定义行为。

---

**相关模块参考**：
- [gesvdj_benchmark](solver_benchmarks-gesvdj_benchmark.md) - 使用分而治之方法的替代 SVD 实现
- [gtsv_benchmark](solver_benchmarks-gtsv_benchmark.md) - 三对角矩阵求解器基准
- [hpc_iterative_solver_pipeline](hpc_iterative_solver_pipeline.md) - 迭代求解器的高级流水线架构

**外部参考**：
- [Xilinx XRT Documentation](https://xilinx.github.io/XRT/)
- [OpenCL 1.2 Specification - Memory Objects](https://www.khronos.org/registry/OpenCL/specs/opencl-1.2.pdf)
- [Golub & Van Loan, "Matrix Computations" - Jacobi SVD Algorithms]