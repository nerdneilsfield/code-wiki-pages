# platform_connectivity 模块：Lepton 编码器 FPGA 平台连接配置

## 一句话概括

`platform_connectivity` 是 Lepton 编码器在 Xilinx Alveo U200 加速器卡上的**硬件连接蓝图**——它定义了 FPGA 内核如何连接 DDR 内存、如何分配芯片资源，以及如何在一个或多个计算单元间分配工作负载。

---

## 1. 这个模块解决什么问题？

### 1.1 背景：从 HLS 代码到比特流的鸿沟

当你用 Vitis HLS 写好一个 JPEG 解码 + Lepton 编码的加速器内核（`lepEnc`）后，代码只是描述了**计算逻辑**。要让这片逻辑在真实的 Alveo U200 卡上跑起来，你必须回答几个关键的硬件问题：

- **内存连接**：内核的 AXI 主端口要接到哪块 DDR？带宽如何分配？
- **芯片布局**：内核的物理位置在哪里？哪个 SLR（Super Logic Region）？
- **多实例扩展**：如果要部署 7 个内核实例，如何均匀分布在 3 个 SLR 和 3 块 DDR 上？

### 1.2 本模块的职责

`conn_u200.cfg` 就是这份**硬件拓扑的配置声明**。它在 Vitis 链接阶段（`v++ -l`）被解析，指导工具链如何将内核实例映射到 FPGA 的物理资源。没有它，内核代码只是一堆未连接的逻辑门；有了它，才是一张可执行的硬件蓝图。

---

## 2. 心智模型：把配置看作什么？

想象你在设计一个**工厂的流水线布局**：

| 类比 | 工厂设计 | `conn_u200.cfg` 配置 |
|------|---------|---------------------|
| **机器设备** | 生产设备（压缩机、包装机） | `nk=lepEnc:1:lepEnc_0` —— 定义内核类型和实例数量 |
| **电力连接** | 设备接哪条高压线 | `sp=lepEnc_0.datainDDR:DDR[0]` —— 内存端口映射到 DDR 控制器 |
| **厂房分区** | 设备放在哪个车间 | `slr=lepEnc_0:SLR0` —— 内核实例绑定到特定 SLR |
| **扩展规划** | 预留的第 2、3 车间扩展位 | 注释掉的 7 实例配置 —— 展示多 SLR/DDR 均匀分布方案 |

**关键洞察**：这份配置不是"代码"，而是**硬件资源的声明式分配**。它不关心计算逻辑（那是 HLS 代码的事），只关心"线路怎么接、芯片空间怎么用"。

---

## 3. 架构与数据流：配置如何映射到硬件

### 3.1 当前激活的单实例配置

```ini
nk=lepEnc:1:lepEnc_0                    # 1 个内核实例，名为 lepEnc_0
sp=lepEnc_0.datainDDR:DDR[0]            # 输入数据端口 → DDR0
sp=lepEnc_0.arithInfo:DDR[0]            # 算术信息端口 → DDR0
sp=lepEnc_0.res:DDR[0]                  # 结果输出端口 → DDR0
slr=lepEnc_0:SLR0                       # 物理位置 → SLR0
```

**数据流路径**：

```
Host DDR (via PCIe) 
    ↓
FPGA DDR Controller 0 (DDR[0])
    ↓ (AXI4-Full, slave port datainDDR)
┌───────────────────────────────────────┐
│  lepEnc_0 内核 (SLR0)                 │
│  ├── JPEG 解码 (Huffman → IDCT)       │
│  └── Lepton 编码 (算术编码 → 输出)     │
└───────────────────────────────────────┘
    ↓ (AXI4-Full, slave ports arithInfo, res)
FPGA DDR Controller 0 (DDR[0])
    ↓
Host (via PCIe)
```

### 3.2 注释中的多实例扩展方案

配置文件中大部分内容是被注释掉的 7 实例配置，展示了如何将工作负载均匀分布到 3 个 SLR 和 3 块 DDR：

```ini
# 内核 0-2 在 SLR0，共享 DDR0
nk=lepEnc:7:lepEnc_0.lepEnc_1.lepEnc_2.lepEnc_3.lepEnc_4.lepEnc_5.lepEnc_6
sp=lepEnc_0.datainDDR:DDR[0]    # 实例 0
sp=lepEnc_1.datainDDR:DDR[0]    # 实例 1
sp=lepEnc_2.datainDDR:DDR[0]    # 实例 2
slr=lepEnc_0:SLR0
slr=lepEnc_1:SLR0
slr=lepEnc_2:SLR0

# 内核 3 在 SLR1，使用 DDR1
sp=lepEnc_3.datainDDR:DDR[1]
slr=lepEnc_3:SLR1

# 内核 4-6 在 SLR2，共享 DDR2
sp=lepEnc_4.datainDDR:DDR[2]
sp=lepEnc_5.datainDDR:DDR[2]
sp=lepEnc_6.datainDDR:DDR[2]
slr=lepEnc_4:SLR2
slr=lepEnc_5:SLR2
slr=lepEnc_6:SLR2
```

**设计意图**：
- **DDR 分布**：将内存带宽压力分散到 3 个独立的 DDR 控制器
- **SLR 分布**：避免单个 SLR 的资源（LUT、FF、BRAM）过载
- **时序优化**：跨 SLR 走线延迟较高，同 SLR 内的内核间通信更快

---

## 4. 核心组件详解

### 4.1 内核实例声明：`nk=lepEnc:1:lepEnc_0`

| 语法元素 | 含义 |
|---------|------|
| `nk` | "Number of Kernels" 的缩写，声明内核实例 |
| `lepEnc` | 内核类型名称，必须与 HLS 代码中的 `extern "C" void lepEnc(...)` 函数名匹配 |
| `1` | 实例数量 |
| `lepEnc_0` | 实例名称，用于后续 `sp=` 和 `slr=` 引用 |

**关键约束**：内核类型名必须与 HLS 顶层函数名完全一致，否则链接器找不到实现。

### 4.2 内存端口映射：`sp=lepEnc_0.datainDDR:DDR[0]`

| 语法元素 | 含义 |
|---------|------|
| `sp` | "Scalar Port" 的缩写（此处实为 AXI 主端口） |
| `lepEnc_0` | 目标内核实例 |
| `datainDDR` | HLS 代码中声明的 AXI 端口名，对应 `#pragma HLS INTERFACE m_axi port=datainDDR bundle=gmem_in1` |
| `DDR[0]` | 目标物理内存，映射到 FPGA 板上的第 0 块 DDR 控制器 |

**端口对应关系**（来自 `multi_cu.cpp` 中的 HLS 接口声明）：

| HLS Bundle | 端口名 | 连接方向 | DDR 控制器 | 用途 |
|-----------|-------|---------|-----------|------|
| `gmem_in1` | `datainDDR` | 只读 | DDR[0] | 输入 JPEG 数据 |
| `gmem_out1` | `res` | 只写 | DDR[0] | 输出 Lepton 编码结果 |
| `gmem_out2` | `arithInfo` | 只写 | DDR[0] | 算术编码元数据 |

**关键约束**：
- `bundle=` 名必须在 HLS 代码和配置文件中保持一致
- 多个端口可以映射到同一个 DDR 控制器，但共享带宽
- 不同 DDR 控制器提供独立带宽，适合并行访问模式

### 4.3 SLR 位置绑定：`slr=lepEnc_0:SLR0`

| 语法元素 | 含义 |
|---------|------|
| `slr` | "Super Logic Region" 的缩写，指定内核的物理布局位置 |
| `lepEnc_0` | 目标内核实例 |
| `SLR0` | 目标 SLR，Xilinx 大容量 FPGA（如 VU9P）被划分为 2-3 个 SLR，每个 SLR 有自己的时钟网络和可编程逻辑资源 |

**U200 的 SLR 结构**：

```
┌─────────────────────────────────────────────────────────┐
│                      Alveo U200                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  SLR0 (Bottom)                                   │   │
│  │  - 资源丰富                                      │   │
│  │  - 靠近 DDR0/DDR1 控制器                         │   │
│  │  - 推荐放置单实例或主实例                         │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  SLR1 (Middle)                                   │   │
│  │  - 中等资源                                      │   │
│  │  - 位于中间，到各 DDR 距离均衡                     │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  SLR2 (Top)                                      │   │
│  │  - 资源相对较少                                  │   │
│  │  - 靠近 DDR2/DDR3 控制器                         │   │
│  │  - 适合放置辅助实例                              │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**SLR 绑定的影响**：
- **时序**：同一 SLR 内的信号走线延迟低，跨 SLR 需要经过 SLR crossing，延迟增加
- **资源**：每个 SLR 的 LUT、FF、BRAM、DSP 数量有限，需合理分配
- **带宽**：SLR 靠近的 DDR 控制器访问延迟更低

---

## 5. 设计决策与权衡

### 5.1 单实例 vs 多实例：为什么选择 1 个？

当前配置只启用 1 个内核实例（`nk=lepEnc:1:lepEnc_0`），但注释中展示了 7 实例的完整配置。这是**资源、复杂性与性能**的权衡：

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **单实例（当前）** | 资源占用少（~15-20% U200），时序收敛容易，调试简单 | 峰值吞吐量有限 | 原型验证、低并发场景、资源紧张时 |
| **7 实例（注释）** | 吞吐量线性扩展（理论 7x），可并行处理 7 张图片 | 资源占用高（可能接近 100%），时序收敛困难，布局布线时间长 | 生产部署、高吞吐批量处理 |

**决策逻辑**：
1. **开发阶段**：单实例确保快速迭代和稳定时序
2. **生产扩展**：取消注释、调整 `nk=` 行、为每个实例配置 `sp=` 和 `slr=` 即可扩展
3. **资源平衡**：7 实例配置特意让每个 SLR 承载 2-3 个实例，避免某个 SLR 过热

### 5.2 DDR 分配策略：为什么单实例全连 DDR0？

当前配置将 `datainDDR`、`arithInfo`、`res` 三个端口全部映射到 `DDR[0]`。这看起来"把所有鸡蛋放在一个篮子里"，但有其合理性：

| 考量维度 | 单 DDR 策略的理由 |
|---------|-----------------|
| **延迟** | 同一 DDR 控制器的读写延迟可预测，避免跨 DDR 的仲裁延迟 |
| **带宽** | 单实例的带宽需求（约 1-2 GB/s）远低于单个 DDR 控制器的峰值（~20 GB/s），不存在瓶颈 |
| **简单性** | Host 代码只需分配一块连续内存，简化缓冲区管理 |
| **扩展性** | 当扩展到多实例时，再为每个实例分配不同 DDR（如注释中的方案） |

**多实例时的 DDR 分配原则**（来自注释配置）：
- **均匀分布**：7 实例分布在 DDR0、DDR1、DDR2，避免某个 DDR 控制器过载
- **就近原则**：SLR0 的实例优先用 DDR0（距离近、延迟低），SLR2 的实例用 DDR2

### 5.3 SLR 绑定的时序考量

为什么单实例选择 `SLR0` 而非 `SLR1` 或 `SLR2`？

| SLR | 特点 | 单实例选址理由 |
|-----|------|--------------|
| **SLR0** | 最靠近 PCIe 接口和 DDR0/DDR1 控制器 | **主推荐位置**：数据从 PCIe 进来先到 SLR0 附近的 DDR 控制器，放在这里路径最短 |
| **SLR1** | 中间位置，到各 DDR 距离均衡 | 适合多实例时的"中间调度者"角色 |
| **SLR2** | 距离 PCIe 最远，但靠近 DDR2/DDR3 | 适合只访问 DDR2/3 的辅助实例，避免跨 SLR 走线 |

**时序收敛的关键**：跨 SLR 的信号需要经过特殊的 SLR crossing 结构，延迟比同 SLR 内高 2-3 倍。单实例的所有端口都连到 DDR0，放在 SLR0 可以确保：
- 从 DDR0 读数据 → 进内核计算：同 SLR，低延迟
- 内核写结果 → 回 DDR0：同 SLR，低延迟

---

## 6. 依赖关系与调用链

### 6.1 本模块的依赖（谁调用/使用它）

```
Vitis 链接流程 (v++ -l)
    │
    ├── 输入: lepEnc.xo (内核目标文件，由 HLS 编译生成)
    │   └── 来源: multi_cu.cpp → lepEnc() 函数
    │
    ├── 输入: conn_u200.cfg (本配置文件)
    │   └── 定义: nk=, sp=, slr= 连接规则
    │
    └── 输出: lepEnc.xclbin (可执行比特流)
        └── 包含: 布局布线后的物理设计，可直接烧录到 U200
```

**Makefile 中的使用位置**（来自 `codec/L2/demos/leptonEnc/Makefile`）：

```makefile
# 第 133-135 行：检测 U200 平台并添加配置
ifneq (,$(shell echo $(XPLATFORM) | awk '/u200/'))
VPP_FLAGS +=   --config $(CUR_DIR)/conn_u200.cfg
...
endif
```

这意味着：只有为目标平台是 U200（或其变体）时，才应用这份连接配置。其他平台（如 U50、U280）需要自己的 `.cfg` 文件。

### 6.2 本模块依赖的下游组件

配置文件本身不"调用"代码，但它通过命名约定与以下组件紧密耦合：

| 依赖项 | 耦合方式 | 如果改名会怎样 |
|-------|---------|--------------|
| `lepEnc` (HLS 函数) | `nk=lepEnc` 必须与 `extern "C" void lepEnc()` 匹配 | 链接错误：找不到内核实现 |
| `datainDDR` (AXI 端口) | `sp=lepEnc_0.datainDDR` 必须与 HLS 中的 `port=datainDDR` 匹配 | 连接错误：端口未绑定 |
| `DDR[0]` (平台资源) | 假设 U200 有 DDR0；其他平台可能不同 | 如果在 U50（单 DDR）上用 `DDR[1]` 会报错 |
| `SLR0` (芯片结构) | 假设 U200 的 VU9P 有 3 个 SLR | 如果在单 SLR 的芯片上用 `SLR1` 会报错 |

---

## 7. 使用方式与扩展指南

### 7.1 基础使用：跑通单实例

无需修改配置，直接编译：

```bash
# 1. 进入工程目录
cd codec/L2/demos/leptonEnc

# 2. 设置 Xilinx 工具环境
source /opt/xilinx/Vitis/2022.1/settings64.sh

# 3. 编译（默认使用 conn_u200.cfg）
make all TARGET=hw PLATFORM=xilinx_u200_gen3x16_xdma_2_202110_1

# 4. 运行
make run TARGET=hw
```

### 7.2 扩展到 7 实例

取消注释并调整配置：

```ini
# conn_u200.cfg
[connectivity]
# 改为 7 实例
nk=lepEnc:7:lepEnc_0.lepEnc_1.lepEnc_2.lepEnc_3.lepEnc_4.lepEnc_5.lepEnc_6

# 取消所有 sp= 和 slr= 的注释（原文件中已有，只需去掉 #）
sp=lepEnc_0.datainDDR:DDR[0]
sp=lepEnc_0.arithInfo:DDR[0]
...
slr=lepEnc_6:SLR2
```

**Host 代码调整**：需要并发提交 7 个内核任务，示例（概念）：

```cpp
// 为 7 个实例准备 7 组输入缓冲区
cl::Buffer inBuf[7], outBuf[7], arithBuf[7];
cl::Kernel krnl[7];

// 创建 7 个内核对象，分别对应 7 个实例
for (int i = 0; i < 7; i++) {
    krnl[i] = cl::Kernel(program, "lepEnc");  // 实际会映射到 lepEnc_i
    krnl[i].setArg(0, inBuf[i]);
    krnl[i].setArg(1, jpgSize);
    krnl[i].setArg(2, arithBuf[i]);
    krnl[i].setArg(3, outBuf[i]);
}

// 并发提交 7 个任务
for (int i = 0; i < 7; i++) {
    queue.enqueueTask(krnl[i]);
}
queue.finish();
```

### 7.3 适配其他平台（如 U50/U280）

U200 的 3-SLR 结构在其他平台可能不同，需要调整 `slr=` 和 `DDR[n]`：

| 平台 | SLR 数量 | DDR 配置 | 典型调整 |
|------|---------|---------|---------|
| **U200** | 3 (VU9P) | DDR0,1,2,3 | 当前配置基准 |
| **U250** | 3 (VU13P) | DDR0,1,2,3 | 可直接复用 U200 配置 |
| **U280** | 3 (VU35P) | DDR0,1,2,3 + HBM | 可用 HBM 替代 DDR 获取更高带宽 |
| **U50** | 1 (VU35P) | 单 DDR + HBM | 必须去掉所有 `slr=` 和 `DDR[1/2]`，只用 `SLR0` 和 `DDR[0]` |

---

## 8. 新贡献者必读：陷阱与调试技巧

### 8.1 常见错误与解决

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `ERROR: Kernel lepEnc not found` | `nk=` 中的内核名与 HLS 函数名不匹配 | 检查 `multi_cu.cpp` 中的 `extern "C" void lepEnc(...)` 函数名 |
| `ERROR: Port datainDDR not found` | `sp=` 中的端口名与 HLS 端口名不匹配 | 检查 HLS 代码中的 `#pragma HLS INTERFACE m_axi port=...` 声明 |
| `ERROR: DDR[1] not available on platform` | 平台只有单 DDR（如 U50），但配置用了 DDR[1] | 修改为 `DDR[0]` 或去掉多 DDR 配置 |
| `ERROR: SLR1 not available on device` | 单 SLR 芯片（如部分 U50）用了 `slr=...:SLR1` | 所有 `slr=` 改为 `SLR0` |
| 布局布线失败，时序不收敛 | 单个 SLR 资源过载（如放 4 个复杂内核） | 分散到多个 SLR，或减少实例数量 |

### 8.2 验证配置正确性的步骤

```bash
# 1. 检查内核名是否匹配（HLS 侧）
grep -n "extern \"C\"" codec/L2/demos/leptonEnc/kernel/multi_cu.cpp
# 应该看到: extern "C" void lepEnc(...)

# 2. 检查端口名是否匹配（HLS 侧）
grep -n "INTERFACE m_axi" codec/L2/demos/leptonEnc/kernel/multi_cu.cpp
# 应该看到: port=datainDDR, port=res, port=arithInfo

# 3. 验证配置文件语法
cat codec/L2/demos/leptonEnc/conn_u200.cfg
# 确保没有语法错误，如遗漏 '=' 或错误的空间

# 4. 编译时启用详细日志
make all TARGET=hw PLATFORM=xilinx_u200_gen3x16_xdma_2_202110_1 VPP_FLAGS="--verbose"
```

### 8.3 调试多实例配置的技巧

当扩展到多实例时，常见问题及调试方法：

1. **Host 代码没有正确分发任务**
   - 现象：7 个实例但只有 1 个在工作（利用率低）
   - 检查：使用 `xrt::run` 的 `enqueueTask` 是否创建了独立的 `cl::Kernel` 对象

2. **内存冲突**
   - 现象：结果数据混乱，偶尔崩溃
   - 检查：确保不同实例的 `datainDDR` 指向 Host 端不同的缓冲区

3. **DDR 带宽饱和**
   - 现象：增加实例数量但吞吐量不线性增长
   - 检查：使用 `xbutil` 查看 DDR 带宽利用率，可能需要分散到多个 DDR 控制器

---

## 9. 与周边模块的关系

### 9.1 本模块在工程中的位置

```
leptonEnc 工程结构
├── host/                    # Host 端代码（OpenCL/XRT 调用）
│   └── lepton/              # Lepton 编解码器算法实现
├── kernel/                  # HLS 内核源码
│   ├── multi_cu.cpp         # 内核入口（包含 lepEnc 函数）
│   ├── jpeg_dec_lepton_enc.cpp  # 核心算法实现
│   └── ...                  # 其他 HLS 子模块
├── conn_u200.cfg           # ← 本模块：U200 平台连接配置
├── Makefile                # 构建脚本（检测 U200 并传入 --config）
└── description.json        # 工程元数据
```

### 9.2 相关模块参考

| 模块 | 关系 | 说明 |
|------|------|------|
|[`edge_encoding_core`](codec_acceleration_and_demos-lepton_encoder_demo-edge_encoding_core.md)| 兄弟模块 | Lepton 编码器的边缘处理核心算法 |
|[`host_acceleration_timing_and_phase_profiling`](codec_acceleration_and_demos-jxl_and_pik_encoder_acceleration-host_acceleration_timing_and_phase_profiling.md)| 相关模块 | Host 端性能分析基础设施 |
|[`jpeg_decoder_kernel_connectivity_profiles`](codec_acceleration_and_demos-jpeg_and_resize_demos-jpeg_decoder_kernel_connectivity_profiles.md)| 相关模块 | JPEG 解码器的类似连接配置 |

---

## 10. 总结：关键要点回顾

作为新加入的工程师，理解本模块需要把握以下核心要点：

1. **这不是代码，是硬件蓝图**
   - `conn_u200.cfg` 在 Vitis 链接阶段被解析，指导 FPGA 布局布线工具
   - 它声明了"哪个内核实例连到哪块 DDR、放在哪个 SLR"

2. **三个核心指令：nk、sp、slr**
   - `nk=` 声明内核类型和实例数量
   - `sp=` 将内核的 AXI 端口映射到 DDR 控制器
   - `slr=` 指定内核在 FPGA 芯片上的物理位置

3. **当前是保守的单实例配置，注释中藏了扩展方案**
   - 当前只有 1 个内核实例（`nk=lepEnc:1:lepEnc_0`）
   - 注释掉的 7 实例配置展示了如何均匀分布到 3 个 SLR 和 3 块 DDR
   - 生产部署时可以取消注释并调整 Host 代码以利用多实例

4. **命名一致性是关键陷阱**
   - `nk=` 中的内核名必须与 HLS `extern "C"` 函数名完全一致
   - `sp=` 中的端口名必须与 HLS `#pragma INTERFACE` 声明的 `port=` 名一致
   - 不匹配会导致链接或布局阶段难以理解的错误

5. **平台适配需要调整**
   - 本配置专为 U200（3 SLR、4 DDR）设计
   - 移植到 U50（1 SLR、单 DDR）需删除所有 `slr=` 和 `DDR[1/2/3]` 引用
   - 移植到 U280（支持 HBM）可考虑用 HBM 替代 DDR 获取更高带宽

理解这些要点，你就能在调试连接问题、扩展多实例、或移植到新平台时做出正确的决策。
sp=lepEnc_2.datainDDR:DDR[0]    # 实例 2
slr=lepEnc_0:SLR0
slr=lepEnc_1:SLR0
slr=lepEnc_2:SLR0

# 内核 3 在 SLR1，使用 DDR1
sp=lepEnc_3.datainDDR:DDR[1]
slr=lepEnc_3:SLR1

# 内核 4-6 在 SLR2，共享 DDR2
sp=lepEnc_4.datainDDR:DDR[2]
sp=lepEnc_5.datainDDR:DDR[2]
sp=lepEnc_6.datainDDR:DDR[2]
slr=lepEnc_4:SLR2
slr=lepEnc_5:SLR2
slr=lepEnc_6:SLR2
```

**设计意图**：
- **DDR 分布**：将内存带宽压力分散到 3 个独立的 DDR 控制器
- **SLR 分布**：避免单个 SLR 的资源（LUT、FF、BRAM）过载
- **时序优化**：跨 SLR 走线延迟较高，同 SLR 内的内核间通信更快

---

## 4. 核心组件详解

### 4.1 内核实例声明：`nk=lepEnc:1:lepEnc_0`

| 语法元素 | 含义 |
|---------|------|
| `nk` | "Number of Kernels" 的缩写，声明内核实例 |
| `lepEnc` | 内核类型名称，必须与 HLS 代码中的 `extern "C" void lepEnc(...)` 函数名匹配 |
| `1` | 实例数量 |
| `lepEnc_0` | 实例名称，用于后续 `sp=` 和 `slr=` 引用 |

**关键约束**：内核类型名必须与 HLS 顶层函数名完全一致，否则链接器找不到实现。

### 4.2 内存端口映射：`sp=lepEnc_0.datainDDR:DDR[0]`

| 语法元素 | 含义 |
|---------|------|
| `sp` | "Scalar Port" 的缩写（此处实为 AXI 主端口） |
| `lepEnc_0` | 目标内核实例 |
| `datainDDR` | HLS 代码中声明的 AXI 端口名，对应 `#pragma HLS INTERFACE m_axi port=datainDDR bundle=gmem_in1` |
| `DDR[0]` | 目标物理内存，映射