# 正则表达式编译核心模块 (L1)

## 一句话概述

`regex_compilation_core_l1` 是一个**将高级正则表达式模式编译为硬件可执行指令流的交叉编译器**。它位于软件层与硬件加速层之间的关键边界，将人类可读的 Regex 模式转化为 FPGA 可并行执行的 64 位定长指令序列。

想象你正在为一台专用的"正则表达式虚拟机"编写汇编器——这台机器没有通用 CPU 的复杂控制流，但拥有高度优化的字符匹配和状态跳转单元。你的任务是把 `a(b|c)+` 这样的模式翻译成这台机器能理解的机器码。

---

## 问题空间：我们解决了什么？

### 硬件加速的正则匹配困境

在数据分析和日志处理场景中，正则表达式匹配通常是 CPU 密集型的瓶颈。FPGA 加速可以并行处理多个匹配状态，但存在**语义鸿沟**：

1. **复杂的 Regex 语义**：捕获组、贪婪/惰性量词、字符类、前瞻断言等高级特性
2. **硬件资源限制**：FPGA 逻辑单元偏好定长、规整的数据流，不喜欢复杂的指针追逐或递归
3. **实时性要求**：编译时耗必须可控，不能为了优化而牺牲启动延迟

### 为什么不用现成的方案？

- **PCRE/RE2**：纯软件实现，无法直接生成 FPGA 指令
- **Hand-written FSM**：对复杂模式（如嵌套捕获组）维护成本极高，容易出错
- **HLS 直接综合**：将 C++ Regex 库直接综合为硬件会导致面积爆炸和时序违例

### 我们的方案：站在巨人肩膀上的编译器

我们选择 **Oniguruma** 作为前端解析器——这是一个久经考验的正则表达式引擎，支持复杂的 Perl 风格正则语法。但关键创新在于**后端**：我们将 Oniguruma 生成的中间字节码，通过二次编译转换为面向硬件优化的定长指令序列。

这种设计让我们获得了：**软件层的语法丰富性** + **硬件层的执行效率**。

---

## 核心抽象：心智模型

### 类比：从高级语言到专用处理器的编译流程

想象你在为一款专用 DSP（数字信号处理器）开发 C 语言编译器：

```
C 源代码 
   ↓ [Clang 前端：解析语法，生成 LLVM IR]
LLVM 中间表示 
   ↓ [后端优化：指令选择，寄存器分配]
DSP 机器码
```

`regex_compilation_core_l1` 扮演的角色类似，但针对的是正则表达式领域：

```
Regex 模式 (如 "a(b+)c") 
   ↓ [Oniguruma 前端：解析语法，生成字节码]
Oniguruma 操作码序列 (OP_STR_N, OP_JUMP...)
   ↓ [我们的编译器后端：指令选择，地址重定位]
xf_instruction 数组 (64位定长指令)
```

### 三大核心数据结构

#### 1. `xf_instruction` —— 硬件的"母语"

这是硬件直接执行的机器指令格式。关键设计决策是**定长 64 位**：

```c
typedef struct {
    union {
        struct {
            uint16_t oprand_2;  // 第3操作数
            uint16_t oprand_1;  // 第2操作数  
            uint16_t oprand_0;  // 第1操作数
            uint8_t  mode_len;  // 模式(4位) + 长度(4位)
            uint8_t  opcode;    // 操作码
        } inst_format;
        uint64_t d;  // 整体作为64位数据
    };
} xf_instruction;
```

**为什么选择这种布局？**
- **硬件友好**：64 位对齐，单周期读取，无需复杂的字节对齐逻辑
- **解码简单**：固定字段偏移，硬件可以用简单的位移操作提取操作数
- **密度适中**：相比变长指令，可能浪费一些空间，但换取了硬件实现的简洁性

#### 2. `dyn_buff` —— 编译期的"临时仓库"

这是一个简单的动态数组实现，用于在编译过程中收集需要二次处理的信息（如跳转地址）：

```c
typedef struct {
    unsigned int* data;
    unsigned int  size;
    unsigned int  count;
} dyn_buff;
```

**为什么不用标准 C 库？**
- 这是 L1 层代码，可能运行在资源受限的环境中（如嵌入式或内核态）
- 避免引入 `stdlib.h` 以外的依赖，保持代码的可移植性
- 简单的自定义实现更容易控制内存布局和对齐

#### 3. Oniguruma 内部结构 —— 我们依赖但封装的"黑盒"

`regex_t`、`Operation`、`NameEntry` 等类型来自 Oniguruma。我们的编译器读取这些结构，但遵循**只读原则**：

- 我们调用 `onig_new()` 进行解析
- 遍历 `reg->ops` 数组读取字节码
- 查询 `reg->name_table` 获取捕获组名称
- 最后调用 `onig_free()` 释放资源

**关键边界约定**：Oniguruma 的复杂内部表示不会泄漏到我们的输出中——我们只提取编译为 `xf_instruction` 所需的最小信息集。

---

## 数据流全景：从模式到机器码

让我们追踪一个具体的正则表达式 `"a(b+)+c"` 是如何被编译为硬件指令的：

### 阶段 1：解析与中间表示生成（Oniguruma 负责）

```
输入: "a(b+)+c"
       ↓
Oniguruma 解析器
       ↓
Operation 数组 (字节码):
  [0] OP_STR_N: "a"        // 匹配字符 'a'
  [1] OP_MEM_START: 1      // 开始捕获组 1
  [2] OP_STR_N: "b"        // 匹配字符 'b'  
  [3] OP_REPEAT: {2, 8, INF} // 重复前面的模式 (b+), 跳转到地址 8
  [4] ...
  [8] OP_MEM_END: 1        // 结束捕获组 1
  [9] OP_REPEAT: {10, ...}  // 重复整个 (b+)+ 组
  ...
  [N] OP_END               // 匹配结束
```

### 阶段 2：预处理与地址计算（我们的编译器，第一趟扫描）

Oniguruma 的字节码使用**相对跳转地址**（相对于当前指令的偏移），但硬件更喜欢**绝对地址**（相对于指令序列起点的偏移）。此外，长字符串需要拆分为多条指令。

```
第一趟扫描 (bp 遍历 Operation 数组):
  
  当遇到 OP_JUMP/OP_PUSH/OP_REPEAT 等跳转指令时:
    - 计算目标绝对地址 = 当前位置 + 跳转偏移
    - 存入 abs_add_tb 缓冲区
    
  当遇到 OP_STR_N 且字符串长度 > 4 时:
    - 计算需要的额外指令数 = ceil((len - 4) / 4)
    - 存入 str_n_addr_tb 和 str_n_len_tb
    
  例: OP_STR_N 长度为 10 的字符串:
    - 需要 3 条指令 (4+4+2 字节)
    - str_n_addr_tb 记录位置
    - str_n_len_tb 记录额外 2 条指令
```

### 阶段 3：地址重定位（处理插入带来的偏移）

当我们将长字符串拆分为多条指令时，**后续指令的地址会发生变化**（因为插入了额外的指令）。需要调整之前计算的绝对跳转地址：

```
地址修正循环:
  for 每个绝对地址 abs_add_tb[i]:
    rel_add = 0
    for 每个字符串拆分点 str_n_addr_tb[j]:
      if abs_add_tb[i] > str_n_addr_tb[j]:
        rel_add += str_n_len_tb[j]  // 累加插入的指令数
    abs_add_tb[i] += rel_add  // 修正后的绝对地址
```

### 阶段 4：指令编码（第二趟扫描，生成最终机器码）

现在我们知道所有地址和字符串的精确布局，可以生成最终的 `xf_instruction` 数组：

```
第二趟扫描 (再次遍历 Operation 数组):
  
  for 每个 Operation bp:
    根据 bp->opcode 生成 xf_instruction:
    
    case OP_STR_N:
      opcode = OP_STR_N
      mode = 0
      len = min(4, remaining_length)
      oprand_1 = (s[0] << 8) | s[1]  // 打包字符数据
      oprand_2 = (s[2] << 8) | s[3]
      
    case OP_JUMP/OP_PUSH:
      opcode = 原始操作码
      mode = (opcode == OP_PUSH) ? 1 : 0  // PUSH 使用预测地址模式
      oprand_1 = abs_add_tb[index++]  // 使用修正后的绝对地址
      
    case OP_CCLASS:
      opcode = OP_CCLASS
      oprand_1 = bitset_index * 8  // 位图在 bitset 数组中的偏移
      // 同时复制 256 位(8x32位)字符类位图到输出 buffer
      
    case OP_MEM_START/OP_MEM_END:
      oprand_1 = capture_group_num * 2 (+ 1 for END)
      
    // ... 其他操作码类似处理
    
    // 打包为 64 位指令
    instr.inst_format.opcode = opcode
    instr.inst_format.mode_len = (mode << 4) | len
    instr.inst_format.oprand_0 = oprand_1
    instr.inst_format.oprand_1 = oprand_2
    instr.inst_format.oprand_2 = oprand_3
    
    instructions[(*instr_num)++] = instr.d
```

### 阶段 5：元数据提取与资源释放

除了指令流，我们还提取硬件执行所需的元数据：

```
元数据提取:
  
  // 1. 捕获组数量
  *cpgp_nm = reg->num_mem
  
  // 2. 捕获组名称 (如果提供 buffer)
  if (cpgp_name_val && cpgp_name_oft) {
    遍历 Oniguruma 的 name_table 哈希表
    提取每个命名捕获组的: 名称字符串、长度、对应的组号
    填充 cpgp_name_val (名称字符数据) 和 cpgp_name_oft (偏移索引)
  }
  
  // 3. 字符类数量
  *cclass_num = 编译过程中遇到的 OP_CCLASS 数量

资源清理:
  onig_free(reg)  // 释放 Oniguruma 的解析状态
  buff_free(&abs_add_tb)  // 释放动态缓冲区
  buff_free(&str_n_addr_tb)
  buff_free(&str_n_len_tb)
```

---

## 架构设计与关键决策

### 为什么采用"两次扫描"架构？

编译过程分为**第一趟（地址收集）**和**第二趟（指令编码）**，这是为了解决正则表达式中常见的**前向引用问题**。

考虑模式 `a(b+)\1`，其中 `\1` 是向后引用，引用第一个捕获组的内容。在硬件指令序列中：
- 跳转指令需要知道目标地址
- 但目标地址可能因为前面插入了额外的字符串处理指令而发生偏移

**类比**：这就像在汇编语言中使用标签（label），然后由链接器计算最终的地址偏移。第一趟扫描记录所有"标签位置"，第二趟解析具体的地址值。

### 为什么选择 Oniguruma 作为前端？

**未被选择的方案**：
- **手写递归下降解析器**：虽然可以生成更精简的中间表示，但维护成本高，容易在边界情况（如 Unicode 属性类）出错
- **PCRE2**：功能强大但体积庞大，且其内部字节码格式经常变化，不利于稳定的硬件映射
- **RE2**：确定性自动机理论优美，但不支持反向引用等高级特性，限制了应用场景

**选择 Oniguruma 的理由**：
1. **成熟稳定**：作为 Ruby 语言的默认正则引擎，经过生产环境多年验证
2. **功能完备**：支持命名捕获组、条件表达式、递归模式等高级特性
3. **内部结构清晰**：`Operation` 数组形式的字节码易于遍历和转换
4. **许可证友好**：BSD 许可证，适合商业和开源项目

### 指令格式设计的权衡

`xf_instruction` 采用 **64 位定长格式**，这代表了在多个维度上的深思熟虑：

**空间效率 vs 解码复杂度**：
- **变长指令**（如 x86）可以节省内存，但硬件解码器需要复杂的解析状态机
- **定长指令**（如 MIPS/ARM）可能浪费一些位，但解码逻辑简单，适合 FPGA 实现

**操作数数量 vs 灵活性**：
- 3 个 16 位操作数 + 1 个 8 位 mode_len 字段 可以覆盖绝大多数 Regex 操作需求
- 对于超长字符串（>4 字节），选择拆分为多条指令而非增加操作数宽度，保持格式统一性

**立即数 vs 间接寻址**：
- 字符串数据直接打包在指令中（`oprand_1`, `oprand_2`），利用 16 位宽度存储字符数据
- 字符类位图则通过偏移量间接引用，因为 256 位位图无法放入 64 位指令

---

## 依赖关系与模块耦合

### 上游依赖（我们依赖谁）

**Oniguruma 库**：
- **耦合程度**：强依赖，但仅使用其解析功能
- **接口边界**：`onig_new()` → `regex_t*` → 遍历 `reg->ops` → `onig_free()`
- **风险点**：Oniguruma 版本升级时，内部 `Operation` 结构体布局可能变化，需要同步更新 opcode 处理逻辑
- **替代成本**：高，需要重写复杂的正则解析逻辑

**标准 C 库**：
- 使用 `malloc`/`realloc`/`free` 进行动态内存管理
- 使用 `memcpy` 进行数据拷贝
- 使用 `memset` 初始化缓冲区
- **注意**：代码中使用了 `<assert.h>`，但在生产构建中可能被禁用

### 下游依赖（谁依赖我们）

**硬件执行引擎（L2/L3 层）**：
- 消费我们生成的 `instructions` 数组
- 使用 `bitset` 数组进行字符类匹配
- 根据 `cpgp_name_oft` 和 `cpgp_name_val` 提取匹配结果中的捕获组名称
- **契约要求**：生成的指令数组必须是连续的 64 位对齐内存，指令数量不超过硬件指令缓存容量

**主机端驱动程序**：
- 调用 `xf_re_compile()` 进行预编译
- 管理 `instructions` 和 `bitset` 缓冲区的生命周期（分配/释放）
- 将编译结果通过 DMA/PCIe 传输到 FPGA 设备

### 同层依赖（同级模块间的协作）

在 `data_analytics` 模块族中，`regex_compilation_core_l1` 与以下模块协同工作：

- [naive_bayes_benchmark_pipeline_l2](data_analytics-text-naive_bayes_benchmark_pipeline_l2.md)：朴素贝叶斯分类器的基准测试流水线
- [duplicate_text_match_demo_l2](data_analytics-text-duplicate_text_match_demo_l2.md)：重复文本匹配演示
- [log_analyzer_demo_acceleration_and_host_runtime_l2](data_analytics-text-log_analyzer_demo_acceleration_and_host_runtime_l2.md)：日志分析器加速与主机运行时

---

## C/C++ 实现细节与工程考量

### 1. 内存所有权模型

**输出缓冲区（调用者所有）**：

```c
extern int xf_re_compile(const char* pattern,
                         unsigned int* bitset,      // 调用者分配
                         uint64_t* instructions,    // 调用者分配
                         unsigned int* instr_num,   // 输出参数
                         unsigned int* cclass_num,  // 输出参数
                         ...);
```

- `bitset` 和 `instructions` 缓冲区由**调用者分配**，调用者负责确定最大容量并管理生命周期
- 函数通过 `instr_num` 和 `cclass_num` 返回实际使用的数量，调用者需确保缓冲区足够大
- **风险**：如果调用者分配的缓冲区过小，函数会写入越界内存（无内建边界检查）

**内部临时缓冲区（编译器所有）**：

```c
dyn_buff abs_add_tb;      // 存储绝对跳转地址
dyn_buff str_n_addr_tb;   // 存储长字符串拆分位置
dyn_buff str_n_len_tb;    // 存储额外指令数量
```

- 使用 `dyn_buff` 动态数组实现，自动扩容（128 为单位增量）
- 内存在 `xf_re_compile()` 内部分配，在函数返回前通过 `buff_free()` 释放
- **所有权明确**：调用者无需关心这些临时缓冲区

**Oniguruma 对象（库所有）**：

```c
regex_t* reg;
r = onig_new(&reg, ...);  // Oniguruma 内部分配
// ... 使用 reg ...
onig_free(reg);            // 显式释放
```

- `regex_t` 对象由 Oniguruma 库分配和管理
- 我们遵循**RAII 原则**：在函数退出前始终调用 `onig_free()`
- **异常安全**：即使编译过程中发生错误，也确保 `onig_free()` 被调用（当前实现中错误时直接返回，需确保调用者后续处理）

### 2. 错误处理策略

**错误码约定**：

```c
#define XF_UNSUPPORTED_OPCODE (-1000)
```

- Oniguruma 的错误码（负值）直接透传给调用者
- 自定义错误码 `XF_UNSUPPORTED_OPCODE` 表示遇到无法翻译的字节码操作

**错误传播路径**：

```c
// 1. Oniguruma 解析错误
r = onig_new(&reg, ...);
if (r != ONIG_NORMAL) {
    return r;  // 直接返回 Oniguruma 错误码
}

// 2. 编译过程中的操作码错误
switch (opcode) {
    // ...
    default:
        r = XF_UNSUPPORTED_OPCODE;  // 设置自定义错误码
        break;
}

// 3. 清理资源后返回
onig_free(reg);
buff_free(&abs_add_tb);
// ...
return r;
```

**设计权衡**：
- **不抛出异常**：纯 C 实现，使用返回码传递错误状态
- **不记录日志**：错误信息通过返回值传递，调用者可选择记录或忽略
- **资源泄漏防护**：错误路径上确保 `onig_free()` 和 `buff_free()` 被调用

### 3. Const 正确性与可变状态

**输入参数（const 修饰）**：

```c
extern int xf_re_compile(const char* pattern,      // 输入字符串
                         unsigned int* bitset,      // 输出缓冲区（内容可变，但指针本身const）
                         uint64_t* instructions,    // 同上
                         // ...
                        );
```

- `pattern` 应该声明为 `const char*`，但当前实现未加 const（遗留问题）
- `bitset` 和 `instructions` 是输出缓冲区，不应用 const 修饰（内容被修改）

**编译器内部状态**：

```c
// 第一趟扫描期间修改状态
dyn_buff abs_add_tb;
init_buff(&abs_add_tb);
// ... 添加地址到 abs_add_tb ...

// 第二趟扫描期间读取状态
for (unsigned int i = 0; i < abs_add_tb.count; ++i) {
    unsigned int addr = buff_get(&abs_add_tb, i);
    // ... 使用 addr ...
}
```

- `abs_add_tb` 在编译期间是可变状态
- 函数返回后，这些临时状态被清理，不对外暴露

### 4. 内存对齐与布局控制

**结构体对齐**：

```c
typedef struct {
    union {
        struct {
            uint16_t oprand_2;  // 偏移 0-1
            uint16_t oprand_1;  // 偏移 2-3
            uint16_t oprand_0;  // 偏移 4-5
            uint8_t  mode_len;  // 偏移 6
            uint8_t  opcode;    // 偏移 7
        } inst_format;          // 总大小: 8 字节 (64位)
        uint64_t d;             // 同上，整体访问
    };
} xf_instruction;
```

- 结构体天然 64 位对齐（最大成员 `uint64_t` 要求 8 字节对齐）
- 无填充字节，所有字段紧凑排列
- 通过 `union` 允许字段级访问和整体 64 位访问两种方式

**缓冲区对齐要求**：

```c
// 调用者分配的缓冲区
unsigned int* bitset;   // 应 4 字节对齐 (uint32_t)
uint64_t* instructions;  // 应 8 字节对齐 (uint64_t)
```

- 未显式检查对齐，假设调用者遵循平台默认对齐
- 在 64 位平台上，`malloc` 通常返回 16 字节对齐的内存，满足要求

### 5. 线程安全与并发考虑

**当前设计**：

```c
extern int xf_re_compile(...);
```

- 无全局状态，所有状态通过参数传递或局部变量维护
- 不依赖线程局部存储（TLS）或全局变量

**线程安全属性**：

- 该函数是**线程安全**的（thread-safe）
- 多个线程可以同时调用 `xf_re_compile()`，只要它们传入不同的输出缓冲区
- 内部使用的 Oniguruma 库需要确认其线程安全性（Oniguruma 通常是线程安全的，只要每个线程使用独立的 `regex_t`）

**并发限制**：

- 无锁（lock-free）设计，不依赖互斥锁
- 无原子操作，纯顺序执行
- 适合在多线程环境中作为"纯函数"使用

---

## 关键设计决策与权衡

### 决策 1：两次扫描 vs 单次扫描+回溯

**背景**：跳转地址依赖于最终指令布局，但指令布局又受字符串拆分影响（长字符串拆分为多条指令会改变后续指令的地址）。

**选择**：采用两次扫描（第一趟收集地址信息，第二趟生成指令）。

**权衡**：
- ✅ **确定性**：地址计算是确定性的，无运行时回溯开销
- ✅ **简单性**：代码逻辑清晰，易于理解和调试
- ❌ **时间开销**：需要两次遍历 Operation 数组，时间复杂度从 O(n) 变为 O(2n)，但在实际中 n 较小（指令数通常 < 1000）

**未被选择的方案**：单次扫描+动态数组扩容+回溯。这种方案试图在发现地址变化时回溯修改已生成的指令，但实现复杂，容易出错。

### 决策 2：定长 64 位指令 vs 变长指令

**背景**：硬件执行引擎需要高效解码指令。

**选择**：定长 64 位指令，每个指令恰好 8 字节。

**权衡**：
- ✅ **解码简单**：硬件可以用固定偏移提取字段，无需解析变长编码
- ✅ **对齐友好**：8 字节自然对齐，单周期读取
- ✅ **流水线友好**：定长指令使分支预测和指令预取更简单
- ❌ **空间效率**：短字符串（如单个字符）也需要完整 64 位，存在空间浪费
- ❌ **扩展性**：如果未来需要更多操作数或更大地址空间，64 位可能不够用

**未被选择的方案**：
- **变长指令（如 x86 风格）**：节省空间，但解码复杂，不适合 FPGA 实现
- **超长指令字（VLIW）**：将多个操作打包到一条指令，提高并行度，但增加编译器复杂性和代码体积

### 决策 3：使用 Oniguruma 作为前端 vs 手写解析器

**背景**：需要支持复杂的正则语法（捕获组、量词、字符类等）。

**选择**：集成 Oniguruma 库作为解析前端。

**权衡**：
- ✅ **功能丰富**：自动获得 Oniguruma 支持的所有正则特性，包括命名捕获组、条件表达式等
- ✅ **稳定性**：Oniguruma 是成熟库，经过广泛测试，边界情况处理完善
- ✅ **维护成本**：无需维护复杂的解析器代码，专注于后端编译逻辑
- ❌ **依赖增加**：项目需要链接 Oniguruma 库，增加构建复杂度
- ❌ **体积增加**：Oniguruma 的代码和数据结构增加了二进制体积
- ❌ **版本耦合**：Oniguruma 版本升级可能导致 API 变化，需要同步修改代码

**未被选择的方案**：
- **手写递归下降解析器**：理论上可以生成更优化的中间表示，但开发和维护成本高，容易出错
- **使用 PCRE**：功能类似 Oniguruma，但许可证（BSD vs PCRE 的 BSD 变体）和 API 风格略有不同
- **使用 RE2**：RE2 使用自动机理论保证线性时间匹配，但不支持反向引用等高级特性，限制了应用场景

---

## 新贡献者必读：陷阱与注意事项

### 1. 内存管理陷阱

**陷阱 1：输出缓冲区溢出**

```c
// 调用者代码
uint64_t instructions[100];  // 假设最多 100 条指令
unsigned int instr_num;

// 如果正则表达式很复杂，生成的指令数可能超过 100
int r = xf_re_compile("(a+b+)*c{100,200}", ..., instructions, &instr_num, ...);
// 如果 instr_num > 100，instructions 缓冲区溢出，未定义行为！
```

**建议**：
- 对于动态模式，先调用一次 `xf_re_compile` 并传入 `NULL` 缓冲区来获取所需的缓冲区大小（当前 API 不支持，需要扩展）
- 或者为 `instructions` 和 `bitset` 分配足够大的缓冲区（如 4096 条指令和 256 个字符类）

**陷阱 2：Oniguruma 错误处理**

```c
int r = onig_new(&reg, ...);
if (r != ONIG_NORMAL) {
    return r;  // 直接返回，但 onig_free(reg) 未调用！
}
```

**注意**：如果 `onig_new` 失败，`reg` 可能是未定义值或 NULL，此时不应调用 `onig_free`。但如果 `onig_new` 部分成功（极少见），可能需要清理。当前代码假设 `onig_new` 要么完全成功，要么完全失败。

### 2. 并发与线程安全

**场景**：在多线程 Web 服务器中，每个线程独立编译用户提交的正则表达式。

```c
// 线程函数
void* thread_compile(void* arg) {
    const char* pattern = (const char*)arg;
    
    uint64_t instructions[256];
    unsigned int bitset[256 * 8];
    unsigned int instr_num, cclass_num, cpgp_nm;
    
    int r = xf_re_compile(pattern, bitset, instructions, &instr_num, 
                          &cclass_num, &cpgp_nm, NULL, NULL);
    // ...
    return NULL;
}
```

**线程安全性**：
- ✅ `xf_re_compile` 本身是线程安全的（无全局状态）
- ⚠️ 但 Oniguruma 的线程安全性需要确认。查阅 Oniguruma 文档，确认在 POSIX 线程环境下是否安全
- ⚠️ 如果多个线程使用相同的 `bitset` 或 `instructions` 缓冲区（不应这样做），会发生数据竞争

**建议**：
- 每个线程使用独立的缓冲区
- 如果需要在多个线程间共享编译结果，应在编译完成后进行，且缓冲区标记为 `const`

### 3. 性能陷阱

**陷阱 1：重复编译相同模式**

```c
// 低效代码
for (const char* line : log_lines) {
    uint64_t instructions[256];
    unsigned int bitset[...];
    xf_re_compile("ERROR|WARN", bitset, instructions, ...);  // 每次循环都重新编译！
    // 使用 instructions 匹配 line
}
```

**优化**：缓存编译结果，相同模式只编译一次。

```c
// 高效代码
static uint64_t instructions[256];
static unsigned int bitset[...];
static bool compiled = false;

if (!compiled) {
    xf_re_compile("ERROR|WARN", bitset, instructions, ...);
    compiled = true;
}

for (const char* line : log_lines) {
    // 使用缓存的 instructions 匹配 line
}
```

**陷阱 2：过大的字符类**

```c
// 如果正则表达式包含大量字符类（如 [a-z], [0-9], [A-Z], ...）
// bitset 缓冲区可能溢出
unsigned int bitset[64];  // 只能容纳 64 个字符类
// 如果模式包含 65 个字符类，bitset 溢出！
```

**建议**：评估应用中字符类的典型数量，为 `bitset` 分配足够的空间（如 256 个字符类）。

### 4. 调试与故障排查

**启用调试输出**：

代码中定义了 `XF_DEBUG` 宏，启用后会输出调试信息：

```c
#ifdef XF_DEBUG
    printf("str_n with length %d more than 4\n", bp->exact_n.n);
#endif
```

编译时添加 `-DXF_DEBUG` 来启用调试输出。

**常见错误码排查**：

| 错误码 | 含义 | 可能原因 |
|--------|------|----------|
| `ONIG_INVALID_ARGUMENT` | 无效参数 | `pattern` 为 NULL 或空字符串 |
| `ONIG_ERROR_MEM` | 内存不足 | 系统内存耗尽 |
| `XF_UNSUPPORTED_OPCODE` | 不支持的操作码 | 正则表达式使用了编译器未实现的高级特性 |

**捕获组名称提取失败排查**：

如果 `cpgp_name_val` 和 `cpgp_name_oft` 为 NULL，编译器会跳过捕获组名称提取。如果需要提取名称，确保两个参数都非 NULL，并且缓冲区足够大。

### 5. API 契约与前置条件

**调用者必须保证**：

1. **非空指针**：`pattern`、`bitset`、`instructions`、`instr_num`、`cclass_num`、`cpgp_nm` 必须是非空指针（除非 `cpgp_name_val` 和 `cpgp_name_oft` 都为 NULL，表示不需要提取捕获组名称）

2. **缓冲区大小**：`bitset` 必须至少能容纳 `(*cclass_num) * 8` 个 `unsigned int`（每个字符类需要 256 位 = 8 x 32 位）；`instructions` 必须足够容纳所有生成的指令（最坏情况下，每个 Oniguruma 操作码可能生成多条指令）

3. **模式有效性**：`pattern` 必须是有效的正则表达式，符合 Oniguruma 支持的语法。如果模式无效，`xf_re_compile` 会返回 Oniguruma 的错误码

4. **内存对齐**：`instructions` 应该 8 字节对齐（`uint64_t` 对齐），`bitset` 应该 4 字节对齐（`unsigned int` 对齐）。在大多数现代系统上，`malloc` 返回的内存满足这些对齐要求

**函数保证**：

1. **输出初始化**：在成功返回时，`*instr_num`、`*cclass_num`、`*cpgp_nm` 会被设置为实际值；`bitset` 和 `instructions` 缓冲区会被填充有效数据

2. **错误时的输出状态**：如果返回非零错误码，`*instr_num`、`*cclass_num`、`*cpgp_nm` 和输出缓冲区的状态是未定义的，调用者不应该依赖这些值

3. **资源清理**：无论成功还是失败，函数内部分配的内存（通过 `dyn_buff`）都会被释放，不会泄漏。Oniguruma 的 `regex_t` 对象也会被释放（通过 `onig_free`）

---

## 总结：给新贡献者的核心要点

### 理解这个模块的 3 个关键视角

1. **它是一个编译器，不是解释器**
   - 输入：正则表达式字符串
   - 输出：硬件可执行的机器码
   - 类比：GCC 将 C 代码编译为 x86 机器码，这个模块将 Regex 编译为 FPGA 指令

2. **两次扫描架构解决前向引用问题**
   - 第一趟：收集地址信息（跳转目标、字符串拆分位置）
   - 第二趟：生成最终指令（使用修正后的绝对地址）
   - 类比：汇编器的第一趟收集标签地址，第二趟生成机器码

3. **定长 64 位指令是硬件友好的关键设计**
   - 解码简单：固定字段偏移，无需解析变长编码
   - 对齐友好：8 字节对齐，单周期读取
   - 空间权衡：可能浪费一些位，但换取硬件实现的简洁性

### 修改代码前的 5 个检查清单

1. **是否影响指令格式？**
   - 如果修改 `xf_instruction` 结构体，需要同步更新硬件执行引擎
   - 确保新的操作码不会与现有操作码冲突

2. **是否引入新的 Oniguruma 依赖？**
   - 如果使用 Oniguruma 的新特性，确认目标平台的 Oniguruma 版本支持该特性
   - 考虑向后兼容性，提供降级方案

3. **是否处理了所有错误路径？**
   - 确保每个 `return` 语句前都调用了 `onig_free()` 和 `buff_free()`
   - 避免内存泄漏和资源泄漏

4. **是否测试了边界条件？**
   - 空模式 `""`
   - 超长字符串（> 4 字节）
   - 复杂嵌套（多层捕获组、嵌套量词）
   - 特殊字符类（`[\w\d\s]`）

5. **是否更新了文档？**
   - 如果添加了新的错误码，更新"错误处理策略"部分
   - 如果修改了 API 契约，更新"API 契约与前置条件"部分

### 常见的 3 个调试场景

**场景 1：硬件执行结果不匹配**

- **症状**：同一模式，软件正则匹配成功，硬件执行失败
- **排查步骤**：
  1. 检查 `instructions` 数组内容，确认指令序列正确
  2. 检查 `bitset` 数组，确认字符类位图正确
  3. 对比软件匹配使用的字符类与硬件使用的字符类是否一致
  4. 检查硬件执行引擎的指令解码逻辑是否与 `xf_instruction` 格式一致

**场景 2：长字符串模式编译失败**

- **症状**：包含长字符串（> 4 字节）的模式编译时崩溃或产生错误指令
- **排查步骤**：
  1. 检查 `str_n_addr_tb` 和 `str_n_len_tb` 是否正确记录了所有长字符串位置
  2. 检查地址修正循环是否正确计算了相对偏移
  3. 验证 `abs_add_tb` 中的绝对地址是否在修正后指向正确的指令
  4. 检查 `instructions` 缓冲区是否足够大以容纳额外生成的指令

**场景 3：捕获组名称提取失败**

- **症状**：命名捕获组的名称无法正确提取或提取结果错乱
- **排查步骤**：
  1. 确认 `cpgp_name_val` 和 `cpgp_name_oft` 参数非 NULL
  2. 检查 `cpgp_name_val` 缓冲区是否足够大以容纳所有名称字符串
  3. 检查 `cpgp_name_oft` 数组是否正确计算了偏移量（最后一个元素应为总长度）
  4. 验证 Oniguruma 的 `name_table` 遍历逻辑是否正确处理了哈希冲突

---

## 参考资源

### 内部文档

- [L1 层软件接口规范](../specs/l1_sw_interface_spec.md)
- [硬件指令集架构手册](../specs/hw_instruction_set_arch.md)
- [Oniguruma 集成指南](../guides/oniguruma_integration_guide.md)

### 外部参考

- [Oniguruma 官方文档](https://github.com/kkos/oniguruma/blob/master/doc/RE)
- [正则表达式匹配算法综述](https://swtch.com/~rsc/regexp/regexp1.html) (Russ Cox)
- [FPGA 加速字符串匹配综述](https://ieeexplore.ieee.org/document/1234567) (示例链接)

### 相关模块

- [naive_bayes_benchmark_pipeline_l2](data_analytics-text-naive_bayes_benchmark_pipeline_l2.md)：朴素贝叶斯分类器的基准测试流水线
- [duplicate_text_match_demo_l2](data_analytics-text-duplicate_text_match_demo_l2.md)：重复文本匹配演示
- [log_analyzer_demo_acceleration_and_host_runtime_l2](data_analytics-text-log_analyzer_demo_acceleration_and_host_runtime_l2.md)：日志分析器加速与主机运行时

---

## 附录：核心 API 参考

### `xf_re_compile`

**功能**：将正则表达式模式编译为硬件可执行的指令序列。

**原型**：

```c
extern int xf_re_compile(const char* pattern,
                         unsigned int* bitset,
                         uint64_t* instructions,
                         unsigned int* instr_num,
                         unsigned int* cclass_num,
                         unsigned int* cpgp_nm,
                         uint8_t* cpgp_name_val,
                         uint32_t* cpgp_name_oft);
```

**参数**：

| 参数 | 类型 | 方向 | 说明 |
|------|------|------|------|
| `pattern` | `const char*` | 输入 | 正则表达式模式字符串 |
| `bitset` | `unsigned int*` | 输出 | 字符类位图缓冲区，每个字符类需要 8 个 `unsigned int`（256 位） |
| `instructions` | `uint64_t*` | 输出 | 指令缓冲区，每个元素是一个 64 位定长指令 |
| `instr_num` | `unsigned int*` | 输出 | 实际生成的指令数量 |
| `cclass_num` | `unsigned int*` | 输出 | 实际使用的字符类数量 |
| `cpgp_nm` | `unsigned int*` | 输出 | 捕获组数量 |
| `cpgp_name_val` | `uint8_t*` | 输出 | 捕获组名称字符缓冲区，可为 NULL（不提取名称） |
| `cpgp_name_oft` | `uint32_t*` | 输出 | 捕获组名称偏移数组，可为 NULL（不提取名称） |

**返回值**：

| 返回值 | 说明 |
|--------|------|
| `0` (ONIG_NORMAL) | 成功 |
| `< 0` (Oniguruma 错误码) | Oniguruma 解析错误，如 `ONIG_INVALID_ARGUMENT`、`ONIG_ERROR_MEM` 等 |
| `XF_UNSUPPORTED_OPCODE` (-1000) | 遇到编译器不支持的 Oniguruma 操作码 |

**前置条件**：

1. `pattern` 必须是有效的以 null 结尾的 C 字符串
2. `bitset` 缓冲区必须足够大以容纳 `(*cclass_num) * 8` 个 `unsigned int`
3. `instructions` 缓冲区必须足够大以容纳所有生成的指令
4. 如果 `cpgp_name_val` 非 NULL，`cpgp_name_oft` 也必须非 NULL，反之亦然
5. 所有输出指针（`instr_num`、`cclass_num`、`cpgp_nm`）必须非 NULL

**后置条件**：

1. 如果返回 0，`bitset` 和 `instructions` 缓冲区包含有效的编译结果
2. `*instr_num`、`*cclass_num`、`*cpgp_nm` 被设置为实际值
3. 如果 `cpgp_name_val` 和 `cpgp_name_oft` 非 NULL，它们被填充为捕获组名称信息
4. 无论成功还是失败，函数内部分配的临时内存都会被释放

**线程安全**：

- 该函数是线程安全的，可以在多个线程中并发调用，只要每个线程传入不同的输出缓冲区
- 不依赖全局状态或静态变量

**示例用法**：

```c
#include "xf_data_analytics/text/xf_re_compile.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
    const char* pattern = "([a-z]+)@([a-z]+\\.com)";
    
    // 分配缓冲区
    unsigned int bitset[256 * 8];  // 最多 256 个字符类
    uint64_t instructions[1024];   // 最多 1024 条指令
    unsigned int instr_num, cclass_num, cpgp_nm;
    
    // 分配捕获组名称缓冲区
    uint8_t cpgp_name_val[256];
    uint32_t cpgp_name_oft[32];
    
    int r = xf_re_compile(pattern, bitset, instructions, &instr_num, 
                          &cclass_num, &cpgp_nm, cpgp_name_val, cpgp_name_oft);
    
    if (r != 0) {
        printf("编译失败，错误码: %d\n", r);
        return 1;
    }
    
    printf("编译成功！\n");
    printf("  指令数: %u\n", instr_num);
    printf("  字符类数: %u\n", cclass_num);
    printf("  捕获组数: %u\n", cpgp_nm);
    
    // 打印捕获组名称
    printf("  捕获组名称:\n");
    for (unsigned int i = 0; i < cpgp_nm; i++) {
        uint32_t start = cpgp_name_oft[i];
        uint32_t end = cpgp_name_oft[i + 1];
        uint32_t len = end - start;
        printf("    组 %u: %.*s\n", i + 1, len, cpgp_name_val + start);
    }
    
    return 0;
}
```

---

## 修订历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| 1.0  | 2024-01-15 | 技术文档团队 | 初始版本，完整描述模块架构、数据流、设计决策和 API |

---

*本文档是 `regex_compilation_core_l1` 模块的权威参考。如有疑问，请联系维护团队或提交 Issue。*

