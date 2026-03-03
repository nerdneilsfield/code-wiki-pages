# quantitative_finance.L1.benchmarks.SVD.host.util 子模块

## 核心职责

本文件（`util.cpp`）提供 **SVD 基准测试所需的通用主机端工具函数**。与专注于业务逻辑的 `svd.cpp` 不同，本文件专注于**可复用的基础设施**：高精度计时和环境配置读取。这些工具函数设计为**无状态**（Stateless）和**线程不安全**（由调用者保证串行访问），适用于各类 L1 级基准测试场景。

## 关键组件详解

### `diff` 函数 —— 微秒级时间差计算

#### 函数签名
```cpp
unsigned long diff(const struct timeval* newTime, const struct timeval* oldTime);
```

#### 职责
计算两个 POSIX `timeval` 结构体之间的时间差，返回微秒（μs）为单位的 unsigned long 值。这是 L1 基准测试的核心计时原语。

#### 参数契约
- `newTime`：较晚的时间点（必须 >= `oldTime`）
- `oldTime`：较早的时间点
- **前置条件**：两个指针均非 NULL，且 `newTime` 确实晚于 `oldTime`（调用者负责保证）
- **后置条件**：返回值 = `(newTime->tv_sec - oldTime->tv_sec) * 1000000 + (newTime->tv_usec - oldTime->tv_usec)`

#### 内部实现逻辑
```cpp
return (newTime->tv_sec - oldTime->tv_sec) * 1000000 + (newTime->tv_usec - oldTime->tv_usec);
```

- **秒到微秒转换**：`tv_sec` 差值乘以 1,000,000
- **微秒部分**：直接加上 `tv_usec` 差值
- **无溢出检查**：假设时间差小于 2^32 微秒（约 71 分钟），对于 SVD 内核的微秒级执行时间完全安全

#### 精度与局限性

**精度来源**：依赖 `gettimeofday` 系统调用，通常提供 **微秒级分辨率**（1 μs），但实际精度取决于 OS 时钟中断频率（通常为 1-10 毫秒）。对于亚毫秒级测量，可能存在 **量化误差**（Quantization Error）。

**与 `std::chrono` 对比**：
- 优势：`timeval` 是 POSIX 标准，与 C 代码和系统调用（如 `setitimer`）互操作性好
- 劣势：`std::chrono` 提供更高精度（纳秒级）和更好的类型安全（防止单位混淆）

**适用场景**：适合测量 **> 1 毫秒** 的操作（如 FPGA 内核执行、数据传输）。对于纳秒级微基准测试，应改用 `rdtsc` 或 `std::chrono::high_resolution_clock`。

---

### `read_verify_env_int` 函数 —— 带默认值的环境变量整型读取

#### 函数签名
```cpp
int read_verify_env_int(const char* var, int fail_value);
```

#### 职责
从环境变量读取整数值，若变量未设置则使用默认值，同时向 stderr 输出警告信息。这是配置注入（Configuration Injection）的基础机制，允许在不重新编译的情况下调整测试参数。

#### 参数契约
- `var`：要读取的环境变量名（NULL 终止 C 字符串，不得为 NULL）
- `fail_value`：当环境变量未设置时的返回值
- **线程安全**：`getenv` 不是线程安全的（返回静态存储区指针），此函数不应在多线程环境中并发调用，或需外部加锁

#### 内部实现逻辑
```cpp
if (getenv(var) == NULL) {
    std::cerr << "Warning, environment variable " << var 
              << " not set, using " << fail_value << std::endl;
    return fail_value;
} else {
    return atoi(getenv(var));
}
```

**关键行为分析**：
1. **NULL 检查**：`getenv` 返回 NULL 表示变量未定义
2. **警告输出**：使用 `std::cerr` 输出到标准错误流，这是正确的诊断信息输出通道（不应混用 stdout）
3. **字符串到整数转换**：使用 C 标准库 `atoi`
   - **无错误处理**：`atoi` 在遇到非数字字符时返回 0，无法区分 "无效输入" 和 "有效值 0"
   - **无溢出检查**：超范围值导致未定义行为

#### 健壮性局限与改进建议

| 当前实现局限 | 潜在问题 | 改进方案 |
|-------------|---------|---------|
| `atoi` 无错误检查 | "ABC" 输入静默转为 0，配置错误难以发现 | 改用 `strtol` 并检查 `endptr` 和 `errno` |
| 无范围验证 | 负数或极大值可能导致后续逻辑错误 | 添加 `min_val` 和 `max_val` 参数进行钳制 |
| 线程不安全 | 并发调用 `getenv` 返回相同静态指针，可能崩溃 | 使用 `getenv_s` (C11) 或加锁，或改用配置文件 |
| 输出不可控 | stderr 输出可能污染自动化测试的解析 | 添加 `quiet` 模式参数控制日志输出 |

#### 典型使用模式

```cpp
// 在测试主函数中读取可配置参数
int main() {
    // 读取设备索引，默认使用 0 号卡
    int device_idx = read_verify_env_int("SVD_DEVICE_IDX", 0);
    
    // 读取迭代次数，默认 100 次取平均
    int num_iterations = read_verify_env_int("SVD_ITERATIONS", 100);
    
    // 读取是否启用详细日志
    int verbose = read_verify_env_int("SVD_VERBOSE", 0);
    
    // 执行测试...
    for (int i = 0; i < num_iterations; ++i) {
        double err;
        benchmark_svd_functions(xclbin_path, err);
        if (verbose) {
            std::cout << "Iteration " << i << ", error = " << err << std::endl;
        }
    }
}
```

---

### `read_verify_env_string` 函数 —— 带默认值的环境变量字符串读取

#### 函数签名
```cpp
std::string read_verify_env_string(const char* var, std::string fail_value);
```

#### 职责
与 `read_verify_env_int` 类似，但读取字符串值。用于配置路径、文件名或其他非数值参数。

#### 与整数版本的关键差异

| 特性 | `read_verify_env_int` | `read_verify_env_string` |
|------|----------------------|-------------------------|
| 返回值类型 | `int` | `std::string` |
| 转换操作 | `atoi` 字符串转整数 | 无转换，原始字符串 |
| 警告输出 | 有（cerr 输出） | **无**（静默回退） |
| 空值处理 | 返回 `fail_value` | 返回 `fail_value` |

**设计不一致性注意**：字符串版本在变量未设置时**不输出警告**，这与整数版本的"大声失败"哲学不同。这可能是设计疏忽，也可能是刻意为之（字符串配置更常见于可选路径）。使用者应注意：依赖警告来检测配置缺失的策略对字符串变量无效。

#### 使用示例

```cpp
// 读取 XCLBIN 路径，默认使用固定路径
std::string xclbin_path = read_verify_env_string(
    "SVD_XCLBIN_PATH", 
    "/opt/xilinx/svd/kernel_svd.xclbin"
);

// 读取输出文件前缀（可选配置）
std::string output_prefix = read_verify_env_string(
    "SVD_OUTPUT_PREFIX",
    "/tmp/svd_result"
);

// 注意：如果 SVD_XCLBIN_PATH 未设置，不会有任何警告输出！
// 调用者必须通过检查默认值是否与预期不符来间接检测
if (xclbin_path == "/opt/xilinx/svd/kernel_svd.xclbin") {
    std::cout << "Note: Using default XCLBIN path" << std::endl;
}
```

---

## 设计哲学与工程权衡

### 为什么使用 C 风格字符串和原始指针？

代码中混合使用现代 C++（`std::string`, `std::vector`）和传统 C（`const char*`, `getenv`）：

```cpp
// 现代 C++ 风格
std::string read_verify_env_string(const char* var, std::string fail_value);

// C 风格底层调用
if (getenv(var) == NULL) { ... }
```

**权衡理由**：
- `getenv` 是 POSIX 标准 C 库函数，返回 `char*` 指向静态存储区，没有 `std::string` 版本的系统调用
- 使用 `std::string` 作为参数和返回值提供**值语义**（拷贝即安全），避免指针悬空风险
- 这种"C++ 包装 C 底层"模式是系统编程的常见做法：底层与 OS 用 C 接口，上层提供 C++ 类型安全

### 错误处理策略："警告并继续"

当环境变量未设置时，代码选择打印警告并使用默认值，而非抛出异常或中止程序：

```cpp
if (getenv(var) == NULL) {
    std::cerr << "Warning, environment variable " << var 
              << " not set, using " << fail_value << std::endl;
    return fail_value;
}
```

**与替代策略的比较**：

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **警告并继续**（当前） | 用户体验好，开箱即用；向后兼容 | 配置错误可能静默，难以调试 | 有合理默认值的开发/测试环境 |
| **抛出异常** | 强制调用者处理配置缺失 | 需要 try-catch，增加代码复杂度 | 生产环境关键配置 |
| **断言/中止** | 立即暴露问题 | 过于激进，不适合库代码 | 内部调试版本 |

**设计意图**：作为 L1 基准测试工具而非生产库，优先考虑**易用性和快速迭代**。合理的默认值（如设备索引 0，迭代 100 次）允许开发者"直接运行"，而警告信息提醒他们这是回退行为。

### 计时精度与可移植性权衡

选择 `gettimeofday` 而非 `std::chrono` 或 `rdtsc`：

**各方案对比**：

| 计时方法 | 精度 | 可移植性 | 开销 | 适用场景 |
|----------|------|----------|------|----------|
| `gettimeofday` | ~1-10 μs | POSIX 标准（Linux/Unix） | 系统调用，~1μs | 当前场景：ms 级操作 |
| `std::chrono::system_clock` | ~1 μs | C++11 标准 | 库封装，可能调用 `gettimeofday` | 现代 C++ 代码 |
| `rdtsc` (x86 时间戳计数器) | ~1 ns | x86 only，需处理 CPU 频率变化 | 用户空间，< 100ns | 纳秒级微基准测试 |
| `clock_gettime(CLOCK_MONOTONIC)` | ~1 ns | Linux 现代 POSIX | 系统调用，vdso 优化 | 高精度需求 |

**当前选择理由**：
- `gettimeofday` 是**最广泛支持**的 POSIX 调用，在旧版 Linux 和嵌入式系统上可用
- SVD 内核执行时间通常在 **100μs - 10ms** 范围，`gettimeofday` 的 ~1μs 精度足够（误差 < 1%）
- 代码简单，无需处理 `rdtsc` 的 CPU 频率缩放（Turbo Boost）和核心迁移问题

**改进建议**：若需更高精度或 C++ 现代风格，可替换为：
```cpp
#include <chrono>
using clock_type = std::chrono::high_resolution_clock;
auto tstart = clock_type::now();
// ... kernel execution ...
auto tend = clock_type::now();
auto us = std::chrono::duration_cast<std::chrono::microseconds>(tend - tstart).count();
```

---

## 与主模块的关系

本文件（`util.cpp`）是 [l1_svd_benchmark_host_utils](l1-svd-benchmark-host-utils.md) 模块的**基础设施层**。它与 [svd.cpp](quantitative-finance-l1-benchmarks-svd-host-svd.md) 形成明确的**依赖关系**：

```mermaid
graph LR
    A[svd.cpp<br/>业务逻辑层] --> B[util.cpp<br/>基础设施层]
    
    style A fill:#f9f,stroke:#333
    style B fill:#bbf,stroke:#333
```

- **svd.cpp** 依赖于 `diff` 函数进行内核执行时间测量
- **svd.cpp** 可以（虽然没有直接展示）使用 `read_verify_env_*` 进行可配置化
- **util.cpp** 不依赖 svd.cpp，是完全独立的工具集

这种分层确保了工具函数的可重用性 —— 其他 L1 基准测试（如 QR 分解、矩阵求逆）可以直接链接 `util.cpp` 而不引入 SVD 特定的逻辑。
