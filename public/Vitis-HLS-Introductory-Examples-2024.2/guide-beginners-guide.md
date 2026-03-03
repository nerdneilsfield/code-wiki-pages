# Vitis HLS 入门指南

欢迎来到 **Vitis HLS 入门指南**！本指南专为以下读者量身打造：有一定 C/C++ 编程基础、对 FPGA 感到好奇，却对高层次综合（HLS）工具链感到陌生的软件工程师、学生或硬件爱好者。无论你是第一次听说"把 C++ 编译成电路"，还是已经零散接触过 HLS 但始终缺乏系统认知，这里都是你的起点。

在接下来的六个章节中，你将从"HLS 是什么、为什么存在"出发，逐步掌握如何组织工程、如何编写能高效映射到硬件的 C/C++ 代码、如何选择正确的接口协议、如何利用并行化手段压榨性能，最终学会在不同工具流之间平稳迁移。每一章都以 `Vitis-HLS-Introductory-Examples` 代码库中的真实示例作为锚点，让抽象的概念有据可查、有代码可跑。

---

## 章节路线图

```mermaid
flowchart LR
    A["🧭 第一章\nVitis HLS 是什么？"]
    B["🗺️ 第二章\n项目结构与心智模型"]
    C["✍️ 第三章\nC/C++ 硬件编码模式"]
    D["🔌 第四章\n接口设计"]
    E["⚡ 第五章\n并行化与优化"]
    F["🔧 第六章\n工具链迁移与工作流"]

    A --> B --> C --> D --> E --> F
```

---

## 章节目录

### 第一章：[Vitis HLS 是什么，为什么存在？](guide-beginners-guide-what-is-vitis-hls.md)

了解什么是高层次综合（HLS），它为 FPGA 开发带来了哪些革命性变化，以及本示例库如何充当"罗塞塔石碑"，帮助你将软件思维翻译成硬件逻辑。一切旅程的起点，先问"为什么"。

---

### 第二章：[项目结构与心智模型：代码库导览](guide-beginners-guide-project-structure-and-mental-model.md)

掌握本项目"一个目录即一个示例"的扁平化结构，弄清楚每个顶层模块的职责，从此在代码库中穿行不再迷路。在动手写代码之前，先在脑海里画好地图。

---

### 第三章：[编写能编译成硬件的 C/C++：核心编码模式](guide-beginners-guide-software-to-hardware-coding-patterns.md)

发现指针、结构体、模板、定点数类型等熟悉的软件构件，在 HLS 中必须以不同方式书写才能生成高效的 FPGA 电路。以 `coding_modeling` 示例为食谱，让你的代码"硬件友好"。

---

### 第四章：[将内核连接到外部世界：接口设计](guide-beginners-guide-interface-design-bridging-software-and-hardware.md)

学习 HLS 如何将 C/C++ 函数参数映射到实际的 FPGA 物理协议（AXI4-Full、AXI4-Stream、AXI4-Lite），以及为什么选错接口会直接扼杀系统性能。接口选对了，才算真正打通了软硬件的任督二脉。

---

### 第五章：[让它跑得更快：并行化与优化技术](guide-beginners-guide-parallelism-and-optimization.md)

探索硬件并行的四个维度——流水线、数据流、数组分区与任务级并行，并学习如何通过 HLS pragma 引导编译器生成高吞吐量的 RTL 电路。性能不是碰运气，而是有章可循的设计决策。

---

### 第六章：[在工具链变迁中存活：HLS 流程迁移指南](guide-beginners-guide-toolchain-migration-and-workflow.md)

理解同一份 HLS 设计如何分别用 TCL 脚本、INI 配置文件或 Python 驱动流来表达，并学会在不重写核心代码的前提下，将已有项目平稳迁移到 Vitis Unified 统一平台。工具在变，知识可以不变。