# Graph Preprocessing Merge Kernel Configuration

想象一下你正在组装一台高性能赛车引擎。每个气缸都需要精确连接到燃油喷射系统，每个管道都必须有正确的直径和长度，以确保燃油在最恰当的时刻到达。这不是简单的连接——而是关于**带宽、延迟和物理约束的精确编排**。

`graph_preprocessing_merge_kernel_configuration` 模块正是这样一个"引擎组装配置"——它定义了图数据预处理 Merge Kernel 与底层 FPGA 硬件资源（HBM 内存、AXI 互联、Super Logic Region）的映射关系。这不是简单的"配置文件"，而是**硬件-软件协同设计的关键契约**。

## 问题空间：为什么需要这个模块？

### 图预处理的工作负载特性

在图神经网络（GNN）和图分析工作负载中，**Merge Kernel** 承担着图结构数据合并与重组的核心任务。它需要：

1. **高带宽内存访问**：同时读取多个边列表（edge list）和顶点属性（vertex property）
2. **低延迟随机访问**：图结构通常表现为高度不规则的内存访问模式
3. **大规模数据并行**：需要同时处理多个子图分区（subgraph partition）

### 硬件约束的复杂性

Xilinx Alveo U50 加速器卡提供了丰富的硬件资源，但也带来了复杂的配置挑战：

| 资源类型 | 规格 | 配置难点 |
|---------|------|---------|
| HBM (High Bandwidth Memory) | 8GB, 16个伪通道（pseudo-channel） | 需要将高带宽端口均匀分布到不同伪通道以避免争用 |
| AXI4-MM 接口 | 512-bit 数据宽度 | 需要匹配 kernel 内部数据路径宽度 |
| SLR (Super Logic Region) | 3个 SLR (SLR0, SLR1, SLR2) | 需要平衡资源利用和跨 SLR 信号延迟 |
| DDR4 | 可选的板载 DDR | 用于大容量低带宽数据存储 |

### 天真方案的问题

如果没有精心设计的 connectivity 配置：

1. **内存端口争用**：多个 AXI 端口映射到同一个 HBM 伪通道，导致严重的性能瓶颈
2. **跨 SLR 路由拥堵**：Kernel 放置在一个 SLR，但内存接口分布在其他 SLR，导致路由资源耗尽
3. **带宽利用不均**：某些 HBM 伪通道饱和而其他伪通道空闲，整体带宽利用率低下

## 架构设计

### 配置文件解析

`conn_u50.cfg` 文件使用 Vitis 平台的 connectivity 配置格式，定义了 kernel 实例与硬件资源的映射关系：

```ini
[connectivity]
sp=merge_kernel.m_axi_gmem0:HBM[0]
sp=merge_kernel.m_axi_gmem1:HBM[1]
sp=merge_kernel.m_axi_gmem2:HBM[2:3]
... (共12个AXI端口映射)
slr=merge_kernel:SLR0
nk=merge_kernel:1:merge_kernel
```

### 关键配置项解析

#### 1. `sp` (AXI Stream/Port Mapping)

语法：`sp=<kernel_instance>.<port_name>:<memory_resource>`

**设计意图**：将 kernel 的 AXI4-MM 主端口（m_axi）映射到特定的硬件内存资源。每个 `m_axi_gmem*` 对应 kernel 代码中的一个全局内存指针参数。

**配置细节分析**：

```ini
sp=merge_kernel.m_axi_gmem0:HBM[0]     # 单伪通道映射
sp=merge_kernel.m_axi_gmem2:HBM[2:3]   # 双伪通道交织映射
```

- **单伪通道映射** (`HBM[0]`)：适用于访问模式相对集中的数据，保证一致性
- **交织映射** (`HBM[2:3]`)：将地址空间均匀分布在两个伪通道，提升有效带宽

**端口到伪通道分配策略**：

| AXI 端口 | HBM 伪通道 | 分配模式 |
|---------|-----------|---------|
| gmem0 | [0] | 单通道 |
| gmem1 | [1] | 单通道 |
| gmem2 | [2:3] | 双通道交织 |
| gmem3 | [4:5] | 双通道交织 |
| gmem4 | [6] | 单通道 |
| gmem5 | [7] | 单通道 |
| gmem6 | [8:9] | 双通道交织 |
| gmem7 | [10:11] | 双通道交织 |
| gmem8 | [12] | 单通道 |
| gmem9 | [13] | 单通道 |
| gmem10 | [14] | 单通道 |
| gmem11 | [15] | 单通道 |

**设计原理**：
- 高带宽需求的数据流（如边列表）分配到双通道交织端口 (gmem2, gmem3, gmem6, gmem7)
- 控制数据和元数据使用单通道端口
- 所有 16 个 HBM 伪通道都被利用，实现最大化带宽

#### 2. `slr` (Super Logic Region Placement)

语法：`slr=<kernel_instance>:<slr_id>`

```ini
slr=merge_kernel:SLR0
```

**设计意图**：将 kernel 的逻辑资源（LUT、FF、BRAM、URAM、DSP）映射到特定的 SLR 区域。

**为什么选择 SLR0？**

1. **HBM 物理位置**：U50 的 HBM 控制器位于 SLR0，将 kernel 放在同一 SLR 可以最小化跨 SLR 路由延迟
2. **资源可用性**：SLR0 通常具有最丰富的资源，适合放置大型 compute kernel
3. **时序收敛**：减少跨 SLR 信号有助于满足时序约束，提高最大工作频率

#### 3. `nk` (Number of Kernel Instances)

语法：`nk=<kernel_name>:<num_instances>:<instance_names>`

```ini
nk=merge_kernel:1:merge_kernel
```

**设计意图**：定义 kernel 的实例化数量和命名。

- `1`：实例化一个 kernel
- `merge_kernel`：实例名称（与 kernel 名称相同）

**扩展性考虑**：如果需要多 kernel 并行处理（例如流水线中的多个 stage），可以修改为：
```ini
nk=merge_kernel:2:merge_kernel_0.merge_kernel_1
```

## 设计决策与权衡

### 1. HBM 伪通道分配策略

**选择的方案**：12 个 AXI 端口映射到 16 个 HBM 伪通道，其中 8 个端口使用单通道模式，4 个端口使用双通道交织模式。

**替代方案考虑**：

| 方案 | 描述 | 优点 | 缺点 |
|-----|------|------|------|
| A. 全双通道 | 所有 12 个端口都映射到 2 个伪通道 | 最大化单个端口带宽 | 需要 24 个伪通道，超出 HBM 16 通道限制 |
| B. 更均衡分布 | 每个端口映射到 1.33 个伪通道 | 理论上的完美均衡 | 硬件不支持分数通道映射 |
| C. 当前方案 | 关键端口双通道，其他单通道 | 在资源约束下最大化关键路径带宽 | 非关键端口带宽受限 |

**决策理由**：

当前方案（方案 C）是在**硬件资源约束**（16 个 HBM 伪通道）和**应用带宽需求**之间的最优折中。图 Merge Kernel 的核心计算通常围绕边和顶点数据展开，因此 gmem0-gmem3（边和顶点数据）获得最高的带宽分配是合理的。

### 2. SLR 放置决策

**选择的方案**：将 kernel 放置在 SLR0。

**关键考量因素**：

1. **HBM 控制器位置**：在 Alveo U50 上，HBM 控制器物理上位于 SLR0。将 kernel 放在同一 SLR 可以避免跨 SLR 的长距离路由，显著降低信号延迟。

2. **时序收敛**：跨 SLR 的信号需要通过专门的 SLR crossing 资源，这些资源有限且引入额外延迟。本地化放置有助于满足时序约束，特别是在高时钟频率（如 300MHz+）下。

3. **资源利用**：SLR0 通常具有与其他 SLR 相当的资源容量，对于单个 Merge Kernel 实例来说资源充足。

### 3. 单 Kernel 实例决策

**选择的方案**：实例化单个 kernel (`nk=merge_kernel:1:merge_kernel`)。

**设计考量**：

1. **资源效率**：单个 Merge Kernel 实例已经能够充分利用 HBM 带宽（12 个 AXI 端口，每个 512-bit 宽，在 300MHz 下理论峰值带宽约为 230GB/s）。多个实例会导致内存端口争用，反而降低效率。

2. **数据局部性**：图数据预处理通常涉及大量的数据依赖和随机访问。单实例执行可以更好地利用数据局部性，而多实例可能导致缓存失效和内存冲突。

3. **任务粒度**：Merge Kernel 通常处理的是整个子图或分区的合并操作，任务粒度足够大，能够充分填充 pipeline，无需多实例并行。

---

## 与周边模块的关系

### 上游模块

1. **[graph_preprocessing_renumber_kernel_configuration](graph_analytics_and_partitioning-l2_graph_preprocessing_and_transforms-graph_preprocessing_renumber_kernel_configuration.md)**
   - Renumber Kernel 通常作为 Merge Kernel 的前置步骤，负责对图顶点进行重新编号以优化内存访问模式
   - 两个 kernel 共享相似的 HBM 端口配置策略，但 Renumber Kernel 可能使用更少的端口（因为主要是索引操作）

2. **[graph_preprocessing_host_benchmark_timing_structs](graph_analytics_and_partitioning-l2_graph_preprocessing_and_transforms-graph_preprocessing_host_benchmark_timing_structs.md)**
   - 提供主机端的时间测量基础设施
   - Merge Kernel 的执行时间、HBM 带宽利用率等指标通过该模块进行采集和分析

### 下游模块

Merge Kernel 的输出通常直接传递给图分析算法 kernel（如 PageRank、Triangle Counting 等）：

1. **[pagerank_base_benchmark](graph_analytics_and_partitioning-l2_pagerank_and_centrality_benchmarks-pagerank_base_benchmark.md)**
   - 使用经过 Merge Kernel 预处理后的图结构进行 PageRank 计算
   - 期望输入数据符合特定的内存布局（CSR 或 CSC 格式）

2. **[triangle_count_benchmarks_and_platform_kernels](graph_analytics_and_partitioning-l2_graph_patterns_and_shortest_paths_benchmarks-triangle_count_benchmarks_and_platform_kernels.md)**
   - Triangle Counting kernel 依赖于 Merge Kernel 生成的邻接表结构

---

## 使用指南

### 配置文件的使用场景

#### 1. Vitis 编译流程

在编译 FPGA 二进制文件（`.xclbin`）时，connectivity 配置文件作为 `v++` 编译器的输入：

```bash
v++ -l \
    -t hw \
    --platform xilinx_u50_gen3x16_xdma_201920_3 \
    --config conn_u50.cfg \
    -o merge_kernel.xclbin \
    merge_kernel.xo
```

#### 2. 主机代码集成

主机代码需要与 connectivity 配置保持一致，特别是在内存缓冲区分配和 kernel 参数设置时：

```cpp
// 主机端内存分配（与 kernel 端 12 个端口对应）
std::vector<cl_mem_ext_ptr_t> ext_ptrs(12);
std::vector<cl_mem> buffers(12);

// HBM 伪通道分配（与 cfg 文件中的 sp= 映射一致）
int hbm_channels[] = {0, 1, 2, 4, 6, 7, 8, 10, 12, 13, 14, 15};

for (int i = 0; i < 12; i++) {
    ext_ptrs[i].obj = host_data[i];
    ext_ptrs[i].param = 0;
    ext_ptrs[i].flags = XCL_MEM_TOPOLOGY | (hbm_channels[i] << 16);
    
    buffers[i] = clCreateBuffer(context, 
                                CL_MEM_READ_WRITE | CL_MEM_EXT_PTR_XILINX,
                                buffer_sizes[i], &ext_ptrs[i], &err);
}

// 设置 kernel 参数（顺序必须与 kernel 函数签名匹配）
clSetKernelArg(kernel, 0, sizeof(cl_mem), &buffers[0]);  // m_axi_gmem0
clSetKernelArg(kernel, 1, sizeof(cl_mem), &buffers[1]);  // m_axi_gmem1
// ... 继续设置所有 12 个参数
```

### 配置调优指南

#### 场景 1：增加带宽需求

如果应用分析显示某些数据流出现带宽瓶颈，考虑：

1. **增加交织深度**：将单通道映射改为双通道或四通道交织
   ```ini
   # 修改前
   sp=merge_kernel.m_axi_gmem0:HBM[0]
   
   # 修改后
   sp=merge_kernel.m_axi_gmem0:HBM[0:1:2:3]  # 四通道交织
   ```

2. **负载均衡**：重新分配端口到伪通道，确保高流量端口分散到不同 HBM bank

#### 场景 2：降低资源占用

如果需要为其他 kernel 腾出资源：

1. **减少 AXI 端口**：修改 kernel 代码减少 m_axi 接口数量，相应更新 cfg 文件
   
2. **使用 DDR 替代部分 HBM**：对带宽需求不高的数据使用板载 DDR
   ```ini
   sp=merge_kernel.m_axi_gmem_metadata:DDR[0]
   ```

#### 场景 3：多 kernel 扩展

当单 kernel 无法满足吞吐量需求时：

```ini
# 实例化 2 个 kernel
nk=merge_kernel:2:merge_kernel_0.merge_kernel_1

# 分别放置到不同 SLR
slr=merge_kernel_0:SLR0
slr=merge_kernel_1:SLR1

# 分配独立的 HBM 端口（避免冲突）
# Kernel 0 使用 HBM[0:7]
sp=merge_kernel_0.m_axi_gmem0:HBM[0]
...

# Kernel 1 使用 HBM[8:15]
sp=merge_kernel_1.m_axi_gmem0:HBM[8]
...
```

---

## 潜在陷阱与调试指南

### 1. 主机与 CFG 配置不匹配

**症状**：Kernel 启动后挂起或返回错误数据。

**诊断**：
```bash
# 使用 xbutil 检查内存拓扑
xbutil examine -d <bdf> --report memory

# 对比输出中的 HBM 通道分配与 cfg 文件
```

**修复**：确保主机代码中的 `XCL_MEM_TOPOLOGY` 与 cfg 文件中的 `sp=` 映射一致。

### 2. HBM 伪通道争用

**症状**：实测带宽远低于理论峰值，性能随数据量增加而急剧下降。

**诊断**：使用 Vitis Analyzer 打开编译生成的 `.xclbin.info` 文件，检查 AXI 端口到 HBM 控制器的路由。

**修复**：重新分配端口到伪通道，确保高并发访问的端口映射到不同的 HBM bank。

### 3. SLR 跨越导致的时序失败

**症状**：编译时出现大量 `Route` 或 `Timing` 错误，或在某些频率下 kernel 无法正常工作。

**诊断**：
```bash
# 检查实现后的时序报告
grep -i "slack" _x/link/vivado/vpl/prj/prj.runs/impl_1/*_timing_summary_*.rpt
```

**修复**：
- 确保 `slr=` 配置与实际资源需求匹配
- 考虑将大型 kernel 拆分为多个小的 DATAFLOW 阶段，分别放置到不同 SLR
- 调整时钟频率约束

### 4. Kernel 实例命名冲突

**症状**：编译错误提示重复的 kernel 实例名。

**诊断**：检查 `nk=` 行中的实例名称是否在其他 cfg 文件或同一文件的其他位置重复使用。

**修复**：确保每个 `nk=` 定义的实例名在全局范围内唯一。

---

## 性能优化最佳实践

### 1. 内存访问模式优化

**原则**：kernel 内部的内存访问模式应与 HBM 端口的物理特性匹配。

**实践**：
- 对于顺序访问的数据，使用 `__attribute__((coalesce))` 提示编译器合并访问
- 对于随机访问，确保访问粒度与 HBM 突发长度（burst length）对齐（通常为 64 字节）

### 2. 流水线深度调优

**原则**：在 kernel 内部使用 `DATAFLOW` 和 `PIPELINE` pragma 实现指令级并行。

**实践**：
```cpp
// 在 kernel 代码中
void merge_kernel(...) {
    #pragma HLS INTERFACE m_axi port=edge_list offset=slave bundle=gmem0
    #pragma HLS INTERFACE m_axi port=vertex_prop offset=slave bundle=gmem1
    // ... 更多接口定义
    
    #pragma HLS DATAFLOW
    
    // 多个并行 stage
    hls::stream<data_t> stream_a("stream_a");
    hls::stream<data_t> stream_b("stream_b");
    
    stage_1_load(edge_list, stream_a);
    stage_2_process(stream_a, stream_b);
    stage_3_store(stream_b, output);
}
```

### 3. 批处理大小调优

**原则**：通过调整主机端每次 kernel 调用的数据批次大小，隐藏 kernel 启动开销并充分利用 HBM 带宽。

**实践**：
- 对于小规模图，使用单批次处理整个图
- 对于大规模图，将图划分为多个分区（partition），每个分区作为一个批次
- 批次大小的选择应考虑 HBM 容量限制和 kernel 内部 buffer 大小

---

## 模块演进与未来扩展

### 当前限制

1. **固定端口数量**：当前配置硬编码了 12 个 AXI 端口，对于某些只需要少量端口的 kernel 会造成资源浪费
   
2. **单 SLR 放置**：所有 kernel 资源都集中在 SLR0，可能导致该 SLR 资源过度使用，而其他 SLR 闲置

3. **静态配置**：配置文件在编译时确定，无法在运行时根据输入数据特性动态调整

### 潜在改进方向

#### 1. 参数化配置生成

使用脚本根据 kernel 特性和输入数据自动生成最优的 connectivity 配置：

```python
# 概念性的配置生成脚本
def generate_connectivity_config(kernel_info, platform_info):
    config = "[connectivity]\n"
    
    # 根据 kernel 的内存访问模式分配 HBM 端口
    for i, port in enumerate(kernel_info.memory_ports):
        if port.bandwidth_requirement > THRESHOLD_HIGH:
            # 高带宽需求：分配双通道
            config += f"sp={kernel_info.name}.m_axi_{port.name}:HBM[{i*2}:{i*2+1}]\n"
        else:
            # 低带宽需求：单通道
            config += f"sp={kernel_info.name}.m_axi_{port.name}:HBM[{i}]\n"
    
    # 根据 platform 资源分配 SLR
    if platform_info.total_slr > 1:
        # 多 SLR 平台：考虑负载均衡
        for i in range(kernel_info.num_instances):
            slr_id = i % platform_info.total_slr
            config += f"slr={kernel_info.name}_{i}:SLR{slr_id}\n"
    else:
        config += f"slr={kernel_info.name}:SLR0\n"
    
    return config
```

#### 2. 动态重配置支持

未来的 Xilinx 平台可能支持部分重配置（Partial Reconfiguration），允许在运行时根据工作负载动态更换 kernel 逻辑。

---

## 总结

`graph_preprocessing_merge_kernel_configuration` 模块是图预处理流水线中关键的硬件资源配置层。它通过精心设计的 HBM 端口分配、SLR 放置和 AXI 接口映射，实现了图 Merge Kernel 与 Alveo U50 硬件资源的最优协同。

对于新加入团队的开发者，理解这个模块需要注意：

1. **硬件意识**：始终牢记 HBM 的 16 个伪通道限制、SLR 的物理位置、AXI 接口的带宽约束
2. **配置一致性**：确保 cfg 文件、主机代码、kernel 代码三者的端口定义和内存分配完全匹配
3. **性能导向**：任何配置的修改都应该基于性能分析数据，而不是主观猜测

这个模块虽然只是一个配置文件，但它体现了硬件-软件协同设计的精髓，是高性能 FPGA 加速器开发的关键一环。
