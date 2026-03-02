# 进程内存区域枚举与密钥发现算法深度解析

## 1. 问题陈述

### 1.1 形式化定义

设目标进程 $P$ 的虚拟地址空间为 $\mathcal{V} = [0, 2^{47}-1]$（Windows x64 用户模式地址空间上限）。该空间被划分为若干**内存区域**（Memory Regions），每个区域 $r_i$ 由四元组描述：

$$r_i = (b_i, s_i, \sigma_i, \pi_i)$$

其中：
- $b_i \in \mathcal{V}$：基地址（Base Address）
- $s_i \in \mathbb{Z}^+$：区域大小（Region Size）
- $\sigma_i \in \{\text{MEM\_FREE}, \text{MEM\_RESERVE}, \text{MEM\_COMMIT}\}$：状态
- $\pi_i \subseteq \Pi$：保护属性集合，$\Pi = \{PAGE\_NOACCESS, PAGE\_READONLY, PAGE\_READWRITE, \dots\}$

**问题**：给定进程句柄 $h$，枚举所有满足约束条件的已提交可读区域：

$$\mathcal{R}^* = \{ r_i \mid \sigma_i = \text{MEM\_COMMIT} \land \pi_i \cap \Pi_{readable} \neq \emptyset \land 0 < s_i < S_{max} \}$$

其中 $S_{max} = 500 \times 2^{20}$ bytes（500MB 上限，排除映射文件等超大区域）。

### 1.2 应用背景

在 `wechat-decrypt` 项目中，此枚举是**密钥发现**的第一步。微信 WCDB 引擎在内存中缓存 SQLCipher 派生密钥，格式为 `x'<hex>'`。通过扫描可读内存区域，可定位这些密钥缓存，避免昂贵的 PBKDF2 计算（256,000 次迭代）。

---

## 2. 直觉与关键洞察

### 2.1 朴素方法的失败

**方法 A：全地址空间线性扫描**
- 以固定步长（如 4KB）遍历 $\mathcal{V}$
- **缺陷**：未分配区域导致访问违规；无法获知区域边界和保护属性

**方法 B：/proc/pid/maps 风格（Linux）**
- Windows 无等价接口，需使用 `VirtualQueryEx`

### 2.2 关键洞察：操作系统已维护元数据

Windows 内核通过**虚拟地址描述符**（VAD, Virtual Address Descriptor）树维护进程地址空间布局。`VirtualQueryEx` API 暴露这些元数据，允许：
1. **跳过空闲区域**：直接获知下一个已分配区域的边界
2. **原子性查询**：单次调用返回完整区域信息
3. **权限预筛选**：避免尝试读取不可读页面

这类似于稀疏矩阵的 CSR/CSC 存储——只存储非零元素（已分配区域），而非完整的稠密矩阵。

---

## 3. 形式化定义

### 3.1 系统模型

```pseudocode
Type Address      = UInt64
Type RegionSize   = UInt64
Type MemoryState  = Enum { MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_FREE = 0x10000 }
Type ProtectFlags = UInt32

Record MBI:        // Memory Basic Information
    BaseAddress       : Address
    AllocationBase    : Address
    AllocationProtect : ProtectFlags
    RegionSize        : RegionSize
    State             : MemoryState
    Protect           : ProtectFlags
    Type              : UInt32

ReadableSet = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}  // PAGE_READONLY, READWRITE, etc.
```

### 3.2 算法规范

**输入**：进程句柄 $h \in \mathcal{H}$

**输出**：区域列表 $\mathcal{L} = [(b_1, s_1), (b_2, s_2), \dots, (b_n, s_n)]$

**不变式**：设当前查询地址为 $a$，每次迭代满足：

$$a = b_{i} + s_{i} \quad \text{（严格单调递增）}$$

**终止条件**：
- $a \geq A_{max} = 0\text{x}7FFFFFFFFFFF$（用户空间上限）
- `VirtualQueryEx` 返回 0（错误，通常表示地址越界）
- $b_{i+1} \leq b_i$（安全检测：防止无限循环）

---

## 4. 算法详解

### 4.1 伪代码

```pseudocode
Algorithm EnumRegions(h: Handle) → List[(Address, RegionSize)]
    Input:  Process handle h
    Output: List of (base_address, region_size) pairs
    
    regs ← empty list
    addr ← 0
    mbi ← new MBI()
    
    while addr < MAX_ADDR do
        // Query kernel for region information
        result ← VirtualQueryEx(h, addr, &mbi, sizeof(MBI))
        if result = 0 then
            break  // Error or end of address space
        
        // Apply filtering predicate
        if mbi.State = MEM_COMMIT 
           ∧ mbi.Protect ∈ READABLE 
           ∧ 0 < mbi.RegionSize < SIZE_LIMIT then
            append (mbi.BaseAddress, mbi.RegionSize) to regs
        end if
        
        // Advance to next region (critical: use returned bounds)
        next_addr ← mbi.BaseAddress + mbi.RegionSize
        
        // Safety check: detect wrap-around or stagnation
        if next_addr ≤ addr then
            break  // Prevent infinite loop
        end if
        
        addr ← next_addr
    end while
    
    return regs
end Algorithm
```

### 4.2 执行流程图

```mermaid
flowchart TD
    Start([开始]) --> Init[初始化<br/>addr = 0<br/>regs = []]
    Init --> LoopCond{addr < 0x7FFFFFFFFFFF?}
    LoopCond -- 否 --> Return[返回 regs]
    LoopCond -- 是 --> VQE[VirtualQueryEx<br/>查询内存信息]
    VQE --> CheckResult{返回码 > 0?}
    CheckResult -- 否 --> Return
    CheckResult -- 是 --> Filter{MEM_COMMIT?<br/>∧ 可读?<br/>∧ 大小合法?}
    Filter -- 是 --> Append[添加区域到 regs]
    Filter -- 否 --> ComputeNext
    Append --> ComputeNext[计算 next_addr =<br/>BaseAddress + RegionSize]
    ComputeNext --> SafetyCheck{next_addr > addr?}
    SafetyCheck -- 否 --> Return
    SafetyCheck -- 是 --> UpdateAddr[addr = next_addr]
    UpdateAddr --> LoopCond
    Return --> End([结束])
```

### 4.3 数据结构关系

```mermaid
graph TB
    subgraph "Windows Kernel"
        VAD[VAD Tree<br/>虚拟地址描述符]
    end
    
    subgraph "User Space"
        API[VirtualQueryEx<br/>Kernel32.dll]
        MBI_Struct[MBI Structure<br/>ctypes.Structure]
        EnumAlgo[enum_regions<br/>算法实现]
        ResultList[Region List<br/>List[(addr, size)]]
    end
    
    VAD -.->|查询| API
    API -->|填充| MBI_Struct
    MBI_Struct -->|消费| EnumAlgo
    EnumAlgo -->|生成| ResultList
    
    style VAD fill:#f9f,stroke:#333
    style API fill:#bbf,stroke:#333
    style EnumAlgo fill:#bfb,stroke:#333
```

---

## 5. 复杂度分析

### 5.1 时间复杂度

设地址空间中实际存在的**已分配区域**数量为 $n$（而非理论上的最大页数）。

**每次迭代成本**：
- `VirtualQueryEx`：系统调用开销 $T_{syscall} \approx 1-10\,\mu\text{s}$
- 条件判断与列表追加：$O(1)$

**总时间**：

$$T(n) = n \cdot T_{syscall} = O(n)$$

对比朴素线性扫描（步长 $p = 4096$）：

$$T_{naive} = \frac{A_{max}}{p} \cdot T_{fault} = O(2^{35}) \quad \text{(不可行)}$$

### 5.2 空间复杂度

- **辅助空间**：单个 `MBI` 结构，$|\text{MBI}| = 48$ bytes
- **结果存储**：$O(n)$ 个元组，每个 16 bytes（两个 uint64）

$$S(n) = O(n)$$

### 5.3 场景分析

| 场景 | 典型 $n$ | 耗时估算 | 备注 |
|:---|:---|:---|:---|
| 最小进程 | ~50 | ~0.5 ms | 仅加载基本 DLL |
| 微信启动后 | ~500-2000 | ~5-20 ms | 含大量堆、映射文件 |
| 极端情况 | ~10000 | ~100 ms | 碎片化严重的长期运行进程 |

---

## 6. 实现笔记

### 6.1 实际代码与理论的差异

```python
# 实际实现（find_all_keys.py）
def enum_regions(h):
    regs = []
    addr = 0
    mbi = MBI()
    while addr < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(h, ctypes.c_uint64(addr), 
                                   ctypes.byref(mbi), 
                                   ctypes.sizeof(mbi)) == 0:
            break
        if (mbi.State == MEM_COMMIT and 
            mbi.Protect in READABLE and 
            0 < mbi.RegionSize < 500*1024*1024):
            regs.append((mbi.BaseAddress, mbi.RegionSize))
        nxt = mbi.BaseAddress + mbi.RegionSize
        if nxt <= addr:  # 关键的安全检查
            break
        addr = nxt
    return regs
```

**工程妥协**：

| 方面 | 理论理想 | 实际实现 | 理由 |
|:---|:---|:---|:---|
| 地址上限 | $2^{64}-1$ | `0x7FFFFFFFFFFF` | Windows x64 用户空间实际限制 |
| 大小过滤 | 无 | 500 MB 上限 | 排除大文件映射，减少无效扫描 |
| 错误处理 | 异常机制 | 返回码检查 | Python ctypes 的惯用模式 |
| 类型转换 | 隐式 | 显式 `c_uint64` | 确保 64 位地址正确传递 |

### 6.2 关键工程细节

**地址推进策略**：
必须使用 `mbi.BaseAddress + mbi.RegionSize`，而非简单的 `addr += something`。原因：`VirtualQueryEx` 可能返回包含多个子区域的**分配粒度**（Allocation Granularity）信息，直接使用返回的边界确保不遗漏、不重叠。

**安全检查的必要性**：
```python
if nxt <= addr: break
```
防御以下异常情况：
- 空区域报告 `RegionSize = 0`
- 内核返回损坏数据
- 地址空间环绕（理论上不可能，但防御性编程）

---

## 7. 比较与相关研究

### 7.1 与经典算法的对比

| 特性 | 本算法 | 线性扫描 | /proc/pid/maps 解析 |
|:---|:---|:---|:---|
| 平台 | Windows | 通用 | Linux |
| 系统调用次数 | $O(n)$ | $O(2^{47}/p)$ | $O(1)$（单文件读） |
| 信息完整性 | 完整（含保护属性） | 需额外查询 | 完整 |
| 实时性 | 快照 | 快照 | 快照 |
| 特权要求 | `PROCESS_QUERY_INFORMATION` | 相同 | `ptrace` 或 root |

### 7.2 与学术工作的联系

**内存取证领域**：Volatility 框架的 `vadinfo`/`memmap` 插件采用类似思路，通过遍历 `_MMVAD` 结构重建地址空间布局。本算法可视为其**在线、轻量版**——无需完整内存转储，直接通过 API 查询。

**形式化验证**：Alglave et al. (2018) 在《The Semantics of Multicore x86 Machine Code》中讨论了虚拟地址空间的数学模型。本算法的终止性依赖于地址空间的**良基性**（well-foundedness）：$(\mathcal{V}, <)$ 是良序集，且每次迭代严格递增。

### 7.3 替代方案评估

**方案：使用 `NtQueryVirtualMemory`**
- 更低层 NT API，功能等价
- 优势：更稳定（非公开 API 变化风险）
- 劣势：需手动定义未文档化结构

**方案：读取 `/proc/PID/mem` 风格**
- Windows 无直接等价物
- 最接近：`CreateFileMapping` + `MapViewOfFile` 物理内存（需驱动）

---

## 8. 安全性与伦理考量

本算法本身是中性的内存 introspection 工具，但在 `wechat-decrypt` 上下文中的使用涉及：

1. **权限边界**：需要 `SeDebugPrivilege` 或目标进程的所有者权限
2. **最小权限原则**：仅请求 `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ`
3. **目的限制**：设计用于用户解密自己的数据，非未授权访问

从**攻击面分析**角度，此枚举方法是**被动侦察**（passive reconnaissance）的典型实例——不修改目标状态，仅收集元数据。

---

## 9. 总结

`enum_regions` 算法展示了如何利用操作系统提供的抽象高效解决实际问题。其核心贡献在于：

> **将 $O(2^{47})$ 的不可行搜索空间，通过内核元数据查询，压缩至 $O(n)$ 的实际可行复杂度。**

这一模式——"利用系统已有的索引结构，而非重建"——是系统编程中的常见优化策略，值得在类似场景下复用。