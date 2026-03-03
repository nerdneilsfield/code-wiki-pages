# Merge Benchmark Timing 子模块

**所属模块**：[graph_preprocessing_host_benchmark_timing_structs](../graph_analytics_and_partitioning-l2_graph_preprocessing_and_transforms-graph_preprocessing_host_benchmark_timing_structs.md)

**对应源码**：`graph/L2/benchmarks/merge/host/test_merge.cpp`

---

## 职责概述

本子模块实现针对 **图合并内核（merge_kernel）** 的完整端到端基准测试框架。其核心职责包括：

1. **测试驱动**：协调 FPGA 设备初始化、内核执行、结果回传的全流程
2. **性能测量**：使用 `struct timeval` 和 OpenCL Profiling 双轨制计时
3. **结果验证**：与 Golden Data 进行逐字节对比，确保硬件实现正确性

---

## 核心组件详解

### 1. 计时基础设施

**核心结构体**：`struct timeval`

```cpp
#include <sys/time.h>

struct timeval {
    time_t      tv_sec;     // 秒（自 Epoch 以来的秒数）
    suseconds_t tv_usec;    // 微秒（0-999999）
};
```

**使用模式**：

```cpp
struct timeval start_time, end_time;

// 计时起点：OpenCL 操作开始前
gettimeofday(&start_time, 0);

// ... OpenCL H2D -> Kernel -> D2H 完整流程 ...
q.finish();  // 确保所有操作完成

// 计时终点
gettimeofday(&end_time, 0);

// 计算耗时（转换为毫秒）
double elapsed_ms = tvdiff(&start_time, &end_time) / 1000.0;
std::cout << "Execution time " << elapsed_ms << "ms" << std::endl;
```

**精度特征**：
- **理论精度**：1 微秒（μs）
- **实际精度**：受限于操作系统调度粒度，通常为 1-10 微秒
- **适用场景**：毫秒级以上的粗粒度测量

**注意事项**：
- `gettimeofday` 不是单调时钟，受系统时间调整（NTP 同步）影响
- 对于跨天或长时间的精确测量，建议使用 `clock_gettime(CLOCK_MONOTONIC, ...)`

### 2. 图数据处理流程

#### 2.1 输入数据格式

测试使用 **CSR（Compressed Sparse Row）** 格式存储图：

```
offset[i]   = 顶点 i 的邻接边在 edges/weights 中的起始索引
offset[i+1] = 顶点 i+1 的邻接边在 edges/weights 中的起始索引
              （也即顶点 i 的邻接边结束索引）
edges[j]    = 第 j 条边的目标顶点
weights[j]  = 第 j 条边的权重
```

**示例**：
```
顶点 0: 边 0->1(0.5), 边 0->2(0.3)
顶点 1: 边 1->2(0.7)
顶点 2: 无出边

offset  = [0, 2, 3, 3]  // 顶点 0 从索引 0 开始，顶点 1 从索引 2 开始，...
edges   = [1, 2, 2]     // 0->1, 0->2, 1->2
weights = [0.5, 0.3, 0.7]
```

#### 2.2 数据读取实现

```cpp
// 读取 offset 文件（每行一个整数）
std::ifstream myfile(offsetfile.c_str());
while (getline(myfile, line)) {
    numEdges = std::stoi(line);  // 累积获取边数
    num++;  // 统计顶点数
}
// numVertices = num - 1

// 读取边和权重文件
readfile(edgefile, edges_in);
readfile(weightfile, weights_in);
readfile(cfile, c);  // 读取聚类结果
```

#### 2.3 内存分配与对齐

```cpp
// 使用 aligned_alloc 分配页对齐内存
int* offset_in = aligned_alloc<int>(num);
int* edges_in = aligned_alloc<int>(buffer_size1);
float* weights_in = aligned_alloc<float>(buffer_size1);
// ... 其他缓冲区
```

**对齐要求**：
- **X86/x64**: 通常需要 4KB（页大小）对齐以获得最佳 DMA 性能
- **ARM**: 可能要求 64KB 对齐
- **OpenCL 规范**: 推荐至少 `CL_DEVICE_MEM_BASE_ADDR_ALIGN` 对齐

### 3. OpenCL 执行流程

#### 3.1 设备初始化和程序加载

```cpp
// 获取 Xilinx 设备
std::vector<cl::Device> devices = xcl::get_xil_devices();
cl::Device device = devices[0];

// 创建上下文
cl::Context context(device, NULL, NULL, NULL, &fail);

// 创建命令队列（启用 Profiling 和乱序执行）
cl::CommandQueue q(context, device, 
    CL_QUEUE_PROFILING_ENABLE | CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE, &fail);

// 加载 xclbin
cl::Program::Binaries xclBins = xcl::import_binary_file(xclbin_path);
cl::Program program(context, devices, xclBins, NULL, &fail);

// 创建内核
cl::Kernel merge = cl::Kernel(program, "merge_kernel", &fail);
```

#### 3.2 缓冲区创建

```cpp
// 使用 CL_MEM_USE_HOST_PTR 创建零拷贝缓冲区
cl::Buffer offset_in_buf = cl::Buffer(context, 
    CL_MEM_USE_HOST_PTR | CL_MEM_READ_ONLY, 
    num * sizeof(int), offset_in, &err);

// 类似创建其他缓冲区...
cl::Buffer offset_out_buf = cl::Buffer(context,
    CL_MEM_USE_HOST_PTR | CL_MEM_READ_WRITE,
    num * sizeof(int), offset_out, &err);
```

#### 3.3 内核参数设置

```cpp
// 设置内核参数
int arg_idx = 0;
merge.setArg(arg_idx++, num - 1);        // 顶点数
merge.setArg(arg_idx++, numEdges);       // 边数
merge.setArg(arg_idx++, num_c_out);      // 输出社区数
merge.setArg(arg_idx++, num_e_out_buf);  // 输出边数缓冲区
merge.setArg(arg_idx++, offset_in_buf);  // 输入 offset
merge.setArg(arg_idx++, edges_in_buf);   // 输入边
merge.setArg(arg_idx++, weights_in_buf); // 输入权重
merge.setArg(arg_idx++, c_buf);          // 聚类结果
// ... 更多输出和辅助缓冲区
```

#### 3.4 执行和同步

```cpp
// 准备输入/输出内存对象列表
std::vector<cl::Memory> ob_in = {offset_in_buf, edges_in_buf, ...};
std::vector<cl::Memory> ob_out = {offset_out_buf, edges_out_buf, ...};

// 创建事件对象用于计时
std::vector<cl::Event> events_write(1), events_kernel(1), events_read(1);

// 记录开始时间
gettimeofday(&start_time, 0);

// 1. 主机到设备数据传输
q.enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);

// 2. 执行内核（等待 H2D 完成）
q.enqueueTask(merge, &events_write, &events_kernel[0]);

// 3. 设备到主机数据传输（等待 Kernel 完成）
q.enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);

// 等待所有操作完成
q.finish();

// 记录结束时间
gettimeofday(&end_time, 0);
```

### 4. 性能测量详解

#### 4.1 OpenCL Event Profiling

```cpp
// 获取 H2D 传输时间
cl_ulong ts, te;
events_write[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &ts);
events_write[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &te);
float h2d_ms = ((float)te - (float)ts) / 1000000.0;
logger.info(xf::common::utils_sw::Logger::Message::TIME_H2D_MS, h2d_ms);

// 获取 Kernel 执行时间
events_kernel[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &ts);
events_kernel[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &te);
float kernel_ms = ((float)te - (float)ts) / 1000000.0;
logger.info(xf::common::utils_sw::Logger::Message::TIME_KERNEL_MS, kernel_ms);

// 获取 D2H 传输时间
events_read[0].getProfilingInfo(CL_PROFILING_COMMAND_START, &ts);
events_read[0].getProfilingInfo(CL_PROFILING_COMMAND_END, &te);
float d2h_ms = ((float)te - (float)ts) / 1000000.0;
logger.info(xf::common::utils_sw::Logger::Message::TIME_D2H_MS, d2h_ms);
```

**时间戳说明**：
- `CL_PROFILING_COMMAND_START`：命令在设备上实际开始执行的时间
- `CL_PROFILING_COMMAND_END`：命令在设备上完成执行的时间
- 单位：纳秒（nanoseconds）
- 基准：从命令队列创建时开始的相对时间

#### 4.2 主机端 Wall Clock 测量

```cpp
// 计算微秒级时间差
double tvdiff(struct timeval* start, struct timeval* end) {
    return (end->tv_sec - start->tv_sec) * 1000000.0 + 
           (end->tv_usec - start->tv_usec);
}

// 使用示例
double total_us = tvdiff(&start_time, &end_time);
double total_ms = total_us / 1000.0;
std::cout << "Execution time " << total_ms << "ms" << std::endl;
```

**两种计时的关系**：

```
主机端计时 (gettimeofday):
|<-- 文件 I/O -->|<-- H2D -->|<-- Kernel -->|<-- D2H -->|<-- 验证 -->|
^                 ^           ^              ^          ^           ^
|                 |           |              |          |           |
T_start           |           |              |          |         T_end
                  |           |              |          |
OpenCL Profiling:  |           |              |          |
|<-- H2D (ev_w) -->|           |              |          |
                   |<-- Kernel (ev_k) -->|     |          |
                                      |<-- D2H (ev_r) -->| |
```

### 5. 结果验证机制

#### 5.1 后处理：边排序

Merge 操作后，边可能不是按目标顶点排序的，需要进行排序：

```cpp
void sort_by_offset(
    int num_c_out, int num_e_out, 
    int* offset_out, int* edges_out, float* weights_out, 
    std::pair<int, float>* pair_ew) 
{
    // 将边和权重打包为 pair
    for (int i = 0; i < num_e_out; i++) {
        pair_ew[i].first = edges_out[i];
        pair_ew[i].second = weights_out[i];
    }
    
    // 对每个顶点的邻接边按目标顶点排序
    for (int i = 0; i < num_c_out; i++) {
        int start = offset_out[i];
        int end = offset_out[i + 1];
        std::sort(pair_ew + start, pair_ew + end);
    }
    
    // 解包回原始数组
    for (int i = 0; i < num_e_out; i++) {
        edges_out[i] = pair_ew[i].first;
        weights_out[i] = pair_ew[i].second;
    }
}
```

**为什么需要排序**：
- CSR 格式通常要求每个顶点的邻接表按目标顶点有序
- 便于后续图算法（如三角形计数）的处理
- 确保输出与 Golden Data 格式一致

#### 5.2 Golden Data 验证

```cpp
// 使用系统 diff 命令验证输出
std::string diff_o = "diff --brief " + golden_offsetfile + " " + out_offsetfile;
int ro = system(diff_o.c_str());
if (ro) {
    printf("Test offset failed\n");
    return 1;  // 返回非零表示测试失败
}

// 类似验证 edge 和 weight
```

**验证策略**：
1. **精确匹配**：使用 `diff --brief` 进行字节级精确匹配
2. **多文件验证**：分别验证 offset、edge、weight 三个文件
3. **失败处理**：任一文件不匹配即返回错误码，打印失败信息

---

## 常见调试场景

### 场景 1：Execution time 远大于 OpenCL Profiling 总和

**现象**：
```
Execution time 500ms
H2D: 50ms
Kernel: 100ms
D2H: 50ms
```

**分析**：500ms >> (50+100+50)=200ms，说明有 300ms 的额外开销

**可能原因**：
1. **文件 I/O 开销**：读取大型图文件耗时
2. **内存分配延迟**：`aligned_alloc` 大内存可能触发缺页中断
3. **xclbin 加载**：首次加载 FPGA 二进制文件较慢

**排查方法**：
```cpp
// 在关键位置插入计时点
gettimeofday(&t1, 0);
// 文件读取
gettimeofday(&t2, 0);
std::cout << "File I/O: " << tvdiff(&t1, &t2)/1000.0 << "ms\n";
```

### 场景 2：Kernel 时间异常波动

**现象**：同一测试用例，Kernel 执行时间从 10ms 波动到 50ms

**可能原因**：
1. **设备热管理**：FPGA 过热降频
2. **内存带宽竞争**：多进程共享主机内存带宽
3. **PCIe 链路质量**：链路降速导致 H2D/D2H 阻塞后续 Kernel

**排查方法**：
- 监控 FPGA 温度：`cat /sys/class/xilinx/xclmgmt.0/xmc/board_temp`
- 隔离测试：在专用服务器上单独运行
- 检查 PCIe 链路状态：`lspci -vv -s <bdf> | grep Lnk`

### 场景 3：验证失败但输出"看起来正确"

**现象**：`diff` 报告不匹配，但肉眼检查文件内容一致

**可能原因**：
1. **换行符差异**：Unix (LF) vs Windows (CRLF)
2. **精度差异**：浮点数精度损失导致 `3.140000` vs `3.139999`
3. **排序顺序**：边排序算法的稳定性问题

**排查方法**：
```bash
# 检查换行符
diff -u golden.txt output.txt | cat -A  # 显示控制字符

# 十六进制对比
xxd golden.bin > golden.hex
xxd output.bin > output.hex
diff golden.hex output.hex

# 浮点数精度对比（允许 epsilon 误差）
awk '{printf "%.6f\n", $1}' golden.txt > g6.txt
awk '{printf "%.6f\n", $1}' output.txt > o6.txt
diff g6.txt o6.txt
```

---

## 扩展与定制指南

### 添加新的计时点

在关键代码段前后插入计时：

```cpp
struct timeval t_start, t_end;

gettimeofday(&t_start, 0);
// 要测量的代码段
my_custom_operation();
gettimeofday(&t_end, 0);

double duration_us = tvdiff(&t_start, &t_end);
std::cout << "Custom operation took " << duration_us / 1000.0 << " ms\n";
```

### 集成到 CI/CD

回归测试脚本示例：

```bash
#!/bin/bash
set -e

XCLBIN="path/to/merge.xclbin"
TEST_DATA="path/to/test_data"
GOLDEN_DATA="path/to/golden"

# 运行测试
./test_merge \
    -xclbin $XCLBIN \
    -io $TEST_DATA/offset.txt \
    -ie $TEST_DATA/edge.txt \
    -iw $TEST_DATA/weight.txt \
    -ic $TEST_DATA/cluster.txt \
    -oo output_offset.txt \
    -oe output_edge.txt \
    -ow output_weight.txt \
    -go $GOLDEN_DATA/offset.txt \
    -ge $GOLDEN_DATA/edge.txt \
    -gw $GOLDEN_DATA/weight.txt

echo "Test passed!"
```

---

*子模块文档版本：1.0*  
*最后更新：2024*  
*维护团队：Graph Analytics FPGA Acceleration Team*
