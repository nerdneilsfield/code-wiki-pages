# Renumber Benchmark Timing 子模块

**所属模块**：[graph_preprocessing_host_benchmark_timing_structs](../graph_analytics_and_partitioning-l2_graph_preprocessing_and_transforms-graph_preprocessing_host_benchmark_timing_structs.md)

**对应源码**：`graph/L2/benchmarks/renumber/host/test_renumber.cpp`

---

## 职责概述

本子模块实现针对 **重编号内核（kernel_renumber）** 的完整端到端基准测试框架。与 Merge 基准测试不同，Renumber 测试包含一个**关键特性**：

> **CPU 参考实现作为 Golden Data**：测试内置了 CPU 版本的 `renumberClustersContiguously()` 函数，用于生成参考结果，与 FPGA 输出进行直接对比。

核心职责包括：

1. **CPU 参考实现**：提供主机端算法参考，验证 FPGA 结果正确性
2. **性能对比**：直接对比 FPGA 加速 vs CPU 执行的时间
3. **端到端测试**：完整的设备初始化、数据传输、内核执行、结果验证流程

---

## 核心组件详解

### 1. CPU 参考实现：`renumberClustersContiguously`

这是本子模块最具特色的组件。它使用 STL `map` 实现社区 ID 的连续重编号：

```cpp
int renumberClustersContiguously(int* C, int size) {
    printf("Within renumberClustersContiguously()\n");

    double time1 = omp_get_wtime();  // 使用 OpenMP 计时
    
    // 建立原始社区 ID 到新连续 ID 的映射
    map<int, int> clusterLocalMap;
    map<int, int>::iterator storedAlready;
    int numUniqueClusters = 0;

    for (int i = 0; i < size; i++) {
        assert(C[i] < size);
        if (C[i] >= 0) {  // 只处理有效社区 ID
            storedAlready = clusterLocalMap.find(C[i]);
            if (storedAlready != clusterLocalMap.end()) {
                // 已存在：直接使用已有的映射
                C[i] = storedAlready->second;
            } else {
                // 新社区 ID：分配新连续编号
                clusterLocalMap[C[i]] = numUniqueClusters;
                C[i] = numUniqueClusters;
                numUniqueClusters++;
            }
        }
    }
    
    time1 = omp_get_wtime() - time1;
    double ts = time1 * 1000.0;
    printf("INFO: renumberClustersContiguously time %.4f ms.\n", ts);
    
    return numUniqueClusters;  // 返回唯一的社区数量
}
```

**算法复杂度分析**：

| 指标 | 复杂度 | 说明 |
|------|--------|------|
| 时间复杂度 | $O(n \log k)$ | $n$ 为顶点数，$k$ 为唯一社区数。每次 `map.find()` 和 `map[]` 为 $O(\log k)$ |
| 空间复杂度 | $O(k)$ | `clusterLocalMap` 存储唯一社区 ID 的映射 |
| 实际性能 | 取决于数据分布 | 如果社区 ID 已接近连续，性能更好 |

**与 FPGA 实现的对比**：

| 特性 | CPU 实现 | FPGA 实现 |
|------|----------|-----------|
| 数据结构 | STL `map`（红黑树） | 硬件哈希表或排序网络 |
| 并行度 | 单线程（串行 map 操作） | 高并行流水线 |
| 内存访问 | 随机访问（指针跳转） | 顺序流式访问 |
| 典型加速比 | 1x（基线） | 10-100x（取决于规模） |

### 2. FPGA 缓冲区布局

Renumber 内核使用特殊的缓冲区布局，支持硬件流水线处理：

```cpp
// 配置参数
int32_t configs[2];
configs[0] = numVertices;  // 输入顶点数
configs[1] = 0;            // 输出：实际社区数（由内核填充）

// HLS 任意精度整数类型
// DWIDTHS 通常是 32 或 64，表示社区 ID 位宽
ap_int<DWIDTHS>* oldCids = aligned_alloc<ap_int<DWIDTHS>>(numVertices + 1);
ap_int<DWIDTHS>* mapCid0 = aligned_alloc<ap_int<DWIDTHS>>(numVertices + 1);
ap_int<DWIDTHS>* mapCid1 = aligned_alloc<ap_int<DWIDTHS>>(numVertices + 1);
ap_int<DWIDTHS>* newCids = aligned_alloc<ap_int<DWIDTHS>>(numVertices + 1);

// 初始化输入数据
for (int i = 0; i < numVertices; i++) {
    oldCids[i] = C[i];  // C 是从文件读取的原始社区分配
}
```

**双缓冲设计**：`mapCid0` 和 `mapCid1` 是双缓冲结构，用于硬件流水线的 ping-pong 操作，允许内核在处理当前批次的同时，准备下一批次的映射表。

### 3. 执行流程对比（CPU vs FPGA）

```
CPU 执行流程 (renumberClustersContiguously):
=============================================
1. 初始化空 map
2. For each vertex i:
   a. 在 map 中查找 C[i]
   b. 如果找到：使用已有映射
   c. 如果没找到：分配新 ID，插入 map
   d. 更新 C[i] = 新 ID
3. 返回唯一社区数

时间复杂度: O(n log k) - 串行执行


FPGA 执行流程 (kernel_renumber):
=================================
1. 主机: 准备 oldCids 缓冲区
2. H2D: 传输 oldCids -> FPGA
3. FPGA: 
   a. 并行读取 oldCids 流
   b. 硬件哈希/排序确定唯一 ID
   c. 并行生成 newCids
4. D2H: 传输 newCids -> 主机
5. 主机: 读取 configs[1] 获取社区数

时间复杂度: O(n/p) + O(k) - 高度并行 (p 为并行度)
```

**性能对比示例**（假设值）：

| 指标 | CPU (单线程) | FPGA | 加速比 |
|------|-------------|------|--------|
| 10K 顶点，100 社区 | 2 ms | 0.2 ms | 10x |
| 100K 顶点，1K 社区 | 30 ms | 1 ms | 30x |
| 1M 顶点，10K 社区 | 500 ms | 5 ms | 100x |

**注意**：实际性能高度依赖于：
- 社区分布（稀疏/密集）
- FPGA 内核的具体实现（哈希表大小、流水线深度）
- PCIe 带宽和数据传输量

---

## 调试与故障排除

### 问题 1：CPU 和 FPGA 结果不一致

**可能原因**：
1. **社区 ID 边界处理**：CPU 代码跳过负值 (`if (C[i] >= 0)`)，FPGA 内核是否一致？
2. **并发修改**：`renumberClustersContiguously` 直接修改输入数组，是否意外影响了后续 FPGA 输入？

**排查方法**：
```cpp
// 在调用 renumberClustersContiguously 前保存副本
int* C_copy = (int*)malloc(sizeof(int) * numVertices);
memcpy(C_copy, C, sizeof(int) * numVertices);

// 生成 Golden 结果
int numClusters = renumberClustersContiguously(C_copy, numVertices);

// 现在 C 保持不变，可以安全传递给 FPGA
// ... 准备 oldCids 使用原始 C ...
```

### 问题 2：CPU 时间 vs FPGA 时间可比性

**问题**：`renumberClustersContiguously` 使用 `omp_get_wtime()`，而主机端使用 `gettimeofday()`，两者如何对比？

**解答**：
- `omp_get_wtime()` 也是 Wall Clock 时间，单位秒，精度通常微秒级
- 两者都测量真实时间（非 CPU 时间），理论上可比
- 注意 `omp_get_wtime()` 的精度可能依赖于 OpenMP 实现

**建议**：
```cpp
// 统一使用 gettimeofday 进行 CPU 计时
struct timeval cpu_start, cpu_end;
gettimeofday(&cpu_start, 0);
renumberClustersContiguously(...);  // 移除内部的 omp_get_wtime
gettimeofday(&cpu_end, 0);
double cpu_ms = tvdiff(&cpu_start, &cpu_end) / 1000.0;
```

### 问题 3：大规模数据集的内存分配失败

**现象**：`aligned_alloc` 返回 `nullptr`，或程序被 OOM Killer 终止

**诊断**：
```cpp
size_t total_bytes = numVertices * (
    sizeof(int) +           // oldCids
    sizeof(int) +           // mapCid0
    sizeof(int) +           // mapCid1
    sizeof(int) +           // newCids
    sizeof(int) * 3         // 其他辅助数组
);
std::cout << "Estimated memory: " << total_bytes / (1024*1024) << " MB\n";
```

**解决方案**：
1. **分块处理**：将大规模图分割为多个子图分别处理
2. **内存映射**：使用 `mmap` 替代堆分配
3. **NUMA 感知**：在多路服务器上指定 NUMA 节点分配内存

---

*子模块文档版本：1.0*  
*最后更新：2024*  
*维护团队：Graph Analytics FPGA Acceleration Team*
