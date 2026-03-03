# kernel_connectivity 子模块

## 职责概述

本子模块定义了**Two-Gram Predicate (TGP) 内核**与FPGA HBM存储系统之间的物理连接关系。它是硬件设计的"接线图"，决定了数据如何在主机内存、FPGA片上缓存和HBM存储器之间流动。

> 类比：这就像数据中心的网络拓扑设计——哪个机架连接哪个核心交换机，决定了整体吞吐能力的上限。

---

## 核心配置文件：`conn_u50.cfg`

### 文件语义

这是一个**Vitis Linker Configuration**文件，在编译时由`v++ --link`阶段消费，生成最终的`.xclbin`比特流。

### 连接拓扑解析

```ini
[connectivity]
# ═══════════════════════════════════════════════════════════════════
# 第一计算单元: TGP_Kernel_1 (部署于SLR0区域)
# ═══════════════════════════════════════════════════════════════════

# 数据端口: 字段内容缓冲区 (可变长字符串的扁平存储)
sp=TGP_Kernel_1.m_axi_gmem0:HBM[0]

# 数据端口: 偏移量表 (记录每条记录在gmem0中的起始位置)
sp=TGP_Kernel_1.m_axi_gmem1:HBM[1]

# 索引端口: IDF权重表 (4096个2-gram的全局IDF值)
sp=TGP_Kernel_1.m_axi_gmem2:HBM[2]

# 索引端口: TF地址索引 (编码后的文档-词项地址映射)
sp=TGP_Kernel_1.m_axi_gmem3:HBM[3]

# 索引端口: TF值表 (变长压缩存储的文档-词项权重)
sp=TGP_Kernel_1.m_axi_gmem4:HBM[4]
sp=TGP_Kernel_1.m_axi_gmem5:HBM[4]  # 复用bank 4，增加并行端口
sp=TGP_Kernel_1.m_axi_gmem6:HBM[4]  # 复用bank 4
sp=TGP_Kernel_1.m_axi_gmem7:HBM[4]  # 复用bank 4

# 输出端口: 匹配结果索引
sp=TGP_Kernel_1.m_axi_gmem8:HBM[5]

# ═══════════════════════════════════════════════════════════════════
# 第二计算单元: TGP_Kernel_2 (部署于SLR1区域，对称配置)
# ═══════════════════════════════════════════════════════════════════
sp=TGP_Kernel_2.m_axi_gmem0:HBM[10]  # 注意: 使用独立的HBM bank组
sp=TGP_Kernel_2.m_axi_gmem1:HBM[11]
sp=TGP_Kernel_2.m_axi_gmem2:HBM[12]
sp=TGP_Kernel_2.m_axi_gmem3:HBM[13]
sp=TGP_Kernel_2.m_axi_gmem4:HBM[14]
sp=TGP_Kernel_2.m_axi_gmem5:HBM[14]
sp=TGP_Kernel_2.m_axi_gmem6:HBM[14]
sp=TGP_Kernel_2.m_axi_gmem7:HBM[14]
sp=TGP_Kernel_2.m_axi_gmem8:HBM[15]

# ═══════════════════════════════════════════════════════════════════
# 物理放置约束 (SLR = Super Logic Region)
# ═══════════════════════════════════════════════════════════════════
slr=TGP_Kernel_1:SLR0  # 放置在与HBM bank 0-7更近的SLR0
slr=TGP_Kernel_2:SLR1  # 放置在与HBM bank 8-15更近的SLR1

# ═══════════════════════════════════════════════════════════════════
# 内核实例化声明
# ═══════════════════════════════════════════════════════════════════
# nk=<kernel_name>:<num_instances>:<instance1_name>.<instance2_name>
nk=TGP_Kernel:2:TGP_Kernel_1.TGP_Kernel_2
```

---

## 设计决策分析

### 1. HBM Bank分配策略

```
U50 HBM物理布局 (8GB, 32个伪bank映射为16个逻辑bank):
┌─────────────────────────────────────────┐
│  Bank 0-7  (左HBM堆栈, 靠近SLR0)       │
│  ├── Bank 0-3: TGP_Kernel_1 数据       │
│  └── Bank 4-5: TGP_Kernel_1 索引/输出  │
├─────────────────────────────────────────┤
│  Bank 8-15 (右HBM堆栈, 靠近SLR1)       │
│  ├── Bank 10-13: TGP_Kernel_2 数据     │
│  └── Bank 14-15: TGP_Kernel_2 索引/输出│
└─────────────────────────────────────────┘
```

**关键洞察**：
- **隔离性**：TGP_Kernel_1和TGP_Kernel_2使用完全不相交的HBM bank组（0-5 vs 10-15），避免内存争用
- **并行性**：m_axi_gmem4-7复用同一bank(4)，通过AXI互连提供多个独立端口访问同一物理存储区
- **局部性**：SLR放置约束确保内核紧邻其使用的HBM bank，最小化信号传输延迟

### 2. 端口功能语义

| 端口名称 | AXI类型 | 方向 | 数据内容 | 大小量级 | 访问模式 |
|----------|---------|------|----------|----------|----------|
| `m_axi_gmem0` | AXI4-Full | R | 扁平化字段数据 | ~16MB/CU | 突发突发读 |
| `m_axi_gmem1` | AXI4-Full | R | 记录偏移量表 | ~8MB/CU | 索引随机读 |
| `m_axi_gmem2` | AXI4-Full | R | IDF权重数组 | 32KB | 流式广播读 |
| `m_axi_gmem3` | AXI4-Full | R | TF地址编码表 | 32KB | 索引读 |
| `m_axi_gmem4-7` | AXI4-Full | R | TF值变长数组 | ~64MB | 多通道并行读 |
| `m_axi_gmem8` | AXI4-Full | W | 结果索引输出 | ~4MB | 突发写 |

### 3. 多CU扩展性

当前配置使用**2个CU**，但设计本身支持扩展到更多：

```
扩展到4 CU的配置修改:
┌─────────────────────────────────────────┐
│  nk=TGP_Kernel:4:CU_0.CU_1.CU_2.CU_3  │
│                                         │
│  如果仍在U50单卡上:                      │
│  - 需要减少每CU的HBM bank分配            │
│  - 或采用时分复用 (time-multiplexing)   │
│                                         │
│  更好的选择: U50多卡扩展                 │
│  - 每张卡2 CU，通过PCIe交换互联          │
└─────────────────────────────────────────┘
```

---

## 常见问题与调试

### 问题1: 链接时"resource exceeded"错误

**症状**：`v++ --link`报错，提示LUT/BRAM/DSP资源超限。

**根因**：多端口m_axi连接到不同HBM bank会增加地址解码逻辑。

**解决**：
```ini
# 尝试减少端口数或复用bank
# 原配置（9个独立端口）
m_axi_gmem0-8 → HBM[0,1,2,3,4,4,4,4,5]

# 优化配置（共享读端口）
m_axi_gmem0-5 → HBM[0,1,2,3,4,5]  # gmem4-7合并为单一端口
```

### 问题2: 运行时HBM访问冲突

**症状**：间歇性数据损坏或内核挂起。

**根因**：两个CU意外地映射到了重叠的HBM bank。

**检查**：
```bash
# 使用xbutil检查实际分配的内存区域
xbutil examine -d <bdf> -r memory

# 验证xclbin的 connectivity section
xclbinutil --info --input design.xclbin | grep -A 20 CONNECTIVITY
```

### 问题3: SLR跨越延迟过高

**症状**：即使内核逻辑简单， achieved II (Initiation Interval) 仍不理想。

**根因**：内核放置在一个SLR，但主要访问另一个SLR的HBM bank，导致长走线延迟。

**验证配置**：
```ini
# 确保此约束在conn_u50.cfg中
slr=TGP_Kernel_1:SLR0  # TGP_Kernel_1主要访问HBM[0-7]，物理上靠近SLR0
slr=TGP_Kernel_2:SLR1  # TGP_Kernel_2主要访问HBM[10-15]，物理上靠近SLR1
```

---

## 相关链接

- [父模块: duplicate_text_match_demo_l2](data_analytics_text_geo_and_ml-duplicate_text_match_demo_l2.md)
- [子模块: host_predicate_logic](data_analytics_text_geo_and_ml-duplicate_text_match_demo_l2-host_predicate_logic.md)
- [子模块: host_application](data_analytics_text_geo_and_ml-duplicate_text_match_demo_l2-host_application.md)

---

*文档版本: 1.0 | 最后更新: 基于conn_u50.cfg分析*
