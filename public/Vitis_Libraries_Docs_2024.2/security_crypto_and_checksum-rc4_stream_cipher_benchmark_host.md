# RC4 流密码基准测试主机模块深度解析

> **目标读者**: 刚加入团队的资深工程师，具备 C++/OpenCL 背景，需要快速理解本模块的设计意图、架构角色和实现细节。

## 1. 开篇：这到底是什么？

想象你正在设计一条高速公路（FPGA 内核），你需要验证它能否在预期时间内将货物（加密数据）从 A 点运到 B 点。`rc4_stream_cipher_benchmark_host` 正是**负责测试这条高速公路性能的指挥中心**——它不是要为你提供生产级的 RC4 加密服务，而是作为一个**基准测试协调器**，负责在主机端管理数据流、驱动 FPGA 内核、测量性能，并验证加密结果的正确性。

### 1.1 核心问题：为什么需要这个模块？

在数据中心部署 FPGA 加速器（如 AMD/Xilinx Alveo 卡）时，我们面临一个关键挑战：**如何系统性地验证硬件实现的正确性，并精确测量其端到端性能？**

手动验证不可行——RC4 流密码的输出看起来是随机字节。简单测试也不够——我们需要排除冷启动缓存、PCIe 预热等因素，测量可持续的吞吐率。

### 1.2 设计目标

该模块被设计为**自动化验证与性能评估框架**：

1. **正确性验证**：通过与预计算 golden 参考（来自 OpenSSL）逐字节比对，确保 FPGA 逻辑正确
2. **吞吐率测量**：通过重复执行和平稳状态计时，获得准确的可持续吞吐率
3. **隐藏传输延迟**：利用**乒乓缓冲（ping-pong buffering）**将 PCIe 数据传输与 FPGA 计算重叠
4. **多场景覆盖**：支持多通道（`CH_NM`）、多任务（`N_TASK`）、大数据块（`N_ROW`）的组合

---

## 2. 架构思维模型：三个协作层级

理解这个模块，需要在脑海中保持三个清晰分离的协作层级：

```
┌─────────────────────────────────────────────────────────────────────┐
│                         主机端 (Host x86)                            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐              │
│  │ 数据准备层   │──▶│ 传输调度层   │──▶│ 结果验证层   │              │
│  │ (Buffer Mgmt)│   │ (OpenCL CQ) │   │ (Golden Cmp) │              │
│  └──────────────┘   └──────────────┘   └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                              │ PCIe DMA
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    FPGA 设备 (Alveo 卡)                              │
│                    ┌───────────────────┐                            │
│                    │  rc4EncryptKernel_1 │                            │
│                    └───────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 数据准备层：内存布局工程师

职责：为 FPGA 准备物理正确的数据格式。

关键决策：
- **4096 字节对齐**：`posix_memalign(4096)` 满足 PCIe DMA 的硬性要求
- **512-bit 数据字**：`ap_uint<512>` 匹配 FPGA AXI 总线宽度，最大化带宽
- **三维到一维映射**：将 (channel, task, row) 索引展开为线性地址，通过位操作提取

### 2.2 传输调度层：异步流水线导演

职责：通过 OpenCL 事件编排三个并发流，最大化硬件利用率。

三个并发流：
1. **H2D (Host to Device)**：推送下一轮输入到 FPGA 内存
2. **Compute**：触发 FPGA 内核执行
3. **D2H (Device to Host)**：拉回上一轮结果到主机

通过**乒乓缓冲**，这三个流在时间线上重叠：当 Compute 处理第 N 轮时，H2D 准备第 N+1 轮，D2H 取回第 N-1 轮。

### 2.3 结果验证层：正确性仲裁者

职责：执行最终判决——FPGA 输出是否正确？

挑战：FPGA 输出是**位打包**的，不能直接用 `memcmp`。

验证流程：
1. 逆向 FPGA 的数据布局，计算目标数据所在的 512-bit 字索引
2. 使用 `.range()` 方法从该字中提取特定的 8-bit 字节
3. 与 golden 数据进行逐字节比对
4. 失败时输出详细诊断：kernel 编号、channel、task、row、期望值、实际值

---

## 3. 核心实现机制深度解析

### 3.1 乒乓缓冲与事件链

这是整个设计中最精妙的部分。通过 OpenCL 事件构建流水线：

```cpp
// 写操作依赖前前次的读操作完成（保证缓冲区可用）
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
} else {
    q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[i][0]);
}

// 内核依赖写完成
q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);

// 读操作依赖内核完成
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, &kernel_events[i], &read_events[i][0]);
```

#### 为什么需要这种依赖链？

想象一个装配线：
- **W** (Write): 将零件（输入数据）运送到工位
- **K** (Kernel/Compute): 工位加工（FPGA 加密）
- **R** (Read): 将成品运出

如果没有依赖链，可能会出现：
1. 第二次的 Write 覆盖了第一次还未读取的输出缓冲区
2. 内核在数据到达前就开始执行
3. 读取操作在内核完成前就读取未定义数据

#### 乒乓缓冲的具体工作模式

通过 `int use_a = i & 1`，偶数次迭代使用缓冲区 A (`_a`)，奇数次使用缓冲区 B (`_b`)：

```
Iteration 0 (i=0, use_a=0): Write to B_a -> Compute on B_a -> Read from B_a
Iteration 1 (i=1, use_a=1): Write to B_b -> Compute on B_b -> Read from B_b  
Iteration 2 (i=2, use_a=0): Write to B_a -> Compute on B_a -> Read from B_a
... and so on
```

注意依赖关系：`write_events[i]` 等待 `read_events[i-2]`，这意味着：
- 第 2 次迭代的写必须等待第 0 次迭代的读完成（因为都使用 B_a）
- 第 3 次迭代的写必须等待第 1 次迭代的读完成（因为都使用 B_b）

这种**两级延迟依赖**确保了乒乓缓冲区的安全复用。

### 3.2 位打包数据布局

本模块使用了高度优化的位打包内存布局，这是 FPGA 加速代码的典型特征。

#### 3.2.1 数据类型选择

```cpp
#include <ap_int.h>

typedef ap_uint<512> data_word_t;  // 512-bit 无符号整数
```

选择 512-bit 的原因：
1. **匹配硬件总线宽度**：现代 Alveo 卡（U200/U250/U280）的 HBM/DRAM 接口为 512-bit 宽
2. **最大化带宽利用率**：单次内存访问传输 64 字节，减少总线事务数量
3. **HLS 友好**：Vitis HLS 对 `ap_uint<512>` 有直接硬件映射，生成高效的加载/存储逻辑

#### 3.2.2 配置块布局

```cpp
// 配置块位于输入缓冲区的第一个 512-bit 字 (hb_in1[0])
hb_in1[0].range(127, 0)   = N_ROW;    // [127:0]   - 每任务行数
hb_in1[0].range(191, 128) = N_TASK;   // [191:128] - 每块任务数  
hb_in1[0].range(207, 192) = KEY_SIZE; // [207:192] - 密钥长度（字节）
// [511:208] 保留/未使用
```

这种紧凑的布局最小化了配置数据的传输开销。

#### 3.2.3 密钥块布局

```cpp
// 密钥数据：CH_NM * 4 个 512-bit 字
// 由于 KEY_SIZE = 80 字节，每个 512-bit 字可容纳 6 个密钥（384 bits）
// 实际使用：4 组不同的密钥配置，每组重复 CH_NM 次
for (unsigned int j = 0; j < CH_NM * 4; j++) {
    hb_in1[j + 1] = keyBlock[j % 4];  // keyBlock[0..3] 是 4 个不同的密钥配置
}
```

这里的关键设计是**密钥复用模式**：虽然物理上有 `CH_NM * 4` 个密钥槽，但只填充 4 种不同的密钥配置，每种重复 `CH_NM` 次。这支持了 FPGA 端的并行处理架构（多 PU，每个 PU 处理一个通道）。

#### 3.2.4 数据块布局与交错模式

```cpp
// 明文数据块：交替填充两个不同的字节值
const char datain[]  = {0x01};  // 偶数位置
const char datain2[] = {0x7e};  // 奇数位置

ap_uint<512> dataBlock;
for (unsigned int i = 0; i < 64; i++) {  // 64 字节 = 512 bits
    if (i % 2 == 0) {
        dataBlock.range(i * 8 + 7, i * 8) = datain[0];   // 0x01
    } else {
        dataBlock.range(i * 8 + 7, i * 8) = datain2[0];  // 0x7e
    }
}
```

这创建了一个可预测的测试模式：`0x01, 0x7e, 0x01, 0x7e, ...`。这种交替模式有助于检测位顺序错误（bit ordering errors）和字节对齐问题。

数据块随后被复制到整个输入数据区域：

```cpp
for (unsigned int j = 0; j < N_ROW * N_TASK * CH_NM / 64; j++) {
    hb_in1[j + 1 + 4 * CH_NM] = dataBlock;
}
```

注意索引偏移 `j + 1 + 4 * CH_NM`：跳过配置块（索引 0）和密钥块（4 * CH_NM 个 512-bit 字）。

#### 3.2.5 输出数据提取（验证阶段）

验证阶段的位操作最为复杂，因为需要逆向 FPGA 端的打包逻辑：

```cpp
// 索引计算：定位到特定的 512-bit 输出字
unsigned int word_idx = 
    j * ((N_ROW / 32) * (CH_NM / 2)) +  // 任务偏移
    (i / 32) * (CH_NM / 2) +             // 行块偏移  
    k / 2;                               // 通道对偏移

// 位范围提取：从 512-bit 字中提取特定字节
unsigned int bit_offset = 
    (k % 2) * 256 +   // 选择高/低 256-bit 半字
    (i % 32) * 8;     // 选择半字内的字节位置

// 提取 8-bit 值
ap_uint<8> fpga_byte = 
    hb_out_a[n][word_idx].range(bit_offset + 7, bit_offset);
```

这个复杂的索引公式揭示了 FPGA 端的数据布局架构：

1. **双通道交织（Channel Interleaving）**：每两个通道（`k/2`）共享一个 512-bit 字，每个通道占用 256-bit 半字（`(k % 2) * 256`）
2. **32 字节行块（Row Blocking）**：每 32 行（`i / 32`）组成一个块，因为 256 bits / 8 bits per byte = 32 bytes
3. **任务并行（Task Parallelism）**：每个任务（`j`）有独立的输出区域，大小为 `(N_ROW / 32) * (CH_NM / 2)` 个 512-bit 字

这种布局最大化 FPGA 内部并行性（多 PU 并行处理多通道），但给主机端验证带来了显著的复杂性。

---

## 4. 依赖关系与生态系统

### 4.1 本模块依赖的上游组件

| 依赖类别 | 组件/库 | 功能用途 | 版本/来源 |
|---------|---------|---------|----------|
| **FPGA Runtime** | Xilinx Runtime (XRT) | OpenCL 设备管理、内存分配、内核调度 | 随 Vitis/Vivado 安装 |
| **OpenCL Wrapper** | `xcl2.hpp` | Xilinx 提供的 OpenCL C++ 封装，简化设备枚举、二进制加载、缓冲区创建 | 随示例代码提供 |
| **HLS 数据类型** | `ap_int.h` (Vitis HLS) | 提供 `ap_uint<512>` 等任意精度整数类型 | Vitis HLS 安装 |
| **日志工具** | `xf_utils_sw::Logger` | 标准化的测试日志输出（TEST_PASS/TEST_FAIL） | Xilinx 安全库 |
| **系统库** | `sys/time.h`, `fstream` | 高精度计时、文件 I/O | 标准 C++ 库 |

### 4.2 模块树位置

在整体架构中的位置：

```
security_crypto_and_checksum (安全加密与校验和基准测试套件)
├── checksum_integrity_benchmarks (Adler32/CRC32)
├── aes256_cbc_cipher_benchmarks (AES-256-CBC)
├── hmac_sha1_authentication_benchmarks (HMAC-SHA1)
└── rc4_stream_cipher_benchmark_host (本模块 - RC4 流密码)
    └── 核心: security/L1/benchmarks/rc4Encrypt/host/main.cpp
```

**同级模块参考**：
- [checksum_integrity_benchmarks](security_crypto_and_checksum-checksum_integrity_benchmarks.md) - 校验和基准测试
- [aes256_cbc_cipher_benchmarks](security_crypto_and_checksum-aes256_cbc_cipher_benchmarks.md) - AES-256-CBC 加密基准测试
- [hmac_sha1_authentication_benchmarks](security_crypto_and_checksum-hmac_sha1_authentication_benchmarks.md) - HMAC-SHA1 认证基准测试

---

## 5. 关键设计决策与权衡

### 5.1 决策一：乒乓缓冲 vs. 串行执行

**背景**：在主机-FPGA 数据传输中，PCIe 延迟是不可忽略的。如果采用最简单的串行模式（传输→计算→回传→下一批），FPGA 会在传输期间空闲。

**决策**：采用双缓冲（乒乓）策略。

**权衡**：
- **收益**：理论上可以将吞吐率提升接近 2 倍（当传输时间和计算时间相当时）
- **代价**：内存占用翻倍；代码复杂度显著增加；调试困难

**替代方案**：三缓冲（Triple Buffering）可以进一步提升并行度，但需要三倍内存和更复杂的依赖管理。

### 5.2 决策二：512-bit 总线对齐 vs. 字节可访问性

**背景**：主机端代码需要为 FPGA 准备数据。最直接的方式是用 `uint8_t` 数组。

**决策**：强制使用 `ap_uint<512>` 类型，所有数据访问通过 `.range()` 位操作完成。

**权衡**：
- **收益**：与 FPGA AXI 总线宽度完美匹配，最大化内存带宽；避免 HLS 生成额外的字节对齐逻辑
- **代价**：主机端代码可读性和可维护性大幅下降；调试极其困难；任何索引计算错误都会导致静默数据损坏

**关键洞察**：这是典型的 HLS 协同设计理念——**为硬件优化优先，软件便利性次之**。

### 5.3 决策三：外部 Golden 文件 vs. 内联参考实现

**背景**：验证 FPGA 输出需要可信参考。最直接的方式是在主机代码中直接调用软件 RC4 实现（如 OpenSSL）实时计算参考值。

**决策**：将 golden 生成逻辑注释掉，改为从外部文件加载。

**权衡**：
- **当前方案（外部文件）**：
  - 优势：解耦参考生成与硬件测试；支持预生成的大规模测试向量；主机环境无需安装 OpenSSL 开发库
  - 劣势：引入文件 I/O 开销；文件格式或大小不匹配会导致难以诊断的验证失败

- **替代方案（内联 OpenSSL）**：
  - 优势：自包含，单文件即可运行；可动态调整测试参数
  - 劣势：增加编译依赖；对于大 `N_ROW`，主机端软件 RC4 计算可能成为瓶颈

### 5.4 决策四：细粒度事件链 vs. 粗粒度同步

**背景**：OpenCL 提供两种同步极端：完全异步（依赖事件）或完全同步（`clFinish` 阻塞）。

**决策**：构建精细的三级事件依赖图（Write → Kernel → Read），并引入两级延迟的乒乓依赖。

**权衡**：
- **细粒度事件链**：
  - 优势：最大化硬件利用率，允许调度器进行指令级并行优化；精确控制数据流
  - 劣势：代码复杂度极高；调试困难；OpenCL 驱动实现差异可能导致非确定性行为

- **粗粒度同步（替代方案）**：
  - 伪代码：`for (i) { write(); finish(); kernel(); finish(); read(); finish(); }`
  - 优势：简单、确定性强、易于调试
  - 劣势：完全串行化，吞吐率受限于 `write + kernel + read` 的总和

---

## 6. 使用指南与操作手册

### 6.1 构建指令

#### 环境准备

```bash
# 设置 Xilinx 工具链环境
source /opt/xilinx/xrt/setup.sh
source /opt/xilinx/vitis/2023.1/settings64.sh

# 验证 OpenCL 环境
xbutil examine
```

#### 编译命令

```bash
g++ -std=c++11 -O2 \
    -I$XILINX_XRT/include \
    -I/path/to/xilinx/security/L1/include \
    -I/path/to/xilinx/common/L1/include \
    -L$XILINX_XRT/lib \
    -lOpenCL -lpthread -lrt \
    main.cpp -o rc4Encrypt.exe
```

### 6.2 运行参数

```bash
./rc4Encrypt.exe -xclbin <fpga_bitstream.xclbin> -gld <golden_file.bin> [-rep <num_repetitions>]
```

**参数说明**：
- `-xclbin` (必需): FPGA 比特流文件路径
- `-gld` (必需): Golden 参考数据文件路径（二进制格式）
- `-rep` (可选): 重复执行次数，默认 2，范围 [2, 20]

**Golden 文件格式**：
- 二进制格式，无头部
- 总大小：4 × N_ROW 字节（4 组参考数据，每组 N_ROW 字节）

### 6.3 常见故障排查

| 症状 | 可能原因 | 解决方案 |
|------|---------|----------|
| `ERROR:xclbin path is not set!` | 缺少 `-xclbin` 参数 | 确认命令行包含 `-xclbin <path>` |
| `cl::Error: CL_OUT_OF_RESOURCES` | FPGA 内核编译错误或资源不足 | 确认 `.xclbin` 与目标 Alveo 卡型号匹配；检查 `dmesg` |
| 验证失败，输出全零 | PCIe 数据传输失败或内核未启动 | 检查 `xclbin` 是否包含 `rc4EncryptKernel_1`；使用 `xbutil` 检查卡状态 |
| 验证失败，部分数据错误 | 时序问题或内存损坏 | 确认 `N_ROW`, `N_TASK`, `CH_NM` 与 FPGA 内核配置一致；检查 golden 文件是否被截断 |
| `Segmentation fault` | 对齐分配失败或缓冲区溢出 | 确认系统有足够大页内存；检查 `posix_memalign` 返回值；验证 `N_ROW` 和 `N_TASK` 未设置过大值 |

---

## 7. 边缘情况与隐性契约

### 7.1 静默缓冲区溢出风险

如果手动修改 `N_ROW` 或 `N_TASK` 但未重新计算缓冲区大小公式，会导致堆溢出：

```cpp
// 危险：如果 N_ROW 或 CH_NM 改变，以下计算可能不正确
hb_out_a[i] = aligned_alloc<ap_uint<512>>(N_ROW * N_TASK * CH_NM / 64);
```

**契约**：`N_ROW * N_TASK * CH_NM` 必须是 64 的倍数（因为 512 bits = 64 bytes）。

### 7.2 严格的事件依赖时序

代码假设 `num_rep >= 2`，否则会强制设为 2。这是因为在事件依赖图中，第 `i` 次的写依赖于第 `i-2` 次的读。如果 `num_rep = 1`，这个依赖不存在，但代码通过强制 `num_rep >= 2` 避免了特殊处理。

### 7.3 内存泄漏风险

代码使用原始指针配合 `posix_memalign`，但**没有显式释放内存**：

```cpp
// 分配
ap_uint<512>* hb_in1 = aligned_alloc<ap_uint<512>>(size);

// 使用... 但没有 free！
```

**影响**：对于短期运行的基准测试（通常 < 1 分钟），依赖进程退出时的操作系统回收是可接受的。但如果将此代码改编为长期服务，必须添加 `free(ptr)` 或使用智能指针。

### 7.4 未处理的 OpenCL 错误

代码检查 OpenCL 错误码，但除了记录日志外，没有采取纠正措施：

```cpp
cl_int err = CL_SUCCESS;
cl::Context context(device, NULL, NULL, NULL, &err);
logger.logCreateContext(err);  // 仅记录，不终止
// 即使 err != CL_SUCCESS，代码仍继续执行
```

**风险**：如果 OpenCL 对象创建失败，后续操作可能产生未定义行为。生产代码应在关键错误时立即终止或抛出异常。

---

## 8. 总结：给新加入者的建议

### 8.1 关键要点回顾

1. **这不是一个加密库**，而是一个**FPGA 加速验证框架**。它的目标是验证硬件实现的正确性和性能，而不是提供生产级加密服务。

2. **三层架构思维**：数据准备层（内存布局）、传输调度层（OpenCL 事件链）、结果验证层（Golden 比对）。理解这三层如何协作是理解本模块的关键。

3. **乒乓缓冲是性能核心**：通过双缓冲和两级延迟依赖，实现数据传输与 FPGA 计算的流水线并行，这是达到高吞吐率的关键。

4. **位打包是复杂性来源**：`ap_uint<512>` 和 `.range()` 操作虽然优化了硬件性能，但给主机端代码带来了显著的复杂性和调试难度。

### 8.2 常见陷阱与避免方法

| 陷阱 | 后果 | 避免方法 |
|------|------|----------|
| 修改 `N_ROW`/`N_TASK` 但未更新缓冲区大小计算 | 堆溢出或验证失败 | 始终检查 `N_ROW * N_TASK * CH_NM` 是 64 的倍数，并重新计算缓冲区大小 |
| 使用未对齐的内存（非 4096 字节对齐） | PCIe DMA 失败或性能下降 | 始终使用 `posix_memalign(4096, ...)` 分配 DMA 缓冲区 |
| 忽略 `num_rep < 2` 的警告 | 乒乓缓冲无法正常工作 | 确保 `-rep` 参数 >= 2，或接受默认值 2 |
| 直接修改 golden 文件而不理解格式 | 验证失败，难以诊断 | 使用提供的 Python 脚本生成 golden 文件，或严格遵循二进制格式规范 |
| 在验证失败后不检查详细错误输出 | 错过关键诊断信息 | 始终检查错误输出中的 kernel 编号、channel、task、row、期望值、实际值 |

### 8.3 扩展与修改建议

如果你需要修改或扩展本模块，请考虑以下建议：

1. **添加内存自动释放**：使用 `std::unique_ptr` 与自定义删除器包装 `aligned_alloc` 返回的指针，确保异常安全。

2. **增强错误处理**：在关键 OpenCL 操作失败时立即终止，而不是仅记录日志。可以使用异常或返回码传播错误。

3. **支持动态参数**：将 `N_ROW`, `N_TASK`, `CH_NM` 从编译时常量改为运行时参数，通过命令行或配置文件传入，增加灵活性。

4. **添加性能分析**：利用 OpenCL 事件的内置性能分析功能（`CL_QUEUE_PROFILING_ENABLE` 已启用），计算每个阶段的实际耗时（H2D 传输、内核执行、D2H 传输），而不仅仅是端到端时间。

5. **支持多设备**：扩展代码以支持多 FPGA 卡并行（使用多个 `cl::Device` 和多个 `cl::CommandQueue`），进一步提升吞吐率。

---

## 附录：关键代码片段注释

### A.1 对齐内存分配

```cpp
template <typename T>
T* aligned_alloc(std::size_t num) {
    void* ptr = nullptr;
    // 使用 4096 字节（页大小）对齐，满足 PCIe DMA 要求
    if (posix_memalign(&ptr, 4096, num * sizeof(T))) 
        throw std::bad_alloc();
    return reinterpret_cast<T*>(ptr);
}
```

### A.2 乒乓缓冲调度核心

```cpp
for (int i = 0; i < num_rep; i++) {
    int use_a = i & 1;  // 偶数次用 A，奇数次用 B
    
    // 根据 use_a 选择对应的缓冲区对象
    std::vector<cl::Memory> ib = use_a ? in_buff_a : in_buff_b;
    std::vector<cl::Memory> ob = use_a ? out_buff_a : out_buff_b;
    
    // 阶段 1: 写入输入数据 (H2D)
    // 依赖：第 i-2 次迭代的读取必须完成（乒乓缓冲的反向依赖）
    if (i > 1) {
        q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
    } else {
        q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[i][0]);
    }
    
    // 阶段 2: 启动内核 (Compute)
    // 依赖：本次迭代的写入必须完成（数据已到达 FPGA 内存）
    q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);
    
    // 阶段 3: 读取输出数据 (D2H)
    // 依赖：本次迭代的内核执行必须完成（结果已产生）
    q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, &kernel_events[i], &read_events[i][0]);
}
```

### A.3 验证逻辑核心

```cpp
// 遍历所有输出，逐字节验证
for (unsigned int n = 0; n < 1; n++) {  // kernel 编号
    for (unsigned int j = 0; j < N_TASK; j++) {  // task
        for (unsigned int k = 0; k < CH_NM; k++) {  // channel
            for (unsigned int i = 0; i < N_ROW; i++) {  // row
                // 复杂的索引计算，逆向 FPGA 的数据打包逻辑
                unsigned int word_idx = 
                    j * ((N_ROW / 32) * (CH_NM / 2)) +
                    (i / 32) * (CH_NM / 2) +
                    k / 2;
                
                unsigned int bit_offset = 
                    (k % 2) * 256 +
                    (i % 32) * 8;
                
                // 提取 FPGA 输出字节
                ap_uint<8> fpga_byte = 
                    hb_out_a[n][word_idx].range(bit_offset + 7, bit_offset);
                
                // 与 golden 数据比对
                if (fpga_byte != golden[n][i]) {
                    checked = false;
                    // 输出详细错误信息...
                }
            }
        }
    }
}
```

---

**文档版本**: 1.0  
**最后更新**: 2024  
**维护者**: FPGA 加速团队
