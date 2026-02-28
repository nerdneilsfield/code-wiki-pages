# output_formatting 模块技术深度解析

> **注意**：详细文档已移至 [http_api_and_tabular_output-output_formatting](./http_api_and_tabular_output-output_formatting.md)

## 快速索引

| 主题 | 链接 |
|------|------|
| 模块解决的问题 | [这个模块解决什么问题](./http_api_and_tabular_output-output_formatting.md#这个模块解决什么问题) |
| 心智模型 | [心智模型：把模块想象成"智能翻译员"](./http_api_and_tabular_output-output_formatting.md#心智模型把模块想象成智能翻译员) |
| 数据流 | [数据是如何流过这个模块的](./http_api_and_tabular_output-output_formatting.md#数据是如何流过这个模块的) |
| 核心组件 | [ColumnInfo 结构体](./http_api_and_tabular_output-output_formatting.md#columninfo-结构体表格列的元数据) |
| 设计决策 | [关键设计决策与权衡](./http_api_and_tabular_output-output_formatting.md#设计决策与权衡) |
| 边界情况 | [新贡献者应该注意什么](./http_api_and_tabular_output-output_formatting.md#新贡献者应该注意什么) |

## 概述

`output_formatting` 模块 (`crates/ov_cli/src/output.rs`) 是 OpenViking CLI 的输出格式化引擎，负责将后端 API 返回的 JSON 数据转换为人类可读的终端输出。

### 核心职责

- **表格渲染**：将 JSON 数组对象转换为对齐的表格
- **JSON 输出**：支持紧凑和美化两种 JSON 格式
- **智能格式选择**：根据数据结构自动选择最佳渲染策略

### 核心组件

- `OutputFormat` 枚举：`Table` | `Json`
- `ColumnInfo` 结构体：表格列的元数据
- `output_success<T>` 函数：主入口 API
- `print_table<T>` 函数：表格渲染核心逻辑
- `format_array_to_table` 函数：数组到表格的转换器

### 格式化规则

模块实现了六条规则（Rule 1-6），按优先级匹配数据结构并选择渲染方式。

### 关键设计点

1. **启发式规则** - 自动识别数据结构，而非硬编码
2. **两遍扫描** - 第一遍分析列属性，第二遍输出表格
3. **直接打印** - 不返回字符串，简化调用方
4. **Unicode 处理** - 正确计算 CJK 字符显示宽度
5. **URI 特殊处理** - URI 列永不截断