# Chapter 3：数据如何进出一个 Kernel（内核）

上一章我们学了“去哪里找例子”。  
这一章我们讲“数据怎么走路”。

想象你开了一家厨房：

- **厨师** = `kernel`（内核，也就是被综合成硬件电路的顶层函数）
- **点菜单** = 控制寄存器（告诉厨师“做什么、做多少”）
- **仓库搬运车** = 内存映射 AXI（按地址去 DDR/HBM 搬很多原料）
- **传送带** = AXI4-Stream（连续一口一口喂数据）

接口选错，就像让外卖小哥一勺一勺搬米：能做，但慢到崩溃。

---

## 3.1 先建立全局地图：Kernel 边界有三条路

```mermaid
graph TD
    H[Host 主机程序] --> C[AXI4-Lite 控制口]
    H --> M[AXI4 Master 内存口]
    SRC[上游流数据源] --> S_IN[AXI4-Stream 输入]
    S_OUT[AXI4-Stream 输出] --> SNK[下游流消费者]
    C --> K[Kernel 内核逻辑]
    M --> K
    S_IN --> K
    K --> S_OUT
    M --> DDR[DDR/HBM 外部内存]
```

这张图可以这样读：  
想象一个工厂车间，**控制口**像前台按钮，**内存口**像叉车通道，**流接口**像流水线。三条路都连到同一个车间（内核逻辑），但每条路的“交通规则”不同。

---

## 3.2 概念关系图：三种接口到底各管什么

> 第一次出现术语解释：  
> **AXI**（Advanced eXtensible Interface）可以理解成 FPGA 世界里非常标准的“物流协议”。  
> **AXI4-Lite** 适合小量配置。  
> **AXI4 Master（m_axi）** 适合按地址批量搬数据。  
> **AXI4-Stream（axis）** 适合连续数据流，不带地址。

```mermaid
classDiagram
    class Kernel{
      硬件加速函数
    }
    class AXI4Lite{
      小数据
      低带宽
      配置与状态
    }
    class MAXI{
      按地址访问
      支持突发传输
      连DDR/HBM
    }
    class AXIS{
      连续数据
      TVALID/TREADY握手
      可带TLAST包尾
    }
    class Performance{
      吞吐量
      延迟
      资源占用
    }

    Kernel --> AXI4Lite : 控制
    Kernel --> MAXI : 批量读写
    Kernel --> AXIS : 流式处理
    AXI4Lite --> Performance : 影响启动/管理开销
    MAXI --> Performance : 影响带宽上限
    AXIS --> Performance : 影响流水稳定性
```

你可以把它想成 React 项目里的三类状态来源：  
- `AXI4-Lite` 像 `props` 里的配置参数（小、明确）  
- `m_axi` 像去数据库批量查数据  
- `axis` 像 WebSocket 持续推流

---

## 3.3 控制寄存器（AXI4-Lite）：告诉 Kernel 什么时候干活

**控制寄存器**就是一组“可读可写的小格子”，主机往里写数字，硬件据此行动。  
想象微波炉面板：`时间`、`火力`、`开始键` 都是寄存器风格。

### 控制流程

```mermaid
flowchart TD
    A[主机写参数寄存器] --> B[主机写 start=1]
    B --> C[Kernel 读取参数]
    C --> D[Kernel 执行]
    D --> E[Kernel 置 done=1]
    E --> F[主机轮询或中断读取 done]
```

这就是最常见的“下单-做菜-取餐”流程。  
在 `interface_design/using_axi_lite` 里，你会看到这种模式的最基础写法。

### 交互时序（request trace）

```mermaid
sequenceDiagram
    participant Host as Host主机
    participant Ctrl as AXI4-Lite控制口
    participant K as Kernel

    Host->>Ctrl: 写threshold/size等参数
    Host->>Ctrl: 写ap_start=1
    Ctrl->>K: 触发启动
    K-->>Ctrl: 运行中(ap_idle=0)
    K-->>Ctrl: 完成(ap_done=1)
    Host->>Ctrl: 读状态寄存器
```

这个时序可以理解为：主机像项目经理，先发 Jira 任务（写参数），再点“开始”，最后查状态。

---

## 3.4 内存映射 AXI（m_axi）：按地址搬大批数据

**内存映射**（memory-mapped）意思是：硬件把外部内存看成“有门牌号的仓库货架”，通过地址去拿货。  
`m_axi` 是“我主动去内存读写”的主设备接口，所以叫 **master**（主发起方）。

### 架构图：m_axi 在系统中的位置

```mermaid
graph TD
    K[Kernel] --> MA[m_axi端口]
    MA --> IC[AXI互连]
    IC --> MC[内存控制器]
    MC --> MEM[DDR/HBM]
    H[Host] --> MEM
```

想象：Kernel 不是直接碰 DDR，而是先过“高速路收费站”（AXI 互连和内存控制器）。

### 为什么“突发传输（burst）”很关键

**突发传输**就是“一次报地址，连续搬多拍数据”，像快递员一次搬一整箱，而不是每次只拿一件再重新登记。

```mermaid
flowchart TD
    A[循环访问数组] --> B{地址连续吗?}
    B -->|是| C[生成burst突发]
    B -->|否| D[退化成单拍访问]
    C --> E[高带宽]
    D --> F[低带宽]
```

这也是 `manual_burst_*` 示例要教你的核心：  
代码里多一个不合适的 `if`，就可能让“整箱搬运”退化成“单件搬运”。

---

## 3.5 AXI4-Stream：像传送带一样连续喂数据

**流接口**（streaming interface）没有地址，只有“这一拍有没有数据”。  
它靠握手信号工作：

- `TVALID`：发送方说“我这拍有货”
- `TREADY`：接收方说“我这拍接得住”
- 两者同时为 1 才真正传输

### 握手时序图

```mermaid
sequenceDiagram
    participant P as Producer生产者
    participant K as Kernel
    participant C as Consumer消费者

    P->>K: TVALID=1, TDATA=D0
    K-->>P: TREADY=1
    K->>C: TVALID=1, TDATA=F(D0)
    C-->>K: TREADY=1
    P->>K: TVALID=1, TDATA=D1, TLAST=1
    K->>C: TVALID=1, TDATA=F(D1), TLAST=1
```

`TLAST` 可以理解成“这一包的最后一件货”，常见于视频帧、网络包结尾。  
这正是 `using_axi_stream_with_side_channel` 在讲的点。

### 背压（back-pressure）直观图

**背压**就是下游太慢时，反过来让上游“先别发”。

```mermaid
graph TD
    S[上游源] --> F1[FIFO缓冲]
    F1 --> K[Kernel]
    K --> F2[FIFO缓冲]
    F2 --> D[下游]
    D -.忙/变慢.-> F2
    F2 -.满了.-> K
    K -.暂停输出.-> F1
    F1 -.接近满.-> S
```

你可以把它想成地铁站限流：后面站台满了，前面闸机会暂时关小，避免系统崩掉。

---

## 3.6 接口选择如何改变性能（最实用）

```mermaid
classDiagram
    class Workload{
      数据规模
      连续性
      实时性
    }
    class Choice{
      s_axilite
      m_axi
      axis
    }
    class Result{
      吞吐量(每秒处理量)
      延迟(响应时间)
      资源(LUT/BRAM)
    }
    Workload --> Choice : 决定接口
    Choice --> Result : 决定性能形状
```

一句话：**接口不是“语法偏好”，而是性能开关**。

- 控制参数：`s_axilite`
- 大数组进出 DDR：`m_axi`
- 连续实时数据：`axis`

### 快速决策流程

```mermaid
flowchart TD
    A[你的数据是什么?] --> B{标量控制参数?}
    B -->|是| C[用s_axilite]
    B -->|否| D{需要按地址访问外部内存?}
    D -->|是| E[用m_axi]
    D -->|否| F{连续实时流?}
    F -->|是| G[用axis]
    F -->|否| H[混合接口: m_axi + axis + s_axilite]
```

实际项目里最常见是 **混合接口**：  
`s_axilite` 负责“控制台”，`m_axi` 负责“仓库”，`axis` 负责“传送带”。

---

## 3.7 对照仓库示例：这章该先跑哪些目录

```mermaid
graph TD
    I1[using_axi_lite] --> G1[学控制寄存器]
    I2[using_axi_master] --> G2[学m_axi基础]
    I3[manual_burst_inference_success/failure] --> G3[学burst成败]
    I4[using_axi_stream_no_side_channel] --> G4[学基础stream]
    I5[using_axi_stream_with_side_channel] --> G5[学TLAST/TKEEP]
    I6[axi_stream_to_master] --> G6[学流-内存桥接]
```

建议你按图顺序跑。  
这像先学“方向盘”，再学“高速超车”，最后学“拖挂车倒库”。

---

## 本章小结（你现在应该掌握）

1. `kernel` 边界有三条主路：控制、内存、流。  
2. `s_axilite` 管“小而关键”的控制信号。  
3. `m_axi` 管“大批量、有地址”的数据，`burst` 决定带宽上限。  
4. `axis` 管“连续实时”数据，握手和背压决定是否稳定满速。  
5. 接口选择直接塑造吞吐量、延迟和资源占用。

下一章我们进内核内部，看“同样的数据，怎么在硬件里并行处理”。