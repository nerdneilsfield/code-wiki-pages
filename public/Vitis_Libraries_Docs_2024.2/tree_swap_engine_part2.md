
## 组件深度解析

### 主入口：`main` 函数与测试框架

`main` 函数是整个模块的 orchestrator（编排器）。它不是简单的线性执行，而是一个**分阶段的状态机**，根据编译时和运行时条件在多种执行模式间切换。

#### 多模式执行架构

代码通过条件编译和运行时检测支持三种执行模式：

1. **HLS Test Mode (`HLS_TEST`)**：用于高层综合（High-Level Synthesis）验证。在此模式下，代码不链接FPGA比特流，而是使用C/RTL协同仿真，验证算法正确性。这是开发周期的早期阶段，关注功能正确性而非性能。

2. **Hardware Emulation Mode (`hw_emu`)**：在软件仿真器中运行FPGA逻辑，无需实际硬件。这允许在实际烧录前验证Host-FPGA交互逻辑、内存映射和OpenCL队列行为。`timestep` 在此模式下被硬编码为10以加速仿真。

3. **Hardware Mode (`hw`)**：在真实FPGA硬件上执行，使用从 `-xclbin` 参数加载的比特流文件。这是生产环境，追求最大性能。

这种多模式架构体现了**开发效率与运行时性能的权衡**：同一代码库支持从算法验证到生产部署的全生命周期，但增加了条件编译的复杂性。

#### 参数解析与配置（`ArgParser`）

`ArgParser` 类实现了一个简单的命令行解析器，支持 `-xclbin` 参数指定比特流路径。这是一个**最小可行实现（MVP）**：它只解析单个参数，没有使用 `getopt` 或 `boost::program_options` 等库，避免了外部依赖，但牺牲了扩展性。

关键配置参数包括：
- **XCLBIN Path**：FPGA比特流文件路径，包含编译好的 `scanTreeKernel` 硬件逻辑。
- **Run Mode**：通过环境变量 `XCL_EMULATION_MODE` 自动检测，无需手动指定。

#### 黄金参考值（Golden Values）与验证策略

代码中硬编码了一组 `golden` 值，对应不同 `timestep`（10, 50, 100, 500, 1000）下的期望NPV（净现值）：

```cpp
if (timestep == 10) golden = -0.00020198789915012378;
if (timestep == 50) golden = -0.0002019878994616189;
// ...
```

这揭示了一个**关键验证策略**：由于金融衍生品定价没有简单的解析解（特别是含提前执行的百慕大式产品），模块采用**收敛性验证（Convergence Testing）**。随着 timestep 增加，离散化误差减小，NPV 应收敛到理论值。

这种验证方式隐含了**数值分析的专业知识**：
1. **稳定性**：Hull-White三叉树算法是数值稳定的，timestep 增加不会导致爆炸性误差。
2. **单调收敛**：误差随 timestep 增加单调递减，不会出现振荡。
3. **容差设定**：`minErr = 10e-10` 定义了验证通过阈值，平衡了数值精度与硬件浮点误差。

### Hull-White 模型参数结构（`ScanInputParam0` / `ScanInputParam1`）

代码中使用了两个关键数据结构 `ScanInputParam0` 和 `ScanInputParam1`（具体定义未在片段中展示，但从使用方式可推断其结构），它们是**金融模型语义到硬件数据通路的桥梁**。

#### `ScanInputParam1`：模型动态参数

```cpp
inputParam1_alloc[i].a = 0.055228873373796609;      // 均值回归速度
inputParam1_alloc[i].sigma = 0.0061062754654949824; // 波动率
inputParam1_alloc[i].flatRate = 0.04875825;         // 平准利率
inputParam1_alloc[i].fixedRate = fixedRate;         // 互换固定票息
inputParam1_alloc[i].timestep = timestep;           // 离散化步数
```

这些参数定义了**风险中性测度下的利率动态**：
- **$a$（均值回归速度）**：控制利率向长期均值回归的快慢。较大的$a$意味着利率快速回归，树结构的空间离散范围较窄；较小的$a$允许利率长期偏离，需要更宽的空间离散。
- **$\sigma$（波动率）**：年化波动率，直接影响三叉树的步长大小（space step）。在Hull-White模型中，空间步长 $\Delta r$ 通常与 $\sigma\sqrt{3\Delta t}$ 成正比。
- **Flat Rate**：用于构建即期利率曲线的简化假设。在实际生产系统中，这里会替换为完整的即期曲线（zero curve），但示例代码使用flat rate简化。

#### `ScanInputParam0`：产品结构参数

```cpp
inputParam0_alloc[i].x0 = 0.0;           // 初始短期利率
inputParam0_alloc[i].nominal = 1000.0;   // 名义本金
inputParam0_alloc[i].spread = 0.0;       // 浮动利差
for (int j = 0; j < initSize; j++) {
    inputParam0_alloc[i].initTime[j] = initTime[j]; // 支付时间表
}
```

这些参数定义了**金融产品的现金流结构**：
- **Nominal（名义本金）**：互换合约的基础金额，所有现金流计算基于此。
- **Spread（利差）**：浮动利率腿相对于参考利率（如LIBOR）的固定利差。
- **InitTime[]**：一个包含12个时间点的数组，定义了互换的支付时间表。从值来看（0, 1, 1.4958..., 2...），这代表一个非标准的互换结构，支付日不是完全规则的（可能考虑了实际天数/365的计息惯例）。

#### 百慕大执行特性（Bermudan Exercise）

```cpp
int exerciseCnt[5] = {0, 2, 4, 6, 8};  // 可执行日期索引
int fixedCnt[5] = {0, 2, 4, 6, 8};     // 固定腿支付计数
int floatingCnt[10] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}; // 浮动腿支付计数
```

这些计数器定义了**百慕大式期权的执行结构**：
- **ExerciseCnt**：包含5个可能的执行日期索引（0, 2, 4, 6, 8），对应 `initTime` 数组中的位置。在这些时间点，持有者可以选择进入底层的利率互换。
- **FixedCnt / FloatingCnt**：分别对应固定腿和浮动腿的支付时间点。注意浮动腿有10个支付点（更频繁，通常是每半年或每季度），而固定腿有5个（可能每年一次）。

这种结构对应现实中的**百慕大式互换期权（Bermudan Swaption）**：持有者可以在未来一系列特定日期（但不是任意日期，因此不是美式）选择进入利率互换。这种灵活性使得定价必须在每个执行日期比较立即执行的价值与继续持有期权的价值，取较大者——这正是需要在三叉树上进行 backward induction 的核心原因。
