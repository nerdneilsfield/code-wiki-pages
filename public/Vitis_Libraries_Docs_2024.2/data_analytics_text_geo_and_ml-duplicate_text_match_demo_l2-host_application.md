# Host Application: 重复记录匹配主机端编排器

## 一句话概括

`host_application` 是重复文本记录匹配（Duplicate Record Matching）演示的主机端入口，它扮演着**机场塔台**的角色：协调 FPGA 加速器（"飞机"）与地面数据流（"乘客与行李"）之间的有序交互，确保原始记录数据被准确送入硬件流水线，并将匹配结果（聚类成员关系与置信度）安全回收、验证并交付。

---

## 1. 问题空间：为何需要这个模块？

### 1.1 实体解析的计算困境

在数据清洗场景中，识别描述同一实体的重复记录涉及**组合爆炸**问题：N 条记录需要 O(N²) 次相似度计算。通用 CPU 在处理大规模字符串相似度（编辑距离、Jaccard 等）时效率受限——SIMD 单元宽度有限、内存随机访问缓存不友好、分支预测失败代价高。

### 1.2 FPGA 加速的必要性

FPGA 提供**自定义数据通路**、**高并行度**（同时处理数百对记录）和**确定性时延**（无操作系统调度抖动）。但 FPGA 无法独立完成整个任务——需要主机端协调：数据编解码、DMA 内存管理、流控与同步、结果聚合、验证与调试。

### 1.3 为何选择同步阻塞模型？

本模块采用**同步阻塞**设计（`dup_match.run()` 直到 FPGA 完成才返回）。这是**有意为之**的 L2 级演示（Level 2 Demonstration）权衡——功能验证优先于吞吐率最大化。同步模型保证**确定性执行**和**易于调试**，避免了异步流水线带来的复杂状态管理。

---

## 2. 核心抽象："机场塔台" 心智模型

```
塔台调度员 (main() 函数)
├── 接收飞行计划        (解析命令行：xclbin, 输入文件, golden文件)
├── 验证计划可行性      (检查文件存在性)
├── 协调各部门同步      (初始化 DupMatch 对象)
├── 发布起飞指令        (调用 run() 启动处理)
└── 监控航班状态        (计时与结果验证)
        │
        ▼
停机坪与登机口 (DupMatch 类) ──► 飞机 (FPGA 内核)
        │                              │
        ▼                              ▼
行李处理系统    ◄──────────────────────┘
(输入/输出数据流)
```

---

## 3. 代码解剖与关键实现

### 3.1 命令行解析与验证阶段

```cpp
// 严格分层的状态机：参数获取 → 存在性验证 → 错误处理
std::string xclbin_path;
if (!parser.getCmdOption("-xclbin", xclbin_path)) {
    std::cout << "ERROR:xclbin path is not set!\n";
    return -1;  // 提前失败（fail-fast）
}
if (!exist_file(xclbin_path)) {
    std::cout << "ERROR: xclbin file is not exist\n";
    return -1;  // 避免部分初始化后的复杂清理
}
```

**防御性编程策略**：采用**提前失败（fail-fast）**模式。在分配任何 FPGA 资源或读取输入数据之前，先验证所有文件路径的可访问性。这避免了在部分初始化状态下的复杂清理逻辑。

### 3.2 核心执行与计时

```cpp
struct timeval tk1, tk2;
gettimeofday(&tk1, 0);  // 使用 POSIX 而非 std::chrono，保证嵌入式环境兼容性

const std::vector<std::string> field_name{"Site name", "Address", "Zip", "Phone"};
DupMatch dup_match = DupMatch(in_file, golden_file, field_name, xclbin_path);
std::vector<std::pair<uint32_t, double> > cluster_membership;
dup_match.run(cluster_membership);  // 同步阻塞，直到 FPGA 完成

gettimeofday(&tk2, 0);
std::cout << "Execution time " << tvdiff(&tk1, &tk2) / 1000.0 << "s" << std::endl;
```

**关键设计决策解读**：

1. **为何使用 `gettimeofday` 而非 `std::chrono`？**
   - **历史兼容性**：`gettimeofday` 是 POSIX 标准，在 Xilinx 嵌入式 Linux 环境中有确定行为
   - **微秒级精度**：`struct timeval` 直接提供 `tv_sec` 和 `tv_usec`，无需 `duration_cast`
   - **跨平台一致性**：`std::chrono` 的高分辨率时钟在不同平台（x86 vs ARM）可能有不同实现保证

2. **为何 `field_name` 是硬编码的？**
   这揭示了该演示的**领域特定性**：它是为特定的餐厅/企业目录数据集设计的。这不是通用框架，而是**概念验证（PoC）**。字段名对应输入 CSV 的列头，`DupMatch` 使用这些名称来定位相似度计算所需的列。

3. **RAII 与对象生命周期**：
   - `DupMatch` 对象在栈上构造（`DupMatch dup_match = DupMatch(...)`）
   - 构造函数内部可能分配堆内存（OpenCL 缓冲区、DMA 内存），但外部通过栈对象间接管理
   - 析构时自动释放 FPGA 资源，即使 `run()` 抛出异常也不会泄漏（假设 `DupMatch` 实现遵循 RAII）

4. **输出参数 vs 返回值**：
   使用**输出参数**（非 const 引用）而非返回值，允许调用者：
   - 预分配内存（如果知道大小）避免重新分配
   - 重复使用同一向量进行多次运行（`clear()` 后重用容量）
   - 避免大向量返回值优化（RVO）不确定时的拷贝

### 3.3 结果验证逻辑详解

```cpp
if (en_check) {
    std::ifstream f(golden_file, std::ios::in);
    std::string line_str;
    uint32_t ii = 0;
    while (getline(f, line_str)) {
        if (cluster_membership[ii++].first != std::stoi(line_str)) nerr++;
    }
    f.close();
}
```

**隐式契约与边界情况**：

1. **行序假设**：Golden 文件与 `cluster_membership` 向量**必须按相同记录顺序排列**。代码假设第 i 行对应第 i 条输入记录。

2. **越界风险**（**关键缺陷**）：
   - 循环条件 `while (getline(f, line_str))` 在文件结束时停止
   - 如果 golden 文件行数 < `cluster_membership.size()`，验证不完整
   - 如果 golden 文件行数 > `cluster_membership.size()`，`cluster_membership[ii++]` 将在 `ii >= size()` 时访问越界，导致**未定义行为**

   **生产环境应添加**：
   ```cpp
   if (ii >= cluster_membership.size()) {
       logger.error("Golden file has more lines than output records");
       nerr++;
       break;
   }
   ```

3. **整数解析异常**：`std::stoi(line_str)` 在 `line_str` 不是有效整数时抛出 `std::invalid_argument` 或 `std::out_of_range`。演示代码**没有异常处理**，非整数输入将导致程序异常终止。

---

## 4. 依赖关系与模块定位

### 4.1 架构层次位置

```
L3: 应用框架层 (完整端到端管道)
    ▲
    │ uses
L2: 演示验证层 (功能正确性验证)  ◄── YOU ARE HERE
    │   host_application (本文档)
    │   ├── 命令行接口
    │   ├── 资源生命周期管理
    │   └── 结果验证与计时
    │
    ├── uses ──► DupMatch 类 (host_predicate_logic 模块)
    │            ├── OpenCL 上下文管理
    │            ├── FPGA 缓冲区分配
    │            └── 内核启动与同步
    │
    └── loads ──► FPGA 比特流 (kernel_connectivity 模块)
                  ├── 相似度计算内核
                  ├── 聚类/连通分量内核
                  └── DMA 与内存接口
```

### 4.2 关键依赖契约

**对 `DupMatch` 类的依赖**：
- **构造函数**：`DupMatch(in_file, golden_file, field_name, xclbin_path)`
  - 预条件：所有文件路径有效且可读，xclbin 兼容当前硬件
  - 副作用：分配 FPGA 缓冲区，加载比特流，解析输入 CSV
- **run 方法**：`void run(std::vector<std::pair<uint32_t, double>>& cluster_membership)`
  - 同步阻塞直至 FPGA 完成
  - 后置条件：`cluster_membership.size()` 等于输入记录数

---

## 5. 新手指南：扩展与维护

### 5.1 如何添加新的命令行选项

在 `ArgParser parser(argc, argv)` 之后、文件验证之前添加：

```cpp
std::string my_new_param;
if (!parser.getCmdOption("-myparam", my_new_param)) {
    // 可选参数：不提供则使用默认值
    my_new_param = "default_value";
}
// 将参数传递给 DupMatch（需修改 DupMatch 构造函数）
DupMatch dup_match = DupMatch(in_file, golden_file, field_name, xclbin_path, my_new_param);
```

### 5.2 如何修改计时范围

当前计时包含对象构造 + FPGA 执行 + 结果回传。如需仅测量 FPGA 执行：

```cpp
// 将计时起点移到 run() 之前
dup_match.prepare();  // 若需分离准备阶段
gettimeofday(&tk1, 0);
dup_match.run(cluster_membership);
gettimeofday(&tk2, 0);
// 计算传输 + 执行时间
```

### 5.3 如何处理新的输出格式

若 `DupMatch` 未来输出额外信息（如相似度矩阵）：

```cpp
// 添加新的输出容器
std::vector<std::pair<uint32_t, double>> cluster_membership;
std::vector<float> similarity_matrix;  // 新增

// 修改 run 签名或添加新方法
dup_match.run_with_similarity(cluster_membership, similarity_matrix);

// 序列化到文件用于分析
std::ofstream sim_out("similarity.bin", std::ios::binary);
sim_out.write(reinterpret_cast<char*>(similarity_matrix.data()), 
              similarity_matrix.size() * sizeof(float));
```

---

## 6. 已知限制与未来工作

### 6.1 当前限制

1. **单线程阻塞**：无法利用 CPU-FPGA 流水线重叠
2. **固定字段名**：仅支持硬编码的四字段 CSV 格式
3. **Golden 验证脆弱性**：无长度检查，存在越界风险
4. **异常安全性**：无 try-catch 块，异常会导致资源泄漏（若 DupMatch 析构函数不完善）
5. **精度限制**：`gettimeofday` 受系统时钟调整影响，不适合亚毫秒精度测量

### 6.2 建议改进方向

1. **异步流水线**：使用 `std::async` 或自定义线程池实现双缓冲
2. **配置驱动**：添加 JSON/YAML 配置文件支持动态字段映射
3. **稳健验证**：添加边界检查、异常处理、详细错误消息
4. **现代 C++**：迁移到 `std::chrono::steady_clock`，使用 `std::filesystem::path`
5. **可观测性**：添加结构化日志（JSON 格式）、性能指标导出（Prometheus 风格）

---

## 7. 总结

`host_application` 作为 L2 级演示的主机端入口，其设计哲学是**"清晰优于 clever"**。通过同步阻塞模型、严格的阶段分离（解析→验证→执行→验证）、以及显式的错误处理路径，它为 FPGA 加速的实体解析算法提供了一个**可理解、可调试、可扩展**的参考实现。

理解这个模块的关键在于把握其**架构定位**：它不是生产级数据管道，而是连接算法创新与工程实现的**桥梁**——让研究者能够快速验证 FPGA 加速的正确性，同时为工程团队提供清晰的扩展路径。