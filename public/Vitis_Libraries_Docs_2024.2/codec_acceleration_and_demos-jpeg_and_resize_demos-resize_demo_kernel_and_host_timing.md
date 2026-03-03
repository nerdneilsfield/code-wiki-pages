# resize_demo_kernel_and_host_timing 模块深度解析

## 一句话概括

这是一个**基于 Xilinx FPGA 的图像缩放加速演示模块**，展示了如何将 OpenCV 风格的 resize 操作卸载到 FPGA 内核执行，同时通过双重计时机制（Host 端 wall-clock 与 OpenCL 事件分析）精确测量端到端延迟和纯内核执行时间。

---

## 问题空间：为什么需要这个模块？

### 背景：图像缩放的计算瓶颈

在视频处理、计算机视觉 pipeline 中，**图像缩放（Resize）**是最基础也最频繁的操作之一。一张 4K 图像缩放到 1080p，需要对约 200 万个像素进行插值计算。

在 CPU 上，这通常通过 OpenCV 的 `cv::resize` 完成，但对于实时视频流（30fps 或 60fps），CPU 可能无法在处理其他任务的同时维持所需的吞吐量。

### FPGA 加速的价值主张

FPGA 允许将 resize 算法固化成专用硬件电路：
- **高并行度**：每个时钟周期处理多个像素（通过 `NPPC` 参数配置）
- **确定性延迟**：硬件执行时间可精确预测
- **能耗效率**：专用电路比通用 CPU 能耗更低

### 为什么需要"演示+计时"模块？

仅仅有一个能运行的 FPGA 内核是不够的。在实际部署中，我们需要回答：

1. **端到端延迟是多少？**（从 Host 发出请求到拿到结果的总时间）
2. **纯内核执行时间是多少？**（排除数据传输开销后，FPGA 实际计算的时间）
3. **数据传输开销占比多少？**（H2D、D2H）
4. **瓶颈在哪里？**（是内核计算太慢？还是 PCIe 传输带宽不够？）

这个模块正是为了回答这些问题而设计的。它不仅是功能演示，更是一个**性能分析工具**。

---

## 架构全景

### 模块定位

在更大的系统中，这个模块位于：

```
blas_python_api/
└── codec_acceleration_and_demos/
    └── jpeg_and_resize_demos/
        ├── jpeg_decoder_kernel_connectivity_profiles/
        ├── jpeg_decoder_host_timing_support/
        └── resize_demo_kernel_and_host_timing/  <-- 当前模块
```

它与兄弟模块的关系：
- **[jpeg_decoder_kernel_connectivity_profiles](codec_acceleration_and_demos-jpeg_and_resize_demos-jpeg_decoder_kernel_connectivity_profiles.md)**：JPEG 解码的内核连接配置，与当前模块共享 HBM 内存连接模式的设计理念
- **[jpeg_decoder_host_timing_support](codec_acceleration_and_demos-jpeg_and_resize_demos-jpeg_decoder_host_timing_support.md)**：JPEG 解码的 Host 端计时支持，与当前模块使用相同的 OpenCL 性能分析技术

### 核心组件

模块由两个紧密协作的部分组成：

**关键文件说明：**

| 组件 ID | 文件 | 角色 |
|---------|------|------|
| `codec.L2.demos.resize.conn_u50.cfg.kernel_resize` | `conn_u50.cfg` | 内核连接配置 — 定义 kernel_resize 与 HBM 内存的物理连接关系 |
| `codec.L2.demos.resize.host.test_resize.timeval` | `test_resize.cpp` | Host 端测试程序 — 负责 OpenCL 环境初始化、内存分配、数据传输、内核调度、计时和结果验证 |

---

## 设计意图与关键决策

### 1. 内存架构：为什么使用 HBM？

**决策：** 内核配置中指定了三个 HBM (High Bandwidth Memory) 区域：
```cfg
sp=kernel_resize.m_axi_gmem0:HBM[0]  # 配置参数
sp=kernel_resize.m_axi_gmem1:HBM[1]  # 源图像
sp=kernel_resize.m_axi_gmem2:HBM[2]  # 目标图像
```

**权衡分析：**

| 维度 | HBM (已选) | DDR4 | PLRAM |
|------|-----------|------|-------|
| **带宽** | 460 GB/s | ~38 GB/s | ~100 GB/s |
| **容量** | 8GB (HBM2) | 多 GB 级 | 10s-100s MB |
| **延迟** | 较低 | 较高 | 最低 |
| **资源消耗** | 专用硬核 | 需要控制器 | BRAM/URAM |
| **适用场景** | 高吞吐数据流 | 大容量缓冲 | 低延迟小数据 |

**为什么选 HBM：**
图像 resize 是**内存带宽密集型**任务。实际中双线性插值需要读取源图像多个邻近像素来计算每个输出像素，**内存访问模式是不规则的且带宽需求更高**。HBM 提供的 460 GB/s 带宽确保了 FPGA 内核可以全速运行而不会被内存带宽饿死。

### 2. 双计时系统：Wall-Clock vs. OpenCL Profiling

**决策：** 代码中同时使用了两种计时机制：
```cpp
// Host 端 wall-clock 计时（微秒级精度）
struct timeval start_time, end_time;
gettimeofday(&start_time, 0);
gettimeofday(&end_time, 0);

// OpenCL 事件分析（纳秒级精度，纯内核执行时间）
events_kernel[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &ts);
events_kernel[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &te);
```

**对比分析：**

| 测量阶段 | 计时方式 | 包含内容 | 典型用途 |
|---------|---------|---------|---------|
| **端到端延迟** | Host wall-clock | H2D 传输 + 内核执行 + D2H 传输 + 调度开销 | 用户体验评估 |
| **H2D 传输** | OpenCL Profiling (write) | PCIe 传输 + 内存拷贝 | 带宽瓶颈分析 |
| **纯内核执行** | OpenCL Profiling (kernel) | FPGA 实际计算时间 | 算法效率评估 |
| **D2H 传输** | OpenCL Profiling (read) | PCIe 传输 + 内存拷贝 | 带宽瓶颈分析 |

**关键洞察：** 如果 wall-clock 时间远大于内核执行时间，说明瓶颈在数据传输（PCIe 带宽）或 OpenCL 调度开销上，而非 FPGA 计算能力。

### 3. 像素并行度 (NPPC) 设计

**决策：** 代码通过条件编译支持两种像素处理模式：
```cpp
#if NPPC == 1
    // 单像素模式：每个时钟处理 1 个像素
    for (int i = 0; i < src_width * src_height; i++) {
        fread(&srcPixel, 1, 1, fp);
        axi_src[i] = srcPixel;
    }
#else
    // 多像素模式：每个时钟处理 8 个像素 (NPPC=8)
    for (int i = 0; i < src_width * src_height; i++) {
        // ... 打包 8 个像素到 64 位 ...
        if ((i + 1) % 8 == 0) axi_src[i / 8] = pixel_64;
    }
#endif
```

**权衡分析：**

| 模式 | 吞吐量 | 资源消耗 | 适用场景 |
|------|--------|---------|---------|
| **NPPC=1** | 1 像素/周期 | 低（逻辑资源少） | 低分辨率、资源受限 |
| **NPPC=8** | 8 像素/周期 | 高（8 倍并行逻辑） | 高分辨率、高帧率 |

**实际限制：**
- 内存带宽：即使 FPGA 逻辑能处理 8 像素/周期，如果 HBM 只能提供 4 像素/周期的数据，额外的逻辑也会被饿死
- 内核频率：更复杂的逻辑可能导致布线拥塞，降低最高运行频率

---

## 新贡献者指南：注意事项与常见陷阱

### 1. 内存对齐要求

**陷阱：** 使用 `malloc` 而不是 `aligned_alloc` 分配 Host 内存。

**后果：** DMA 传输可能失败、性能下降，或在某些平台上产生段错误。

**正确做法：**
```cpp
// 错误
ap_uint<32>* configs = (ap_uint<32>*)malloc(sizeof(ap_uint<32>) * 5);

// 正确
ap_uint<32>* configs = aligned_alloc<ap_uint<32>>(4 + 1);
```

### 2. HBM 通道索引一致性

**陷阱：** `conn_u50.cfg` 中的 HBM 索引与 Host 代码中的 `XCL_MEM_TOPOLOGY` 索引不匹配。

**后果：** Kernel 和 Host 访问的是不同的物理内存区域，导致数据错误或内核读取垃圾数据。

**正确做法（保持一致）：**
```cpp
// conn_u50.cfg
sp=kernel_resize.m_axi_gmem0:HBM[0]
sp=kernel_resize.m_axi_gmem1:HBM[1]
sp=kernel_resize.m_axi_gmem2:HBM[2]

// test_resize.cpp
mext_o[0] = {(unsigned int)(0) | XCL_MEM_TOPOLOGY, configs, 0};  // HBM[0]
mext_o[1] = {(unsigned int)(1) | XCL_MEM_TOPOLOGY, axi_src, 0};   // HBM[1]
mext_o[2] = {(unsigned int)(2) | XCL_MEM_TOPOLOGY, axi_dst, 0};   // HBM[2]
```

### 3. 事件依赖与同步顺序

**陷阱：** 在内核执行完成前就启动 D2H 传输，或忘记调用 `q.finish()`。

**后果：** 竞争条件，读取到未完成的计算结果或垃圾数据。

**正确顺序：**
```cpp
// 1. H2D 传输（异步）
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);

// 2. 内核执行（依赖 H2D 完成）
q.enqueueTask(resize, &events_write, &events_kernel[0]);

// 3. D2H 传输（依赖内核完成）
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);

// 4. 同步等待所有操作完成
q.finish();

// 5. 安全访问结果数据
processResults(axi_dst);
```

### 4. NPPC 模式与数据打包

**陷阱：** 混淆 NPPC=1 和 NPPC=8 的数据布局。

**后果：** 像素数据错位，输出图像出现花屏或条纹。

**数据布局差异：**
```cpp
// NPPC=1: 每个字节一个像素，顺序存储
axi_src[0] = pixel_0
axi_src[1] = pixel_1
axi_src[2] = pixel_2
...

// NPPC=8: 每 8 个像素打包到一个 64 位字
axi_src[0] = {pixel_7, pixel_6, pixel_5, pixel_4, pixel_3, pixel_2, pixel_1, pixel_0}
axi_src[1] = {pixel_15, ..., pixel_8}
...
```

**注意：** Host 端和 Kernel 端必须使用相同的 NPPC 设置，否则数据解释会出错。

### 5. 尺寸验证

**陷阱：** 输入尺寸小于输出尺寸（上采样），或没有设置尺寸参数。

**后果：** 代码检查会返回错误，或产生未定义行为。

**代码中的防护：**
```cpp
if (src_width < dst_width || src_height < dst_height) {
    std::cout << "WARNING: The output size is invaild!\n";
    return 1;
}
```

**注意：** 当前实现只支持**下采样**（缩小），不支持上采样（放大）。尝试放大图像会触发错误退出。

---

## 总结

`resize_demo_kernel_and_host_timing` 模块是一个完整的 FPGA 图像缩放加速参考设计，它不仅实现了功能，更通过双重计时系统提供了深度的性能洞察。

### 关键要点回顾

1. **内存架构**：使用 HBM 提供高带宽内存访问，避免内核被内存带宽饿死
2. **双计时系统**：结合 wall-clock 和 OpenCL Profiling 精确识别性能瓶颈
3. **事件驱动执行**：使用 OpenCL 事件构建正确的依赖链，确保数据一致性
4. **像素并行度**：通过 NPPC 参数权衡吞吐量和资源消耗
5. **HBM 通道一致性**：确保 Kernel 配置和 Host 代码使用相同的内存通道映射

### 适用场景

这个模块适合作为：
- **学习参考**：了解 FPGA 图像处理加速的基本模式
- **性能基准**：建立图像 resize 任务的性能基线
- **优化起点**：在此基础上进行算法优化（如添加双三次插值）或系统优化（如多帧流水线）

### 扩展方向

可能的扩展包括：
1. **多帧流水线**：重叠数据传输和计算，提高吞吐量
2. **双线性/双三次插值**：当前可能是最近邻插值，可以升级算法
3. **彩色图像支持**：当前是灰度图（8bpp），可以扩展到 RGB（24bpp）
4. **多分辨率支持**：动态调整输出尺寸而不是编译时固定

---

*文档版本: 1.0*
*最后更新: 2024*
