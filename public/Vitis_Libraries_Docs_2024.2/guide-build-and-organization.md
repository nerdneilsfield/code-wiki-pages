# Vitis_Libraries 构建与代码组织分析

> **目标读者**：希望理解项目构建方式、源码树组织结构及依赖管理的开发者。

---

## 1. 项目目录结构

Vitis_Libraries 是一个由 AMD/Xilinx 维护的**超大型多库单仓（Monorepo）**，按照**功能领域**进行顶层划分，每个子库（domain library）再按照**硬件抽象层级（L1/L2/L3）**进行内部划分。

### 1.1 顶层目录职责图

```mermaid
graph TD
    Root["Vitis_Libraries/"]

    Root --> blas["blas/\n线性代数加速库\nBLAS Level 1/2/3"]
    Root --> codec["codec/\n图像编解码加速\nJPEG/WebP/JXL/Lepton"]
    Root --> data_analytics["data_analytics/\n数据分析加速\n正则/GeoSpatial/ML"]
    Root --> data_compression["data_compression/\n数据压缩加速\nGzip/Zlib/LZ4/Snappy"]
    Root --> data_mover["data_mover/\n数据搬运原语\nDMA/Stream 工具"]
    Root --> database["database/\n数据库查询加速\nGQE/Hash Join/Sort"]
    Root --> dsp["dsp/\n数字信号处理\nFIR/FFT/DFT"]
    Root --> graph["graph/\n图计算加速\nPageRank/BFS/Louvain"]
    Root --> hpc["hpc/\n高性能计算\n迭代求解器"]
    Root --> motor_control["motor_control/\n电机控制算法"]
    Root --> quantitative_finance["quantitative_finance/\n量化金融\nMonte Carlo/树模型"]
    Root --> security["security/\n安全加密\nAES/SHA/RC4"]
    Root --> solver["solver/\n数值求解器\nSVD/线性方程组"]
    Root --> sparse["sparse/\n稀疏矩阵运算\nSpMV"]
    Root --> ultrasound["ultrasound/\n超声成像算法"]
    Root --> utils["utils/\n通用工具原语\n跨库复用"]
    Root --> vision["vision/\n计算机视觉\nOpenCV HLS 加速"]

    Root --> RootFiles["根级元文件\nJenkinsfile\ndependency.json\nREADME.md\nLICENSE.txt"]
```

### 1.2 单个子库的内部分层结构

每个领域库都遵循统一的 **L1 → L2 → L3** 三层抽象架构：

```mermaid
graph TD
    LibRoot["<library>/"]

    LibRoot --> L1["L1/ — HLS 原语层\n纯 HLS C++ 模板函数\n头文件库，不依赖 OpenCL\n可用于 HLS/Vitis HLS 综合"]
    LibRoot --> L2["L2/ — RTL 内核层\n将 L1 原语封装为 OpenCL Kernel\n包含 .cfg 连接脚本\n可生成 .xclbin FPGA 比特流"]
    LibRoot --> L3["L3/ — 主机软件层\n面向应用的 C++/Python API\n依赖 XRT/OpenCL 运行时\n管理 Host-Device 数据传输"]
    LibRoot --> docs["docs/ — 文档系统\nDoxygen 配置\nSphinx RST 文档"]
    LibRoot --> ext["ext/ — 本地外部依赖\nxcl2/ — OpenCL 封装\nmake_utility/ — 公共 Makefile\n第三方库（Arrow/Oniguruma等）"]
    LibRoot --> meta["meta/ — 元数据配置\nJSON 描述文件\n用于 Vitis IDE 集成"]
    LibRoot --> Jenkinsfile["Jenkinsfile\nCI/CD 流水线定义"]
    LibRoot --> library_json["library.json\n库元数据描述"]

    L1 --> L1_inc["include/ — HLS 模板头文件"]
    L1 --> L1_tests["tests/ — HLS 仿真测试"]
    L2 --> L2_inc["include/ — Kernel 头文件"]
    L2 --> L2_src["src/ — Kernel 源文件(.cpp)"]
    L2 --> L2_tests["tests/ — 含 Makefile 的测试用例"]
    L3 --> L3_inc["include/ — Host API 头文件"]
    L3 --> L3_src["src/ — Host 实现(.cpp)"]
    L3 --> L3_tests["tests/ — 端到端测试"]
```

---

## 2. 构建与编译流水线

Vitis_Libraries 涉及两条完全不同的编译路径：**FPGA 硬件综合路径**和**主机软件编译路径**，两者最终通过 XRT 运行时对接。

### 2.1 完整编译流水线（从源码到可运行产物）

```mermaid
flowchart TD
    subgraph Sources["源代码层"]
        HLS_HDR["L1/include/\n*.hpp HLS 模板头文件"]
        KERNEL_SRC["L2/src/\n*.cpp OpenCL Kernel 源码"]
        HOST_SRC["L3/src/\n*.cpp Host 应用源码"]
        CFG["L2/tests/*/\n*.cfg 连接配置\n*.ini 仿真配置"]
    end

    subgraph FPGAPath["FPGA 综合路径（Vitis 工具链）"]
        direction TB
        HLS["Vitis HLS\n高层次综合\nHLS C++ → RTL（VHDL/Verilog）"]
        Synthesis["Vivado 逻辑综合\nRTL → 门级网表"]
        Impl["Vivado 布局布线\n网表 → 比特流"]
        XCLBIN["*.xclbin\nFPGA 可执行二进制\n包含 PR 分区信息"]
    end

    subgraph HostPath["主机编译路径（GCC/G++ 工具链）"]
        direction TB
        XCPP["xcl2.cpp\nOpenCL 封装层编译"]
        HOST_OBJ["*.o 目标文件\ng++ -std=c++17 编译"]
        HOST_BIN["主机可执行文件\n./app.exe 或 ./test.exe"]
    end

    subgraph Runtime["运行时"]
        XRT["Xilinx Runtime (XRT)\nOpenCL 1.2 兼容层"]
        PLATFORM["目标平台\n如 U50/U200/U250/U280\n或 VCK190（Versal AIE）"]
    end

    subgraph Artifacts["最终产物"]
        RESULT["可运行的异构应用\nHost Binary + .xclbin"]
    end

    HLS_HDR --> HLS
    KERNEL_SRC --> HLS
    CFG --> HLS
    HLS --> Synthesis
    Synthesis --> Impl
    Impl --> XCLBIN

    HOST_SRC --> HOST_OBJ
    XCPP --> HOST_OBJ
    HOST_OBJ --> HOST_BIN

    XCLBIN --> Runtime
    HOST_BIN --> Runtime
    XRT --> PLATFORM
    Runtime --> RESULT
```

### 2.2 Makefile 目标体系

每个 L2/L3 测试用例目录下都包含一个 `Makefile`，其目标体系如下：

```mermaid
flowchart LR
    subgraph MakeTargets["Makefile 核心目标"]
        direction TB
        SW_EMU["make run TARGET=sw_emu\n软件仿真\n最快，验证功能正确性\n无需 FPGA"]
        HW_EMU["make run TARGET=hw_emu\n硬件仿真\n验证时序，速度较慢\n需要 PLATFORM 参数"]
        HW["make all TARGET=hw\n真实硬件编译\n数小时，生成 .xclbin\n部署到 Alveo 卡"]
        CLEAN["make clean\n清理中间产物"]
        CHECK["make check\n功能验证对比"]
    end

    SW_EMU -->|"通过后"| HW_EMU
    HW_EMU -->|"通过后"| HW
```

### 2.3 典型 Makefile 变量与编译标志

```makefile
# 通用编译变量（以 data_compression 为例）
PLATFORM      ?= xilinx_u50_gen3x16_xdma_201920_3   # 目标 Alveo 平台
TARGET        ?= sw_emu                               # 编译目标类型
VPP_FLAGS     += --config <lib>.cfg                   # Vitis++ 连接配置
CXXFLAGS      += -std=c++17 -O3                       # Host 编译标准
CXXFLAGS      += -I$(XILINX_XRT)/include              # XRT 头文件路径
CXXFLAGS      += -I$(XILINX_VIVADO)/include           # Vivado HLS 头文件
LDFLAGS       += -lOpenCL -lpthread -lrt              # 链接库
LDFLAGS       += -L$(XILINX_XRT)/lib -lxilinxopencl  # XRT 运行时库
```

---

## 3. 依赖管理

### 3.1 依赖层次总览

```mermaid
graph TD
    subgraph Xilinx_Tools["Xilinx/AMD 工具链（外部环境）"]
        VITIS["Vitis™ IDE\n综合/仿真/分析"]
        VIVADO["Vivado™\n逻辑综合/布局布线"]
        XRT["XRT - Xilinx Runtime\nOpenCL 驱动/用户态库"]
        HLS_LIB["Vitis HLS 标准库\nhls_stream / ap_int / ap_fixed"]
    end

    subgraph Ext_Local["本地外部依赖（ext/ 目录内联）"]
        xcl2["xcl2/\nOpenCL 封装工具\n共 8 个子库共用"]
        make_util["make_utility/\n公共 Makefile 片段\n跨库复用"]
        Arrow["ext/arrow/\nApache Arrow CSV 解析\n(data_analytics 专用)"]
        Onig["ext/oniguruma/\n正则引擎库\n(data_analytics 专用)"]
        Swig["ext/swig/\nPython 绑定生成\n(data_analytics 专用)"]
        QuantLib["ext/quantlib/\n量化金融算法库\n(quantitative_finance 专用)"]
        dcmt["ext/dcmt/\n随机数生成\n(quantitative_finance 专用)"]
        ssb_dbgen["ext/ssb_dbgen/\nSSB 基准测试数据生成\n(database 专用)"]
        MatrixGen["ext/MatrixGen/\n矩阵测试数据生成\n(solver 专用)"]
    end

    subgraph Python_Deps["Python 依赖（blas/）"]
        ENV_YML["environment.yml\nConda 环境定义\n（版本锁定）"]
        REQ_TXT["requirements.txt\npip 依赖列表"]
    end

    subgraph LibDeps["库间依赖"]
        UTILS["utils/ 库\n被其他所有库引用"]
        DATA_MOVER["data_mover/\n被 graph/hpc 引用"]
    end

    VITIS --> XRT
    VITIS --> VIVADO
    XRT --> xcl2
    xcl2 --> make_util

    Xilinx_Tools --> Ext_Local
    Ext_Local --> LibDeps
    Python_Deps --> LibDeps
```

### 3.2 依赖版本锁定策略

| 依赖类型 | 锁定机制 | 文件位置 | 说明 |
|---------|---------|---------|------|
| Vitis 工具链 | README/Jenkinsfile 硬编码版本号 | 各库 `README.md` | 例如 `Vitis: 2022.1` |
| FPGA Shell（平台） | Makefile `PLATFORM` 变量 | `Makefile` | 例如 `u50_gen3x16_xdma` |
| Python 环境 | Conda environment.yml | `blas/environment.yml` | 包含精确版本约束 |
| Python pip | requirements.txt | `blas/requirements.txt` | 固定版本号 |
| 第三方 C++ 库 | Git Submodule 或本地复制 | `ext/` 目录 | 以 xcl2、Arrow 等为代表 |
| 根级元数据 | dependency.json | `Vitis_Libraries/dependency.json` | 声明跨库依赖关系 |

### 3.3 `ext/xcl2` 的特殊地位

`xcl2` 是被**最多子库共用**的内部依赖（codec、data_analytics、data_compression、database、dsp、graph、quantitative_finance、security、solver、utils、vision 等均内联了一份），其功能是对原始 OpenCL C API 进行 C++ RAII 封装，简化：

- `cl::Context` / `cl::CommandQueue` 的创建
- `.xclbin` 文件的加载与 `cl::Program` 的构建
- OpenCL Buffer 的对齐分配（4096 字节对齐，支持 DMA 零拷贝）

---

## 4. 多语言协作

Vitis_Libraries 是一个典型的**多语言异构系统**，不同层次使用不同语言，通过明确的 ABI 边界协作。

### 4.1 语言分工架构图

```mermaid
graph TD
    subgraph FPGA_Device["FPGA 设备端（综合时编译）"]
        HLS_CPP["HLS C++ (C++14)\nL1 原语模板库\n使用 ap_int/ap_fixed/hls_stream\n综合为 RTL 逻辑"]
        RTL["RTL (Verilog/VHDL)\nVivado 自动生成\n无需手写"]
    end

    subgraph Host_SW["主机软件端（GCC 编译）"]
        HOST_CPP["Host C++ (C++17)\nL2/L3 应用层\n使用 OpenCL/XRT API\n管理 Host-Device 通信"]
        PYTHON["Python 3\nblas/L3 Python API\n通过 SWIG 绑定调用 C++\n用于快速原型验证"]
        TCL["Tcl 脚本\n如 vision/ext/xf_rtl_utils.tcl\n用于 Vivado 约束和自动化"]
        MAKE["GNU Makefile\n构建系统\n调用 v++ 和 g++"]
    end

    subgraph Scripts["辅助脚本层"]
        PY_SCRIPT["Python 脚本\n如 dsp/scripts/instance_generator.py\n代码生成（参数化实例）"]
        SHELL["Shell 脚本\n如 data_compression/common/run_all.sh\n批量测试自动化"]
        JENKINS["Groovy (Jenkinsfile)\nCI/CD 流水线定义"]
    end

    HLS_CPP -->|"v++ --compile 综合"| RTL
    RTL -->|"v++ --link 封装"| XCLBIN["*.xclbin"]

    HOST_CPP -->|"OpenCL clEnqueue*"| XCLBIN
    PYTHON -->|"SWIG 自动生成的\n*.py 包装模块"| HOST_CPP
    TCL -->|"source 到 Vivado"| RTL
    MAKE -->|"调用"| HOST_CPP
    MAKE -->|"调用 v++"| HLS_CPP
    PY_SCRIPT -->|"生成 .cpp/.hpp"| HOST_CPP
```

### 4.2 HLS C++ 与 Host C++ 的协作边界

| 维度 | HLS C++（设备端） | Host C++（主机端） |
|------|-----------------|-----------------|
| 编译器 | `vitis_hls` / `v++` | `g++ -std=c++17` |
| C++ 标准 | C++14 | C++17 |
| 头文件路径 | `$(XILINX_VIVADO)/include` | `$(XILINX_XRT)/include` |
| 内存模型 | FPGA 片上 BRAM / HBM | DDR4 主机内存 |
| 通信方式 | AXI4-Stream / AXI4-MM | OpenCL Buffer / DMA |
| 典型数据类型 | `ap_uint<N>`, `hls::stream<T>` | `cl::Buffer`, `std::vector<T>` |

### 4.3 Python 与 C++ 协作（blas 库）

```mermaid
sequenceDiagram
    participant User as Python 用户代码
    participant SWIG as SWIG 生成的 .py 模块
    participant CPP as L3 C++ 库 (.so)
    participant XRT as XRT 运行时
    participant FPGA as FPGA 设备

    User->>SWIG: import xf_blas; xf_blas.gemm(A, B)
    SWIG->>CPP: 调用 C++ 封装函数
    CPP->>XRT: clCreateBuffer / clEnqueueMigrateMemObjects
    XRT->>FPGA: DMA 数据传输
    FPGA-->>XRT: 计算完成中断
    XRT-->>CPP: clEnqueueReadBuffer
    CPP-->>SWIG: 返回结果指针
    SWIG-->>User: 转换为 numpy array 返回
```

---

## 5. 开发工作流

### 5.1 标准开发流程

```mermaid
flowchart TD
    Start(["开始开发"])

    Start --> Step1["1. 环境准备\nsource /opt/xilinx/xrt/setup.sh\nsource /opt/Xilinx/Vitis/2022.1/settings64.sh\nexport PLATFORM_REPO_PATHS=/path/to/platforms"]

    Step1 --> Step2["2. 选择目标库和测试用例\ncd <library>/L2/tests/<testcase>"]

    Step2 --> Step3{"开发阶段"}

    Step3 -->|"功能开发"| SW_EMU["3a. 软件仿真（最快迭代）\nmake run TARGET=sw_emu\n  PLATFORM=\$PLATFORM_PATH\n耗时：数分钟"]

    Step3 -->|"时序验证"| HW_EMU["3b. 硬件仿真（中等速度）\nmake run TARGET=hw_emu\n  PLATFORM=\$PLATFORM_PATH\n耗时：数十分钟"]

    Step3 -->|"部署验证"| HW_BUILD["3c. 真实硬件编译\nmake all TARGET=hw\n  PLATFORM=\$PLATFORM_PATH\n耗时：数小时（Vivado P&R）"]

    SW_EMU --> Check{"功能正确？"}
    HW_EMU --> Check
    HW_BUILD --> Deploy["4. 部署运行\n./app.exe <args>"]

    Check -->|"否"| Fix["修复 HLS 代码\n调整 pragma/约束"]
    Fix --> Step3
    Check -->|"是"| NextLevel["进入下一层验证"]

    Deploy --> Docs["5. 生成文档\ncd <library>/docs\nmake html  # Sphinx 文档\nmake doxygen  # API 参考文档"]
```

### 5.2 常用开发命令速查

#### 环境配置

```bash
# 设置 Xilinx 工具链环境
source /opt/xilinx/xrt/setup.sh
source /opt/Xilinx/Vitis/2022.1/settings64.sh

# 设置平台路径
export PLATFORM_REPO_PATHS=/opt/xilinx/platforms
export PLATFORM=xilinx_u50_gen3x16_xdma_201920_3

# Python 环境（blas 库）
conda env create -f blas/environment.yml
conda activate xf_blas
pip install -r blas/requirements.txt
```

#### 构建与仿真

```bash
# ============================================================
# 软件仿真（验证功能，无需 FPGA，数分钟内完成）
# ============================================================
cd data_compression/L2/tests/lz4_compress
make run TARGET=sw_emu PLATFORM=$PLATFORM

# ============================================================
# 硬件仿真（验证时序行为，需要 XSim，数十分钟）
# ============================================================
make run TARGET=hw_emu PLATFORM=$PLATFORM

# ============================================================
# 真实硬件编译（生成 .xclbin，需数小时）
# ============================================================
make all TARGET=hw PLATFORM=$PLATFORM
# 运行：
./app.exe -xclbin <testcase>.xclbin <input_file>

# ============================================================
# data_compression L3 示例：Zlib SO Demo
# ============================================================
cd data_compression/L3/demos/libzso
source scripts/setup.csh
make run TARGET=sw_emu PLATFORM=$PLATFORM    # 仿真
make all TARGET=hw PLATFORM=$PLATFORM        # 硬件
./xzlib input_file           # 压缩
./xzlib -d input_file.zlib   # 解压
./xzlib -t input_file        # 测试流程
./xzlib -t input_file -n 0   # 不用加速（纯软件）
```

#### 测试与验证

```bash
# 运行特定测试用例的功能验证
make check TARGET=sw_emu PLATFORM=$PLATFORM

# 批量运行所有测试（data_compression 示例）
cd data_compression/common
./run_all.sh

# DSP 库：生成参数化实例（Python 代码生成器）
cd dsp
python3 scripts/instance_generator.py \
    --kernel fir_decimate_asym \
    --params config.json

# 数据移动器：生成实例
cd data_mover
python3 scripts/instance_generator.py
```

#### 文档构建

```bash
# 构建 Sphinx HTML 文档
cd <library>/docs
make html -f Makefile.sphinx

# 构建 Doxygen API 参考
cd <library>/docs
doxygen Doxyfile_L1   # L1 层 API
doxygen Doxyfile_L2   # L2 层 API
doxygen Doxyfile_L3   # L3 层 API（若存在）

# 完整文档（Sphinx + Doxygen 联合）
make all -f Makefile.sphinx
```

#### 清理构建产物

```bash
# 清理单个测试用例
make clean

# 清理特定目标的产物
make cleanall TARGET=hw_emu

# 清理整个库的所有产物（谨慎操作）
find <library>/ -name "_x" -type d | xargs rm -rf
find <library>/ -name "*.xclbin" | xargs rm -f
find <library>/ -name "*.xo" | xargs rm -f
```

### 5.3 开发注意事项速查

```mermaid
graph LR
    subgraph Pitfalls["常见陷阱"]
        P1["⚠️ OpenCL 事件链\n必须等待 clWaitForEvents\n再读取 Device → Host 结果"]
        P2["⚠️ 内存对齐\nHost Buffer 必须 4096 字节对齐\n支持 DMA 零拷贝"]
        P3["⚠️ FPGA 异步执行\nenqueueMigrateMemObjects 不阻塞\n必须显式 q.finish()"]
        P4["⚠️ HLS 模板实例化\n每种参数组合单独综合\n避免不必要的参数变化"]
        P5["⚠️ sw_emu 与 hw 行为差异\n浮点精度/定点截断\n硬件验证不可省略"]
    end

    subgraph BestPractices["最佳实践"]
        B1["✅ 使用 xcl2 封装\n避免裸写 OpenCL API"]
        B2["✅ 从 sw_emu 开始\n逐步向 hw_emu 和 hw 推进"]
        B3["✅ 使用 RAII 管理资源\nxcl2::aligned_allocator<T>"]
        B4["✅ 参考 L1 tests 验证原语\n再集成到 L2 Kernel"]
        B5["✅ 检查 library.json\n了解库的元数据和配置约束"]
    end
```

---

## 附录：关键文件角色速查

| 文件/目录 | 作用 |
|----------|------|
| `<lib>/library.json` | Vitis IDE 集成元数据，描述库能力、目标平台、版本 |
| `Vitis_Libraries/dependency.json` | 根级跨库依赖声明 |
| `<lib>/ext/xcl2/` | OpenCL C++ 封装（RAII），所有 Host 代码的基础设施 |
| `<lib>/ext/make_utility/` | 公共 Makefile 片段，`include` 到各测试用例的 Makefile |
| `<lib>/L*/meta/*.json` | 参数约束元数据，用于 Vitis IDE 的参数化配置向导 |
| `<lib>/docs/Makefile.sphinx` | Sphinx 文档构建入口 |
| `<lib>/Jenkinsfile` | Jenkins CI 流水线，定义自动化测试矩阵 |
| `blas/environment.yml` | Conda 环境定义，Python 依赖版本锁定 |