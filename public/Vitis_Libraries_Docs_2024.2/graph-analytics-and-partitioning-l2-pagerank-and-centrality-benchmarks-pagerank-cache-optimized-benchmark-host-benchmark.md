# PageRank Cache-Optimized Benchmark - Host Benchmark

## 一句话概括

本文件是 PageRank FPGA 加速器的**主机端 benchmark 实现**，负责图数据加载与格式转换、HBM 内存管理、OpenCL 运行时调度和性能分析，是连接图算法与 FPGA 硬件的桥梁。

---

## 文件概述

### 文件路径与上下文

- **路径**: `graph/L2/benchmarks/pagerank_cache/host/test_pagerank.cpp`
- **所属模块**: `pagerank_cache_optimized_benchmark`
- **依赖关系**: `xcl2.hpp` (Xilinx OpenCL 封装), `xf_graph_L2.hpp` (图算法库), `graph.hpp` (图数据结构)

### 核心职责

1. **命令行参数解析** - 配置图路径、运行次数、算法参数
2. **图数据加载** - 从文件读取 CSC 格式图数据
3. **内存分配** - 对齐分配主机内存，准备数据传输
4. **OpenCL 初始化** - 创建设备上下文、命令队列、内核
5. **HBM Bank 分配** - 将数据映射到不同 HBM Bank
6. **数据传输** - 主机到FPGA数据迁移
7. **内核执行** - 启动 PageRank 计算核
8. **结果回传** - FPGA到主机数据迁移
9. **结果解析** - 从 512-bit 宽总线提取浮点结果
10. **正确性验证** - 与 golden reference 对比
11. **性能分析** - 测量传输时间、计算时间、端到端延迟

---

## 核心数据结构

### 精度类型与缓冲类型

```cpp
typedef float DT;  // 可切换为 double，控制计算精度
typedef ap_uint<512> buffType;  // 512-bit 宽总线缓冲区类型
```

### 时间测量结构

```cpp
struct timeval {
    time_t tv_sec;   // 秒
    suseconds_t tv_usec;  // 微秒
};
```

---

## 内存分配与对齐

### 对齐分配函数

```cpp
template <typename T>
T* aligned_alloc(std::size_t num) {
    void* ptr = nullptr;
#if _WIN32
    ptr = (T*)malloc(num * sizeof(T));
    if (num == 0) {
#else
    if (posix_memalign(&ptr, 4096, num * sizeof(T))) {
#endif
        throw std::bad_alloc();
    }
    return reinterpret_cast<T*>(ptr);
}
```

**设计要点**：
- 使用 `posix_memalign` 分配 4KB 对齐的内存
- 满足 HBM  burst 传输的对齐要求
- Windows 平台使用标准 `malloc` (简化处理)

### 主要缓冲区分配

| 缓冲区 | 分配大小 | 用途 | Bank |
|--------|---------|------|------|
| `offsetArr` | `sizeNrow * sizeof(ap_uint<32>)` | CSC 列偏移 | 0 |
| `indiceArr` | `sizeNNZ * sizeof(ap_uint<32>)` | 行索引 | 2-3 |
| `weightArr` | `sizeNNZ * sizeof(float)` | 边权重 | 4-5 |
| `degreeCSR` | `sizeDegree * sizeof(ap_uint<32>)` | 出度 | 6-7 |
| `buffPing` | `iteration2 * sizeof(buffType)` | 乒乓缓冲 A | 8-9 |
| `buffPong` | `iteration2 * sizeof(buffType)` | 乒乓缓冲 B | 10-11 |
| `resultInfo` | `2 * sizeof(int)` | 结果信息 | 12 |
| `orderUnroll` | `sizeOrder * sizeof(ap_uint<32>)` | 排序顺序 | 1 |

---

## OpenCL 运行时流程

### 1. 设备和上下文初始化

```cpp
// 获取 Xilinx 设备列表
std::vector<cl::Device> devices = xcl::get_xil_devices();
cl::Device device = devices[0];

// 创建上下文和命令队列
cl::Context context(device, NULL, NULL, NULL, &fail);
cl::CommandQueue q(context, device, 
    CL_QUEUE_PROFILING_ENABLE | CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE, &fail);
```

**关键标志**：
- `CL_QUEUE_PROFILING_ENABLE`：启用性能分析，允许测量内核执行时间
- `CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE`：允许乱序执行，提高吞吐

### 2. 内核加载和创建

```cpp
// 导入 xclbin 文件
cl::Program::Binaries xclBins = xcl::import_binary_file(xclbin_path);

// 创建设备程序
cl::Program program(context, devices, xclBins, NULL, &fail);

// 创建内核对象
cl::Kernel kernel_pagerank(program, "kernel_pagerank_0", &fail);
```

### 3. HBM Bank 分配

```cpp
// 使用 cl_mem_ext_ptr_t 指定 HBM Bank
std::vector<cl_mem_ext_ptr_t> mext_in(9);

// offsetArr -> HBM Bank 0
mext_in[0].flags = XCL_BANK0;
mext_in[0].obj = offsetArr;
mext_in[0].param = 0;

// indiceArr -> HBM Bank 2-3
mext_in[1].flags = XCL_BANK2;
mext_in[1].obj = indiceArr;
mext_in[1].param = 0;

// ... 其他 bank 分配
```

**关键宏定义**：
```cpp
#define XCL_BANK(n) (((unsigned int)(n)) | XCL_MEM_TOPOLOGY)
#define XCL_BANK0 XCL_BANK(0)
#define XCL_BANK1 XCL_BANK(1)
// ... 到 XCL_BANK15
```

### 4. OpenCL 缓冲区创建

```cpp
std::vector<cl::Buffer> buffer(9);

// offsetArr - 列偏移
buffer[0] = cl::Buffer(context, CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
                       sizeof(ap_uint<32>) * (nrows + 1), offsetArr);

// indiceArr - 行索引
buffer[1] = cl::Buffer(context, CL_MEM_USE_HOST_PTR | CL_MEM_READ_ONLY,
                       sizeof(ap_uint<32>) * nnz, indiceArr);

// weightArr - 边权重
buffer[2] = cl::Buffer(context, CL_MEM_USE_HOST_PTR | CL_MEM_READ_ONLY, 
                       sizeof(float) * nnz, weightArr);

// ... 其他缓冲区
```

**关键标志**：
- `CL_MEM_USE_HOST_PTR`：使用已分配的主机内存，避免额外的数据拷贝
- `CL_MEM_READ_ONLY` / `CL_MEM_READ_WRITE`：指定访问模式，允许驱动优化

### 5. 内核参数设置

```cpp
// 标量参数
kernel_pagerank.setArg(0, nrows);      // 节点数
kernel_pagerank.setArg(1, nnz);         // 非零边数
kernel_pagerank.setArg(2, alpha);      // 阻尼系数 (0.85)
kernel_pagerank.setArg(3, tolerance);  // 收敛阈值 (1e-3)
kernel_pagerank.setArg(4, maxIter);     // 最大迭代次数

// 缓冲区参数 (对应 m_axi_gmem 接口)
kernel_pagerank.setArg(5, buffer[0]);   // m_axi_gmem0 - offsetCSC
kernel_pagerank.setArg(6, buffer[1]);   // m_axi_gmem1 - indiceCSC
kernel_pagerank.setArg(7, buffer[2]);   // m_axi_gmem2 - weightCSC
kernel_pagerank.setArg(8, buffer[3]);   // m_axi_gmem3 - degree
kernel_pagerank.setArg(9, buffer[4]);  // m_axi_gmem4 - cntValFull
kernel_pagerank.setArg(10, buffer[5]); // m_axi_gmem5 - buffPing
kernel_pagerank.setArg(11, buffer[6]); // m_axi_gmem6 - buffPong
kernel_pagerank.setArg(12, buffer[7]); // m_axi_gmem6 - resultInfo
kernel_pagerank.setArg(13, buffer[8]); // m_axi_gmem7 - orderUnroll
```

### 6. 执行和性能分析

```cpp
// 创建事件对象用于性能分析
std::vector<cl::Event> events_write(1);
std::vector<std::vector<cl::Event>> events_kernel(1);
std::vector<cl::Event> events_read(1);
events_kernel[0].resize(1);

// 端到端计时
struct timeval start_time, end_time;
gettimeofday(&start_time, 0);

// 1. 主机到设备数据传输
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);

// 2. 执行内核
q.enqueueTask(kernel_pagerank, &events_write, &events_kernel[0][0]);

// 3. 设备到主机数据传输
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel[0], &events_read[0]);

q.finish();
gettimeofday(&end_time, 0);

// 性能分析：提取时间戳
cl_ulong timeStart, timeEnd;

// 写入时间
events_write[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &timeStart);
events_write[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &timeEnd);
unsigned long write_time = (timeEnd - timeStart) / 1000.0; // 微秒

// 读取时间
events_read[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &timeStart);
events_read[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &timeEnd);
unsigned long read_time = (timeEnd - timeStart) / 1000.0;

// 内核执行时间
events_kernel[0][0].getProfilingInfo(CL_PROFILING_COMMAND_START, &timeStart);
events_kernel[0][0].getProfilingInfo(CL_PROFILING_COMMAND_END, &timeEnd);
unsigned long exec_time0 = (timeEnd - timeStart) / 1000.0;

// 端到端时间
unsigned long exec_timeE2E = diff(&end_time, &start_time);
```

---

## 结果解析与验证

### 从 512-bit 宽总线提取结果

```cpp
// 读取收敛信息和迭代次数
bool resultinPong = (bool)(*resultInfo);
int iterations = (int)(*(resultInfo + 1));

// 解析 512-bit 宽缓冲区为 float/double 数组
int cnt = 0;
for (int i = 0; i < iteration2; ++i) {
    xf::graph::internal::calc_degree::f_cast<DT> tt;
    
    // 根据 resultinPong 选择正确的缓冲区
    ap_uint<512> tmp11 = resultinPong ? buffPong[i] : buffPing[i];
    
    // 拆解为 16 个 float 或 8 个 double
    for (int k = 0; k < unrollNm2; ++k) {
        if (cnt < nrows) {
            tt.i = tmp11.range(widthT * (k + 1) - 1, widthT * k);
            pagerank[cnt] = (DT)(tt.f);
            cnt++;
        }
    }
}
```

### 正确性验证

```cpp
// 计算误差和准确率
DT err = 0.0;
int accurate = 0;
for (int i = 0; i < nrows; ++i) {
    // 累积平方误差
    err += (golden[i] - pagerank[i]) * (golden[i] - pagerank[i]);
    
    // 统计在容差范围内的准确值
    if (std::abs(pagerank[i] - golden[i]) < tolerance) {
        accurate += 1;
    }
}

DT accRate = accurate * 1.0 / nrows;
err = std::sqrt(err);

// 验证结果
if (err < nrows * tolerance) {
    std::cout << "INFO: Result is correct" << std::endl;
    return 0;
} else {
    std::cout << "INFO: Result is wrong" << std::endl;
    return 1;
}
```

---

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-xclbin` | xclbin 文件路径 | 无 (必须指定) |
| `-runs` | 运行次数 | 1 |
| `-nnz` | 非零边数 | 7 |
| `-nrows` | 节点数 | 5 |
| `-files` | 数据集文件名 | 空字符串 |
| `-dataSetDir` | 数据集目录 | `./data/` |
| `-refDir` | 参考数据目录 | `./data/` |

---

## 编译与执行

### 编译选项

```bash
# 定义 HBM 使用
-DUSE_HBM

# HLS 测试模式 (软件仿真)
-D_HLS_TEST_

# 生成参考数据模式
-DGENDATA_

# Benchmark 模式
-DBANCKMARK
```

### 执行示例

```bash
# 基本执行
./test_pagerank -xclbin kernel_pagerank.xclbin \
    -files graph1 -dataSetDir ./datasets/ -refDir ./refs/ \
    -nrows 1000000 -nnz 50000000 -runs 10
```

---

## 总结

本文件实现了 PageRank FPGA 加速器的完整主机端 benchmark 流程：

1. **数据准备**：图数据加载、格式转换、内存对齐分配
2. **运行时管理**：OpenCL 上下文、命令队列、缓冲区创建
3. **硬件协同**：HBM Bank 分配、内核参数设置、执行调度
4. **结果处理**：512-bit 宽总线解析、正确性验证、性能分析

理解本文件的实现细节，是成功部署和优化 PageRank FPGA 加速器的关键。
