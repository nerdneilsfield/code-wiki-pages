# host_predicate_logic 模块深度解析

## 一句话概括

本模块是**基于 2-gram（二元语法）的文本相似度预过滤引擎**，它通过构建倒排索引（Inverted Index）和 TF-IDF 加权，在 CPU 端完成索引构建与数据预处理，然后调用 FPGA 加速内核（TGP Kernel）执行高性能的相似度检索，解决大规模文本去重场景中计算密集型的相似度计算瓶颈。

---

## 1. 为什么需要这个模块？问题空间与设计洞察

### 1.1 问题背景：大规模文本去重的计算困境

在数据清洗、日志分析、用户生成内容（UGC）去重等场景中，我们经常需要判断**两条文本记录是否足够相似**（例如相似度 > 80% 即认为是重复）。

朴素的解决方案是两两计算编辑距离或 Jaccard 相似度，但这在数据量为 N 时会产生 $O(N^2)$ 的复杂度。当 N 达到百万甚至千万级别时，这种暴力方法完全不可行。

### 1.2 核心洞察：局部敏感哈希与倒排索引的协同

本模块基于一个关键观察：**相似的文本必然共享大量短语法单元（2-gram）**。因此，我们可以通过以下步骤实现高效预过滤：

1. **分词**：将文本拆分为 2-gram（连续两个字符组成的单元）
2. **索引构建**：构建倒排索引，记录每个 2-gram 出现在哪些文档中
3. **TF-IDF 加权**：根据词频（TF）和逆文档频率（IDF）计算每个 2-gram 的重要性权重
4. **相似度检索**：使用 FPGA 加速内核并行计算候选文档与查询文档的加权余弦相似度

### 1.3 为什么需要 FPGA 加速？

虽然倒排索引将搜索空间从 $O(N^2)$ 降低到 $O(N \cdot M)$（M 为平均倒排列表长度），但在超大规模数据集中，候选集仍然可能很大。TGP（Two-Gram Predicate）Kernel 利用 FPGA 的并行计算能力，可以同时对数千个候选文档执行相似度计算，实现数量级的加速。

---

## 2. 心智模型与核心抽象

理解本模块的关键在于建立以下三个层面的抽象：

### 2.1 文本处理流水线：从原始字符串到数值向量

想象文本处理就像一条**工厂流水线**：

1. **清洗工位（`charFilter` / `preTwoGram`）**：去除杂质（特殊字符、多余空格），统一大小写，将文本转换为标准化的字节流
2. **切割工位（`twoGram`）**：将连续字符流切割成 2-gram 单元（类似将布料裁剪成标准尺寸的布片）
3. **编码工位（`charEncode`）**：将字符映射为数值编码（37 进制：0-9 → 0-9，a-z/A-Z → 10-35，其他 → 36），将 2-gram 压缩为 12-bit 整数（$64 \times 64 = 4096$ 种可能）
4. **向量化工位（`index`）**：构建稀疏向量表示，记录每个 2-gram 的出现频次和权重

### 2.2 倒排索引结构：从词汇到文档的映射表

倒排索引可以想象成一本**图书馆的检索卡片目录**：

- **主键（Term ID）**：2-gram 的编码（0-4095）
- **倒排列表（Posting List）**：包含该 2-gram 的所有文档列表，每个条目记录：
  - 文档 ID（在去重后的唯一字段集中的索引）
  - TF（词频）权重，经过对数变换和归一化处理

在内存布局上，索引被组织为三个关键数组：
- `idf_value_[4096]`：每个 2-gram 的 IDF 值（逆文档频率）
- `tf_addr_[4096]`：每个 2-gram 的倒排列表在 `tf_value_` 中的起始地址和长度编码
- `tf_value_[]`：变长数组，存储实际的倒排列表（文档 ID + 权重）

### 2.3 异构计算架构：CPU-FPGA 协同处理

本模块采用**主从协同**的计算模式：

- **CPU 端（主机端）**：
  - 承担**控制流**和**数据预处理**职责
  - 构建倒排索引，管理内存缓冲区
  - 调用 OpenCL API 配置 FPGA 内核，传输数据，同步执行
  
- **FPGA 端（设备端）**：
  - 运行 **TGP_Kernel**，承担**计算密集**的相似度匹配任务
  - 并行处理大规模候选集的相似度计算
  - 将结果（匹配到的重复文档 ID）写回主机内存

这种分工充分利用了 CPU 的灵活性和 FPGA 的并行性，形成互补。

---

## 3. 数据流与关键操作端到端追踪

### 3.1 索引构建阶段（`TwoGramPredicate::index`）

```
输入: vector<string> column (原始文本列，可能包含重复)
│
├─ Step 1: 字段去重 ─────────────────────┐
│  遍历 column，提取 preTwoGram 处理后的特征串
│  使用 map<string, uint32_t> col_map 去重
│  生成 unique_field: vector<pair<string, uint32_t>>
│
├─ Step 2: 2-gram 编码与统计 ──────────────┤
│  对每个 unique_field[i]:
│    ├─ twoGram() 分割为 2-gram terms (vector<uint16_t>)
│    ├─ 建立局部字典 dict (uuMT): term_id -> 出现次数
│    ├─ 计算 TF 权重: w = log(count) + 1
│    ├─ L2 归一化: W = sqrt(sum(w^2)), w_norm = w / W
│    └─ 存储到 word_info[wid]: 记录 (doc_id=i, weight=w_norm)
│
├─ Step 3: 压缩与索引编码 ─────────────────┤
│  计算 threshold = max(1000, N * 0.05)  // 高频词过滤阈值
│  对每个 2-gram (共 4096 种可能):
│    ├─ 获取其倒排列表 word_info[wid]
│    ├─ 若列表长度 > threshold: 跳过 (视为停用词)
│    ├─ 计算 IDF: idf_value_[sn] = log(1.0 + N / size)
│    ├─ 编码地址: tf_addr_[sn] = (begin >> 1) + (end << 31)
│    └─ 序列化倒排列表到 tf_value_: [doc_id, weight] 对
│
输出: 填充好的 idf_value_[4096], tf_addr_[4096], tf_value_[]
```

### 3.2 搜索执行阶段（`TwoGramPredicate::search`）

```
输入: xclbinPath (FPGA bitstream 路径), column (查询文本), indexId (输出数组)
│
├─ Step 1: 数据分区与缓冲区准备 ───────────┐
│  将 column 划分为 CU (通常=2) 个块
│  对每个计算单元 i:
│    ├─ 分配 fields[i]: 原始文本拼接缓冲区 (BS 大小)
│    ├─ 分配 offsets[i]: 每条记录偏移量数组 (RN 大小)
│    ├─ 拷贝文本数据到 fields[i]，填充 offsets[i]
│    └─ 填充 config[i]: docSize (文档数), fldSize (总字节数)
│
├─ Step 2: OpenCL 运行时初始化 ─────────────┤
│  获取 Xilinx 设备，创建 Context 和 CommandQueue
│  导入 xclbin 并创建 Program
│  创建 2 个 Kernel 实例: TGP_Kernel_1, TGP_Kernel_2 (对应 CU=2)
│
├─ Step 3: 缓冲区对象创建与映射 ────────────┤
│  对每个 CU i:
│    ├─ 创建 cl_mem_ext_ptr_t 映射主机指针到设备缓冲区:
│    │  fields[i] -> bank 1, offsets[i] -> bank 2
│    │  idf_value_ -> bank 3, tf_addr_ -> bank 4
│    │  tf_value_ -> bank 5, indexId[i] -> bank 9
│    ├─ 创建 cl::Buffer 对象 (USE_HOST_PTR 模式)
│    └─ 设置 Kernel 参数 (0-9): config, 5 个输入 buffer, 3 个 tf_value buffer (用于内部计算), 输出 buffer
│
├─ Step 4: 内核执行与同步 ──────────────────┤
│  1. enqueueMigrateMemObjects(ob_in, 0, ...): 将输入数据从主机迁移到设备 (H2D)
│  2. enqueueTask(PKernel[i], ...): 启动 2 个 CU 的 TGP Kernel (并行执行)
│  3. enqueueMigrateMemObjects(ob_out, 1, ...): 将结果从设备迁移回主机 (D2H)，依赖 kernel 完成事件
│
输出: indexId[2][] 数组，存储每个查询文档匹配到的重复文档 ID
```

---

## 4. 组件深度剖析

### 4.1 `TwoGramPredicate` 类：核心索引与搜索引擎

#### 职责定位

这是模块的核心类，实现了**基于 2-gram 的局部敏感哈希索引**。它的设计目标是：在内存受限的前提下，为大规模文本集构建紧凑的倒排索引，并支持快速的相似度检索。

#### 关键数据结构解析

**索引三元组（Index Triad）**

```cpp
double idf_value_[4096];    // 固定大小数组，索引为 2-gram 编码 (0-4095)
uint64_t tf_addr_[4096];    // 地址编码：[63:31] 存储结束位置，[30:0] 存储起始位置/2
double tf_value_[TFLEN];    // 变长数组，存储实际的倒排列表 (doc_id, weight)
```

这种设计的精妙之处在于：
- **固定头部（Fixed Header）**：`idf_value_` 和 `tf_addr_` 是定长数组（4096 个元素，对应 37×37 种可能的 2-gram 组合），支持 O(1) 随机访问
- **压缩尾部（Compressed Tail）**：`tf_value_` 只存储非停用词的倒排列表，通过 `tf_addr_` 编码的偏移量进行访问
- **地址压缩**：`tf_addr_[i]` 使用 64 位打包编码：(begin >> 1) + (end << 31)，既节省空间又避免指针开销

**字符编码方案（37 进制压缩）**

```cpp
char TwoGramPredicate::charEncode(char in) {
    if (in >= '0' && in <= '9') return in - '0';        // 0-9
    if (in >= 'a' && in <= 'z') return in - 'a' + 10;   // 10-35
    if (in >= 'A' && in <= 'Z') return in - 'A' + 10;   // 10-35 (大小写不敏感)
    return 36;  // 其他字符
}
```

这种编码将字符空间压缩到 37 个符号，两个字符组合产生 $37^2 = 1369$ 种可能，但实际只使用 4096（$2^{12}$）的编码空间，为 FPGA 的固定宽度处理单元优化。

#### 核心算法流程

**索引构建（Index Method）**

索引构建采用**两阶段归并**策略：

1. **局部统计阶段**：对每个唯一文档，提取 2-gram，建立局部词频字典，计算归一化 TF 权重
2. **全局归并阶段**：按 2-gram ID 聚合所有局部统计，构建全局倒排列表

**关键优化：高频词剪枝（Threshold-based Pruning）**

```cpp
int threshold = int(1000 > N * 0.05 ? 1000 : N * 0.05);
if (size > threshold) {
    skip++;  // 跳过高频词（停用词），不存入倒排索引
    continue;
}
```

这是一种**有损压缩**策略：出现频率超过阈值的 2-gram（通常是 "的"、"he"、"in" 等常见模式）被视为区分度低，直接从索引中剔除。这大幅减少了存储开销和搜索时的计算量，代价是极端情况下可能漏检某些高频模式主导的重复文本。

**搜索执行（Search Method）**

搜索方法实现了**异构计算卸载**模式：

1. **数据分区**：将输入数据集划分为 CU（Compute Unit，通常为 2）个分区，每个分区由一个 FPGA 内核实例处理
2. **缓冲区准备**：使用 `aligned_alloc` 分配页对齐内存，满足 FPGA DMA 传输的对齐要求
3. **零拷贝映射**：通过 `CL_MEM_USE_HOST_PTR` 和 `cl_mem_ext_ptr_t` 将主机内存直接映射到 FPGA 地址空间，避免数据拷贝开销
4. **流水线执行**：H2D 传输 → 内核计算 → D2H 传输形成三级流水线，通过 OpenCL 事件（`cl::Event`）实现依赖同步

### 4.2 `WordPredicate` 类：基于单词的精确匹配回退

#### 职责定位

`WordPredicate` 提供了**基于单词（Word-based）的精确匹配能力**，作为 2-gram 模糊匹配的补充。它适用于需要精确单词匹配而非近似相似度的场景，或作为 2-gram 索引构建前的预处理步骤。

#### 与 TwoGramPredicate 的关键差异

| 维度 | TwoGramPredicate | WordPredicate |
|------|-------------------|---------------|
| **处理单元** | 2-gram（字符级） | Word（单词级，空格分隔） |
| **匹配类型** | 模糊匹配（相似度阈值） | 精确匹配（哈希/字典查找） |
| **索引结构** | 压缩倒排索引 + IDF 加权 | 简单字典（term_to_id_）+  postings |
| **执行位置** | FPGA 加速（TGP Kernel） | CPU 执行（search 方法） |
| **适用场景** | 近似重复检测（typos、格式差异） | 精确键值匹配、规范化后的精确去重 |

#### 核心数据结构

```cpp
// 从单词字符串到全局唯一 ID 的映射
std::map<std::string, uint32_t> term_to_id_;

// 从文档特征串（预处理后的单词序列）到文档 ID 的映射  
std::map<std::string, uint32_t> doc_to_id_;

// 倒排索引：term_id -> 列表 of (doc_id, normalized_weight)
std::vector<std::vector<udPT>> tf_value_;

// IDF 值数组
std::vector<double> idf_value_;
```

注意 `tf_value_` 使用 `vector<vector<>>` 的嵌套结构，每个外层索引对应一个 term_id，内层 vector 存储该 term 的所有倒排记录。这种设计与 `TwoGramPredicate` 的扁平化数组（`tf_value_` 一维数组 + `tf_addr_` 索引）形成对比，反映了 CPU 端更灵活的内存管理能力。

#### 搜索算法：归并求交（Merge-based Intersection）

`WordPredicate::search` 实现了**多列表归并**算法来高效计算文档相似度：

1. **查询解析**：将查询文本分词，查找每个词对应的 term_id
2. **列表收集**：根据 term_id 获取对应的倒排列表（`tf_value_`）
3. **归并计算**：使用 `addMerge` 辅助函数，迭代归并多个倒排列表：
   - 首先归并前两个列表，产生临时结果
   - 然后将下一个列表与上次归并结果归并，直到处理完所有列表
4. **阈值过滤**：计算查询向量的 L2 范数，设定相似度阈值（默认 0.8），筛选出权重超过阈值的候选文档
5. **去重输出**：使用 `canopy` 数组记录已分配的重复组 ID，确保输出结果的一致性

这种归并策略的时间复杂度为 $O(L_1 + L_2 + ... + L_k)$，其中 $L_i$ 是各倒排列表的长度，远优于暴力扫描的 $O(N \cdot k)$。

---

## 5. 设计决策与权衡分析

### 5.1 为何选择 2-gram 而非 word-based 或 3-gram？

**决策**：使用 2-gram（双字符组）作为索引单元。

**权衡分析**：

| 方案 | 优势 | 劣势 | 适用场景 |
|------|------|------|----------|
| **Word-based** | 语义明确，人类可理解 | 对拼写错误敏感，需要分词器 | 精确匹配、规范化文本 |
| **2-gram** | 对拼写错误鲁棒，无需分词，固定 4096 维空间适合 FPGA | 区分度较低，可能产生更多假阳性 | 近似匹配、脏数据去重 |
| **3-gram** | 区分度更高，假阳性更少 | 索引空间膨胀到 $37^3 = 50653$ 维，内存和计算开销剧增 | 高精度近似匹配 |

**设计理由**：2-gram 是在**区分能力**、**计算开销**和**硬件友好性**之间的最佳平衡点。4096 维的固定空间正好对应 FPGA 的块 RAM 容量和并行处理能力，而 37 进制的编码方案在信息密度和碰撞率之间取得了实用性的平衡。

### 5.2 有损压缩：高频词剪枝的利弊

**决策**：使用动态阈值 `threshold = max(1000, N * 0.05)` 剪除高频 2-gram。

**利弊分析**：

- **收益**：
  - 存储空间减少 30%-70%（取决于数据分布）
  - 搜索时减少无效的归并计算
  - 降低 FPGA 内存带宽压力

- **代价**：
  - **假阴性风险**：如果两个重复文本的相似性主要来自高频词（如 "的的是是" 这种重复模式），可能漏检
  - 阈值参数需要调优，不同数据集可能需要不同的阈值

**设计智慧**：这种 "以空间换准确性" 的权衡在工程实践中是合理的，因为文本去重的目标通常是**找到明显重复的记录**而非捕获所有边缘情况的相似性。阈值参数的存在也为不同精度要求的场景提供了调整空间。

### 5.3 异构计算的职责划分

**决策**：CPU 负责索引构建和数据管理，FPGA 负责相似度计算。

**划分依据**：

| 任务 | 执行位置 | 理由 |
|------|----------|------|
| 索引构建 | CPU | 涉及复杂的哈希表操作、动态内存分配、不规则的数据结构访问，不适合 FPGA 的 SIMD 架构 |
| 数据预处理 | CPU | 需要字符串解析、正则处理等控制流密集型操作 |
| 倒排列表归并 | FPGA | 规则的数据并行计算，大量浮点乘加操作，适合 FPGA 的 DSP 单元并行处理 |
| 相似度阈值判断 | FPGA | 简单的比较操作，可以与计算流水线融合，减少数据传输 |

这种划分遵循 **Amdahl 定律** 和 **数据局部性原理**：将计算密集且规则的部分卸载到 FPGA，将控制密集且不规则的部分保留在 CPU，两者通过 PCIe 总线以批处理模式交互，最大化整体吞吐量。

---

## 6. 使用模式与扩展点

### 6.1 典型使用流程

```cpp
// Step 1: 准备数据
std::vector<std::string> column = loadDataFromCSV("input.csv");

// Step 2: 创建索引对象
TwoGramPredicate tgp;

// Step 3: 构建索引（CPU 端预处理）
tgp.index(column);

// Step 4: 准备输出缓冲区
uint32_t* indexId[2];
indexId[0] = new uint32_t[column.size()];
indexId[1] = new uint32_t[column.size()];

// Step 5: 执行 FPGA 加速搜索
tgp.search("/path/to/tgp_kernel.xclbin", column, indexId);

// Step 6: 处理结果
for (size_t i = 0; i < column.size(); i++) {
    if (indexId[0][i] != -1) {
        std::cout << "Record " << i << " is duplicate of " << indexId[0][i] << std::endl;
    }
}
```

### 6.2 关键配置参数

| 参数 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `BS` | 编译时常量 | 通常 64MB | fields 缓冲区总大小，决定最大支持的文本数据量 |
| `RN` | 编译时常量 | 通常 1M | 最大记录数，决定 offsets 数组大小 |
| `TFLEN` | 编译时常量 | 通常 16M | tf_value_ 最大长度，决定索引容量 |
| `CU` | 编译时常量 | 2 | Compute Unit 数量，决定并行内核实例数 |
| `threshold` | 运行时计算 | max(1000, N*0.05) | 高频词过滤阈值 |

### 6.3 扩展点与定制方向

1. **自定义字符编码**：修改 `charEncode` 和 `charFilter` 方法，支持非拉丁字符集（如中文 Unicode 编码）
2. **动态阈值调整**：通过配置文件或运行时参数传递 `threshold` 乘数，适应不同精度要求
3. **替代相似度度量**：当前使用余弦相似度（通过 TF-IDF 加权隐式实现），可通过修改 FPGA 内核逻辑支持 Jaccard、Dice 等其他度量
4. **多 FPGA 扩展**：修改 `CU` 和 `search` 中的设备枚举逻辑，支持跨多个 FPGA 卡的数据分区

---

## 7. 陷阱与注意事项

### 7.1 内存管理陷阱

**陷阱 1：缓冲区溢出**
```cpp
// 危险：假设 column.size() < RN，但实际可能超出
offsets[i] = aligned_alloc<uint32_t>(RN);  // RN 是编译时常量
copy(column.begin(), column.end(), offsets[i]);  // 如果 column 超过 RN，溢出！
```

**正确做法**：在分配前检查数据规模，或动态调整缓冲区大小。

**陷阱 2：对齐要求**
```cpp
// 错误：普通 malloc 不满足 FPGA DMA 对齐要求
fields[i] = (uint8_t*)malloc(BS);  // 可能导致 DMA 失败或性能下降

// 正确：使用页对齐分配
fields[i] = aligned_alloc<uint8_t>(BS);  // 通常对齐到 4KB 边界
```

### 7.2 OpenCL 运行时陷阱

**陷阱 3：内存对象生命周期**
```cpp
// 危险：cl::Buffer 在 cl_mem_ext_ptr_t 之前析构
cl_mem_ext_ptr_t ext = {1, host_ptr, kernel()};
{
    cl::Buffer buf(context, flags, size, &ext);  // buf 在这里析构
}
// 后续使用 ext 或访问 host_ptr 可能导致未定义行为
```

**陷阱 4：事件依赖链错误**
```cpp
// 错误：read 操作依赖于 kernel 完成，但没有正确传递事件
cl::Event write_event, kernel_event, read_event;
queue.enqueueWriteBuffer(buf, false, 0, size, data, nullptr, &write_event);
queue.enqueueKernel(kernel, cl::NullRange, global, local, nullptr, &kernel_event);  // 缺少对 write_event 的依赖
queue.enqueueReadBuffer(buf, false, 0, size, result, &kernel_event, &read_event);  // 依赖不完整
```

### 7.3 算法正确性陷阱

**陷阱 5：高频词剪枝导致的假阴性**
在阈值设置过高或数据集中高频模式占主导时，合法重复记录可能被错误地判定为非重复。建议：
- 对关键业务场景进行离线评估，调整阈值
- 实现 Fallback 机制，对 FPGA 未命中记录进行 CPU 二次验证

**陷阱 6：浮点精度累积误差**
TF-IDF 计算涉及大量浮点乘加操作，在 FPGA 和 CPU 端使用不同精度（如 FPGA 使用固定点、CPU 使用双精度）可能导致结果不一致。建议：
- 在验证阶段对比 FPGA 和 CPU 参考实现的结果差异
- 设定合理的容差阈值（如 1e-4）判定匹配成功与否

---

## 8. 依赖关系与模块边界

### 8.1 向上依赖（本模块调用谁）

| 依赖模块 | 依赖方式 | 用途 |
|----------|----------|------|
| Xilinx OpenCL Runtime (libxilinxopencl) | 动态链接 | FPGA 设备管理、内核执行、数据传输 |
| `xf::common::utils_sw::Logger` | 头文件包含 | OpenCL 操作日志记录和错误检查 |
| 标准 C++ 库 (`<map>`, `<vector>`, `<algorithm>`) | 头文件包含 | 标准容器和算法 |

### 8.2 向下依赖（谁调用本模块）

本模块是 `duplicate_text_match_demo_l2` 的核心组件，通常被 **host_application** 模块调用：

```
host_application
    │
    ├── 调用 host_predicate_logic::TwoGramPredicate::index()  // 构建索引
    ├── 调用 host_predicate_logic::TwoGramPredicate::search() // 执行搜索
    └── 处理返回的 indexId 数组，输出重复记录组
```

### 8.3 模块边界与契约

**输入契约**：
- 输入文本数据必须是有效的 UTF-8 或 ASCII 编码字符串
- 单条记录长度不应超过内部缓冲区限制（`BS / 平均记录数`）
- `xclbinPath` 必须指向有效的、与本模块版本兼容的 FPGA 比特流文件

**输出契约**：
- `indexId` 数组与输入 `column` 一一对应，每个元素表示该记录所属的重复组 ID（-1 表示无重复）
- 重复组 ID 是稳定的（同一组重复记录具有相同的 ID），但不保证连续性或从 0 开始

**资源契约**：
- 运行时需要至少 1 个 Xilinx FPGA 设备（Alveo U50/U200/U250 等）
- 主机内存需求约为 `2 * BS + TFLEN * sizeof(double)` 加上数据本身大小

---

## 9. 总结：关键设计智慧

本模块展示了异构计算场景下的典型设计模式，其关键智慧在于：

1. **问题分解的艺术**：将 $O(N^2)$ 的暴力匹配问题，通过倒排索引转化为 $O(N \cdot M)$ 的稀疏向量运算，再通过 FPGA 并行化降低常数因子。

2. **内存布局的优化**：固定头部 + 压缩尾部的索引结构，既支持 O(1) 随机访问，又保持存储紧凑；地址打包编码减少指针开销。

3. **有损计算的权衡**：高频词剪枝牺牲极端情况下的召回率，换取存储和计算效率的大幅提升，体现了工程实践中 "足够好即可" 的实用主义。

4. **异构职责的划分**：CPU 负责不规则的控制流和数据管理，FPGA 负责规则的数据并行计算，两者通过批处理和零拷贝技术最小化通信开销。

理解这些设计智慧，有助于在其他异构计算场景（如 GPU 加速、AI 推理加速）中做出类似的架构决策。
