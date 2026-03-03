# hash_join_v4_sc_host 技术深度解析

## 30 秒快速理解

**hash_join_v4_sc_host** 是 FPGA 加速数据库查询的"指挥中枢"。想象一个交响乐团：FPGA 芯片是演奏家，负责执行高强度的哈希连接（Hash Join）计算；而这个 Host 模块则是指挥，负责调度数据传输、协调计算节奏、验证结果正确性。它专门处理 TPC-H 基准测试中的典型查询模式——将 `Lineitem` 表与 `Orders` 表通过 `orderkey` 进行连接并聚合计算。

---

## 问题空间：为什么要做这个模块？

### 背景：哈希连接的复杂性

在数据分析型数据库中，**哈希连接（Hash Join）** 是最关键的算子之一。当执行类似如下的 SQL 时：

```sql
SELECT SUM(l_extendedprice * (1 - l_discount))
FROM lineitem l, orders o
WHERE l_orderkey = o_orderkey;
```

数据库必须：
1. **构建阶段（Build）**：将较小的表（Orders）按连接键哈希后存入哈希表
2. **探测阶段（Probe）**：遍历较大的表（Lineitem），对每个元组计算哈希值，在哈希表中查找匹配
3. **聚合阶段**：对匹配成功的元组执行计算（如求和）

### 为什么要用 FPGA 加速？

传统 CPU 实现面临内存带宽瓶颈和指令级并行限制。FPGA 可以：
- **流水线并行**：同时处理多个元组的哈希计算、内存访问、结果累加
- **高带宽存储**：利用 HBM（高带宽内存）存储哈希表，实现 TB/s 级访问带宽
- **确定性延迟**：硬件逻辑避免了 CPU 缓存未命中和分支预测失败的抖动

### Host 侧的角色

FPGA 就像 GPU，需要 Host 侧程序来：
- 管理设备内存（HBM/DDR）分配
- 传输输入数据（表数据）到 FPGA
- 启动 Kernel 执行
- 回收结果并验证正确性
- 协调多批次数据的流水线执行（双缓冲）

**hash_join_v4_sc_host** 正是承担这一角色的生产级实现。

---

## 架构蓝图与数据流

### 系统拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   Host                                       │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────────────────────┐  │
│  │   Data Gen   │───>│ Host Buffers │───>│  OpenCL Command Queue           │  │
│  │  (Synthetic) │    │(aligned_alloc)│   │  (Out-of-order + Profiling)    │  │
│  └──────────────┘    └──────────────┘    └─────────────────────────────────┘  │
│                                                   │                         │
│                              ┌────────────────────┴────────────┐              │
│                              v                                 v              │
│  ┌─────────────────────────────────────┐    ┌────────────────────────┐       │
│  │  Golden Reference (CPU)             │    │   Result Validator     │       │
│  │  std::unordered_multimap           │───>│   (Callback Verify)    │       │
│  └─────────────────────────────────────┘    └────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │ PCIe Gen3/Gen4 x16
                                        v
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   FPGA                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ HBM Bank 0  │  │ HBM Bank 1  │...│ HBM Bank 7  │  │   Input Buffers     │   │
│  │ (Hash Table)│  │ (Hash Table)│  │ (Hash Table)│  │   (Lineitem/Orders) │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │
│         │                │                │                     │              │
│         └────────────────┴────────────────┴─────────────────────┘              │
│                                   │                                          │
│                         ┌─────────▼──────────┐                                │
│                         │  8x Processing Unit │                               │
│                         │   (join_kernel)     │                               │
│                         │  - Build & Probe    │                               │
│                         │  - Hash & Aggregate │                               │
│                         └─────────┬──────────┘                                │
│                                   │                                          │
│                         ┌─────────▼──────────┐                                │
│                         │   Result Buffer     │                               │
│                         │   (SUM value)       │                               │
│                         └─────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 核心抽象层

1. **Buffer Manager**：使用 `aligned_alloc` 分配页对齐主机内存，通过 `CL_MEM_USE_HOST_PTR` 实现零拷贝（Zero-copy）数据传输
2. **Command Orchestrator**：OpenCL 的 `cl::CommandQueue` 配置为 `OUT_OF_ORDER_EXEC_MODE_ENABLE`，允许读写和计算重叠
3. **Double Buffering（Ping-Pong）**：维护 A/B 两套输入缓冲区，实现 "Transfer-Compute-Transfer" 流水线
4. **Event Callback System**：使用 OpenCL 事件回调机制异步验证 FPGA 结果与 CPU Golden Reference

---

## 组件深度剖析

### 1. 数据结构定义

#### `timeval` 结构体

```cpp
struct timeval tv0;  // 记录起始时间戳
```

**设计意图**：使用 POSIX `gettimeofday` 进行微秒级 wall-clock 计时，测量端到端延迟。注意这不是 CPU 时钟周期计数，而是真实时间，包含数据传输和 Kernel 执行。

#### `print_buf_result_data_` 结构体

```cpp
typedef struct print_buf_result_data_ {
    int i;              // 迭代批次号
    long long* v;       // FPGA 计算结果指针
    long long* g;       // CPU Golden Reference 指针
    int* r;             // 错误计数器指针
} print_buf_result_data_t;
```

**设计意图**：这是 OpenCL 事件回调机制的上下文数据结构。当 FPGA 结果传回主机内存后，OpenCL 运行时异步调用 `print_buf_result` 回调函数，传入此结构体进行结果比对。

**内存所有权**：
- `v` 指向主机缓冲区（`row_result_a` 或 `row_result_b`），由 `main` 函数分配，回调函数仅读取
- `g` 指向栈变量 `golden` 的地址，由 CPU `get_golden_sum` 计算，需确保回调执行时 `main` 未返回
- `r` 指向 `main` 的局部变量 `ret`，用于累计错误次数

**关键风险**：回调函数在 OpenCL 后台线程执行，必须确保 `main` 函数在 `q.finish()` 完成前不退出，否则 `g` 和 `r` 指向的栈内存将失效（Use-after-free）。

### 2. 数据生成器：`generate_data`

```cpp
template <typename T>
int generate_data(T* data, int range, size_t n) {
    if (!data) { return -1; }
    for (size_t i = 0; i < n; i++) {
        data[i] = (T)(rand() % range + 1);
    }
    return 0;
}
```

**设计意图**：生成合成 TPCH 数据用于基准测试。使用 `rand()` 而非硬件随机数，确保可复现性。

**内存契约**：
- 调用者必须确保 `data` 指向已分配的缓冲区，大小至少为 `n * sizeof(T)`
- 返回 `-1` 表示空指针错误，否则返回 `0`

**性能特征**：$O(n)$ 时间复杂度，计算密集型但内存带宽友好（顺序写入）。

**陷阱**：`rand()` 不是线程安全的，且模运算 `%` 在 `range` 不是 2 的幂时存在偏置（modulo bias），对于严格随机性要求的场景不适用，但对于硬件测试足够。

### 3. CPU 黄金参考：`get_golden_sum`

```cpp
int64_t get_golden_sum(int l_row, KEY_T* col_l_orderkey, 
                       MONEY_T* col_l_extendedprice, MONEY_T* col_l_discount,
                       int o_row, KEY_T* col_o_orderkey) {
    int64_t sum = 0;
    int cnt = 0;
    std::unordered_multimap<uint32_t, uint32_t> ht1;

    // Build phase: 插入 Orders 表到哈希表
    for (int i = 0; i < o_row; ++i) {
        uint32_t k = col_o_orderkey[i];
        uint32_t p = 0; // payload 不需要，只检查存在性
        ht1.insert(std::make_pair(k, p));
    }

    // Probe phase: 遍历 Lineitem 表
    for (int i = 0; i < l_row; ++i) {
        uint32_t k = col_l_orderkey[i];
        uint32_t p = col_l_extendedprice[i];
        uint32_t d = col_l_discount[i];
        
        auto its = ht1.equal_range(k);
        for (auto it = its.first; it != its.second; ++it) {
            sum += (p * (100 - d)); // 定点数计算，避免浮点
            ++cnt;
        }
    }
    return sum;
}
```

**设计意图**：这是 FPGA 结果的**真理之源（Source of Truth）**。使用标准 C++ 容器实现最直观、最易验证的哈希连接算法，不考虑优化，只要求绝对正确。

**算法复杂度**：
- 时间：$O(O_{row} + L_{row} \cdot \alpha)$，其中 $\alpha$ 是平均冲突链长度（通常接近 1）
- 空间：$O(O_{row})$ 存储哈希表

**关键设计选择**：

1. **`std::unordered_multimap` 而非 `unordered_map`**：
   - Orders 表的 `orderkey` 可能不唯一（虽然 TPCH 中通常唯一，但代码保守处理）
   - `equal_range` 支持一对多匹配

2. **Payload 省略**：
   - 哈希表中只存 key，value 为 0，因为只需检查存在性，无需从 Orders 表取其他字段

3. **定点数计算**：
   - `p * (100 - d)` 而非浮点 `price * (1 - discount/100)`，避免浮点精度误差，与 FPGA 定点数实现保持一致

**与 FPGA 的契约**：
- 使用相同的哈希函数（隐式：FPGA 必须复现 `std::hash<uint32_t>` 的行为，通常是 identity 或 simple mod）
- 相同的连接语义（inner join）
- 相同的聚合逻辑（sum of product）

**陷阱**：
- `std::unordered_multimap` 的 `equal_range` 在 C++11 后返回 `pair<iterator, iterator>`，遍历顺序不保证，但此处只需求和，顺序无关
- 内存：当 `o_row` 很大时（如 TPCH SF100），哈希表可能占用数百 MB，确保系统内存充足

### 4. 主控逻辑：`main` 函数核心流程

由于 `main` 函数较长，本节聚焦关键设计模式。

#### 双缓冲执行流水线

```cpp
// 事件数组：管理并发依赖关系
std::vector<std::vector<cl::Event>> write_events(num_rep);
std::vector<std::vector<cl::Event>> kernel_events(num_rep);
std::vector<std::vector<cl::Event>> read_events(num_rep);

// 核心执行循环
for (int i = 0; i < num_rep; ++i) {
    int use_a = i & 1;  // 奇偶选择缓冲区
    
    // 1. 数据写入（H2D）
    // 依赖：i-2 次的读取完成（双缓冲释放）
    if (i > 1) {
        q.enqueueMigrateMemObjects(ib, 0, &read_events[i-2], &write_events[i][0]);
    } else {
        q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[i][0]);
    }
    
    // 2. Kernel 执行
    // 依赖：本次写入完成
    kernel0.setArg(...);  // 设置 A/B 缓冲区
    q.enqueueTask(kernel0, &write_events[i], &kernel_events[i][0]);
    
    // 3. 结果读取（D2H）
    // 依赖：本次 Kernel 完成
    q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, 
                              &kernel_events[i], &read_events[i][0]);
    
    // 4. 异步回调注册
    read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + i);
}
```

**流水线时序图**：

```
时间轴 ──────────────────────────────────────────────>

迭代 0:  [W0][K0][R0]                                    
迭代 1:       [W1][K1][R1]                               
迭代 2:            [W2][K2][R2]                          
迭代 3:                 [W3][K3][R3]                     

W = Write (H2D), K = Kernel, R = Read (D2H)
```

**设计原理**：双缓冲使 **传输与计算重叠**，有效吞吐率接近理论峰值（取决于 PCIe 带宽与 FPGA 计算速度的瓶颈）。单缓冲模式下，每轮必须等全部阶段完成才能开始下一轮，设备利用率低。

---

## 关键设计决策与权衡

### 1. 内存管理策略：裸指针 vs RAII

**现状**：代码使用 `aligned_alloc` + 裸指针，无自动释放。

**权衡分析**：
- **选择**：手动管理，牺牲安全性换取显式控制
- **原因**：OpenCL 对象（`cl::Buffer`）与主机指针存在复杂的生命周期交叉；过早释放会导致 DMA 错误
- **风险**：内存泄漏（当前代码缺失 `free` 调用）、Use-after-free（回调中访问已释放栈内存）

**建议改进**：使用 `std::unique_ptr<T[], decltype(&free)>` 包装主机缓冲区，保持异常安全。

### 2. 同步机制：事件链 vs 屏障

**现状**：使用细粒度的 `cl::Event` 链式依赖（`write_events[i]` → `kernel_events[i]` → `read_events[i]`）。

**权衡分析**：
- **选择**：显式事件链，最大化并发
- **替代方案**：`clFinish` 屏障同步（简单但阻塞，无法重叠）
- **收益**：双缓冲下设备利用率 > 90%（取决于 PCIe 与 FPGA 性能比）
- **代价**：代码复杂度指数增长，事件管理容易出错

### 3. 验证策略：异步回调 vs 同步比对

**现状**：`read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, ...)`。

**权衡分析**：
- **选择**：异步回调，验证与流水线重叠
- **替代方案**：`q.finish()` 后同步遍历比对（简单但阻塞）
- **风险**：回调在后台线程执行，访问 `main` 栈变量需确保 `main` 未退出；代码通过 `q.finish()` 等待所有回调完成，正确但脆弱

### 4. 随机数生成：rand() vs 现代 C++

**现状**：`rand() % range + 1`。

**权衡分析**：
- **选择**：C 标准 `rand()`，简单可移植
- **问题**：
  - 线程不安全（本代码单线程，无影响）
  - 模偏置（Modulo bias）：`% range` 在 `range` 非 2 的幂时分布不均
  - 周期短（通常 2^31），不适合大规模数据
- **建议**：生产环境应使用 `<random>` 的 `std::mt19937` 或硬件 RNG

---

## 数据流完整追踪

以单次迭代（`i = 0`，使用 Buffer A）为例，追踪数据从生成到验证的全生命周期：

### Step 1: 数据生成（主机 CPU）

```cpp
generate_data<TPCH_INT>(col_l_orderkey, 100000, l_nrow);
generate_data<TPCH_INT>(col_l_extendedprice, 10000000, l_nrow);
generate_data<TPCH_INT>(col_l_discount, 10, l_nrow);
generate_data<TPCH_INT>(col_o_orderkey, 100000, o_nrow);
```

- **输入**：行数 `l_nrow`、`o_nrow`（由 `sim_scale` 缩放）
- **输出**：填充好的主机缓冲区（`col_l_*`、`col_o_orderkey`）
- **数据范围**：`orderkey` 范围 1-100000，`extendedprice` 1-10000000，`discount` 1-10（定点数，实际表示 0.01-0.10）

### Step 2: CPU 黄金参考计算（主机 CPU）

```cpp
long long golden = get_golden_sum(l_nrow, col_l_orderkey, col_l_extendedprice, 
                                   col_l_discount, o_nrow, col_o_orderkey);
```

- **输入**：与 Step 1 相同的主机缓冲区
- **处理**：`std::unordered_multimap` 构建 + 探测 + 聚合
- **输出**：64 位整数 `golden`，即 `SUM(extendedprice * (100 - discount))`

### Step 3: 数据迁移 H2D（PCIe DMA）

```cpp
// 将输入缓冲区加入迁移列表
std::vector<cl::Memory> ib;
ib.push_back(buf_o_orderkey_a);      // Orders.orderkey
ib.push_back(buf_l_orderkey_a);      // Lineitem.orderkey  
ib.push_back(buf_l_extendedprice_a); // Lineitem.extendedprice
ib.push_back(buf_l_discout_a);       // Lineitem.discount

// 第 i=0 次，无前序依赖（nullptr）
q.enqueueMigrateMemObjects(ib, 0, nullptr, &write_events[0][0]);
```

- **源**：主机内存（`col_l_*`、`col_o_orderkey` 的页对齐缓冲区）
- **目的**：FPGA 设备内存（DDR 或 HBM 的输入缓冲区）
- **传输方式**：XDMA（Xilinx DMA）引擎通过 PCIe 总线，绕过 CPU，无需拷贝到内核空间
- **事件依赖**：`write_events[0][0]` 标记传输完成，供后续 Kernel 任务等待

### Step 4: FPGA Kernel 执行（Hash Join 加速）

```cpp
// 设置 Kernel 参数（共 24 个）
kernel0.setArg(0, buf_o_orderkey_a);   // Orders 表（Build 侧）
kernel0.setArg(1, o_nrow);             // Orders 行数
kernel0.setArg(2, buf_l_orderkey_a);   // Lineitem 表（Probe 侧）
kernel0.setArg(3, buf_l_extendedprice_a);
kernel0.setArg(4, buf_l_discout_a);
kernel0.setArg(5, l_nrow);              // Lineitem 行数
kernel0.setArg(6, k_bucket);            // 哈希桶深度
// 参数 7-14: 8 个 HBM Bank 的哈希表缓冲区
kernel0.setArg(7, buf_ht[0]); ... kernel0.setArg(14, buf_ht[7]);
// 参数 15-22: 8 个 HBM Bank 的辅助存储
kernel0.setArg(15, buf_s[0]); ... kernel0.setArg(22, buf_s[7]);
// 参数 23: 结果缓冲区
kernel0.setArg(23, buf_result_a);

// 启动 Kernel，依赖写完成
q.enqueueTask(kernel0, &write_events[0], &kernel_events[0][0]);
```

- **输入**：已传输到 FPGA 内存的表数据（Orders、Lineitem）
- **处理**：FPGA 内部的 `join_kernel`（HLS 生成）执行 8-路并行哈希连接：
  1. **Build 阶段**：将 Orders 表按 `orderkey` 哈希，分散到 8 个 HBM Bank
  2. **Probe 阶段**：流式读取 Lineitem，计算哈希值，访问对应 HBM Bank，匹配则累加
  3. **聚合**：每个 PU 计算局部和，最终归约到全局结果
- **输出**：单个 64 位整数，写入 `buf_result_a`

### Step 5: 结果回传 D2H（PCIe DMA）

```cpp
std::vector<cl::Memory> ob;
ob.push_back(buf_result_a);  // 只有结果缓冲区

// 依赖 Kernel 完成
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, 
                          &kernel_events[0], &read_events[0][0]);
```

- **源**：FPGA 内存中的结果缓冲区（`buf_result_a`）
- **目的**：主机内存（`row_result_a`）
- **传输**：PCIe DMA，数据量极小（仅 16 字节，两个 64 位数），延迟可忽略

### Step 6: 异步回调验证（多线程）

```cpp
// 准备回调上下文
cbd_ptr[0].i = 0;                    // 迭代号
cbd_ptr[0].v = (long long*)row_result_a;  // FPGA 结果指针
cbd_ptr[0].g = &golden;              // CPU 黄金参考指针
cbd_ptr[0].r = &ret;                 // 错误计数器指针

// 注册回调：D2H 完成后触发
read_events[0][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + 0);
```

- **触发时机**：OpenCL 运行时检测到 `read_events[0]` 完成（D2H 传输结束）
- **执行上下文**：后台线程（非 `main` 线程）
- **处理**：`print_buf_result` 函数比对 `*v`（FPGA）与 `*g`（CPU）：
  - 相等：打印 "FPGA result X: Y"
  - 不等：打印两者值，`*r` 自增（错误计数）

### 完整数据流总结

```
主机内存                          PCIe                         FPGA HBM
───────────                     ─────────                    ─────────
合成数据生成 ───────────────────────────────────────────────>
(col_l_*, col_o_*)
      │
      ▼
CPU 黄金参考
(unordered_map)                    DMA H2D
      │                        ┌───────────────┐
      │                        ▼               │
      │                   输入缓冲区            │
      │              (Orders, Lineitem)         │
      │                        │               │
      │                        ▼               │
      │              ┌─────────────────┐       │
      │              │  join_kernel    │       │
      │              │  (8x PU, HBM)   │       │
      │              │  - Build Phase  │       │
      │              │  - Probe Phase  │       │
      │              │  - Aggregate    │       │
      │              └────────┬────────┘       │
      │                       │                │
      │                       ▼                │
      │                  结果缓冲区            │
      │              (SUM 64-bit value)        │
      │                       │                │
      │                       │ DMA D2H        │
      │                       ▼                │
      │                  ┌──────────┐          │
      └─────────────────>│ 结果比对  │<─────────┘
        (print_buf_result)│ (Callback)│
                         └──────────┘
```

---

## 关键设计决策与权衡

### 1. 内存管理策略：裸指针 vs RAII

**现状**：代码使用 `aligned_alloc` + 裸指针，无自动释放。

**权衡分析**：
- **选择**：手动管理，牺牲安全性换取显式控制
- **原因**：OpenCL 对象（`cl::Buffer`）与主机指针存在复杂的生命周期交叉；过早释放会导致 DMA 错误
- **风险**：内存泄漏（当前代码缺失 `free` 调用）、Use-after-free（回调中访问已释放栈内存）

**建议改进**：使用 `std::unique_ptr<T[], decltype(&free)>` 包装主机缓冲区，保持异常安全。

### 2. 同步机制：事件链 vs 屏障

**现状**：使用细粒度的 `cl::Event` 链式依赖（`write_events[i]` → `kernel_events[i]` → `read_events[i]`）。

**权衡分析**：
- **选择**：显式事件链，最大化并发
- **替代方案**：`clFinish` 屏障同步（简单但阻塞，无法重叠）
- **收益**：双缓冲下设备利用率 > 90%（取决于 PCIe 与 FPGA 性能比）
- **代价**：代码复杂度指数增长，事件管理容易出错

### 3. 验证策略：异步回调 vs 同步比对

**现状**：`read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, ...)`。

**权衡分析**：
- **选择**：异步回调，验证与流水线重叠
- **替代方案**：`q.finish()` 后同步遍历比对（简单但阻塞）
- **风险**：回调在后台线程执行，访问 `main` 栈变量需确保 `main` 未退出；代码通过 `q.finish()` 等待所有回调完成，正确但脆弱

### 4. 随机数生成：rand() vs 现代 C++

**现状**：`rand() % range + 1`。

**权衡分析**：
- **选择**：C 标准 `rand()`，简单可移植
- **问题**：
  - 线程不安全（本代码单线程，无影响）
  - 模偏置（Modulo bias）：`% range` 在 `range` 非 2 的幂时分布不均
  - 周期短（通常 2^31），不适合大规模数据
- **建议**：生产环境应使用 `<random>` 的 `std::mt19937` 或硬件 RNG

### 5. 错误处理：返回值 vs 异常

**现状**：OpenCL 错误码检查（`logger.logCreateContext(err)`），无异常。

**权衡分析**：
- **选择**：返回码检查，符合 OpenCL C API 风格
- **替代**：C++ 异常（需包装 OpenCL 调用，增加开销）
- **现状问题**：部分错误仅记录日志，未立即返回（如 `logger.logCreateContext(err)` 后仍继续），可能导致级联错误难以定位

---

## 依赖关系分析

### 本模块依赖（被调用）

| 被调用模块/库 | 用途 | 关键 API/组件 |
|-------------|------|--------------|
| **Xilinx XRT (xcl2)** | OpenCL 运行时、FPGA 设备管理 | `xcl::get_xil_devices`, `xcl::import_binary_file`, `cl::Context`, `cl::CommandQueue` |
| **Xilinx xf::common::utils_sw** | 日志、参数解析 | `Logger`, `ArgParser` |
| **标准库** | 数据结构、随机数、计时 | `std::unordered_multimap`, `std::vector`, `rand()`, `gettimeofday` |
| **Vitis HLS 生成的 xclbin** | FPGA Kernel 执行 | `join_kernel`（由 HLS C++ 编译生成） |

### 依赖本模块（调用者）

本模块是 **顶层测试程序（Testbench）**，无上游调用者。它直接由用户/CI 系统执行：

```bash
./test_join -mode fpga -xclbin /path/to/join_kernel.xclbin -rep 10 -scale 1
```

下游数据消费者是：
- **标准输出**：人类可读的计时、验证结果
- **返回码**：`0` = 测试通过，`1` = 测试失败（用于自动化测试框架）

---

## 使用指南与最佳实践

### 基本用法

```bash
# 基本 FPGA 测试（单次执行）
./test_join -mode fpga -xclbin ./join_kernel.xclbin

# 性能测试（10 次重复，取平均）
./test_join -mode fpga -xclbin ./join_kernel.xclbin -rep 10

# 快速功能验证（1/10 数据量）
./test_join -mode fpga -xclbin ./join_kernel.xclbin -scale 10 -rep 1
```

### 关键参数说明

| 参数 | 含义 | 典型值 | 注意事项 |
|-----|------|-------|---------|
| `-mode` | 执行模式 | `fpga` | 必须，当前仅支持 FPGA |
| `-xclbin` | FPGA 比特流路径 | 绝对/相对路径 | 必须，文件需与目标卡匹配（U50/U280/Versal） |
| `-rep` | 重复次数 | 1-20 | 用于统计平均延迟，受限于代码硬编码上限 20 |
| `-scale` | 数据缩放因子 | 1, 10, 100 | 1=全量数据，越大数据越少，用于快速验证 |

### 扩展与定制

#### 添加新的查询模式

当前代码硬编码 TPC-H Query 1 的简化聚合（`SUM(extendedprice * (1-discount))`）。要支持其他查询：

1. **修改 `get_golden_sum`**：实现新的 CPU 参考算法
2. **修改 Kernel 参数**：添加新列缓冲区（如 `l_quantity`、`l_tax`）
3. **更新 `join_kernel`**（HLS 代码）：实现新的聚合逻辑（在单独的文件中，非本 Host 代码）

#### 支持多卡扩展

当前代码仅使用 `devices[0]`。要支持多卡数据并行：

```cpp
// 伪代码：将数据分区，分配到多个卡
int num_cards = devices.size();
for (int c = 0; c < num_cards; ++c) {
    // 为每卡创建独立 Context、Queue、Kernel
    // 分区数据：第 c 卡处理行范围 [c*rows/num_cards, (c+1)*rows/num_cards)
    // 聚合各卡结果
}
```

---

## 陷阱、边界条件与调试

### 常见错误与解决方案

| 症状 | 可能原因 | 解决方案 |
|-----|---------|---------|
| `ERROR: xclbin path is not set` | 命令行缺少 `-xclbin` | 提供绝对路径或确认文件存在 |
| `CL_INVALID_BINARY` | xclbin 与目标卡不匹配 | 确认卡型号（U50/U280/VCK190）与编译目标一致 |
| `CL_OUT_OF_RESOURCES` | HBM 分配超出容量 | 减小 `L_MAX_ROW`/`O_MAX_ROW` 或增大 `sim_scale` |
| 验证失败（FPGA != Golden） | 哈希函数不一致、溢出、数据损坏 | 检查 `KEY_T`/`MONEY_T` 位宽定义，确认 HLS 与 Host 一致 |
| 性能低于预期（< 10 GB/s） | PCIe 链路降级、未启用双缓冲 | 检查 `lspci -vv` 链路速度，确认 `-rep > 1` 启用流水线 |

### 关键边界条件

1. **整数溢出**：
   ```cpp
   sum += (p * (100 - d));  // p 最大 10M，100-d 最大 100，积最大 ~1e9
   ```
   `int64_t`（`long long`）可安全累加 `9e18`，TPCH SF100 的 Lineitem ~6亿行，`sum` 最大 ~6e17，安全。

2. **HBM 容量限制**：
   - 每 PU 哈希表：`PU_HT_DEPTH` 行 × 64 字节/行（键+值+元数据）
   - 8 PU × 64KB = 512KB，远小于 HBM 容量（4-8GB），但需注意 `PU_HT_DEPTH` 编译时常数与运行时数据规模的匹配

3. **回调生命周期**：
   ```cpp
   q.finish();  // 确保所有回调执行完毕
   ```
   若注释掉 `q.finish()` 直接返回，`cbd_ptr` 指向的栈内存释放，回调访问无效地址，Segmentation Fault。

### 调试技巧

1. **启用 OpenCL Profiling**：
   ```cpp
   // 已启用 CL_QUEUE_PROFILING_ENABLE
   kernel_events[i][0].getProfilingInfo(CL_PROFILING_COMMAND_START, &ts);
   kernel_events[i][0].getProfilingInfo(CL_PROFILING_COMMAND_END, &te);
   ```
   精确测量 Kernel 纯执行时间（不含数据传输）。

2. **HLS 仿真模式（HLS_TEST）**：
   ```cpp
   #ifdef HLS_TEST
       // 直接调用 join_kernel C++ 函数，无需 FPGA 卡
       join_kernel(...);
   #endif
   ```
   用于无硬件环境下的算法验证。

3. **数据比对可视化**：
   修改 `print_buf_result`，将不匹配的数据行号、键值、计算中间结果写入日志，定位差异来源。

---

## 参考与相关模块

### 本模块依赖（调用）

| 模块/库 | 路径/头文件 | 用途 |
|--------|------------|------|
| **Vitis XRT (xcl2)** | `<xcl2.hpp>` | OpenCL 运行时、FPGA 设备管理 |
| **Xilinx 工具库** | `xf_utils_sw/logger.hpp` | 日志记录 (`Logger`) |
| **HLS Kernel 头文件** | `table_dt.hpp`, `join_kernel.hpp`, `utils.hpp` | 数据类型定义、Kernel 声明 |
| **Vitis HLS 生成物** | `join_kernel.xclbin` | FPGA 比特流（编译时生成） |

### 相关兄弟模块

| 模块名称 | 路径 | 关系说明 |
|---------|------|---------|
| **hash_join_v2_host** | `database/L1/benchmarks/hash_join_v2/host/` | 早期版本，v4_sc 的前代，功能类似但无 HBM 支持 |
| **hash_join_v3_sc_host** | `database/L1/benchmarks/hash_join_v3_sc/host/` | 中间版本，单通道（SC）优化 predecessor |
| **hash_join_membership_variants** | `database/L1/benchmarks/hash_join_membership/` | 变体：仅检查存在性（Bloom Filter 风格），无聚合 |
| **hash_multi_join** | `database/L1/benchmarks/hash_multi_join/` | 扩展：支持多表连接（>2 表）|
| **compound_sort** | `database/L1/benchmarks/compound_sort/` | 兄弟模块：排序加速，共享 XRT 基础设施 |

### 上游调用链

本模块是**顶层可执行文件**，无上游调用者。典型的调用方式是命令行执行或 CI 系统调用：

```bash
# 手动执行
./test_join -mode fpga -xclbin ./join_kernel.xclbin -rep 10 -scale 1

# CI/自动化测试
make test-hash-join-v4  # 假设 Makefile 封装上述命令
```

---

## 附录：关键常数与类型定义

本模块依赖的头文件（未在片段中展开）定义了以下关键常数：

| 常数/类型 | 典型值 | 含义 |
|----------|-------|------|
| `KEY_T` | `int32_t` | 连接键（orderkey）数据类型 |
| `MONEY_T` | `int64_t` | 金额类型（定点数，4 位小数）|
| `TPCH_INT` | `int32_t` | 数据生成时的整数类型 |
| `VEC_LEN` | 4 或 8 | SIMD 向量长度（FPGA 并行度）|
| `L_MAX_ROW` | 600000000 (SF100) | Lineitem 最大行数 |
| `O_MAX_ROW` | 150000000 (SF100) | Orders 最大行数 |
| `PU_NM` | 8 | Processing Unit 数量 |
| `PU_HT_DEPTH` | 8192 或更大 | 每 PU 哈希表深度 |
| `PU_S_DEPTH` | 8192 | 每 PU 辅助存储深度 |

这些常数在 `table_dt.hpp` 和 `join_kernel.hpp` 中定义，编译期确定，影响 FPGA 资源占用（LUT、FF、BRAM、URAM、HBM 带宽）。

---

## 结语：写给新加入的开发者

**hash_join_v4_sc_host** 是一个典型的**异构计算 Host 程序**，它展示了如何高效地 orchestrate FPGA 加速器。作为新团队成员，理解本模块时请关注以下几点：

1. **数据流优先**：不要陷入 OpenCL API 的细节，先理解数据从哪里来、到哪里去、在哪里转换（主机内存 → PCIe → FPGA HBM → Kernel 计算 → PCIe → 主机内存）

2. **并发与重叠**：双缓冲（Ping-Pong）是本模块的核心优化，理解事件链如何让 "传输 N+1" 与 "计算 N" 重叠，是掌握异构编程的关键

3. **验证策略**：始终有 "Golden Reference"（CPU 参考实现），这是调试 FPGA 逻辑错误的最后防线；理解为什么必须用定点数、为什么必须避免浮点

4. **资源与约束**：HBM Bank 数量（8 个）、哈希表深度、PCIe 带宽，这些硬件约束决定了算法的可扩展性上限；当你需要修改 Kernel 或增加表数量时，这些是第一考虑因素

最后，建议的阅读路径：先通读本文档理解架构，再对照代码看 `main` 函数的执行流程，最后深入 `get_golden_sum` 理解算法，最后研究 OpenCL 事件链的细节。遇到具体问题时，善用 XRT 的 profiling 工具和 HLS 仿真模式（`HLS_TEST`）。

欢迎加入团队，期待你的贡献！
