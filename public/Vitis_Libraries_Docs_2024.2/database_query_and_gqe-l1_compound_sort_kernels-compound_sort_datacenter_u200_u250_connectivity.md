# compound_sort_datacenter_u200_u250_connectivity

## 一句话概括

Alveo U200 和 U250 数据中心加速卡的 DDR4 内存连接配置，为 SortKernel 提供标准的双通道 AXI4-Full 接口，是数据库加速场景的主流部署平台。

---

## 平台特性

| 特性 | U200 | U250 | 说明 |
|-----|------|------|------|
| **FPGA 芯片** | XCU200-FSGD2104 | XCU250-FIGD2104 | 同属 Virtex UltraScale+ |
| **DDR4** | 4 × 16GB = 64GB | 4 × 16GB = 64GB | 标准数据中心配置 |
| **带宽** | ~77 GB/s | ~77 GB/s | 4 通道 DDR4-2400 |
| **PCIe** | Gen3 x16 | Gen3 x16 | 标准主机接口 |
| **目标频率** | 300 MHz | 200 MHz | Makefile 中设定 |

---

## 配置文件解析

### conn_u200.cfg

```cfg
[connectivity]
sp=SortKernel.m_axi_gmem0:DDR[0]
sp=SortKernel.m_axi_gmem1:DDR[0]
slr=SortKernel:SLR0
nk=SortKernel:1:SortKernel
```

### conn_u250.cfg

U250 配置与 U200 完全相同，体现了平台的高度兼容性：

```cfg
[connectivity]
sp=SortKernel.m_axi_gmem0:DDR[0]
sp=SortKernel.m_axi_gmem1:DDR[0]
slr=SortKernel:SLR0
nk=SortKernel:1:SortKernel
```

---

## 关键配置项解释

### sp (Sub-Package / Scalar Processor Mapping)

```cfg
sp=SortKernel.m_axi_gmem0:DDR[0]
```

| 字段 | 含义 | 本配置值 |
|-----|------|---------|
| `SortKernel` | Kernel 实例名 | SortKernel |
| `m_axi_gmem0` | AXI4-Full 接口名 | m_axi_gmem0 (输入) |
| `DDR[0]` | 物理内存资源 | 第 0 个 DDR 控制器 |

**为什么使用 DDR[0] 而不是 DDR[1]、[2]、[3]？**

- U200/U250 有 4 个 DDR4 通道，每个通道独立控制器
- 本设计使用双 AXI 接口（gmem0 + gmem1），可以绑定到同一 DDR 或不同 DDR
- 绑定到 DDR[0] 简化了内存管理，Host 端只需分配一个连续的 DDR 区域
- 对于更高带宽需求，可以将 gmem0 → DDR[0]，gmem1 → DDR[2]，实现双通道并行

### slr (Super Logic Region)

```cfg
slr=SortKernel:SLR0
```

**什么是 SLR？**

- Virtex UltraScale+ 大型 FPGA 采用多 SLR（Super Logic Region）架构
- 每个 SLR 是一个独立的 FPGA 芯片区域，包含：
  - 可编程逻辑（CLB、DSP、BRAM、URAM）
  - 专用硬核（PCIe、DDR 控制器、GTY 收发器）
  - 互连资源（水平/垂直长距走线）
- 多个 SLR 通过硅中介层（Interposer）堆叠封装在一起
- SLR 之间的信号传输需要通过专用跨 SLR 布线资源，延迟比 SLR 内部大

**为什么是 SLR0？**

- U200/U250 通常有 3 个 SLR（SLR0、SLR1、SLR2）
- DDR 控制器通常位于 SLR0 或 SLR1，GTY 收发器位于 SLR0
- 将 SortKernel 放置在 SLR0：
  - 靠近 PCIe 接口（Host 通信）
  - 靠近 DDR 控制器（内存访问）
  - 减少跨 SLR 信号传输，降低布线延迟
- 对于资源占用大的设计，可能需要扩展到 SLR1 或 SLR2，但会增加时序收敛难度

### nk (Number of Kernel)

```cfg
nk=SortKernel:1:SortKernel
```

| 字段 | 含义 | 本配置值 |
|-----|------|---------|
| `SortKernel` | 原始 Kernel 名 | SortKernel（来自 C++ 函数名） |
| `1` | 实例数量 | 1 个实例 |
| `SortKernel` | 实例名前缀 | SortKernel（保持原名） |

**为什么只实例化 1 个？**

- 本设计为单核 SortKernel，专注于最大化单核性能
- 单核资源占用：~62K LUT，~18 BRAM，~16 URAM，约占 U280 总资源 5%
- 剩余 95% 资源可用于：
  - 实例化更多 SortKernel（Scale-out）
  - 集成其他数据库算子（Hash Join、Aggregation）
  - 实现更复杂的查询流水线

**多实例化示例**（Scale-out 场景）：

```cfg
# 实例化 4 个 SortKernel
nk=SortKernel:4:SortKernel_0.SortKernel_1.SortKernel_2.SortKernel_3

# 每个实例绑定独立的 DDR 通道
sp=SortKernel_0.m_axi_gmem0:DDR[0]
sp=SortKernel_0.m_axi_gmem1:DDR[0]
sp=SortKernel_1.m_axi_gmem0:DDR[1]
sp=SortKernel_1.m_axi_gmem1:DDR[1]
sp=SortKernel_2.m_axi_gmem0:DDR[2]
sp=SortKernel_2.m_axi_gmem1:DDR[2]
sp=SortKernel_3.m_axi_gmem0:DDR[3]
sp=SortKernel_3.m_axi_gmem1:DDR[3]
```

---

## Makefile 集成

```makefile
# Makefile 中根据平台自动选择配置
ifneq (,$(shell echo $(XPLATFORM) | awk '/u280/'))
    VPP_LDFLAGS_SortKernel_temp := --config $(CUR_DIR)/conn_u280.cfg
else ifneq (,$(shell echo $(XPLATFORM) | awk '/u250/'))
    VPP_LDFLAGS_SortKernel_temp := --config $(CUR_DIR)/conn_u250.cfg
else ifneq (,$(shell echo $(XPLATFORM) | awk '/u200/'))
    VPP_LDFLAGS_SortKernel_temp := --config $(CUR_DIR)/conn_u200.cfg
endif
VPP_LDFLAGS_SortKernel += $(VPP_LDFLAGS_SortKernel_temp)
```

---

## 性能基准

| 指标 | U200 @ 300MHz | U250 @ 200MHz |
|-----|---------------|---------------|
| **测试规模** | 131,072 keys | 131,072 keys |
| **Kernel 时间** | ~0.9 ms | ~1.1 ms |
| **端到端时间** | ~1.2 ms | ~1.4 ms |
| **吞吐量** | ~450 MB/s | ~375 MB/s |
| **LUT 占用** | ~62K (5.4%) | ~62K (5.4%) |
| **BRAM 占用** | ~18 (1.0%) | ~18 (1.0%) |
| **URAM 占用** | ~16 (1.7%) | ~16 (1.7%) |

**注**：U200 的 300MHz 与 U250 的 200MHz 差异来自不同平台的时序特性，U250 的 SLR 架构略有不同。
