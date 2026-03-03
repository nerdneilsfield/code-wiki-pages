# host_benchmark_application: WCC FPGA 主机基准测试应用

## 一句话概括

这是一个**图计算加速器的主机端指挥中枢**——它负责将大规模图数据从磁盘加载到 FPGA 的 HBM 内存，启动 Weakly Connected Components (WCC) 内核进行并行计算，然后回收结果并验证正确性。想象它是一个交响乐指挥：乐谱是 CSR 格式的图数据，乐手是 FPGA 上的计算单元，而指挥棒就是这个 `main.cpp`。

---

## 为什么需要这个模块？

### 图分析的计算困境

弱连通分量 (WCC) 是图分析中最基础的操作之一：找出图中所有互相可达的顶点集合。在社交网络中，这是发现社群；在网页链接分析中，这是识别孤立子网；在生物信息学中，这是发现功能模块。

**问题在于规模**：现代图数据通常包含数十亿顶点和数百亿边。纯软件实现（如 Boost Graph Library 或 NetworkX）在这种规模下可能需要数小时甚至数天。

### FPGA 加速的必要性

FPGA（现场可编程门阵列）提供了**定制化数据通路**的能力：
- 将图的邻接表结构直接映射到 HBM（高带宽内存）通道
- 流水线化处理邻居遍历、标签传播和路径压缩
- 通过数百个并行处理单元同时探索不同连通分量

**但 FPGA 不会自己工作**——它需要一个主机程序来：
1. 管理 FPGA 设备（Alveo U50/U200/U280 等）
2. 准备图数据（从文件格式转换为 CSR）
3. 协调主机内存和 FPGA HBM 之间的 DMA 传输
4. 启动内核并等待完成
5. 回收结果并验证正确性

### 为什么不是简单的脚本？

你可能想："这看起来就是个 OpenCL 程序模板嘛，有什么特别的？"

**关键在于图数据的特殊性**：
- **CSR 格式复杂性**：需要同时管理 `offset` 数组（顶点索引）和 `column` 数组（边目标），两者必须严格同步
- **内存对齐要求**：FPGA 的 DMA 引擎要求特定对齐（通常是 4KB 或 64B），未对齐访问会导致静默数据损坏或内核崩溃
- **HBM 银行分配**：现代 FPGA 有数十个 HBM 银行，错误的银行分配会导致内存带宽瓶颈
- **双缓冲（Ping-Pong）**：WCC 算法通常需要多轮迭代，必须有备用缓冲区来交换中间结果

**这些都不是 OpenCL 教程会教你的**——它们是高性能图计算领域的专门知识，被编码在这个 `main.cpp` 的每一行中。

---

## 核心抽象与心智模型

### 想象一个数据工厂

把这个系统想象成一个**高度专业化的数据工厂**：

- **原料仓库 (CSR加载)**：从磁盘读取图数据，转换为 CSR 格式
- **运输调度 (OpenCL CommandQueue)**：管理数据在主机和设备之间的流动
- **指令中心 (内核启动)**：向 FPGA 发送执行命令
- **质检中心 (结果验证)**：对比 FPGA 结果与预期输出

### 三个核心抽象

#### 1. CSR 图表示（Compressed Sparse Row）

CSR 是图计算的"标准语言"：

```cpp
// 原始图: 顶点 0 连接到 [1, 2], 顶点 1 连接到 [0], 顶点 2 连接到 [1]
// CSR 表示:
offset = [0, 2, 3, 4]   // offset[i] 是顶点 i 的邻居在 column 数组中的起始索引
column = [1, 2, 0, 1]   // 展平的所有边（目标顶点）
// 顶点 0 的邻居: column[offset[0]..offset[1]) = column[0..2) = [1, 2]
```

**为什么这很重要**：FPGA 的 HBM 控制器喜欢**顺序访问**。CSR 让邻居遍历变成顺序内存扫描，而不是随机的指针追踪。

#### 2. 内存银行分配（HBM Bank Mapping）

现代 FPGA（如 Alveo U280）有 32 个 HBM 银行，每个提供 ~14GB/s 带宽。但**访问错误的银行**会让你的有效带宽暴跌到 1/32。

代码中的 `cl_mem_ext_ptr_t` 和 `XCL_BANK` 宏就是解决这个问题：

```cpp
// 不是普通的 OpenCL 内存分配：
// 这是明确告诉 HBM 控制器："把这个缓冲区放在 Bank 2"
mext_o[0] = {2, column32, wcc()};  // flags=2 表示 Bank 2
cl::Buffer column32G1_buf = cl::Buffer(
    context, 
    CL_MEM_EXT_PTR_XILINX | CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
    sizeof(ap_uint<32>) * numEdges, 
    &mext_o[0]  // 扩展指针包含银行映射信息
);
```

**类比**：想象 HBM 银行是超市的 32 个收银台。不把缓冲区均匀分布在收银台上，等于让所有顾客排在一个收银台——不管其他 31 个多么空闲。

#### 3. 命令队列编排（OpenCL Event DAG）

这代码不是简单的"发送-等待"——它构建了一个**事件依赖图**：

```cpp
// 步骤 1: 数据传输 (H2D)
// 没有依赖（nullptr），立即开始
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);

// 步骤 2: 内核执行
// 依赖 events_write（数据传输完成）
q.enqueueTask(wcc, &events_write, &events_kernel[0]);

// 步骤 3: 结果回传 (D2H)
// 依赖 events_kernel（内核完成）
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);

// 等待整个流水线完成
q.finish();
```

**这为什么重要**：没有显式事件依赖，OpenCL 运行时可能**并发启动**数据传输和内核，导致读写同一缓冲区的数据竞争。通过 `&events_write` 等参数，我们构建了一个正确的 happens-before 关系。

**类比**：这是工厂的生产线调度——"零件到达后才能组装，组装完成后才能质检"。没有明确的依赖声明，整个工厂会乱成一团。

---

## 参考与延伸阅读

- **详细技术解析续篇**: [host_benchmark_application 深度解析（续）](graph-L2-benchmarks-connected_component-host-part2.md) - 包含 C++ 内存模型、异常安全、设计权衡详细分析

- **父模块**: [connected_component_benchmarks](graph-L2-benchmarks-connected_component.md)

- **Xilinx XRT 文档**: https://xilinx.github.io/XRT/master/html/

- **OpenCL 1.2 规范**: https://www.khronos.org/registry/OpenCL/specs/opencl-1.2.pdf
