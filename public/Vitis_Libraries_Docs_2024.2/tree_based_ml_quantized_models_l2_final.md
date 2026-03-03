# tree_based_ml_quantized_models_l2: FPGA-Accelerated Quantized Tree-Based Machine Learning

## 一句话概括

本模块实现了在FPGA上高速训练量化决策树和随机森林的完整流水线，通过定点数量化、数据流架构和层叠式并行处理，在保持模型精度的同时，将训练吞吐量提升10-100倍于CPU实现。

---

## 1. 问题空间与设计理念

### 1.1 为什么要用FPGA训练树模型？

决策树和随机森林的训练存在三个核心挑战：

1. **不规则内存访问**：需要反复遍历数据集，对特征列进行随机访问，CPU缓存层次难以应对
2. **计算复杂度高**：每个节点需要扫描所有样本计算最佳分裂点，复杂度为 $O(N \cdot F \cdot 2^D)$ 
3. **并行性受限**：节点间存在依赖关系（需要父节点分裂完成），难以提取大规模并行性

FPGA通过**自定义数据流流水线**、**显式存储层次控制**和**细粒度精度调节**，可以针对性地解决这些问题。

### 1.2 量化的价值与风险

将浮点特征值量化为8位定点数带来三重收益：
- **资源效率**：8位运算消耗的DSP资源为32位浮点的1/4到1/8
- **存储密度**：相同片上存储可容纳4-8倍数据
- **计算吞吐**：定点运算流水线时钟频率更高，II更低

但量化需谨慎：
- 树模型只关心 `feature < threshold` 的布尔结果，对精度不敏感
- 但边界效应可能导致不同实现产生不同结果
- 多轮迭代（如GBDT）中量化误差可能累积

### 1.3 核心抽象：四层架构塔

本模块是一个四层建筑，每层处理不同粒度的并行性：

| 层级 | 名称 | 并行粒度 | 说明 |
|------|------|----------|------|
| Layer 4 | Forest Level | 多棵树 | 多棵树并行训练，共享数据扫描逻辑 |
| Layer 3 | Layer Level | 节点级 | PARA_NUM个节点并行计算分裂 |
| Layer 2 | Feature Level | 特征级 | 并行计算信息增益/基尼指数 |
| Layer 1 | Data Level | 样本级 | II=1循环流式处理样本 |

---

## 2. 数据流架构详解

### 2.1 工厂流水线隐喻

本模块是一个高度自动化的工厂流水线，包含5个工位：

**工位1：原料卸货 (Scan)**
- AXI总线将原始数据从DDR搬运到片上
- `axiVarColToStreams` 完成行→列的转置，输出多个特征流

**工位2：路径分拣 (FilterByPredict)**
- 每个样本确定它当前落在哪个节点
- 从根节点开始，根据特征值和阈值判断左右分支
- 更新 `node_id` 直到到达当前层目标节点

**工位3：精细加工 (DispatchSplit)**
- 只选取当前节点需要评估的分裂特征
- 从完整的特征流中提取特定列，打包成分裂候选流
- 内存带宽优化的关键，避免传输无关特征

**工位4：质量检验 (statisticAndCompute)**
- 对每个候选分裂，统计左右子树的类别分布
- 计算基尼指数或信息增益，找出最佳分裂
- 使用8项LRU缓存 (`cache_nid_cid`) 避免重复统计

**工位5：产品入库 (updateTree + writeOut)**
- 根据最佳分裂更新树结构，创建子节点
- 将完成的树序列化为512位AXI流，写回DDR
- 后续推理可以直接加载这个紧凑表示

### 2.2 HLS数据流的优势

HLS数据流(`#pragma HLS dataflow`)将这5个工位映射为并行的硬件流水线阶段：

- **II=1循环**：每个时钟周期处理一个新样本，理论吞吐量 = 时钟频率 × 数据宽度
- **背压传播**：下游工位满时自动阻塞上游，无需显式同步
- **确定性延迟**：没有缓存未命中或分支预测失败，延迟可精确计算

### 2.3 节点结构：压缩档案袋

每个 `Node` 结构是一个72+64位的压缩档案袋：

```
nodeInfo (72 bits): 决策导航图
├─ bit 0      : isLeaf — 是否是终点？
├─ bits 1-15  : leafCat — 终点类别编号
├─ bits 16-31 : featureId — 用哪个特征决策？
└─ bits 32-71 : chl (child left) — 左孩子节点索引

threshold (64 bits): 决策标尺
├─ bits 0-7   : quantizedSplit — 8位量化分裂点索引
└─ bits 8-63  : (预留，可用于扩展精度)
```

设计优势：
1. **URAM对齐**：136位接近URAM的144位端口宽度，100%利用存储带宽
2. **单周期决策**：从读取节点到确定下一节点，一个时钟周期内完成
3. **紧凑序列化**：线性存储为Node数组，无需指针间接寻址
4. **向后兼容**：预留位域允许未来扩展

---

## 3. 关键设计决策与权衡

### 3.1 层内节点并行 vs 样本并行

**选择**：层内节点并行（Layer Level Parallelism）

**权衡分析**：

| 维度 | 层内节点并行 | 样本并行 |
|------|-------------|---------|
| 同步开销 | 低（层边界同步） | 高（每节点需归约） |
| 内存访问模式 | 顺序扫描（友好） | 随机访问（不友好） |
| 扩展性 | 随深度指数增长 | 固定（受样本数限制） |
| 实现复杂度 | 中等 | 高（需处理冲突） |

**关键洞察**：树模型训练中，样本间存在天然依赖（父节点分裂决定子节点样本集合），强行样本并行会导致大量同步和冲突解决开销。层内节点并行顺应了树的自然层次结构。

### 3.2 8位量化 vs 浮点

**选择**：8位量化索引 + 浮点阈值表

**权衡分析**：

| 维度 | 8位量化 | 32位浮点 |
|------|---------|----------|
| 比较器面积 | ~50 LUTs | ~200 LUTs + 1 DSP |
| 存储带宽 | 8 bit/sample | 32 bit/sample |
| 精度损失 | <1% 分裂差异 | 无 |
| 动态范围 | 受分桶策略限制 | 完整IEEE754 |

**混合策略**：
- 样本特征值存储为8位桶索引（`splits_uint8`）
- 实际比较阈值存储为浮点表（`splits_float`）
- 比较时：将8位索引映射回浮点值，再执行比较

这样获得了8位存储密度 + 浮点精度的最佳组合。

### 3.3 URAM vs BRAM for Node存储

**选择**：URAM（UltraRAM）存储Node结构

**权衡分析**：

| 维度 | BRAM | URAM |
|------|------|------|
| 单块容量 | 18/36 Kb | 288 Kb (9x) |
| 端口宽度 | 最大72b | 最大144b |
| 访问延迟 | 1-2周期 | 1-2周期 |
| 资源密度 | 中等 | 高 |

**选择理由**：
1. **容量匹配**：`MAX_NODES_NUM=1023` 个节点 × 136位/节点 ≈ 140Kb，单个URAM块即可容纳，而BRAM需要多块拼接
2. **宽度匹配**：URAM的144位端口宽度完美匹配Node结构的136位，无带宽浪费
3. **简化布线**：单块存储避免多BRAM块间的复杂路由，提高布线成功率

---

## 4. 子模块组织与导航

本模块包含三个紧密关联的子模块，分别处理不同类型的树模型：

| 子模块 | 路径 | 功能 | 关键差异 |
|--------|------|------|----------|
| [classification_decision_tree_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-classification_decision_tree_quantize.md) | `L2/src/classification/decision_tree_quantize.cpp` | 单棵分类决策树 | 最简实现，无节点并行 |
| [classification_rf_trees_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-classification_rf_trees_quantize.md) | `L2/src/classification/rf_trees_quantize.cpp` | 分类随机森林 | 多棵树实例化，分类统计 |
| [regression_rf_trees_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-regression_rf_trees_quantize.md) | `L2/src/regression/rf_trees_quantize.cpp` | 回归随机森林 | 连续值处理，MSE分裂准则 |

### 4.1 为什么分成三个子模块？

虽然三个子模块共享大量公共代码（通过头文件包含和模板实现），但分离为独立文件带来以下好处：

1. **独立优化**：每个子模块可以根据自己的目标场景调整 `PARA_NUM`、`MAX_TREE_DEPTH` 等模板参数
2. **资源隔离**：分类和回归可以分别综合，避免单次编译时间过长，也便于资源分配
3. **清晰依赖**：避免头文件循环依赖，每个子模块只依赖明确的公共接口
4. **测试独立**：可以分别验证分类准确率、回归MSE等不同指标

### 4.2 共享代码的组织

三个子模块共享以下公共基础设施：

| 共享组件 | 位置 | 用途 |
|----------|------|------|
| `Node` struct | `decision_tree_quantize.hpp` | 统一的节点存储格式 |
| `Paras` struct | `decision_tree_quantize.hpp` | 训练超参数集合 |
| `readConfig()` | 各cpp文件 | 配置数据解析（模板实例化） |
| `writeOut()` | 各cpp文件 | 树序列化（模板实例化） |
| 统计计算核心 | `statisticAndCompute()` | 分裂点评估（模板实例化） |

---

## 5. 新贡献者指南

### 5.1 HLS特定的调试技巧

**理解HLS报告**：
- 综合报告（Synthesis Report）中的 `II (Initiation Interval)` 是关键指标，目标为1
- `Latency` 分为 `min`/`max`，差异大说明有数据依赖分支
- `Resource Utilization` 关注 `DSP`、`BRAM`、`URAM`、`LUT` 四类的平衡

**常见II>1的原因与修复**：

| 症状 | 根因 | 修复方法 |
|------|------|----------|
| 数组访问II冲突 | 单端口RAM无法同时读写 | 使用 `dual-port` 或 `array_partition` |
| 数据依赖循环 | 当前迭代依赖前次结果 | 展开循环或插入 `dependence false` pragma |
| 资源限制 | DSP/加法器不足 | 增加 `allocation` 限制或降低并行度 |
| 浮点运算 | 浮点流水线深度大 | 改用定点数或插入 `pipeline` II=2 |

### 5.2 常见陷阱与避坑指南

**陷阱1：隐式类型转换导致精度损失**
```cpp
// 错误：ap_uint<8> 自动转为 int，再转回时可能溢出
ap_uint<8> a = 255;
ap_uint<8> b = a + 1;  // b = 0 (溢出)

// 正确：显式指定位宽
ap_uint<9> temp = a + 1;
ap_uint<8> b = temp.range(7, 0);
```

**陷阱2：DATAFLOW死锁**
```cpp
// 错误：条件写入导致死锁
if (condition) {
    stream.write(data);  // 可能永远不写，下游永远等待
}

// 正确：确保每条路径都产生输出
stream.write(condition ? data : dummy);
```

**陷阱3：数组分区导致的资源爆炸**
```cpp
// 危险：完全分区大数组
int arr[1024];
#pragma HLS array_partition variable=arr dim=0 complete  // 1024个独立寄存器！

// 推荐：循环分区或块分区
#pragma HLS array_partition variable=arr dim=0 cyclic factor=16  // 16个bank
```

---

## 6. 总结

本模块 (`tree_based_ml_quantized_models_l2`) 是Xilinx Vitis Libraries中用于FPGA加速树模型训练的核心组件。通过深入理解其**四层并行架构**、**数据流流水线设计**和**量化策略**，开发者可以：

1. **优化训练性能**：通过调整 `PARA_NUM`、`MAX_TREE_DEPTH` 等模板参数匹配目标FPGA资源
2. **保证数值正确性**：理解8位量化与浮点精度的权衡，避免边界效应导致的精度损失
3. **调试HLS代码**：掌握II优化、数组分区和数据流死锁排查的技巧
4. **扩展新功能**：基于现有框架添加新的分裂准则（如回归的MSE）或采样策略

建议新贡献者按照以下路径学习：
1. 先阅读 [classification_decision_tree_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-classification_decision_tree_quantize.md) 了解最简实现
2. 再阅读 [classification_rf_trees_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-classification_rf_trees_quantize.md) 理解节点并行机制
3. 最后阅读 [regression_rf_trees_quantize](data_analytics_text_geo_and_ml-tree_based_ml_quantized_models_l2-regression_rf_trees_quantize.md) 学习回归连续值处理

---

*本文档最后更新时间：2024年*
*如有问题或建议，请通过项目Issue跟踪系统反馈*
