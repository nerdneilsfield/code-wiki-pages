# PageRank Cache-Optimized Benchmark - Kernel Connectivity

## 一句话概括

本文件是 FPGA 内核的**硬件连接配置图**，定义了 PageRank 计算核的 8 个 AXI 主接口到 HBM 高带宽内存物理 Bank 的映射关系，以及内核在 FPGA 芯片上的物理布局约束。

---

## 文件目的与上下文

### 为什么需要这个配置文件？

在 Xilinx Vitis 开发流程中，硬件连接配置 (`*.cfg`) 文件是**连接抽象内核代码与物理 FPGA 资源**的关键桥梁：

1. **AXI 接口映射**：内核代码中的 `m_axi_gmem*` 接口是逻辑抽象，cfg 文件将它们绑定到具体的 HBM Bank
2. **物理布局约束**：指定内核放置的 SLR (Super Logic Region)，确保满足时序要求
3. **内存拓扑声明**：告知 Vitis 链接器 (v++ -l) 如何构建内存子系统

没有这个文件，Vitis 链接器将无法知道：
- 哪个 `m_axi` 接口连接到哪个 HBM Bank
- 内核应该放置在 FPGA 的哪个物理区域
- 如何分配内存控制器资源

### 模块在整个系统中的位置

```
Vitis 编译流程：
                    
kernel_pagerank.cpp ──→ v++ -c (编译) ──→ kernel_pagerank.xo
                                               ↓
conn_u50.cfg ──────────────────────────────→ v++ -l (链接)
                                               ↓
                                         kernel_pagerank.xclbin
                                               ↓
                                   加载到 Alveo U50/U280 FPGA
```

---

## 配置详解

### 完整配置内容

```ini
[connectivity]
sp = kernel_pagerank_0.m_axi_gmem0:HBM[0]
sp = kernel_pagerank_0.m_axi_gmem1:HBM[2:3]
sp = kernel_pagerank_0.m_axi_gmem2:HBM[4:5]
sp = kernel_pagerank_0.m_axi_gmem3:HBM[6:7]
sp = kernel_pagerank_0.m_axi_gmem4:HBM[8:9]
sp = kernel_pagerank_0.m_axi_gmem5:HBM[10:11]
sp = kernel_pagerank_0.m_axi_gmem6:HBM[12:13]
sp = kernel_pagerank_0.m_axi_gmem7:HBM[1]
slr = kernel_pagerank_0:SLR0
nk = kernel_pagerank_0:1:kernel_pagerank_0
```

### 指令类型详解

#### 1. `sp` (Stream Port) - 内存映射连接

**语法**：`sp = <kernel>.<interface>:<memory_resource>`

| 配置行 | 内核接口 | HBM 目标 | 用途 |
|--------|---------|---------|------|
| `sp = ...m_axi_gmem0:HBM[0]` | gmem0 | Bank 0 | CSC 列偏移 (`offsetArr`) |
| `sp = ...m_axi_gmem1:HBM[2:3]` | gmem1 | Bank 2-3 | 行索引 (`indiceArr`) |
| `sp = ...m_axi_gmem2:HBM[4:5]` | gmem2 | Bank 4-5 | 边权重 (`weightArr`) |
| `sp = ...m_axi_gmem3:HBM[6:7]` | gmem3 | Bank 6-7 | 出度数组 (`degreeCSR`) |
| `sp = ...m_axi_gmem4:HBM[8:9]` | gmem4 | Bank 8-9 | 常量/累加值 (`cntValFull`) |
| `sp = ...m_axi_gmem5:HBM[10:11]` | gmem5 | Bank 10-11 | 乒乓缓冲 Pong (`buffPong`) |
| `sp = ...m_axi_gmem6:HBM[12:13]` | gmem6 | Bank 12-13 | Ping缓冲/结果信息 (`buffPing`, `resultInfo`) |
| `sp = ...m_axi_gmem7:HBM[1]` | gmem7 | Bank 1 | 排序/展开顺序 (`orderUnroll`) |

**为什么 gmem1-gmem6 使用多 Bank 范围？**

```
HBM[2:3] 表示该接口可以访问 Bank 2 和 Bank 3
- 提供更大的连续地址空间
- 内核代码中通过统一地址访问，底层自动分散到两个 bank
- 对于行索引 (indiceArr) 这种大数组，需要跨 bank 存储
```

#### 2. `slr` (Super Logic Region) - 物理布局

**语法**：`slr = <kernel>:<slr_id>`

```ini
slr = kernel_pagerank_0:SLR0
```

**含义**：
- 将 `kernel_pagerank_0` 放置在 FPGA 的 SLR0 (Super Logic Region 0) 区域
- Alveo U50/U280 等高端 FPGA 包含多个 SLR，每个 SLR 有自己的资源池
- 明确 SLR 分配有助于：
  - 满足时序约束 (Timing Closure)
  - 优化跨 SLR 的信号路由
  - 平衡资源利用

#### 3. `nk` (Number of Kernels) - 实例化控制

**语法**：`nk = <kernel_name>:<num_instances>:<naming_pattern>`

```ini
nk = kernel_pagerank_0:1:kernel_pagerank_0
```

**含义**：
- 实例化 1 个 `kernel_pagerank_0` 内核
- 实例名称为 `kernel_pagerank_0` (与内核名相同)
- 支持扩展：如果需要多实例并行处理多个子图，可以改为 `nk = kernel_pagerank_0:4:kernel_pagerank_%d` 生成 4 个实例

---

## 与主机代码的交互

### 连接配置如何影响主机代码

cfg 文件中的配置**直接决定了主机代码如何设置 OpenCL 缓冲区**：

```cpp
// cfg: sp = kernel_pagerank_0.m_axi_gmem0:HBM[0]
// 主机代码必须将 offsetArr 分配到 Bank 0

cl_mem_ext_ptr_t mext_in0;
mext_in0.flags = XCL_BANK0;  // 对应 HBM[0]
mext_in0.obj = offsetArr;
mext_in0.param = 0;

cl::Buffer buffer0(context, CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
                   sizeof(ap_uint<32>) * sizeNrow, offsetArr, &mext_in0);
```

**如果 cfg 和主机代码不匹配会发生什么？**

| 不匹配情况 | 结果 |
|-----------|------|
| 主机分配到 Bank 0，cfg 映射到 Bank 1 | 运行时错误或数据损坏 |
| cfg 分配多 Bank 范围，主机只指定单个 Bank | 部分地址空间无法访问 |
| 缓冲区大小超过 cfg 映射的 Bank 容量 | 段错误或静默数据损坏 |

### 内核签名与 AXI 接口映射

内核函数的参数列表决定了 AXI 接口的命名：

```cpp
// 内核函数签名 (推测)
void kernel_pagerank_0(
    int nrows, int nnz, float alpha, float tolerance, int maxIter,
    ap_uint<512>* offsetCSC,      // --> m_axi_gmem0
    ap_uint<512>* indiceCSC,      // --> m_axi_gmem1
    ap_uint<512>* weightCSC,      // --> m_axi_gmem2
    ap_uint<512>* degree,         // --> m_axi_gmem3
    ap_uint<512>* cntValFull,     // --> m_axi_gmem4
    ap_uint<512>* buffPing,       // --> m_axi_gmem5 / gmem6
    ap_uint<512>* buffPong,       // --> m_axi_gmem5 / gmem6
    int* resultInfo,              // --> m_axi_gmem6
    ap_uint<256>* orderUnroll     // --> m_axi_gmem7
);
```

**接口到 gmem 的映射规则**：
- 数组/指针参数按出现顺序映射到 `m_axi_gmem0`, `m_axi_gmem1`, ...
- 标量参数 (如 `int nrows`) 默认映射到 `s_axilite` 控制寄存器接口
- 可以使用 `#pragma HLS INTERFACE` 显式指定映射

---

## 总结

`conn_u50.cfg` 文件是 PageRank FPGA 加速器与硬件资源之间的**关键契约**：

1. **内存拓扑定义**：将逻辑 AXI 接口映射到物理 HBM Bank，决定数据流向
2. **性能基础**：合理的 bank 分配最大化并行带宽，错误的分配导致瓶颈
3. **物理约束**：SLR 放置确保时序收敛，影响最大 achievable frequency
4. **软硬协同**：cfg 配置必须与主机代码的 `XCL_BANK` 分配、内核代码的接口定义保持一致

理解本配置文件的每一项设置，是成功部署和优化 PageRank FPGA 加速器的基础。任何对硬件连接的修改都必须同步更新 cfg 文件、主机代码和内核代码，确保三者的一致性。
