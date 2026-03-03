# q5_result_format_and_timing_types 模块深度解析

## 一句话概括

这是一个为 **TPC-H Query 5** 的 FPGA 硬件加速查询引擎服务的**结果格式化与性能计时**基础设施模块。它解决了硬件加速数据库查询中常见的一个棘手问题：如何在异步、流水线化的硬件执行模型与宿主程序的顺序、面向结果的报告需求之间架起桥梁。

想象你是一个仓库管理员（Host），而你有一群机器人（FPGA Kernel）在另一个房间里高速分拣货物。你不能每次都走进去看机器人分拣得怎么样了，而是需要一种机制：当机器人完成一批分拣后，自动把结果放在传送带上，同时记录下这次分拣花了多长时间。这个模块就是设计那个"传送带机制"和"计时器"的。

---

## 模块架构与核心抽象

### 整体定位

```
┌─────────────────────────────────────────────────────────────────┐
│                        TPC-H Q5 Demo Host                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   q5_result_format_and_timing_types (本模块)            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │  │
│  │  │  rlt_pair    │  │  timeval     │  │print_buf_    │   │  │
│  │  │  (结果聚合)   │  │  (时间测量)   │  │result_data_  │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                    OpenCL Runtime / XRT                        │
│                              │                                   │
│                    ┌─────────────────┐                          │
│                    │  FPGA Kernel    │                          │
│                    │  q5_hash_join   │                          │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### 核心数据结构

#### 1. `rlt_pair` —— 查询结果的聚合单元

```cpp
struct rlt_pair {
    std::string name;           // 国家名称（如 "IRAQ", "SAUDI ARABIA"）
    TPCH_INT nationkey;         // 国家在 TPC-H schema 中的 key
    long long group_result;     // 聚合计算结果（收入，已乘以 10000 避免浮点）
};
```

**设计意图**：TPC-H Q5 查询要求按国家分组计算收入并排序。`rlt_pair` 是 Host 端最终输出的**原子单位**。注意到 `group_result` 使用 `long long` 而非 `double`，这是 FPGA 加速数据库的典型做法——**定点数运算**比浮点更适合硬件流水线。

#### 2. `timeval` ——  POSIX 标准时间测量

```cpp
typedef struct timeval {
    time_t tv_sec;      // 秒
    suseconds_t tv_usec; // 微秒
};
```

**使用场景**：代码中通过 `gettimeofday(&tv_r_s, 0)` 和 `gettimeofday(&tv_r_e, 0)` 包围 CPU 端的 R-N（Region-Nation）Join 操作，测量纯软件执行时间作为对比基准。

#### 3. `print_buf_result_data_` —— 异步回调的上下文载体

```cpp
typedef struct print_buf_result_data_ {
    int i;                  // 迭代次数/批次号
    TPCH_INT* v;            // 指向结果 key 缓冲区的指针
    TPCH_INT* price;        // 指向 extendedprice 列的指针
    TPCH_INT* discount;     // 指向 discount 列的指针
    rlt_pair* r;            // 指向结果聚合数组的指针
} print_buf_result_data_t;
```

**核心作用**：这是 OpenCL **异步回调机制**的核心。当 FPGA Kernel 完成执行并通过 DMA 将结果写回 Host 内存后，OpenCL Runtime 会触发 `CL_CALLBACK print_buf_result`。但回调函数签名是固定的 `(cl_event, cl_int, void*)`，`print_buf_result_data_t` 就是那个 `void* user_data` 的**具体类型**，携带了回调需要的一切上下文。

---

## 数据流与执行流程

### 宏观执行流程

```
1. 数据准备阶段 (CPU)
   ├─ 从磁盘加载 TPC-H 表数据 (Lineitem, Orders, Customer, etc.)
   ├─ CPU 端执行 R-N Join (Region-Nation)
   └─ 准备 FPGA 输入缓冲区 (n_out_k)
   
2. FPGA 流水线执行阶段 (异步)
   ├─ Kernel 1: C Join (Customer) ────────┐
   ├─ Kernel 2: O Join (Orders) ───────────┤ 依赖链
   ├─ Kernel 3: L Join (Lineitem) ─────────┤
   └─ Kernel 4: S Join (Supplier) ──────────┘
   
3. 结果回传与处理阶段 (回调)
   ├─ DMA 将结果写回 Host 内存 (out2_k, out2_p1, out2_p2)
   ├─ OpenCL Event 触发 CL_COMPLETE 回调
   └─ print_buf_result 执行 Group-By 和 Order-By
```

### 详细数据流

```cpp
// 阶段 1: CPU 预处理
struct timeval tv_r_s, tv_r_e;
gettimeofday(&tv_r_s, 0);
// ... R-N Join 逻辑，填充 n_out_k ...
gettimeofday(&tv_r_e, 0);
std::cout << "CPU execution time of R and N join " 
          << tvdiff(&tv_r_s, &tv_r_e) / 1000 << " ms" << std::endl;

// 阶段 2: 设置回调上下文
std::vector<print_buf_result_data_t> cbd(num_rep);
// ... 填充 cbd[i].v, cbd[i].price, cbd[i].discount, cbd[i].r ...

// 阶段 3: FPGA 执行链（以第 i 次迭代为例）
// Kernel C: Customer Join
q.enqueueTask(kernel0, &write_events[i], &kernel_events_c[i][0]);

// Kernel O: Orders Join（依赖 C 完成）
q.enqueueTask(kernel0, &kernel_events_c[i], &kernel_events_o[i][0]);

// Kernel L: Lineitem Join（依赖 O 完成）
q.enqueueTask(kernel0, &kernel_events_o[i], &kernel_events_l[i][0]);

// Kernel S: Supplier Join（依赖 L 完成）
q.enqueueTask(kernel0, &kernel_events_l[i], &kernel_events_s[i][0]);

// 阶段 4: 异步读取结果
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, 
                          &kernel_events_s[i], &read_events[i][0]);

// 阶段 5: 设置回调（当 DMA 完成时触发）
read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + i);
```

### 回调处理的核心逻辑

```cpp
void CL_CALLBACK print_buf_result(cl_event event, cl_int cmd_exec_status, void* user_data) {
    print_buf_result_data_t* d = (print_buf_result_data_t*)user_data;
    
    // 1. 解包数据指针
    TPCH_INT* key = d->v;
    TPCH_INT* price = d->price;
    TPCH_INT* discount = d->discount;
    
    // 2. Group-By 聚合（在 Host 端完成，而非 FPGA）
    int nm = *(d->v)++;
    for (int i = 0; i < 5; i++) {
        d->r[i].group_result = 0;  // 初始化 5 个国家的结果
    }
    for (int i = 0; i < nm; i++) {
        for (int j = 0; j < 5; j++) {
            if (d->r[j].nationkey == key[i + 16]) {
                // 收入计算公式：price * (100 - discount)
                d->r[j].group_result += price[i + 16] * (100 - discount[i + 16]);
                break;
            }
        }
    }
    
    // 3. Order-By 排序（按收入降序）
    std::vector<rlt_pair> rows;
    for (int i = 0; i < 5; i++) {
        rows.push_back(d->r[i]);
    }
    std::sort(rows.begin(), rows.end(), 
              [](const rlt_pair& a, const rlt_pair& b) { 
                  return a.group_result > b.group_result; 
              });
    
    // 4. 格式化输出
    printf("FGPA result %d:\n", d->i);
    for (int i = 0; i < 5; i++) {
        // 定点数转浮点：除以 10000 得到实际金额
        printf("Name %s: %lld.%lld\n", 
               rows[i].name.c_str(), 
               rows[i].group_result / 10000,
               rows[i].group_result % 10000);
        if (d->i == 0) {
            query_result.push_back(rows[i]);  // 保存第一次迭代的结果用于验证
        }
    }
}
```

---

## 设计决策与权衡

### 1. 计算任务划分：FPGA 做什么 vs CPU 做什么？

**决策**：将 Join 操作（C, O, L, S 表）放在 FPGA 执行，而将最终的 Group-By 和 Order-By 放在 CPU 执行。

**权衡分析**：

| 方案 | 优势 | 劣势 | 选择理由 |
|------|------|------|----------|
| **全部 FPGA 化** | 最大吞吐量，最小延迟 | 逻辑资源消耗巨大，排序算法在 FPGA 上实现复杂（需要树形归约或排序网络） | 对于只有 5 个国家的 Q5 查询，边际收益太低 |
| **全部 CPU 化** | 实现简单，易于调试 | 失去硬件加速意义，大数据量时 Join 成为瓶颈 | 违背项目目标 |
| **混合模式（当前）** | FPGA 处理数据密集型 Join（过滤+匹配），CPU 处理轻量级聚合排序 | 需要 PCIe 往返传输中间结果 | **最优平衡点**：Join 是 $O(n \log n)$ 或 $O(n)$（哈希），聚合是 $O(k)$（$k=5$ 个国家），通信开销可忽略 |

**关键洞察**：这体现了**异构计算**的核心设计哲学——让硬件做它最擅长的事（并行、流水线、无分支的 Join），让软件做灵活性要求高的事（复杂控制流、字符串处理、最终展示）。

### 2. 异步回调 vs 同步轮询

**决策**：使用 OpenCL 的 `setCallback` 机制实现异步结果处理，而非阻塞式的 `clFinish` 轮询。

**代码体现**：
```cpp
// 异步路径（本模块采用）
read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, cbd_ptr + i);

// 同步路径（对比）
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST);
q.finish();  // 阻塞等待
print_buf_result_manually();
```

**权衡分析**：

| 维度 | 异步回调 | 同步轮询 |
|------|----------|----------|
| **CPU 利用率** | 高，Host 可在 FPGA 计算时做其他事 | 低，Host 空转等待 |
| **延迟敏感度** | 略高（回调调度开销） | 低（立即知道完成） |
| **代码复杂度** | 高，需处理生命周期、线程安全 | 低，线性逻辑 |
| **流水线重叠** | 支持，可实现双缓冲 ping-pong | 不支持，必须等上一次完成 |

**本模块的关键选择理由**：

1. **Ping-Pong 双缓冲机制**：代码中明确使用了 `use_a = i & 1` 的交替模式，A/B 两套缓冲区交替使用。这要求必须是异步模型——在第 $i$ 次迭代的 FPGA 执行期间，第 $i-1$ 次的结果回调处理必须能并发执行。

2. **吞吐率最大化**：TPC-H 测试关注 QPS（每秒查询数），异步模型允许 FPGA 始终处于满负荷状态，而同步模型会有气泡（Bubble）。

### 3. 定点数 vs 浮点数

**决策**：收入计算使用定点数（`long long`，实际值 × 10000）而非 `double`。

**代码体现**：
```cpp
// 计算时：price * (100 - discount)
// discount 已经是百分比乘以 100 的整数（如 5% 存为 5）
// price 单位是 0.01 元（即分）

// 输出时转换为浮点显示
group_result / 10000,  // 整数部分（元）
group_result % 10000   // 小数部分（万分之几元）
```

**权衡分析**：

| 特性 | 定点数 (long long) | 浮点数 (double) |
|------|-------------------|----------------|
| **FPGA 资源** | 极少（整数 ALU） | 极多（硬核 DSP 或软核浮点单元） |
| **精度** | 精确，无舍入误差 | 有 IEEE-754 舍入误差 |
| **范围** | 64 位可表示约 ±9e18 | ±1e308 |
| **Host 端处理** | 需手动转换显示 | 直接打印 |
| **TPC-H 符合性** | 完全符合，规格允许定点 | 符合，但实现复杂 |

**关键洞察**：这是一个**硬件友好型**设计。FPGA 上的整数乘法可以流水线到每个时钟周期一个结果，而浮点乘法需要多周期或大量 DSP 资源。对于 TPC-H Q5 这种计算密集型查询，定点数是工程上的必然选择。

### 4. 内存模型与生命周期管理

**决策**：使用 `aligned_alloc` 分配页对齐内存，通过 `CL_MEM_USE_HOST_PTR` 实现零拷贝（Zero-Copy）传输。

**代码体现**：
```cpp
// 分配页对齐内存
TPCH_INT* col_l_orderkey = aligned_alloc<TPCH_INT>(l_depth);

// 创建 OpenCL Buffer 时直接使用 Host 指针，不分配新内存
cl_mem_ext_ptr_t mext_l_orderkey = {2, col_l_orderkey, kernel0()};
cl::Buffer buf_l_orderkey_a(
    context, 
    CL_MEM_EXT_PTR_XILINX | CL_MEM_USE_HOST_PTR | CL_MEM_READ_ONLY,
    (size_t)(TPCH_INT_SZ * l_depth), 
    &mext_l_orderkey
);
```

**权衡分析**：

| 方案 | 机制 | 延迟 | 内存占用 | 复杂度 |
|------|------|------|----------|--------|
| **Zero-Copy (当前)** | `CL_MEM_USE_HOST_PTR` + `aligned_alloc` | 极低（无拷贝） | 最低（共享内存） | 中（需管理对齐和生命周期） |
| **显式拷贝** | `CL_MEM_COPY_HOST_PTR` 或 `enqueueWriteBuffer` | 高（PCIe 拷贝延迟） | 高（Host + Device 各一份） | 低（OpenCL 管理） |
| **SVM (共享虚拟内存)** | `CL_MEM_SVM_FINE_GRAIN_BUFFER` | 低（页级共享） | 中 | 高（需硬件支持 SVM） |

**生命周期契约**：

1. **分配期**：`main()` 函数开始时，所有缓冲区通过 `aligned_alloc` 分配，生命周期持续到 `main()` 结束。
2. **映射期**：OpenCL Buffer 对象创建时绑定到 Host 指针，要求 Host 内存必须保持有效且**不能被移动**（因此不能用 `std::vector` 的 realloc 策略）。
3. **使用期**：Kernel 执行期间，Host 内存被硬件通过 DMA 访问，Host 代码**不得读写**这些内存（Cache 一致性问题）。
4. **回调期**：`print_buf_result` 回调被触发时，表明 DMA 传输完成，Host 可以安全读取内存。
5. **释放期**：`aligned_alloc` 分配的内存需要显式 `free`，代码中由操作系统进程结束时统一回收（演示性质）。

**关键风险点**：`print_buf_result_data_t` 中的指针（`v`, `price`, `discount`, `r`）都是**裸指针**，回调执行时如果对应的 `aligned_alloc` 内存已被释放，或者 FPGA 结果还没写完，就会产生 Use-After-Free 或数据竞争。代码通过 `q.finish()` 在 `main` 结束前等待所有回调完成来保证安全性。

---

## 依赖关系与调用图谱

### 向上依赖（谁调用本模块）

本模块是 TPC-H Q5 Demo 的**叶节点模块**，没有上层调用者。它提供的类型被 `test_q5.cpp` 的 `main()` 函数直接使用。

### 向下依赖（本模块调用谁）

```
q5_result_format_and_timing_types
│
├─ 标准库 <sys/time.h>
│   └─ struct timeval, gettimeofday()
│
├─ 标准 C++ 库 <string>, <vector>, <algorithm>, <iostream>
│   └─ std::string, std::vector, std::sort, std::cout
│
├─ OpenCL/Xilinx Runtime <CL/cl_ext_xilinx.h>, <xcl2.hpp>
│   └─ cl::Buffer, cl::CommandQueue, cl::Kernel, cl_event callbacks
│
├─ TPC-H 类型定义 "table_dt.hpp"
│   └─ TPCH_INT, TPCH_INT_SZ, VEC_LEN
│
└─ 工具库 "utils.hpp", "prepare.hpp"
    └─ aligned_alloc, prepare(), tvdiff()
```

### 数据流契约

```
Input Data Flow:
  aligned_alloc<TPCH_INT>(depth) ─────────────────┐
                                                   │
  kernel0.setArg(n, buffer) ──► FPGA Execution ────┤
                                                   │ DMA
  setCallback(CL_COMPLETE) ◄─── Event Trigger ◄────┘
            │
            ▼
  print_buf_result(event, status, user_data)
            │
            ▼
  Output: std::vector<rlt_pair> query_result (按 revenue 排序)
```

---

## 使用方式与配置

### 基本使用模式

本模块**不是**一个独立可运行的库，而是作为 `test_q5.cpp` 的一部分编译。使用流程如下：

```cpp
// 1. 定义结果聚合数组
rlt_pair result[5];  // Q5 查询固定返回 5 个国家

// 2. 初始化回调上下文
std::vector<print_buf_result_data_t> cbd(num_rep);
for (int i = 0; i < num_rep; i++) {
    cbd[i].i = i;
    cbd[i].v = (TPCH_INT*)out2_k;        // FPGA 输出缓冲区
    cbd[i].price = (TPCH_INT*)out2_p1;
    cbd[i].discount = (TPCH_INT*)out2_p2;
    cbd[i].r = result;
}

// 3. 提交 FPGA 任务并关联回调
q.enqueueTask(kernel0, &write_events[i], &kernel_events_c[i][0]);
// ... 依赖链调度 ...
q.enqueueMigrateMemObjects(ob, CL_MIGRATE_MEM_OBJECT_HOST, 
                          &kernel_events_s[i], &read_events[i][0]);
read_events[i][0].setCallback(CL_COMPLETE, print_buf_result, &cbd[i]);

// 4. 等待所有回调完成
q.flush();
q.finish();  // 阻塞直到所有 callback 执行完毕
```

### 关键配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `num_rep` | int | 1 | 重复执行次数，用于统计平均延迟 |
| `PU_NM` | const int | 8 | Processing Unit 数量，对应 FPGA 内部 8 个并行 hash join 单元 |
| `VEC_LEN` | macro | (见 table_dt.hpp) | SIMD 向量长度，影响内存对齐要求 |
| `result_depth` | const size_t | 180000 + VEC_LEN | 输出缓冲区深度，必须足够容纳最坏情况下的 Join 结果膨胀 |

---

## 边缘情况与陷阱

### 1. 内存对齐地狱

**陷阱**：`aligned_alloc` 分配的指针必须满足 FPGA DMA 的对齐要求（通常是 4KB 页对齐）。如果改用普通的 `malloc` 或 `new`，OpenCL Runtime 可能会默默回退到拷贝模式，导致性能暴跌却不报错。

**检测方法**：在 Buffer 创建后检查 `CL_MEM_USE_HOST_PTR` 是否真的生效，或通过 profiling 观察是否有意外的内存拷贝。

### 2. 回调生命周期陷阱

**陷阱**：`print_buf_result_data_t` 包含裸指针，如果 `main()` 函数在 `q.finish()` 之前就退出了，或者 `cbd` vector 被提前销毁，回调将访问已释放内存。

**代码中的防护**：
```cpp
q.flush();
q.finish();  // 必须显式等待，不能依赖进程退出
```

### 3. 定点数溢出

**陷阱**：`group_result` 是 `long long`（通常 64 位），但 TPC-H Q5 的 `extendedprice` 和 `discount` 都是大整数，乘积可能溢出。

**代码中的假设**：`price[i + 16] * (100 - discount[i + 16])` 假设单次乘法不会溢出 64 位。对于 TPC-H 1GB 数据集这是成立的，但对于 100TB 数据集可能需要 `__int128`。

### 4. 硬编码的 Q5 逻辑

**陷阱**：`print_buf_result` 函数硬编码了 5 个国家（`for (int i = 0; i < 5; i++)`），以及特定的 `filter_con = "MIDDLE EAST"`。这不是通用库代码，而是专门为 TPC-H Q5 Demo 编写的。

**影响**：不能直接将此模块用于其他 TPC-H 查询或通用 SQL 引擎，需要针对具体查询重写回调逻辑。

### 5. 双缓冲索引偏移错误

**陷阱**：代码中频繁出现 `i + 16` 这样的偏移量（如 `key[i + 16]`），这是因为 FPGA Kernel 在前 16 个元素中存放了元数据（如行数），实际数据从第 16 个元素开始。

**风险**：如果 `VEC_LEN` 宏定义改变（当前值可能是 16），所有硬编码的 `16` 必须同步修改，否则会发生缓冲区越界或数据错位。

---

## 总结：给新手的检查清单

当你需要修改或调试这个模块时：

- [ ] **内存对齐检查**：所有 `aligned_alloc` 的指针是否页对齐？Buffer 创建是否使用了 `CL_MEM_USE_HOST_PTR`？
- [ ] **生命周期验证**：`cbd` vector 和回调数据是否在 `q.finish()` 之后才被销毁？
- [ ] **偏移量一致性**：检查所有 `+ VEC_LEN` 或 `+ 16` 的偏移是否与 FPGA Kernel 的元数据大小匹配。
- [ ] **定点数范围**：确认 `group_result` 不会溢出 64 位，特别是在测试大数据集时。
- [ ] **回调线程安全**：如果未来扩展到多线程提交，确认 `print_buf_result` 中的全局变量 `query_result` 需要加锁保护（当前单线程无需）。

理解了这个模块，你就掌握了如何在 FPGA 加速数据库查询中处理**异步结果回传**和**性能计时**这两个核心问题。
