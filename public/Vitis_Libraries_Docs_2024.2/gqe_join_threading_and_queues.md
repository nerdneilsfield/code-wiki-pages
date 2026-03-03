# GQE Join 线程池与队列系统

## 一句话概括

这是一个面向 FPGA 加速数据库查询的高性能哈希连接执行引擎，通过多级流水线、线程池、双缓冲架构，解决大表连接时"数据装不进设备内存"的性能瓶颈，实现 CPU 端数据搬运与 FPGA 端计算的完全并行重叠。

---

## 1. 问题空间：为什么需要这个模块？

### 1.1 核心矛盾

在 FPGA 加速的数据库查询引擎中，**哈希连接（Hash Join）**是最核心的算子。典型场景是 Orders 表与 Lineitem 表连接：

- **Orders 表**：较小，作为 Build 端
- **Lineitem 表**：巨大（数十亿行），作为 Probe 端

**核心矛盾**：现代 FPGA 加速卡的设备内存通常只有 16GB-64GB，而真实业务表往往数百 GB 甚至 TB 级。

### 1.2 朴素方案的缺陷

| 方案 | 做法 | 问题 |
|------|------|------|
| 全表上载 | 等所有数据拷贝到 FPGA 再计算 | 启动延迟极高，内存不够直接崩溃 |
| 串行分批 | 切分数据块，一块上载→计算→下载→下一块 | CPU 搬运时 FPGA 空转，资源利用率 < 50% |
| 简单多线程 | 随意开线程分别处理 | 无协调导致数据竞争、内存碎片、缓存失效 |

### 1.3 设计目标

1. **流水线并行**：CPU 数据搬运与 FPGA 计算完全重叠
2. **大表处理**：单表超过设备内存时，通过分区-分片策略化整为零
3. **资源保护**：线程数、内存占用、队列深度必须可控
4. **零拷贝优化**：使用页锁定内存（Pinned Memory）加速 DMA

---

## 2. 心智模型：如何理解这个系统？

### 2.1 类比：工厂流水线

想象一个三班倒的自动化工厂：

| 现实工厂 | 本系统对应 | 职责 |
|---------|-----------|------|
| 原料仓库 | Host 内存（用户表数据） | 存储原始数据 |
| 装卸工班组 | `part_o_in_t`, `part_l_in_t` 等线程 | 将原料从仓库搬上流水线入口 |
| 传送带（A/B 双轨） | **Ping-Pong 双缓冲** | 一条在上料时另一条加工，不停止 |
| 数控机床 | FPGA Kernel (`gqePart`, `gqeJoin`) | 执行实际的哈希分区/连接计算 |
| 质检打包工 | `part_o_out_t`, `probe_out_t` 等 | 将成品搬下流水线，送回成品仓库 |
| 调度室白板 | **队列系统 (`queue_struct_join`)** | 记录待处理任务，协调各班组工作节奏 |

**核心洞见**：系统不是"做完一步再做下一步"，而是**多个步骤同时进行**，通过**双缓冲**确保流水线永不停顿。

### 2.2 核心抽象

本模块围绕两大核心抽象构建：

#### 抽象 1：`threading_pool` —— 工人池

`threading_pool` 管理 13 个特定职能的线程和 15 个任务队列：

```cpp
class threading_pool {
    // 线程分组
    std::thread part_o_in_t, part_o_d2h_t, part_o_out_t;      // O 表分区流水线
    std::thread part_l_in_ping_t, part_l_in_pong_t, ...;    // L 表分区流水线  
    std::thread build_in_t, probe_in_ping_t, ...;             // 哈希连接流水线
    
    // 15 个任务队列（生产者-消费者通道）
    std::queue<queue_struct_join> q0;   // Part O: 等待 memcpy in
    std::queue<queue_struct_join> q1_d2h; // Part O: 等待 D2H
    std::queue<queue_struct_join> q1;   // Part O: 等待 memcpy out
    // ... q2_ping 到 q6
    
    // 同步原语
    std::mutex m;
    std::condition_variable cv;
    std::atomic<bool> q0_run, q1_run, ...; // 线程生命周期控制
};
```

**设计要点**：
- **专岗专责**：每个线程只做一种操作，避免上下文切换
- **双缓冲（Ping-Pong）**：成对线程交替处理两张缓冲，无缝流水线
- **队列解耦**：生产者与消费者通过队列通信，无需直接同步

#### 抽象 2：`queue_struct_join` —— 任务描述符

```cpp
struct queue_struct_join {
    int sec, p;                    // 分片 ID、分区 ID
    int64_t meta_nrow;             // 元数据：行数
    MetaTable* meta;               // 指向元数据表的指针
    
    // OpenCL 事件依赖管理
    int num_event_wait_list;       // 依赖事件数量
    cl_event* event_wait_list;     // 依赖事件列表
    cl_event* event;               // 本任务完成时触发的事件
    
    // 数据搬运描述
    std::vector<int> col_idx;      // 涉及的列索引
    char* ptr_src[4];              // 源地址（Host 内存）
    char* ptr_dst[4];              // 目的地址
    int type_size[4];              // 数据类型大小
    int64_t size[4];               // 拷贝字节数
    
    // 分区特定字段
    int partition_num;             // 分区总数
    int64_t part_max_nrow_512;     // 每分区最大行数（512-bit 对齐）
    char*** part_ptr_dst;          // 分区输出目标地址数组
    
    // Probe 阶段特定字段
    int slice;                     // 分片索引
    int64_t per_slice_nrow;        // 每分片行数
    int64_t buf_head[4];           // 缓冲区头部偏移
    cl_command_queue cq;           // OpenCL 命令队列
    cl_mem dbuf;                   // OpenCL 设备内存缓冲区
};
```

**设计要点**：
- **自描述性**：一个结构体完整描述一次数据搬运任务的所有信息
- **事件链**：通过 `event_wait_list` 和 `event` 构建任务间的显式依赖图
- **多态承载**：通过不同字段组合描述 Partition、Build、Probe 阶段的任务

---

## 3. 数据流全景

### 3.1 三阶段流水线

本模块实现三种不同的 Join 策略，分别对应不同数据规模：

| 方案 | 方法 | 适用场景 | 关键调用 |
|------|------|----------|----------|
| **Solution 0** | 直接连接 | 两表都能装入设备内存 | `join_sol0()` |
| **Solution 1** | 流水线连接 | 大表需要分批，但小表能装入 | `join_sol1()` |
| **Solution 2** | 分区+连接 | 两表都太大，必须分区后再连接 | `join_sol2()` |

### 3.2 Solution 2（最复杂）数据流

```
Phase 1: O 表分区（Partition O）
================================
User Buffer O ──▶ [part_o_in_t] ──▶ Pinned Buffer ──▶ H2D迁移 ──▶ FPGA gqePart Kernel
                                                                       │
                                                                     D2H迁移
                                                                       ▼
                                                              Pinned Buffer ──▶ [part_o_d2h_t]
                                                                                  │
                                                                                  ▼
                                                                   [part_o_out_t] ──▶ User Partitioned O

Phase 2: L 表分区（Partition L）
================================
User Buffer L ──▶ [part_l_in_ping/pong_t] ──▶ Ping-Pong Buffers ──▶ H2D ──▶ FPGA gqePart
                                                                                   │
                                                                                 D2H
                                                                                   ▼
                                                                    [part_l_d2h_t] ──▶ [part_l_out_t]
                                                                                          │
                                                                                          ▼
                                                                                 User Partitioned L

Phase 3: 哈希连接（Hash Join per Partition）
============================================
For each partition pair (O_p, L_p):
    
    Partitioned O_p ──▶ [build_in_t] ──▶ H2D ──▶ FPGA HBM Hash Table (Build)
                                                      │
    Partitioned L_p ──▶ [probe_in_ping/pong_t] ──▶ H2D ──▶ FPGA Probe Kernel
                                                                  │
                                                                D2H
                                                                  ▼
                                                        [probe_d2h_t] ──▶ [probe_out_t]
                                                                            │
                                                                            ▼
                                                                  User Join Result
```

### 3.3 事件依赖链（关键路径）

```cpp
// 典型任务依赖链（以 L 表分区为例）
// T0: memcpy in (CPU) ──▶ T1: H2D迁移 (DMA) ──▶ T2: Kernel执行 (FPGA) ──▶ T3: D2H迁移 (DMA) ──▶ T4: memcpy out (CPU)

// 实际代码中的事件链构建：
cl_event evt_memcpy_in, evt_h2d, evt_krn, evt_d2h, evt_memcpy_out;

// 1. 用户事件：memcpy in 完成信号
clCreateUserEvent(ctx, &evt_memcpy_in);

// 2. H2D 依赖 memcpy in
clEnqueueMigrateMemObjects(cq, ..., 1, &evt_memcpy_in, &evt_h2d);

// 3. Kernel 依赖 H2D
clEnqueueTask(cq, kernel, 1, &evt_h2d, &evt_krn);

// 4. D2H 依赖 Kernel
clEnqueueMigrateMemObjects(cq, ..., 1, &evt_krn, CL_MIGRATE_MEM_OBJECT_HOST, &evt_d2h);

// 5. memcpy out 任务入队，依赖 D2H
queue_struct_join task;
task.num_event_wait_list = 1;
task.event_wait_list = &evt_d2h;
// ... 填充其他字段
q3_d2h.push(task);
```

---

## 4. 依赖关系与数据契约

### 4.1 上游依赖（谁调用本模块）

本模块属于 L3 层（高层抽象），由更上层的查询执行器调用：

```
┌─────────────────────────────────────────┐
│  L4: SQL Parser / Query Optimizer       │  ← 生成执行计划
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  L3: GQE Table / Join Strategy          │  ← 决策 Join 策略，调用本模块
│       (gqe_table.hpp / gqe_join.hpp)    │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  YOU ARE HERE:                          │
│  L3 Implementation:                     │
│  threading_pool + queue_struct_join     │
│  (gqe_join.cpp)                         │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  L2: OpenCL Runtime / XRT               │
│  (设备内存管理、内核启动)                 │
└─────────────────────────────────────────┘
```

**关键调用入口**：
- `Joiner::run()`：主入口，根据策略选择 `join_sol0/1/2`
- `JoinStrategyBase`：策略基类，子类可自定义分区数、切片数等参数

### 4.2 下游依赖（本模块调用谁）

| 被调用模块 | 功能 | 关键 API |
|-----------|------|----------|
| **OpenCL Runtime** | 设备内存管理、内核启动 | `clCreateBuffer`, `clEnqueueMigrateMemObjects`, `clEnqueueTask` |
| **XRT (Xilinx Runtime)** | FPGA 设备管理、内存拓扑 | `XCL_BANK0/1` 内存区指定 |
| **L2 MetaTable** | 表元数据管理 | `MetaTable::setCol()`, `MetaTable::meta()` |
| **L3 GQE Table** | 用户表抽象 | `Table::getRowNum()`, `Table::getColPointer()` |
| **Utils (Timer/MM)** | 性能统计、内存对齐 | `utils::Timer`, `utils::MM::aligned_alloc()` |

### 4.3 数据契约（接口约定）

#### 4.3.1 输入契约（调用者必须保证）

| 契约项 | 要求 | 违反后果 |
|--------|------|----------|
| **内存对齐** | 用户表数据必须 64 字节对齐 | DMA 传输失败或性能骤降 |
| **设备内存容量** | 用户需通过 `StrategySet` 确保分区后单区可装入 HBM | 运行时 `MEM_ERROR` |
| **OpenCL 上下文** | 调用前必须完成 `xclbin` 加载和上下文初始化 | 段错误或空指针异常 |
| **结果缓冲区** | `tab_c` 必须预分配足够空间（行数预估） | 缓冲区溢出，数据损坏 |

#### 4.3.2 输出契约（本模块保证）

| 契约项 | 保证 | 说明 |
|--------|------|------|
| **数据正确性** | 分区不丢失、不重复 | 通过 `partition_num` 和 `part_max_nrow_512` 保证 |
| **行数准确** | `tab_c.setRowNum()` 为实际结果行数 | 通过 `meta_probe_out.getColLen()` 累加 |
| **资源清理** | 退出时释放所有 OpenCL 资源 | `clReleaseMemObject`, `clReleaseKernel` 等 |
| **性能可测** | 内置 `Timer` 记录各阶段耗时 | `JOIN_PERF_PROFILE` 宏控制 |

---

## 5. 设计决策与权衡

### 5.1 关键设计决策

#### 5.1.1 决策 1：专用线程 vs 通用线程池

**选择**：13 个专用职能线程，而非动态线程池

**权衡分析**：

| 方案 | 优点 | 缺点 | 本模块选择 |
|------|------|------|-----------|
| **专用线程** | 无调度开销、CPU 亲和性可绑核、缓存友好 | 线程数固定、不灵活 | ✅ **采用** |
| **动态线程池** | 自适应负载、资源节省 | 调度延迟、上下文切换、缓存失效 | ❌ 不适用 |

**理由**：FPGA 加速场景下，数据流是确定的（Partition → Build → Probe），不存在突发负载。专用线程可将 CPU 核心独占绑定，避免缓存抖动。

#### 5.1.2 决策 2：双缓冲 (Ping-Pong) vs 单缓冲

**选择**：所有关键路径采用双缓冲

**权衡分析**：

| 方案 | 吞吐量 | 延迟 | 内存占用 | 适用场景 |
|------|--------|------|----------|----------|
| **单缓冲** | 低（CPU/FPGA 串行） | 低 | 2x 数据量 | 小数据、低延迟优先 |
| **双缓冲** | 高（CPU/FPGA 并行） | 稍高（启动填充） | 4x 数据量 | **大数据、高吞吐优先** |
| **多缓冲 (>2)** | 边际增益递减 | 更高 | 线性增长 | 复杂调度场景 |

**本模块选择**：双缓冲是**最佳甜点**——
- 内存占用可控（2x 双缓冲 = 4x 单数据量，现代服务器通常可承受）
- 实现复杂度适中（Ping-Pong 逻辑清晰，再多缓冲调度复杂）
- 重叠率接近理论上限（FPGA 计算时间通常 > 2x 数据传输时间）

#### 5.1.3 决策 3：显式事件链 vs 隐式屏障同步

**选择**：OpenCL 显式事件依赖链（`cl_event`）

**权衡分析**：

| 方案 | 控制粒度 | 开销 | 调试难度 | 可扩展性 |
|------|----------|------|----------|----------|
| **显式事件链** | 细粒度（每个操作） | 低（硬件支持） | 高（可追踪） | 高（可构造 DAG） |
| **隐式屏障** | 粗粒度（批次级别） | 中（批处理延迟） | 低 | 低（全局同步点） |
| **回调函数** | 中粒度 | 高（线程切换） | 中 | 中 |

**选择理由**：
- FPGA 执行是**确定性**的（无抢占、无调度不确定），适合构造精确的事件 DAG
- 显式事件允许**最大重叠**（下一个 H2D 可在上一个 Kernel 还在跑时就开始准备）
- 虽然代码复杂（需要管理 `cl_event` 生命周期），但这是高性能的必要代价

### 5.2 性能与资源权衡

| 设计选择 | 性能增益 | 资源代价 | 适用约束 |
|----------|----------|----------|----------|
| 13 个专用线程 | 消除调度延迟 | 占用 13 个 CPU 核心 | 需要多核服务器 |
| Ping-Pong 双缓冲 | 重叠率 >90% | 4x 内存占用 | 单表分片后 < 设备内存 50% |
| 页锁定内存 | DMA 带宽提升 2-3x | 无法换页，占用物理内存 | 总 pinned 内存 < 系统 80% |
| OpenCL 事件链 | 零同步开销 | 代码复杂度指数增长 | 开发者熟悉 OpenCL 事件模型 |
| 分区策略 (Sol 2) | 可处理任意大数据 | 2-3x 数据搬运量 | 网络/磁盘 I/O 不是瓶颈 |

---

## 6. 使用指南与陷阱规避

### 6.1 如何调用本模块

```cpp
#include "xf_database/gqe_join.hpp"

using namespace xf::database::gqe;

// 1. 准备输入表（L2 GQE Table）
Table tab_a(orders_schema);  // O 表
Table tab_b(lineitem_schema); // L 表
Table tab_c(result_schema);   // 结果表（需预分配空间）

// 填充数据...
tab_a.setRowNum(15000000);
tab_b.setRowNum(60000000);

// 2. 创建 Joiner 实例
Joiner joiner;
joiner.setHardware(hardware_ctx);  // 设置 OpenCL 上下文、设备、程序

// 3. 选择策略（或使用默认自动选择）
// 方式 A：自动选择
ErrCode err = joiner.run(tab_a, "o_orderkey > 0",  // filter_a
                         tab_b, "l_quantity > 0",  // filter_b
                         "o_orderkey = l_orderkey", // join key
                         tab_c, "o_orderdate, l_extendedprice", // output
                         INNER_JOIN);

// 方式 B：手动指定策略（大数据必须 Sol 2）
JoinStrategyManualSet strategy;
strategy.setSolution(2);      // 强制使用 Sol 2: Partition + Join
strategy.setLogPart(8);       // 256 个分区 (1 << 8)
strategy.setSliceNum(4);      // 每个分区 4 个切片
strategy.setExpansion(1.5);   // 膨胀系数 1.5x

err = joiner.run(tab_a, ..., tab_b, ..., ..., strategy);
```

### 6.2 关键陷阱与规避

#### 陷阱 1：内存对齐违规

**现象**：程序在 `clEnqueueMigrateMemObjects` 时崩溃或返回 `CL_MEM_COPY_OVERLAP`

**原因**：用户表数据未按 64 字节对齐

**解决**：
```cpp
// 使用 GQE 提供的内存管理器
gqe::utils::MM mm;
char* aligned_buf = mm.aligned_alloc<char>(size, 64);  // 64 字节对齐

// 或者用标准库
typedef std::aligned_storage<64, 64>::type aligned_block;
```

#### 陷阱 2：结果缓冲区溢出

**现象**：结果数据错乱，或程序崩溃（内存损坏）

**原因**：`tab_c` 预分配空间不足

**解决**：
```cpp
// 方法 A：保守估计（最坏情况：笛卡尔积）
int64_t max_result_rows = tab_a.getRowNum() * tab_b.getRowNum();  // 极端保守

// 方法 B：基于选择性估计（推荐）
double selectivity = 0.1;  // 假设 10% 的匹配率
int64_t est_result_rows = tab_a.getRowNum() * selectivity;

// 方法 C：使用自动扩展（Sol 1/2 内部处理）
// 在 join_sol1/join_sol2 中，输出缓冲区是 Ping-Pong 双缓冲，内部自动管理

// 最终设置
tab_c.setRowNum(est_result_rows);
tab_c.allocColumns();  // 根据 schema 和行数分配列内存
```

#### 陷阱 3：OpenCL 事件泄漏

**现象**：长时间运行后程序崩溃，或 `clCreateUserEvent` 返回 `CL_OUT_OF_HOST_MEMORY`

**原因**：未正确释放 `cl_event` 对象

**解决**：
```cpp
// 正确做法：RAII 包装或确保每个 create 对应一个 release
class ScopedEvent {
    cl_event evt;
public:
    ScopedEvent() { clCreateUserEvent(ctx, &evt); }
    ~ScopedEvent() { clReleaseEvent(evt); }
    cl_event* get() { return &evt; }
};

// 或者手动管理（代码中实际做法）
cl_event evt;
clCreateUserEvent(ctx, &evt);
// ... 使用 ...
clSetUserEventStatus(evt, CL_COMPLETE);  // 触发下游
// ... 等待完成 ...
clReleaseEvent(evt);  // 必须释放！
```

#### 陷阱 4：线程生命周期管理

**现象**：程序退出时挂起或崩溃（段错误）

**原因**：主线程退出时，工作线程仍在运行或等待条件变量

**解决**：
```cpp
// 正确的线程关闭序列（代码中 join_sol2 的清理逻辑）
// 1. 设置停止标志
pool.q0_run = false;
pool.q1_run = false;
// ... 所有 qX_run

// 2. 唤醒所有等待条件变量的线程
pool.cv.notify_all();

// 3. 等待所有线程完成（join 阻塞等待）
if (pool.part_o_in_t.joinable()) pool.part_o_in_t.join();
if (pool.part_o_d2h_t.joinable()) pool.part_o_d2h_t.join();
// ... 所有线程

// 4. 现在安全释放 OpenCL 资源
clReleaseMemObject(buf_table_o_partition_in_col[0][0]);
// ...
```

---

## 7. 性能调优指南

### 7.1 关键参数说明

| 参数 | 含义 | 调优建议 |
|------|------|----------|
| `log_part` | 分区数 = 2^log_part | 大表内存 / 单分区内存 ≈ 分区数 |
| `slice_num` | 每分区切片数 | 使单切片 < FPGA HBM 容量 / 4 |
| `coef_expansion` | 分区膨胀系数 | 哈希冲突严重时增大 (1.3-2.0) |
| `sec_o` / `sec_l` | 输入分片策略 | 0=自动均分，1=单一大块 |

### 7.2 典型配置示例

```cpp
// 场景：U50 (8GB HBM), Orders 15GB, Lineitem 60GB
JoinStrategyManualSet strategy;
strategy.setSolution(2);           // 必须 Sol 2 (Partition + Join)
strategy.setLogPart(10);           // 1024 个分区
strategy.setSliceNum(8);           // 每分区 8 切片
strategy.setExpansionPartO(1.5);   // O 表分区膨胀 1.5x
strategy.setExpansionPartL(1.8);   // L 表分区膨胀 1.8x (Probe 端冲突更多)
```

---

## 8. 总结

### 8.1 架构亮点

1. **三级流水线**：Partition → Build → Probe，每级内部又分 Ping-Pong 双缓冲
2. **事件驱动架构**：OpenCL `cl_event` 构建精确依赖图，最大化并行重叠
3. **资源严格管控**：13 个线程、15 个队列、所有内存预分配，无动态分配
4. **策略可插拔**：Sol 0/1/2 自动/手动选择，适应不同数据规模

### 8.2 适用边界

- ✅ **适用**：大数据量（> 设备内存）、高吞吐（> 10GB/s）、流式处理场景
- ❌ **不适用**：小数据量（< 1GB，线程开销占比过高）、低延迟（< 10ms，启动开销大）、非 FPGA 平台

### 8.3 演进方向

1. **异步化**：支持多个 Join 并发，共享线程池
2. **自适应**：基于运行时统计动态调整分区数/切片数
3. **NUMA 感知**：CPU 线程绑定到数据所在 NUMA 节点
4. **零拷贝优化**：支持 RDMA/GPUDirect，跳过 Host 内存

---

## 参考链接

- 上游调用：[L3 GQE Join 策略层](database-L3-src-sw-gqe_join-strategy.md)
- 下游依赖：[L2 MetaTable 元数据管理](database-L2-src-sw-meta_table.md)
- 硬件抽象：[OpenCL/XRT 运行时](database-L1-src-sw-opencl_runtime.md)
- 相关模块：[gqe_filter_threading_and_queues](database-L3-src-sw-gqe_filter-threading_pool.md)（Filter 算子，类似架构）
