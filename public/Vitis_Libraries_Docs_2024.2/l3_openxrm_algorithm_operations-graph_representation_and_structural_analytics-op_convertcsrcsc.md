# opConvertCsrCsc 子模块技术文档

## 功能概述

`opConvertCsrCsc` 实现了**稀疏图表示格式转换**的 FPGA 加速，将 CSR（Compressed Sparse Row）格式转换为 CSC（Compressed Sparse Column）格式。这是图分析中基础且高频的操作，许多图算法需要在行优先和列优先遍历之间切换。

## 核心概念

### CSR vs CSC 格式

**CSR（Compressed Sparse Row）**：
- `offsetsCSR[i]`：第 i 行的起始边索引
- `indicesCSR[j]`：第 j 条边指向的目标节点
- **优势**：快速遍历某个节点的所有出边

**CSC（Compressed Sparse Column）**：
- `offsetsCSC[i]`：第 i 列的起始边索引
- `indicesCSC[j]`：第 j 条边的源节点
- **优势**：快速遍历某个节点的所有入边

**转换复杂度**：$O(|E|)$，需要对整个边列表进行重排序。

## 类设计与组件

### opConvertCsrCsc 类结构

```cpp
class opConvertCsrCsc {
private:
    uint32_t maxCU;                    // 最大 CU 数量
    uint32_t deviceNm;                 // 设备数量
    static uint32_t cuPerBoardConvertCsrCsc;
    static uint32_t dupNmConvertCsrCsc;
    
    clHandle* handles;                 // CU 句柄数组
    std::vector<uint32_t> deviceOffset;
    std::vector<event<int> > task_queue;

public:
    void createHandle(openXRM* xrm, clHandle& handle, ...);
    void setHWInfo(uint32_t numDev, uint32_t CUmax);
    void init(openXRM* xrm, std::string kernelName, ...);
    void freeConvertCsrCsc(xrmContext* ctx);
    void cuRelease(xrmContext* ctx, xrmCuResource* resR);
    
    int compute(unsigned int deviceID, unsigned int cuID, ...);
    event<int> addwork(Graph<uint32_t, uint32_t> g, Graph<uint32_t, uint32_t> g2);
    
    void bufferInit(clHandle* hds, std::string instanceName0, ...);
    void migrateMemObj(clHandle* hds, bool type, ...);
    int cuExecute(clHandle* hds, cl::Kernel& kernel0, ...);
};
```

## 核心方法详解

### 1. init() - 初始化流程

```cpp
void opConvertCsrCsc::init(
    openXRM* xrm,
    std::string kernelName,
    std::string kernelAlias,
    std::string xclbinFile,
    uint32_t* deviceIDs,
    uint32_t* cuIDs,
    unsigned int requestLoad
);
```

**执行流程**：

1. **计算复制因子**：
   ```cpp
   dupNmConvertCsrCsc = 100 / requestLoad;
   cuPerBoardConvertCsrCsc /= dupNmConvertCsrCsc;
   ```
   实现 CU 的"时间复用"——一个物理 CU 可以逻辑上服务多个请求。

2. **为每个 CU 创建句柄**：
   ```cpp
   for (int i = 0; i < maxCU; ++i) {
       createHandle(xrm, handles[i], ...);
       handles[i].buffer = new cl::Buffer[6];
   }
   ```

3. **构建设备偏移映射**：
   ```cpp
   if (deviceIDs[i] != prev) {
       deviceOffset.push_back(i);
   }
   ```

### 2. bufferInit() - 缓冲区初始化

**缓冲区布局（6 个缓冲区）**：

| 索引 | 缓冲区 | 用途 | 方向 | 大小 |
|------|--------|------|------|------|
| 0 | `buffer[0]` | `g.offsetsCSR` | Host → Device | `V × sizeof(uint32_t)` |
| 1 | `buffer[1]` | `g.indicesCSR` | Host → Device | `E × sizeof(uint32_t)` |
| 2 | `buffer[2]` | `g2.offsetsCSC` | Device → Host | `V × sizeof(uint32_t)` |
| 3 | `buffer[3]` | `g2.indicesCSC` | Device → Host | `E × sizeof(uint32_t)` |
| 4 | `buffer[4]` | `degree` | Host → Device | `V × sizeof(uint32_t)` |
| 5 | `buffer[5]` | `offsetsCSC2` | 内部使用 | `V × sizeof(uint32_t)` |

**内核参数设置**：
```cpp
kernel0.setArg(0, g.nodeNum);        // 节点数
kernel0.setArg(1, g.edgeNum);        // 边数
kernel0.setArg(2, hds[0].buffer[0]); // offsetsCSR
kernel0.setArg(3, hds[0].buffer[1]); // indicesCSR
kernel0.setArg(4, hds[0].buffer[2]); // offsetsCSC (输出)
kernel0.setArg(5, hds[0].buffer[3]); // indicesCSC (输出)
kernel0.setArg(6, hds[0].buffer[4]); // degree
kernel0.setArg(7, hds[0].buffer[5]); // offsetsCSC2 (中间)
```

### 3. compute() - 主计算流程

**详细执行流程**：

**阶段 1：定位 CU 句柄**
```cpp
clHandle* hds = &handles[
    channelID +
    cuID * dupNmConvertCsrCsc +
    deviceID * dupNmConvertCsrCsc * cuPerBoardConvertCsrCsc
];
```

**阶段 2：主机端内存分配**
```cpp
uint32_t* offsetsCSC2 = aligned_alloc<uint32_t>(maxVertices);
uint32_t* degree = aligned_alloc<uint32_t>(maxVertices);
```

**阶段 3：异步执行流水线**
```cpp
// 创建事件对象
std::vector<cl::Event> events_write(1);
std::vector<cl::Event> events_kernel(num_runs);
std::vector<cl::Event> events_read(1);

// 第 1 步：主机 → 设备数据传输（异步）
bufferInit(hds, instanceName, g, g2, offsetsCSC2, degree, kernel0, ob_in, ob_out);
migrateMemObj(hds, 0, num_runs, ob_in, nullptr, &events_write[0]);

// 第 2 步：执行内核（等待传输完成）
int ret = cuExecute(hds, kernel0, num_runs, &events_write, &events_kernel[0]);

// 第 3 步：设备 → 主机结果回传（等待内核完成）
migrateMemObj(hds, 1, num_runs, ob_out, &events_kernel, &events_read[0]);

// 第 4 步：阻塞等待最终结果
events_read[0].wait();
```

**阶段 4：资源清理**
```cpp
hds->isBusy = false;
free(offsetsCSC2);
free(degree);
```

## 与 opTriangleCount 的差异对比

| 特性 | opConvertCsrCsc | opTriangleCount |
|------|-----------------|-------------------|
| **核心算法** | CSR → CSC 格式转换 | 三角形计数 |
| **输出数据** | CSC 格式图（大规模数组） | 单个标量计数 |
| **缓冲区数** | 6 个 | 7 个 |
| **内核参数** | 8 个 | 9 个 |
| **计算复杂度** | $O(\|E\|)$ | $O(\|E\| \cdot \bar{d})$ |
| **访存模式** | 顺序扫描 + 随机写入 | 随机读取（邻接表遍历） |
| **中间数据** | offsetsCSC2, degree | 多组 offsets/rows 副本 |

## 常见问题和调试技巧

### 1. 对齐错误

**症状**：`clEnqueueMigrateMemObjects` 返回 `CL_MEM_OBJECT_ALLOCATION_FAILURE` 或程序崩溃。

**原因**：主机内存未按要求对齐（通常需要 4KB 对齐）。

**解决**：始终使用 `aligned_alloc`：
```cpp
// 正确
uint32_t* ptr = aligned_alloc<uint32_t>(size);

// 错误！
uint32_t* ptr = (uint32_t*)malloc(size);
```

### 2. XRM 资源泄漏

**症状**：后续运行报告 `allocCU` 失败，即使程序已退出。

**原因**：`freeConvertCsrCsc` 未被调用或 XRM 上下文异常。

**调试**：
```bash
# 检查 CU 状态
xrmadm -query

# 手动释放（紧急恢复）
xrmadm -release
```

### 3. 缓冲区溢出

**症状**：内核输出错误结果或 FPGA 挂起。

**原因**：输入图超过硬编码的 `V=800000` 或 `E=800000` 限制。

**解决**：在调用前检查图大小：
```cpp
if (g.nodeNum > 800000 || g.edgeNum > 800000) {
    // 报错或分批处理
}
```

### 4. 异步执行中的竞态条件

**症状**：间歇性错误或输出不一致。

**原因**：主机缓冲区在异步传输完成前被修改或释放。

**确保**：在调用 `wait()` 或确保事件完成前，不要访问或释放缓冲区：
```cpp
// 危险
migrateMemObj(hds, 0, 1, ob_in, nullptr, &event);
free(host_ptr);  // 错误！迁移可能还未完成！

// 安全
migrateMemObj(hds, 0, 1, ob_in, nullptr, &event);
event.wait();
free(host_ptr);  // 正确，迁移已完成
```

## 总结

`opConvertCsrCsc` 和 `opTriangleCount` 构成了图表示与结构分析的核心模块。它们展示了如何通过统一的 L3 架构模式，将不同的图算法高效地映射到 FPGA 加速。理解这些实现细节，有助于开发者在此基础上构建更复杂的图分析管线，或针对特定场景进行深度优化。
