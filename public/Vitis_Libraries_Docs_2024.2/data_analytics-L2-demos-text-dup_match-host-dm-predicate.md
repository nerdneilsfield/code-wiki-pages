# host_predicate_logic 模块深度解析

## 概述：为什么需要这个模块？

想象你运营着一个电商平台，每天涌入数百万条商品描述、用户评论和论坛帖子。其中充斥着大量重复或近似重复的内容——同一商品的多个变体描述、复制粘贴的评论、稍微改写的广告文案。**如何在大规模数据集中高效识别这些"近似重复"？**

`host_predicate_logic` 模块正是解决这一问题的核心引擎。它不是一个简单的字符串比对工具，而是一个结合了**信息检索理论**（TF-IDF 加权）、**模糊匹配算法**（2-gram 分词）和**异构计算加速**（FPGA 内核）的复合系统。

这个模块的独特之处在于它**同时提供两种互补的匹配策略**：
- **TwoGramPredicate**：面向模糊相似性，使用 2-gram 分词和 FPGA 加速，适合"这个句子是否是另一个句子的改写"这类问题
- **WordPredicate**：面向精确词汇匹配，纯 CPU 执行，适合"这两个文档是否包含完全相同的词集合"这类问题

---

## 核心概念与心智模型

要理解这个模块的设计，你需要建立一个**"倒排索引搜索引擎"**的心智模型——就像 Google 或 Elasticsearch 的工作方式，但更加专业化。

### 从文档到索引：数据流动的三个阶段

想象一下图书馆的卡片目录系统。传统的卡片目录是按书名的字母顺序排列的（正排索引），如果你想找"所有关于猫的书"，你需要检查每一本书。而倒排索引就像是主题索引——直接列出"猫"这个主题下有哪些书。

**阶段一：预处理（Preprocessing）**
```
原始文本 → 字符过滤 → 归一化 → 分词单元
"Hello World!" → "hello world" → ["he", "el", "ll", "lo", "o ", " w", ...]
```

**阶段二：索引构建（Indexing）**
```
统计词频(TF) + 逆文档频率(IDF) → 加权倒排表
"el" → [(doc_5, 0.82), (doc_12, 0.34), (doc_8, 0.91)]
```

**阶段三：查询匹配（Matching）**
```
查询分词 → 索引查找 → 相似度计算 → 候选列表合并排序
"hello" → 取倒排表 → 加权求和 → 返回 Top-K 相似文档
```

### 核心抽象：三大基石

#### 1. 倒排索引（Inverted Index）

这是整个系统的核心数据结构。不同于正排索引（文档 → 词列表），倒排索引是**词 → 文档列表**的映射。它的威力在于：当你想查找包含某个词的文档时，不需要扫描所有文档，直接跳转到该词对应的列表即可。

在 `TwoGramPredicate` 中，这个结构被编码为三个并行数组：
- `idf_value_[4096]`：每个 2-gram 的逆文档频率（全局权重）
- `tf_addr_[4096]`：每个 2-gram 对应的文档-权重列表在 `tf_value_` 中的位置编码
- `tf_value_[TFLEN]`：紧凑存储的 (doc_id, weight) 对序列

这种编码方式是为了**FPGA 友好**——连续内存访问、固定大小索引、无需指针解引用。

#### 2. TF-IDF 权重（Term Frequency - Inverse Document Frequency）

这是一种信息检索中的经典加权方案，解决的是"如何区分重要词和常见词"的问题。

**TF（词频）**：一个词在文档中出现得越频繁，它对这篇文档的代表性就越强。但为了防止长文档占优，通常需要归一化（除以文档总词数或欧几里得范数）。

**IDF（逆文档频率）**：一个词出现在越多的文档中，它的区分能力就越弱。例如"的"、"是"这类词几乎出现在每个文档中，IDF 会让它们的权重趋近于零。

最终权重 = TF × IDF。这个值同时考虑了"词在文档内的重要性"和"词在整个语料库中的区分度"。

#### 3. 2-gram（二元语法）分词

传统的分词（Word-based）需要词典和语言知识，对拼写错误、缩写、新词很敏感。2-gram 则是一种**字符级**的局部特征提取方法：将文本拆分为连续的两个字符组合。

例如："hello" → ["he", "el", "ll", "lo"]

这种方法的优势：
- **语言无关**：不需要词典，适用于任何字符集
- **容错性强**：单个字符的拼写错误只会影响有限的 2-gram，不会破坏整个词
- **局部敏感**：改动的位置不同，影响的 2-gram 也不同，保留了一定的位置信息

---

## 架构与数据流

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               Host (CPU) 层                                      │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐                    │
│  │  TwoGram      │    │  WordPredicate│    │  OpenCL Runtime│                   │
│  │  Predicate    │    │               │    │                │                    │
│  │  (FPGA加速)   │    │  (纯CPU)      │    │  Buffer/Queue  │                    │
│  └───────┬───────┘    └───────────────┘    └───────┬────────┘                    │
│          │                                         │                             │
│          └─────────────────┬───────────────────────┘                             │
│                            ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  预处理流水线：字符过滤 → 2-gram 分词 → TF-IDF 编码 → 索引结构生成      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FPGA 加速卡层                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  TGP_Kernel (Two-Gram Predicate Kernel)                                  │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │     │
│  │  │ 匹配引擎 PE  │  │ 累加器数组   │  │ 相似度阈值比较器             │  │     │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────────┘  │     │
│  │  功能：接收 2-gram 查询向量，在倒排索引上并行匹配，计算 TF-IDF 相似度   │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 核心类职责

#### `TwoGramPredicate` —— FPGA 加速的模糊匹配引擎

这是模块的核心类，负责整个 2-gram 索引的构建和 FPGA 加速查询。它的设计体现了**CPU 预处理 + FPGA 并行计算**的异构计算范式。

**关键方法剖析：**

**`index(const std::vector<std::string>& column)` —— 索引构建**

这个方法实现了完整的倒排索引构建流水线。它接收一个文本列（例如数据库表的一列），输出三个核心数据结构：`idf_value_`、`tf_addr_` 和 `tf_value_`。

处理流程分解：
1. **去重与字段提取** (`preTwoGram`)：将原始文本归一化为规范形式，去重后得到 `unique_field` 列表
2. **2-gram 分词** (`twoGram`)：对每个唯一字段进行分词，生成 2-gram 列表
3. **TF 计算** (`dict` 统计)：对每个文档内的 2-gram 进行词频统计，并计算归一化权重
4. **倒排列表生成** (`word_info`)：将 (doc_id, weight) 对按 2-gram ID 组织成倒排列表
5. **阈值过滤与编码**：跳过出现频率过高的 2-gram，对剩余的计算 IDF 并编码

**关键设计决策：阈值过滤**

代码中的 `threshold = int(1000 > N * 0.05 ? 1000 : N * 0.05)` 是一个重要的调优参数。它的逻辑是：如果一个 2-gram 出现在超过 5% 的文档中（或超过 1000 个文档），就直接跳过它。

为什么这样做？
- **高频 2-gram 区分度低**：比如"th"、"in"这类组合在英语中几乎无处不在
- **减少存储和计算开销**：高频词的倒排列表通常很长
- **避免噪声干扰**：在近似匹配中，高频共现可能导致误匹配

但这是**精度与召回的权衡**：过于激进的阈值可能导致某些真正相似的文档被漏检。

---

**`search(std::string& xclbinPath, std::vector<std::string>& column, uint32_t* indexId[2])` —— FPGA 加速查询**

这是 TwoGramPredicate 最复杂的部分，它展示了**异构计算的完整生命周期**：数据准备 → 设备初始化 → 内核配置 → 任务调度 → 结果回传。

**数据分区策略：**

代码中 `uint32_t blk_sz = column.size() / CU` 展示了如何将数据分区到多个计算单元（CU，Compute Unit）。这里 `CU` 通常是预定义的常量（如 2），意味着同时启动两个 FPGA 内核实例处理数据的不同分区。

这种设计的优势：
- **并行度提升**：两个 CU 同时工作，理论上吞吐量翻倍
- **负载均衡**：每个 CU 处理约一半的数据
- **流水线隐藏**：数据传输和计算可以重叠

**内存对齐与分配：**

`aligned_alloc<uint8_t>(BS)` 和 `aligned_alloc<uint32_t>(RN)` 是关键的内存操作。FPGA 通过 DMA 与主机内存交互，通常需要**页对齐**（4KB 对齐）的内存地址以获得最佳传输效率。

**OpenCL 运行时交互：**

代码展示了完整的 OpenCL 应用模式：
1. **设备发现**：`xcl::get_xil_devices()` 枚举 Xilinx FPGA 设备
2. **上下文创建**：`cl::Context` 管理 OpenCL 对象的生命周期
3. **命令队列**：`cl::CommandQueue` 支持性能分析和乱序执行
4. **程序加载**：`xcl::import_binary_file()` 加载编译好的 FPGA 比特流
5. **内核实例化**：创建 `cl::Kernel` 对象对应 FPGA 上的 TGP_Kernel 实例

**任务调度策略：**

```cpp
queue_->enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);
for (int i = 0; i < CU; i++) queue_->enqueueTask(PKernel[i], &events_write, &events_kernel[i]);
queue_->enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);
```

这展示了经典的 **Map-Reduce 式 FPGA 任务流**：
1. **H2D 传输**（Host to Device）：将输入数据从主机内存迁移到 FPGA 设备内存
2. **内核执行**：两个 CU 同时启动，依赖 `events_write` 确保数据传输完成后再执行
3. **D2H 传输**（Device to Host）：将结果从设备内存迁移回主机

这种事件依赖链保证了执行顺序的正确性，同时允许底层运行时做流水线优化。

---

#### `WordPredicate` —— 纯 CPU 的精确匹配引擎

`WordPredicate` 提供了与 `TwoGramPredicate` 类似的接口，但实现上完全基于 CPU，使用**单词级分词**而非 2-gram。

**关键差异对比：**

| 特性 | TwoGramPredicate | WordPredicate |
|------|-------------------|---------------|
| 分词粒度 | 字符级 2-gram | 空格分隔的单词 |
| 硬件加速 | FPGA (TGP_Kernel) | 纯 CPU |
| 匹配类型 | 模糊相似性 | 精确词汇匹配 |
| 适用场景 | 改写、变体、拼写错误 | 完全相同的词集合 |
| 索引结构 | 紧凑数组（FPGA友好） | 标准 STL 容器 |

**`WordPredicate::search()` 的 Canopy 聚类算法：**

`search()` 方法实现了一个有趣的**Canopy 聚类**策略来加速批量查询：

```cpp
std::vector<int> canopy(doc_to_id_.size(), -1);
// ... 对于每个查询文档 i ...
if (canopy[doc_id] == -1) {
    // 执行完整的相似度计算...
    // 对于所有相似度 > threshold 的文档 j:
    if (canopy[tmp_value[...][j].first] == -1)
        canopy[tmp_value[...][j].first] = doc_id;
} else {
    indexId[i] = canopy[doc_id];
}
```

这个算法的直觉是：**如果文档 A 与文档 B 非常相似，而文档 B 又与文档 C 已经比较过了，那么 A 很可能也在 C 的 canopy 下**。这种方法避免了为每个查询都执行完整的相似度计算，特别适合存在大量重复或高度相似文档的场景。

---

## 使用指南与最佳实践

### 典型使用模式

**模式一：批量去重（TwoGramPredicate）**

```cpp
// 1. 准备数据
std::vector<std::string> documents = loadDocuments();

// 2. 创建索引
dup_match::TwoGramPredicate predicate;
predicate.index(documents);

// 3. 执行查询（需要 FPGA 硬件和 .xclbin 文件）
std::string xclbinPath = "path/to/TGP_Kernel.xclbin";
uint32_t* results[2];
predicate.search(xclbinPath, documents, results);

// 4. 解析结果
for (size_t i = 0; i < documents.size(); i++) {
    if (results[0][i] != -1) {
        std::cout << "Document " << i << " is duplicate of " << results[0][i] << std::endl;
    }
}
```

**模式二：精确匹配（WordPredicate）**

```cpp
// 1. 准备数据
std::vector<std::string> documents = loadDocuments();

// 2. 创建索引
dup_match::WordPredicate predicate;
predicate.index(documents);

// 3. 执行查询（纯 CPU，无需 FPGA）
std::vector<uint32_t> results;
predicate.search(documents, results);

// 4. 解析结果
for (size_t i = 0; i < documents.size(); i++) {
    if (results[i] != -1) {
        std::cout << "Document " << i << " matches pattern of " << results[i] << std::endl;
    }
}
```

### 关键配置参数

| 参数 | 位置 | 含义 | 调优建议 |
|------|------|------|----------|
| `threshold` | `index()` 方法 | 高频词过滤阈值，取 `max(1000, N*0.05)` | 数据噪声大时降低百分比；需要高召回时提高 |
| `0.8` 相似度系数 | `search()` 方法 | Canopy 聚类的相似度阈值 | 要求高精确度时用 0.9+；要求高召回时用 0.6-0.7 |
| `CU` (Compute Units) | 类常量 | FPGA 内核并行度，通常为 2 | 根据 FPGA 资源和数据量调整，通常 2-4 |
| `BS` / `RN` / `TFLEN` | 类常量 | 缓冲区大小限制 | 根据平均文档长度和总文档数调整 |

---

## 总结：模块的核心价值与适用边界

`host_predicate_logic` 模块是一个**专业化、高性能、但有一定使用门槛**的重复文本检测解决方案。它的核心价值在于：

1. **独特的技术组合**：将信息检索（TF-IDF）、模糊匹配（2-gram）和异构计算（FPGA）三种技术有机结合，实现了在特定场景下的极致性能。

2. **灵活的匹配策略**：通过 `TwoGramPredicate` 和 `WordPredicate` 提供模糊和精确两种模式，适应不同的业务需求和数据特征。

3. **硬件加速能力**：在配备 FPGA 的环境下，可以实现远超纯 CPU 方案的吞吐量和能效比。

然而，这个模块**并非银弹**，它有明确的适用边界：

- **硬件依赖**：`TwoGramPredicate` 需要 Xilinx FPGA 硬件和对应的 .xclbin 文件，部署门槛较高。
- **调优复杂度**：阈值参数（threshold、相似度系数）需要根据具体数据集调优，没有普适的"最佳"配置。
- **近似性权衡**：Canopy 聚类等优化引入了近似性，在对精确度要求极高的场景需要谨慎使用或增加验证环节。
- **维护成本**：涉及 FPGA 的代码路径需要特定的硬件环境进行测试和维护，CI/CD 流程更复杂。

**最佳实践建议**：
- 在**快速原型验证**阶段，先用 `WordPredicate` 验证业务逻辑，确认需求后再考虑引入 `TwoGramPredicate` 和 FPGA 加速。
- 在**生产部署**时，建立清晰的硬件需求文档，确保运维团队理解 FPGA 环境的维护要求。
- 在**性能调优**时，采用系统化的实验方法（如网格搜索或贝叶斯优化）来寻找最优阈值配置，而非依赖经验猜测。
- 在**质量保证**上，为涉及 FPGA 的代码路径建立专门的测试环境，或考虑使用仿真工具进行离线测试。

---

*本文档由系统自动生成，旨在帮助新加入的工程师快速理解 `host_predicate_logic` 模块的设计理念、架构和使用方法。如有疑问或发现文档中的错误，请及时联系维护团队更新。*

### 核心类职责

#### `TwoGramPredicate` —— FPGA 加速的模糊匹配引擎

这是模块的核心类，负责整个 2-gram 索引的构建和 FPGA 加速查询。它的设计体现了**CPU 预处理 + FPGA 并行计算**的异构计算范式。

**关键方法剖析：**

**`index(const std::vector<std::string>& column)` —— 索引构建**

这个方法实现了完整的倒排索引构建流水线。它接收一个文本列（例如数据库表的一列），输出三个核心数据结构：`idf_value_`、`tf_addr_` 和 `tf_value_`。

处理流程分解：
1. **去重与字段提取** (`preTwoGram`)：将原始文本归一化为规范形式，去重后得到 `unique_field` 列表。这是为了处理完全相同的文档只保留一份索引。
2. **2-gram 分词** (`twoGram`)：对每个唯一字段进行分词，生成 2-gram 列表。
3. **TF 计算** (`dict` 统计)：对每个文档内的 2-gram 进行词频统计，并计算归一化权重（欧几里得范数归一化）。
4. **倒排列表生成** (`word_info`)：将 (doc_id, weight) 对按 2-gram ID 组织成倒排列表。
5. **阈值过滤与编码**：跳过出现频率过高的 2-gram（`size > threshold`），对剩余的计算 IDF 并编码到 `tf_addr_` 和 `tf_value_` 数组。

**关键设计决策：阈值过滤**

代码中的 `threshold = int(1000 > N * 0.05 ? 1000 : N * 0.05)` 是一个重要的调优参数。它的逻辑是：如果一个 2-gram 出现在超过 5% 的文档中（或超过 1000 个文档），就直接跳过它。

为什么这样做？
- **高频 2-gram 区分度低**：比如"th"、"in"这类组合在英语中几乎无处不在，匹配它们对区分文档帮助不大。
- **减少存储和计算开销**：高频词的倒排列表通常很长，跳过它们能显著减少内存占用和 FPGA 计算量。
- **避免噪声干扰**：在近似匹配中，高频共现可能导致误匹配，过滤它们提高精度。

但这是**精度与召回的权衡**：过于激进的阈值可能导致某些真正相似的文档因为共享太多"常见"2-gram 而被漏检。

---

**`search(std::string& xclbinPath, std::vector<std::string>& column, uint32_t* indexId[2])` —— FPGA 加速查询**

这是 TwoGramPredicate 最复杂的部分，它展示了**异构计算的完整生命周期**：数据准备 → 设备初始化 → 内核配置 → 任务调度 → 结果回传。

**数据分区策略：**

代码中 `uint32_t blk_sz = column.size() / CU` 展示了如何将数据分区到多个计算单元（CU，Compute Unit）。这里 `CU` 应该是预定义的常量（通常为 2），意味着同时启动两个 FPGA 内核实例处理数据的不同分区。

这种设计的优势：
- **并行度提升**：两个 CU 同时工作，理论上吞吐量翻倍
- **负载均衡**：每个 CU 处理约一半的数据（最后一个 CU 可能稍多，因为 `if (i == CU - 1) end = column.size()`）
- **流水线隐藏**：数据传输和计算可以重叠（通过 OpenCL 的异步队列）

**内存对齐与分配：**

`aligned_alloc<uint8_t>(BS)` 和 `aligned_alloc<uint32_t>(RN)` 是关键的内存操作。FPGA 通过 DMA 与主机内存交互，通常需要**页对齐**（4KB 对齐）的内存地址以获得最佳传输效率。

三个核心缓冲区：
- `fields[i]`：实际文本内容，字节数组，存储去重后的字段数据
- `offsets[i]`：每个文档在 `fields` 中的结束偏移量，用于快速定位文档边界
- `index_id[i]`：输出缓冲区，存储匹配结果（哪个查询匹配到了哪个索引文档）

**OpenCL 运行时交互：**

代码展示了完整的 OpenCL 应用模式：
1. **设备发现**：`xcl::get_xil_devices()` 枚举 Xilinx FPGA 设备
2. **上下文创建**：`cl::Context` 管理 OpenCL 对象的生命周期
3. **命令队列**：`cl::CommandQueue` 支持性能分析（`CL_QUEUE_PROFILING_ENABLE`）和乱序执行（`CL_QUEUE_OUT_OF_ORDER_EXEC_MODE_ENABLE`）
4. **程序加载**：`xcl::import_binary_file()` 加载编译好的 FPGA 比特流（.xclbin）
5. **内核实例化**：创建两个 `cl::Kernel` 对象，分别对应 FPGA 上的两个 TGP_Kernel 实例

**缓冲区绑定与参数传递：**

`cl_mem_ext_ptr_t` 和 `cl::Buffer` 的组合实现了主机内存与 FPGA 之间的零拷贝（Zero-Copy）或 DMA 传输。每个内核有 6 个参数：
1. `fields`：输入文本数据
2. `offsets`：文档偏移索引
3. `idf_value_`：IDF 权重表（4096 个 double）
4. `tf_addr_`：TF 地址编码表（4096 个 uint64_t）
5. `tf_value_`：TF 值表（变长 uint64_t 数组）
6. `indexId`：输出结果数组

**任务调度策略：**

```cpp\nqueue_->enqueueMigrateMemObjects(ob_in, 0, nullptr, &events_write[0]);\nfor (int i = 0; i < CU; i++) queue_->enqueueTask(PKernel[i], &events_write, &events_kernel[i]);\nqueue_->enqueueMigrateMemObjects(ob_out, 1, &events_kernel, &events_read[0]);\n```\n\n这展示了经典的 **Map-Reduce 式 FPGA 任务流**：\n1. **H2D 传输**（Host to Device）：将输入数据从主机内存迁移到 FPGA 设备内存，`events_write` 标记完成事件\n2. **内核执行**：两个 CU 同时启动，依赖 `events_write` 确保数据传输完成后再执行\n3. **D2H 传输**（Device to Host）：将结果从设备内存迁移回主机，依赖 `events_kernel` 确保计算完成后再传输\n\n这种事件依赖链保证了执行顺序的正确性，同时允许底层运行时做流水线优化。\n\n---\n\n#### `WordPredicate` —— 纯 CPU 的精确匹配引擎\n\n`WordPredicate` 提供了与 `TwoGramPredicate` 类似的接口，但实现上完全基于 CPU，使用**单词级分词**而非 2-gram。\n\n**关键差异对比：**\n\n| 特性 | TwoGramPredicate | WordPredicate |\n|------|-------------------|---------------|\n| 分词粒度 | 字符级 2-gram | 空格分隔的单词 |\n| 硬件加速 | FPGA (TGP_Kernel) | 纯 CPU |\n| 匹配类型 | 模糊相似性 | 精确词汇匹配 |\n| 适用场景 | 改写、变体、拼写错误 | 完全相同的词集合 |\n| 索引结构 | 紧凑数组（FPGA友好） | 标准 STL 容器 |\n\n**`WordPredicate::index()` 流程：**\n\n1. **文档去重**：使用 `doc_to_id_` 映射确保相同内容的文档只索引一次\n2. **单词分词**：`splitWord()` 将文本按空格和标点分割为单词序列\n3. **词频统计**：对每个文档统计每个单词的出现次数\n4. **TF 归一化**：计算欧几里得范数并归一化权重\n5. **倒排列表构建**：`tf_value_[wid].push_back(udPT(did, temp))` 按单词 ID 存储 (doc_id, weight) 对\n6. **阈值过滤与 IDF 计算**：跳过高频词，计算 IDF = log(1 + N/size)\n\n**`WordPredicate::search()` 的 Canopy 聚类算法：**\n\n`search()` 方法实现了一个有趣的**Canopy 聚类**策略来加速批量查询：\n\n```cpp\nstd::vector<int> canopy(doc_to_id_.size(), -1);\n// ... 对于每个查询文档 i ...\nif (canopy[doc_id] == -1) {\n    // 执行完整的相似度计算...\n    // 对于所有相似度 > threshold 的文档 j:\n    if (canopy[tmp_value[...][j].first] == -1)\n        canopy[tmp_value[...][j].first] = doc_id;\n} else {\n    indexId[i] = canopy[doc_id];\n}\n```\n\n这个算法的直觉是：**如果文档 A 与文档 B 非常相似，而文档 B 又与文档 C 已经比较过了，那么 A 很可能也在 C 的 canopy 下**。这种方法避免了为每个查询都执行完整的相似度计算，特别适合存在大量重复或高度相似文档的场景。\n\n---\n\n## 核心数据结构与算法详解\n\n### 1. 2-gram 编码与字符处理\n\n**`charEncode()`：字符到数值的归一化映射**\n\n```cpp\nchar TwoGramPredicate::charEncode(char in) {\n    char out;\n    if (in >= 48 && in <= 57)       // '0'-'9'\n        out = in - 48;              // → 0-9\n    else if (in >= 97 && in <= 122) // 'a'-'z'\n        out = in - 87;              // → 10-35\n    else if (in >= 65 && in <= 90)  // 'A'-'Z'\n        out = in - 55;              // → 10-35 (大小写不敏感)\n    else\n        out = 36;                   // 其他字符 → 36\n    return out;\n}\n```\n\n这个编码策略有几个关键设计决策：\n- **大小写归一化**：大写和小写字母映射到相同的数值范围（10-35），实现大小写不敏感匹配\n- **数字保留**：数字0-9单独编码（0-9），保留其区分能力\n- **其他字符统一**：所有标点、符号、空格等都映射到36，降低噪声\n\n**`charFilter()`：输入清洗与归一化**\n\n```cpp\nchar TwoGramPredicate::charFilter(char in) {\n    char out;\n    if (in >= 48 && in <= 57)       // '0'-'9' → 保留\n        out = in;\n    else if (in >= 97 && in <= 122) // 'a'-'z' → 保留\n        out = in;\n    else if (in >= 65 && in <= 90)  // 'A'-'Z' → 转小写\n        out = in + 32;\n    else if (in == 32 || in == 10)  // 空格、换行 → 统一为空格\n        out = 32;\n    else\n        out = 255;                  // 其他 → 丢弃标记\n    return out;\n}\n```\n\n这个方法实现了**输入文本的清洗流水线**：\n1. **保留字母数字**：数字和小写字母直接保留\n2. **大小写归一化**：大写字母转为小写（+32 是 ASCII 中大小写的差值）\n3. **空白统一**：空格和换行统一映射到空格，便于后续分词\n4. **噪声剔除**：所有其他字符（标点、特殊符号等）标记为 255 并在后续处理中丢弃\n