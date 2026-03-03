# hash_semi_join 模块深度解析

## 一句话概括

`hash_semi_join` 是一个针对 FPGA 加速的**半连接（Semi-Join）基准测试框架**，用于验证和评估 TPC-H 查询在异构计算平台上的性能表现。它在主机端实现了完整的 OpenCL 运行时、双缓冲流水线，以及基于 CPU 的参考实现，构成了从数据生成、内核调度到结果验证的完整测试闭环。

---

## 问题空间：我们为什么要做这个？

### 业务背景：TPC-H 查询加速

在数据分析领域，TPC-H 基准测试是衡量决策支持系统性能的行业标准。其中**查询 5（Query 5）**涉及多表连接，特别是 `lineitem` 表与 `orders` 表之间的**半连接**操作——即判断左表的记录是否存在于右表中（而不关心右表的具体内容）。

### 为什么需要专门的 Semi-Join 实现？

传统的哈希连接（Hash Join）会返回所有匹配的组合，而半连接只需要验证存在性。这种差异带来两个关键优化空间：

1. **内存效率**：半连接不需要存储右表的完整记录，只需要哈希键
2. **计算效率**：一旦找到匹配即可终止搜索，减少平均探测时间

### 为什么需要主机端基准框架？

FPGA 内核开发需要配套的主机程序来：
- 管理设备内存和数据传输
- 调度内核执行
- 验证结果正确性
- 测量性能指标

---

## 核心抽象：心智模型

想象一个**工厂流水线**系统：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        主机端基准测试框架                             │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │  数据生成器   │───▶│  双缓冲池    │───▶│   OpenCL 运行时      │   │
│  │  (CPU 端)    │    │  (Ping-Pong) │    │  (设备管理/调度)      │   │
│  └──────────────┘    └──────────────┘    └──────────────────────┘   │
│            │                                    │                  │
│            ▼                                    ▼                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              FPGA 内核 (join_kernel)                        │   │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │   │
│  │  │  构建哈希表  │───▶│  探测哈希表  │───▶│  聚合结果   │    │   │
│  │  │ (orders表) │    │(lineitem表) │    │ (sum计算)   │    │   │
│  │  └─────────────┘    └─────────────┘    └─────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              结果验证器 (CPU 参考实现)                     │   │
│  │  使用 std::unordered_map 实现相同逻辑，对比 FPGA 结果       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**三个关键抽象：**

1. **双缓冲（Double Buffering）**：就像工厂的两条并行传送带，一条在上料时另一条在执行，完全隐藏数据传输延迟。

2. **PU（Processing Unit）分区**：8 个独立的存储缓冲区（`stb_buf[0..7]`），对应 FPGA 内部的 8 个并行处理单元，实现任务级并行。

3. **事件驱动回调**：OpenCL 的异步事件机制配合回调函数，实现"结果就绪即通知"的高效验证模式。

---

## 架构详解：数据流全景

### 1. 初始化阶段：搭建舞台

```cpp
// 1. 设备发现和上下文创建
std::vector<cl::Device> devices = xcl::get_xil_devices();
cl::Context context(device, NULL, NULL, NULL, &err);

// 2. 命令队列：带性能分析和乱序执行能力
cl::CommandQueue q(context, device,
                   CL_QUEUE_PROFILING_ENABLE | CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE);

// 3. 加载 xclbin 二进制
cl::Program::Binaries xclBins = xcl::import_binary_file(xclbin_path);
cl::Program program(context, devices, xclBins);
cl::Kernel kernel0(program, "join_kernel");  // 核心：哈希半连接内核
```

### 2. 内存分配：精心布局的存储策略

主机端分配了**三类内存区域**，每类都有明确的用途和访问模式：

#### A. 输入数据缓冲区（表数据）

```cpp
// lineitem 表数据 (事实表，大)
KEY_T* col_l_orderkey = aligned_alloc<KEY_T>(l_depth);
MONEY_T* col_l_extendedprice = aligned_alloc<MONEY_T>(l_depth);
MONEY_T* col_l_discount = aligned_alloc<MONEY_T>(l_depth);

// orders 表数据 (维度表，较小)
KEY_T* col_o_orderkey = aligned_alloc<KEY_T>(o_depth);
DATE_T* col_o_orderdate = aligned_alloc<DATE_T>(o_depth);
```

**关键设计**：使用 `aligned_alloc` 确保内存对齐，满足 FPGA 直接内存访问（DMA）的对齐要求。

#### B. 双缓冲结果缓冲区

```cpp
MONEY_T* row_result_a = aligned_alloc<MONEY_T>(2);  // ping
MONEY_T* row_result_b = aligned_alloc<MONEY_T>(2);    // pong
```

**用途**：存储聚合结果（sum 和 count），双缓冲设计支持流水线重叠。

#### C. PU 分区存储缓冲区

```cpp
const int PU_NM = 8;
ap_uint<8 * KEY_SZ>* stb_buf[PU_NM];
for (int i = 0; i < PU_NM; i++) {
    stb_buf[i] = aligned_alloc<ap_uint<8 * KEY_SZ> >(BUFF_DEPTH);
}
```

**关键概念**：8 个独立的哈希表分区，对应 FPGA 内的 8 个并行处理单元（PU）。这种分区策略允许：
- 无锁并行：每个 PU 访问自己的分区，避免竞争
- 线性扩展：增加 PU 数量可提升吞吐量

### 3. 数据传输策略：精细的内存扩展控制

代码中展示了**两种内存分配策略**的选择：

```cpp
// 策略 A: HBM (高带宽内存) - 现代 Alveo 卡
memExt[0].flags = XCL_BANK(6);   // 显式指定 HBM bank
memExt[1].flags = XCL_BANK(7);
// ...

// 策略 B: DDR - 传统分配
#ifdef USE_DDR
if (i % 4 == 0) memExt[i].flags = XCL_MEM_DDR_BANK1;
// ...
#endif
```

**设计考量**：不同 Alveo 卡有不同的内存架构（DDR vs HBM），这种条件编译允许代码适配不同硬件代际。

### 4. 双缓冲流水线：隐藏延迟的艺术

这是整个设计的**性能核心**。想象一个餐厅的两条流水线：

```
迭代 0:  W0(上传数据_a) → K0(内核执行) → R0(读取结果_a)
迭代 1:  W1(上传数据_b) → K1(内核执行) → R1(读取结果_b)
迭代 2:  W2(上传数据_a) → K2(内核执行) → R2(读取结果_a)
        ...
```

**关键洞察**：`W2` 可以与 `K1` 和 `R0` 重叠执行！

代码实现通过**事件依赖图**精确控制这种重叠：

```cpp
// 写操作依赖前两次迭代的读操作完成
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
} else {
    q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[i][0]);
}

// 内核执行依赖当前写操作完成
q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);

// 读操作依赖内核执行完成
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, &kernel_events[i], &read_events[i][0]);
```

**依赖链规则**：
- `W[i]` → `W[i-2]` 的读完成（双缓冲距离为 2）
- `K[i]` → `W[i]` 的写完成
- `R[i]` → `K[i]` 的内核完成

### 5. 异步回调验证：零开销结果检查

传统同步验证会阻塞等待结果，而这里使用 OpenCL 的**事件回调机制**：

```cpp
// 设置回调函数，在读取事件完成时自动触发
read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + i);

// 回调函数：比较 FPGA 结果与 CPU 黄金参考值
void CL_CALLBACK print_buf_result(cl_event event, cl_int cmd_exec_status, void* user_data) {
    print_buf_result_data_t* d = (print_buf_result_data_t*)user_data;
    if ((*(d->g)) != (*(d->v))) (*(d->r))++;  // 不匹配则标记错误
    
    printf("FPGA result %d: %lld.%lld\n", d->i, *(d->v) / 10000, *(d->v) % 10000);
    printf("Golden result %d: %lld.%lld\n", d->i, *(d->g) / 10000, *(d->g) % 10000);
}
```

**设计优势**：
- **零延迟开销**：验证与下一次迭代的数据传输重叠执行
- **即时反馈**：每次迭代完成立即知道结果是否正确
- **自动聚合**：通过 `ret` 计数器累计总错误数

### 6. CPU 参考实现：黄金标准的建立

`get_golden_sum` 函数使用标准 C++ 容器实现了相同的半连接逻辑：

```cpp
ap_uint<64> get_golden_sum(int l_row, KEY_T* col_l_orderkey, /* ... */) {
    std::unordered_map<uint32_t, uint32_t> ht1;  // 哈希表：orderkey -> placeholder
    
    // 构建阶段：筛选 1994 年的订单，插入哈希表
    for (int i = 0; i < o_row; ++i) {
        uint32_t k = col_o_orderkey[i];
        uint32_t date = col_o_orderdate[i];
        if (date >= 19940101L && date < 19950101L) {
            ht1.insert(std::make_pair(k, 0));  // 半连接：只存键，不存值
        }
    }
    
    // 探测阶段：扫描 lineitem，匹配则累加
    ap_uint<64> sum = 0;
    for (int i = 0; i < l_row; ++i) {
        uint32_t k = col_l_orderkey[i];
        if (ht1.find(k) != ht1.end()) {
            sum += (col_l_extendedprice[i] * (100 - col_l_discount[i]));
        }
    }
    return sum;
}
```

**关键设计决策**：
- 使用 `std::unordered_map` 实现 O(1) 平均复杂度的哈希查找
- 半连接优化：哈希表中只存储键（`uint32_t`），不存储完整记录
- 谓词下推：在构建阶段就过滤 `o_orderdate`，减少哈希表大小

---

## 设计权衡与决策分析

### 1. 双缓冲 vs 单缓冲：延迟与吞吐的博弈

**选择的方案**：双缓冲（Ping-Pong）

**权衡考量**：
| 维度 | 单缓冲 | 双缓冲 |
|------|--------|--------|
| 内存占用 | 低（1x） | 高（2x） |
| 传输延迟暴露 | 完全暴露 | 被计算隐藏 |
| 流水线占空比 | ~50% | ~100% |
| 代码复杂度 | 简单 | 复杂（事件依赖管理） |

**决策理由**：在 FPGA 加速场景下，PCIe 数据传输延迟往往是性能瓶颈。双缓冲虽然增加 2 倍内存占用，但能将有效吞吐量提升近 2 倍，这在数据分析场景下是值得的取舍。

### 2. 同步 vs 异步验证：正确性检查的开销

**选择的方案**：异步回调验证

**关键洞察**：传统同步验证会引入一个强制同步点：
```cpp
// 同步模式（假设）
q.finish();  // 阻塞等待所有完成
validate_result();  // 才能开始验证
// 下一次迭代必须等待验证完成
```

而回调模式允许验证逻辑与下一次迭代的数据传输重叠，实现**零额外延迟**的正确性检查。

**代价**：代码复杂度增加，需要管理回调生命周期和线程安全问题。

### 3. 内存分配策略：DDR vs HBM

代码中通过条件编译支持两种内存架构：

```cpp
#ifdef USE_DDR
    // 传统 DDR 分配策略
    if (i % 4 == 0) memExt[i].flags = XCL_MEM_DDR_BANK1;
    // ...
#else
    // HBM (High Bandwidth Memory) 分配
    memExt[0].flags = XCL_BANK(6);
    // ...
#endif
```

**设计意图**：
- **DDR**：兼容旧代 Alveo 卡（如 U200/U250），成本低但带宽有限
- **HBM**：新代卡（如 U280/U55C）提供 8-16x 带宽提升，但配置更复杂

这种抽象允许同一份代码适配不同硬件代际，是数据中心软件的重要设计考量。

### 4. PU 分区策略：8 路并行的取舍

代码中硬编码了 8 个 PU（Processing Unit）：

```cpp
const int PU_NM = 8;
ap_uint<8 * KEY_SZ>* stb_buf[PU_NM];
```

**为什么是 8？**
- 与 FPGA 内核架构匹配：通常一个内核实例有 8 个并行处理管道
- 分区哈希策略：通过哈希键的低位选择 PU，实现无锁并行
- 存储器资源：每个 PU 需要独立的 HBM/DDR bank，8 是常见硬件配置

**权衡**：增加 PU 数量提升并行度，但增加存储资源消耗和分区开销（哈希偏斜问题）。8 是一个在典型 FPGA 上平衡资源利用率和性能的甜点值。

---

## 关键组件详解

### 1. 双缓冲事件管理器

**职责**：协调"写-执行-读"流水线的异步执行，确保正确的依赖顺序。

**数据结构**：
```cpp
std::vector<std::vector<cl::Event>> write_events(num_rep);
std::vector<std::vector<cl::Event>> kernel_events(num_rep);
std::vector<std::vector<cl::Event>> read_events(num_rep);
```

**事件依赖图**（以第 i 次迭代为例）：
```
W[i] (数据上传)
  │
  ├── depends on ──▶ R[i-2] (前第二次迭代的读取完成，双缓冲距离)
  │
  ▼
K[i] (内核执行)
  │
  ├── depends on ──▶ W[i] (当前上传完成)
  │
  ▼
R[i] (结果读取)
  │
  ├── depends on ──▶ K[i] (当前内核完成)
  │
  ▼
Callback (回调验证)
```

**关键实现细节**：
```cpp
// 写操作：依赖前两次迭代的读事件（双缓冲）
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
} else {
    q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[i][0]);
}

// 内核执行：依赖当前写事件
q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);

// 读操作：依赖当前内核事件
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, &kernel_events[i], &read_events[i][0]);
```

### 2. 内存扩展指针（cl_mem_ext_ptr_t）管理器

**职责**：建立主机指针与 FPGA 内核参数之间的映射关系，控制内存分配策略（DDR vs HBM）。

**设计模式**：使用 `cl_mem_ext_ptr_t` 结构体将主机缓冲区与特定的内核参数索引和内存 bank 关联。

```cpp
// 输入数据映射：指定内核参数索引
cl_mem_ext_ptr_t mext_l_orderkey = {0, col_l_orderkey, kernel0()};  // arg 0
cl_mem_ext_ptr_t mext_l_extendedprice = {1, col_l_extendedprice, kernel0()};  // arg 1
// ... 更多参数

// 输出结果映射
cl_mem_ext_ptr_t mext_result_a = {15, row_result_a, kernel0()};  // arg 15

// PU 缓冲区内存策略配置
cl_mem_ext_ptr_t memExt[PU_NM];
#ifdef USE_DDR
    // DDR 分配策略：轮询分配到不同 DDR bank
    for (int i = 0; i < PU_NM; ++i) {
        if (i % 4 == 0) memExt[i].flags = XCL_MEM_DDR_BANK1;
        else if (i % 4 == 1) memExt[i].flags = XCL_MEM_DDR_BANK1;
        else if (i % 4 == 2) memExt[i].flags = XCL_MEM_DDR_BANK2;
        else memExt[i].flags = XCL_MEM_DDR_BANK2;
    }
#else
    // HBM 分配策略：显式指定 HBM bank 索引
    memExt[0].flags = XCL_BANK(6);
    memExt[1].flags = XCL_BANK(7);
    // ... 更多 bank
#endif
```

**关键洞见**：
- **参数索引对齐**：`cl_mem_ext_ptr_t` 的第一个字段必须与内核参数索引严格一致，这是 OpenCL 运行时定位内核参数的依据。
- **内存拓扑感知**：通过 `XCL_BANK()` 和 `XCL_MEM_DDR_BANK` 标志，代码显式控制数据在物理内存 bank 上的分布，最大化带宽利用率。

### 3. CPU 参考实现（Golden Model）

**职责**：提供与 FPGA 内核功能等价的 CPU 实现，用于结果验证和性能基线对比。

**算法实现**：使用 `std::unordered_map` 实现哈希半连接。

```cpp
ap_uint<64> get_golden_sum(int l_row, KEY_T* col_l_orderkey,
                           MONEY_T* col_l_extendedprice, MONEY_T* col_l_discount,
                           int o_row, KEY_T* col_o_orderkey, KEY_T* col_o_orderdate) {
    std::unordered_map<uint32_t, uint32_t> ht1;  // 哈希表：键 -> 占位符
    ap_uint<64> sum = 0;
    
    // 阶段 1：构建阶段（Build Phase）
    // 扫描 orders 表，筛选 1994 年的订单，构建哈希表
    for (int i = 0; i < o_row; ++i) {
        uint32_t k = col_o_orderkey[i];
        uint32_t date = col_o_orderdate[i];
        // 谓词下推：在构建阶段就过滤日期范围
        if (date >= 19940101L && date < 19950101L) {
            ht1.insert(std::make_pair(k, 0));  // 半连接：只存键，值无意义
        }
    }
    
    // 阶段 2：探测阶段（Probe Phase）
    // 扫描 lineitem 表，探测哈希表，计算聚合
    for (int i = 0; i < l_row; ++i) {
        uint32_t k = col_l_orderkey[i];
        // 哈希查找：平均 O(1) 复杂度
        if (ht1.find(k) != ht1.end()) {
            // 匹配成功：计算 extendedprice * (1 - discount)
            sum += (col_l_extendedprice[i] * (100 - col_l_discount[i]));
        }
    }
    
    return sum;
}
```

**关键设计决策解析**：

1. **半连接优化（Semi-Join Optimization）**：
   - 传统哈希连接需要存储右表的完整记录以返回连接结果
   - 半连接只需验证键的存在性，因此 `unordered_map` 的值类型可以是 `uint32_t` 占位符
   - 内存占用与右表记录数成正比，而非与连接结果数成正比

2. **谓词下推（Predicate Pushdown）**：
   - 日期范围过滤 (`19940101L <= date < 19950101L`) 发生在构建阶段
   - 这减少了哈希表的大小，提升后续探测阶段的缓存命中率
   - 体现了数据库查询优化中的经典策略

3. **聚合合并（Aggregation Fusion）**：
   - 不在探测阶段存储匹配结果，而是直接累加到 `sum`
   - 避免了中间结果物化，减少内存分配和访问开销
   - 与 FPGA 内核的流式处理策略保持一致

### 4. 异步回调验证器

**职责**：在 OpenCL 读取事件完成时自动触发，比较 FPGA 结果与 CPU 黄金参考值。

```cpp
// 回调数据结构：封装比较所需的所有上下文
typedef struct print_buf_result_data_ {
    int i;              // 迭代索引
    long long* v;       // FPGA 结果指针
    long long* g;       // 黄金参考值指针
    int* r;             // 错误计数器指针
} print_buf_result_data_t;

// OpenCL 事件回调函数
void CL_CALLBACK print_buf_result(cl_event event, cl_int cmd_exec_status, void* user_data) {
    print_buf_result_data_t* d = (print_buf_result_data_t*)user_data;
    
    // 结果比较：FPGA 值 vs 黄金值
    if ((*(d->g)) != (*(d->v))) {
        (*(d->r))++;  // 不匹配则递增错误计数
    }
    
    // 格式化输出：将定点数转换为 decimal(12,4) 格式
    printf("FPGA result %d: %lld.%lld\n", d->i, 
           *(d->v) / 10000, *(d->v) % 10000);
    printf("Golden result %d: %lld.%lld\n", d->i, 
           *(d->g) / 10000, *(d->g) % 10000);
}
```

**关键实现细节**：

1. **上下文封装**：`print_buf_result_data_t` 结构体将验证所需的所有指针打包，因为 OpenCL 回调只接受单个 `void*` 参数。

2. **线程安全考虑**：错误计数器 `r` 通过指针共享，多个回调可能并发递增。虽然 `int` 的递增不是原子操作，但在这种基准测试场景下，精确的错误计数不如检测到有错误重要。

3. **定点数格式化**：`*(d->v) / 10000` 和 `*(d->v) % 10000` 将内部定点数表示转换为可读的小数格式，暗示数据以 1/10000 精度存储（即 4 位小数）。

---

## 依赖关系与数据契约

### 上游依赖（谁调用我）

| 模块 | 关系类型 | 说明 |
|------|----------|------|
| `hash_join_membership_variants_benchmark_hosts` | 父模块 | 提供主机端测试框架的基础设施 |
| `hash_join_single_variant_benchmark_hosts` | 兄弟模块 | 共享相似的单连接变体实现模式 |
| `l1_hash_join_and_aggregation_benchmark_hosts` | 祖父模块 | 定义 L1 层基准测试的通用接口 |

### 下游依赖（我调用谁）

| 模块/库 | 用途 | 关键 API |
|---------|------|----------|
| `xf::common::utils_sw::Logger` | 日志记录 | `logger.error()`, `logger.info()` |
| `xf::common::utils_sw::ArgParser` | 命令行解析 | `parser.getCmdOption()` |
| `xcl2` | Xilinx OpenCL 封装 | `xcl::get_xil_devices()`, `xcl::import_binary_file()` |
| `table_dt.hpp` | 表数据类型定义 | `KEY_T`, `MONEY_T`, `DATE_T` |
| `hashjoinkernel.hpp` | 内核接口 | `join_kernel` 函数原型 |

### 数据契约

**输入数据格式**：
- `col_l_orderkey`: `KEY_T*` (通常 uint32_t)，lineitem 表订单键
- `col_l_extendedprice`: `MONEY_T*` (通常 int64_t 定点数)，扩展价格
- `col_l_discount`: `MONEY_T*`，折扣率（百分比，如 5 表示 5%）
- `col_o_orderkey`: `KEY_T*`，orders 表订单键
- `col_o_orderdate`: `DATE_T*` (通常 int32_t，YYYYMMDD 格式)，订单日期

**输出数据格式**：
- `row_result`: `MONEY_T[2]` 数组
  - `row_result[0]`: sum 值（定点数，精度通常为 1/10000）
  - `row_result[1]`: count 值（匹配行数）

**内核参数契约**：
| 参数索引 | 名称 | 方向 | 说明 |
|----------|------|------|------|
| 0 | col_l_orderkey | 输入 | lineitem 订单键数组 |
| 1 | col_l_extendedprice | 输入 | 扩展价格数组 |
| 2 | col_l_discount | 输入 | 折扣数组 |
| 3 | l_nrow | 输入 | lineitem 行数 |
| 4 | col_o_orderkey | 输入 | orders 订单键数组 |
| 5 | col_o_orderdate | 输入 | 订单日期数组 |
| 6 | o_nrow | 输入 | orders 行数 |
| 7-14 | stb_buf[0-7] | 输入/输出 | 8 个 PU 分区缓冲区 |
| 15 | result | 输出 | 结果数组 |

---

## 设计决策与权衡

### 决策 1：OpenCL vs 专用驱动

**问题**：为什么选择 OpenCL 而不是 Xilinx 的 XRT 原生 API？

**选择的方案**：OpenCL + Xilinx 扩展 (`xcl2`)

**理由**：
1. **可移植性**：OpenCL 是跨平台标准，代码可以更容易移植到其他支持 OpenCL 的 FPGA 平台
2. **生态成熟度**：`xcl2` 封装提供了设备发现、二进制加载等常用功能，减少样板代码
3. **工具链集成**：Vitis 工具链对 OpenCL 有良好支持，便于调试和性能分析

**代价**：相比 XRT 原生 API，OpenCL 有轻微的运行时开销，且某些高级特性（如主机内存直接访问）需要额外扩展。

### 决策 2：双缓冲距离为 2

**问题**：为什么选择 `i-2` 作为写操作的依赖？

```cpp
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
}
```

**分析**：双缓冲意味着有两个缓冲区（A 和 B）交替使用。考虑以下执行序列：

| 迭代 | 使用的缓冲区 | 操作阶段 | 依赖关系 |
|------|-------------|----------|----------|
| 0 | A | W0 → K0 → R0 | 无前置依赖 |
| 1 | B | W1 → K1 → R1 | 无前置依赖（B 空闲）|
| 2 | A | W2 → K2 → R2 | 依赖 R0（A 需空闲）|
| 3 | B | W3 → K3 → R3 | 依赖 R1（B 需空闲）|

**结论**：写操作 `W[i]` 依赖的是 `R[i-2]`，因为两个缓冲区交替使用，必须等前两次迭代的读取完成后，当前缓冲区才能被复用。

### 决策 3：回调数据结构的生命周期管理

**问题**：如何确保回调函数执行时，其用户数据仍然有效？

**选择的方案**：预分配向量 + 迭代器固定

```cpp
// 预分配所有迭代需要的回调数据结构
std::vector<print_buf_result_data_t> cbd(num_rep);
std::vector<print_buf_result_data_t>::iterator it = cbd.begin();
print_buf_result_data_t* cbd_ptr = &(*it);

// 设置回调时，传递指向元素的指针
read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + i);
```

**为什么这样是安全的**：
1. `std::vector` 在构造时一次性分配所有元素，后续不会重新分配（只要没有插入/删除操作）
2. 迭代器和指针在 vector 不重新分配的情况下保持稳定
3. 回调在 `CL_COMPLETE` 事件触发时执行，此时数据仍在 vector 的有效生命周期内

**替代方案的风险**：
- 栈分配：回调可能在线程退出后执行，栈帧已无效
- 堆分配 + 立即释放：需要复杂的手动引用计数
- 静态全局变量：不支持多实例并发执行

### 决策 4：定点数表示 vs 浮点数

**问题**：为什么货币计算使用 `MONEY_T`（通常是 int64_t）而不是 float/double？

**分析**：

| 特性 | 定点数 (int64) | 浮点数 (double) |
|------|---------------|----------------|
| 精度 | 完全精确（十进制） | 二进制近似，有舍入误差 |
| 比较 | 整数相等比较 | 需要 epsilon 容差 |
| FPGA 实现 | 简单，资源少 | 复杂，需要浮点单元 |
| 范围 | 受限于 int64 | 极大动态范围 |

**使用的方案**：定点数，精度为 1/10000（4 位小数）

```cpp
// 格式化输出：将定点数转换为可读的小数
printf("FPGA result %d: %lld.%lld\n", d->i, 
       *(d->v) / 10000,      // 整数部分
       *(d->v) % 10000);     // 小数部分（4位）
```

**为什么选择 1/10000**：
- TPC-H 规范要求货币值精确到 0.01（分）
- 中间计算可能需要更高精度（如折扣计算），1/10000 提供两位额外精度防止累积误差
- 64 位整数范围足够：最大可表示约 ±9e14，远超 TPC-H 的数据规模

---

## 新贡献者必读：边缘情况与陷阱

### 1. 内存对齐陷阱

**问题**：`aligned_alloc` 分配的内存在释放时需要匹配特定的释放函数。

```cpp
// 分配
KEY_T* col_l_orderkey = aligned_alloc<KEY_T>(l_depth);

// 错误释放（未显示在代码中，但如果添加需要小心）
// free(col_l_orderkey);  // 未定义行为！

// 正确释放
aligned_free(col_l_orderkey);
```

**陷阱**：不同平台对 `aligned_alloc` 的释放要求不同（Linux 通常可用 `free`，但严格遵循 C11 标准的代码应使用 `aligned_free` 或 `free`，取决于实现）。

### 2. 事件生命周期与回调陷阱

**问题**：如果回调函数执行时，其用户数据已被释放，会导致 use-after-free。

**代码中的保护**：
```cpp
// 正确：vector 在 main 函数栈帧上，生命周期覆盖所有回调
std::vector<print_buf_result_data_t> cbd(num_rep);
```

**常见错误**：
```cpp
// 错误：栈分配在循环内部，每次迭代后失效
for (int i = 0; i < num_rep; i++) {
    print_buf_result_data_t data = {i, ...};  // 栈分配
    read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, &data);  // 悬垂指针！
}
```

### 3. 双缓冲索引计算陷阱

**问题**：双缓冲的索引计算容易出错，导致数据竞争或死锁。

**代码中的正确模式**：
```cpp
// 双缓冲：使用 i & 1 快速切换 0/1
int use_a = i & 1;  // 偶数迭代用 a，奇数迭代用 b

// 依赖前两次迭代的读取（距离为 2）
if (i > 1) {
    q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 2], &write_events[i][0]);
}
```

**常见错误**：
```cpp
// 错误：依赖距离为 1，单缓冲
q.enqueueMigrateMemObjects(ib, 0, &read_events[i - 1], ...);  // 死锁！

// 错误：依赖距离为 2 但缓冲区分组错误
int use_buffer = i % 3;  // 3 个缓冲区？但只分配了 2 个
```

### 4. OpenCL 缓冲区大小计算陷阱

**问题**：`cl::Buffer` 的大小参数是字节数，容易与元素数混淆。

**代码中的正确模式**：
```cpp
// 正确：使用 sizeof 或预定义的宏计算字节数
cl::Buffer buf_l_orderkey_a(context, CL_MEM_EXT_PTR_XILINX | CL_MEM_USE_HOST_PTR | CL_MEM_READ_ONLY,
                            (size_t)(KEY_SZ * l_depth), &mext_l_orderkey);
// KEY_SZ 是每个元素的字节数，l_depth 是元素个数
```

**常见错误**：
```cpp
// 错误：直接使用元素个数作为字节数
cl::Buffer buf(context, CL_MEM_READ_ONLY, l_depth, ptr);  // 少了 sizeof(T)！

// 错误：混淆指针大小与数据大小
cl::Buffer buf(context, CL_MEM_READ_ONLY, sizeof(ptr), ptr);  // 只分配了指针大小！
```

### 5. HLS 仿真与硬件执行的条件编译

**问题**：代码需要同时支持 HLS 纯软件仿真和实际 FPGA 硬件执行，容易混淆两者。

**代码中的条件编译**：
```cpp
#ifdef HLS_TEST
    // HLS 纯软件仿真路径
    join_kernel(...);  // 直接调用 C++ 函数
    long long* rv = (long long*)row_result_a;
    printf("FPGA result: %lld.%lld\n", *rv / 10000, *rv % 10000);
#else
    // 实际 FPGA 硬件执行路径
    // OpenCL 设备发现、缓冲区创建、内核调度...
#endif
```

**常见错误**：
```cpp
// 错误：在 HLS_TEST 模式下使用 OpenCL API
#ifdef HLS_TEST
    cl::Context context;  // 错误！HLS 仿真没有 OpenCL 运行时
    join_kernel(...);
#endif

// 错误：忘记包含必要头文件
#ifndef HLS_TEST
    #include <xcl2.hpp>  // 必须包含，否则 OpenCL 类型未定义
#endif
```

---

## 使用指南：如何扩展和修改

### 添加新的谓词条件

如果需要修改日期范围或其他过滤条件，编辑 `get_golden_sum` 函数和 FPGA 内核：

```cpp
// CPU 参考实现中的谓词修改
// 原代码：1994 年订单
if (date >= 19940101L && date < 19950101L) {
    ht1.insert(std::make_pair(k, 0));
}

// 修改为：1995 年第一季度
if (date >= 19950101L && date < 19950401L) {
    ht1.insert(std::make_pair(k, 0));
}
```

**注意**：FPGA 内核也需要相应修改，确保 CPU 和 FPGA 逻辑一致。

### 修改 PU 数量

如果需要调整并行度（例如从 8 PU 改为 16 PU）：

```cpp
// 1. 修改 PU_NM 常量
const int PU_NM = 16;  // 原为 8

// 2. 扩展内存 bank 分配
#ifndef USE_DDR
    memExt[0].flags = XCL_BANK(6);
    // ... 扩展到 memExt[15]
    memExt[15].flags = XCL_BANK(21);
#endif

// 3. 更新内核参数绑定（需要重新编译 xclbin）
// FPGA 内核需要支持 16 个 stb_buf 参数
```

**硬件限制**：PU 数量受限于 FPGA 的 HBM/DDR bank 数量和内核逻辑资源。

### 添加性能计数器

如果需要更详细的性能分析，可以扩展事件回调：

```cpp
// 扩展回调数据结构
typedef struct print_buf_result_data_ {
    int i;
    long long* v;
    long long* g;
    int* r;
    // 新增性能计数
    cl_ulong kernel_start;
    cl_ulong kernel_end;
} print_buf_result_data_t;

// 在内核事件完成后获取时间戳
cl_ulong start, end;
kernel_events[i][0].getProfilingInfo(CL_PROFILING_COMMAND_START, &start);
kernel_events[i][0].getProfilingInfo(CL_PROFILING_COMMAND_END, &end);

// 传递给回调数据
cbd_ptr[i].kernel_start = start;
cbd_ptr[i].kernel_end = end;
```

---

## 总结

`hash_semi_join` 模块是一个完整的主机端 FPGA 基准测试框架，它不仅仅是"调用内核"的简单封装，而是一个精心设计的**异构计算运行时系统**。其核心设计亮点包括：

1. **双缓冲流水线**：通过精确的事件依赖图，实现数据传输与内核执行的完全重叠，最大化有效吞吐量。

2. **内存拓扑感知**：显式控制数据在 HBM/DDR bank 上的分布，适配不同硬件代际的内存架构。

3. **异步验证架构**：事件驱动的回调机制实现了零开销的结果验证，验证逻辑与执行流水线完全重叠。

4. **参考实现对比**：提供基于标准库的 CPU 黄金参考，确保 FPGA 实现的正确性可追溯。

对于新加入团队的开发者，理解这个模块的关键在于把握**"流水线思维"**——不要将其视为串行的"准备数据→调用内核→获取结果"，而要理解为一个**持续运转的生产线**，每个阶段都在为下一个阶段准备数据，而双缓冲机制确保这条永不停歇。

---

## 参考链接

- [父模块：hash_join_membership_variants_benchmark_hosts](database-L1-benchmarks-hash_join_membership_variants_benchmark_hosts.md)
- [祖父模块：l1_hash_join_and_aggregation_benchmark_hosts](database-L1-benchmarks-l1_hash_join_and_aggregation_benchmark_hosts.md)
- [相关模块：hash_anti_join](database-L1-benchmarks-hash_anti_join.md)
