---

## 核心组件深度解析

### 1. 参数结构体：ScanInputParam0 与 ScanInputParam1

代码中使用了两个输入参数结构体来传递 Hull-White 模型的配置。虽然具体定义未在提供的代码中展示，但从使用方式可以推断其字段：

```cpp
// 产品级参数（每个交易实例不同）
struct ScanInputParam0 {
    DT x0;           // 初始短期利率
    DT nominal;      // 名义本金
    DT spread;       // 利差（用于浮动端计算）
    DT initTime[12]; // 时间网格点（年化）
};

// 模型级参数（同一批交易共享）
struct ScanInputParam1 {
    int index;       // 实例索引
    int type;        // 产品类型（Cap=0, Floor=1）
    DT fixedRate;    // 固定行权利率
    int timestep;    // 时间步数（树的高度）
    int initSize;    // 时间网格点数
    DT a;            // Hull-White 均值回归速度
    DT sigma;        // Hull-White 波动率
    DT flatRate;     // 用于贴现的平坦利率
    int exerciseCnt[5];   // 行权时间点索引
    int fixedCnt[5];      // 固定端现金流时间点
    int floatingCnt[10];  // 浮动端现金流时间点
};
```

**设计意图**：将参数分为两个结构体是出于内存布局和访问模式的优化考虑。
- `ScanInputParam0` 包含每个交易实例特有的产品级参数（名义本金、初始利率等），在 FPGA 上会存储在可重加载的寄存器组中。
- `ScanInputParam1` 包含模型级参数（Hull-White 的 `a`、`sigma` 等），同一批定价任务共享这些参数，可以存储在片上常量缓存中，减少 DDR 访问。

**为什么这样分**：FPGA 的内存层次结构中，片上 BRAM 的访问延迟是 1 个时钟周期，而 DDR 的访问延迟是数百个周期。将高频访问的模型参数放在 BRAM，将低频访问的产品参数放在 DDR，可以最大化计算吞吐量。

### 2. 内存管理：页对齐与零拷贝 DMA

```cpp
// Host 内存分配
ScanInputParam0* inputParam0_alloc = aligned_alloc<ScanInputParam0>(1);
ScanInputParam1* inputParam1_alloc = aligned_alloc<ScanInputParam1>(1);
DT* output[cu_number];
for (int i = 0; i < cu_number; i++) {
    output[i] = aligned_alloc<DT>(N * K);
}
```

**内存所有权模型**：

| 资源 | 分配者 | 所有者 | 生命周期 |
|------|--------|--------|----------|
| `inputParam0_alloc` | Host (`aligned_alloc`) | Host | `main()` 开始到结束 |
| `cl::Buffer` | XRT Runtime | XRT (RAII) | `cl::Buffer` 对象作用域 |
| FPGA 片上寄存器 | FPGA Kernel | Kernel 执行期间 | Kernel 启动到完成 |
| DDR 内存 | FPGA 硬件 | XRT (通过 Buffer 抽象) | Buffer 映射期间 |

**零拷贝 DMA（Zero-Copy DMA）原理**：

传统 DMA 需要三步：1) Host 分配内存 → 2) 复制到 DMA 缓冲区 → 3) DMA 传输到设备。零拷贝通过页对齐和虚拟内存映射，让 FPGA 直接访问 Host 物理内存，消除了第二步的拷贝开销。

`CL_MEM_USE_HOST_PTR` 标志告诉 XRT："不要分配新的设备内存，而是直接将 Host 指针映射到 FPGA 的地址空间"。`CL_MEM_EXT_PTR_XILINX` 是 Xilinx 扩展，允许通过 `cl_mem_ext_ptr_t` 结构体指定内存扩展属性（如 HBM 堆栈分配）。

**为什么用 `aligned_alloc`**：PCIe DMA 引擎要求传输的 Host 内存必须位于页边界（通常 4KB 对齐）。`malloc` 不保证对齐，而 `aligned_alloc` 可以指定对齐要求，确保 `CL_MEM_USE_HOST_PTR` 能正常工作。
