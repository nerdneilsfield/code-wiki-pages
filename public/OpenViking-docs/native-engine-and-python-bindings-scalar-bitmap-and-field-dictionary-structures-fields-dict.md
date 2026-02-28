# fields_dict 模块技术深度解析

## 概述

`fields_dict` 模块是 OpenViking 向量数据库引擎中的一个基础数据结构模块，位于 `src/index/detail/fields_dict.h`。它定义了一个名为 `FieldsDict` 的 C++ 结构体，扮演着**数据传输容器**的角色——在 Python 层与 C++ 原生层之间、以及 C++ 内部各索引模块之间传递元数据（标量字段）信息。

这个模块解决的问题看似简单却至关重要：**如何将用户定义的键值对字段数据高效地传入索引系统，并让下游的Bitmap索引、范围索引、目录索引等子系统中进行正确的处理和存储**。没有这样一个统一的抽象，每个子系统都需要自己解析 JSON、自己处理类型转换，代码将变得冗余且容易出错。

---

## 架构角色与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Python Client Layer                                │
│  用户调用 add_data(fields={"price": 99.9, "category": "book", "tags": [...]}) │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ fields_str (JSON字符串)
┌─────────────────────────────────────────────────────────────────────────────┐
│                      C++ Native Engine (fields_dict)                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  FieldsDict::parse_from_json()  ──▶  str_kv_map_ + dbl_kv_map_      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ FieldsDict 对象
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ScalarIndex Processing                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  add_row_data(fields, old_fields)                                   │    │
│  │    ├── str_kv_map_ → field_sets_->add_field_data() (字符串/路径索引) │    │
│  │    └── dbl_kv_map_ → field_sets_->add_field_data() (数值/范围索引)   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ 持久化到磁盘
┌─────────────────────────────────────────────────────────────────────────────┐
│                      scalar_index.data (二进制文件)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 关键依赖关系

- **被调用方**：`FieldsDict` 被 `ScalarIndex`（标量索引管理器）使用，用于 `add_row_data()` 和 `delete_row_data()` 操作
- **依赖的外部库**：
  - `rapidjson`：用于 JSON 解析
  - `spdlog`：用于日志记录（`SPDLOG_ERROR`）
- **包含它的头文件**：`scalar_index.h` 包含了 `fields_dict.h`

---

## 核心组件详解

### FieldsDict 结构体

```cpp
struct FieldsDict {
  std::unordered_map<std::string, std::string> str_kv_map_;  // 字符串类型字段
  std::unordered_map<std::string, double> dbl_kv_map_;       // 数值类型字段

  bool empty() const;
  size_t size() const;
  std::string to_string() const;
  int parse_from_json(const std::string& json);
};
```

#### 设计意图

这个结构体的设计基于一个关键洞察：**在向量数据库的标量索引场景中，字段可以分为两大类——字符串类（字符串、布尔值、路径、数组）和数值类（整数、浮点数）**。这种分类不是随意的，而是由下游的索引结构决定的：

- **字符串类字段** → 使用 Bitmap 索引（精确匹配）或 DirIndex（路径前缀树）
- **数值类字段** → 使用 RangedMap（范围索引）或 Bitmap（枚举值）

将两类字段存储在不同的 HashMap 中，使得后续处理逻辑可以针对每个 Map 做专门优化，避免类型判断的开销。

#### 成员变量

| 成员变量 | 类型 | 用途 |
|---------|------|------|
| `str_kv_map_` | `unordered_map<string, string>` | 存储所有非数值类型的字段：字符串、布尔值、路径、数组（序列化为字符串） |
| `dbl_kv_map_` | `unordered_map<string, double>` | 存储所有数值类型的字段：int64（自动转换）、float/double |

---

### parse_from_json() 方法

这是 `FieldsDict` 最重要的方法，负责将 JSON 字符串解析为内部数据结构。理解它的设计需要先理解它要处理的类型转换逻辑：

```cpp
int parse_from_json(const std::string& json) {
  // 1. 空字符串直接返回成功（空字典是合法的）
  if (json.empty()) {
    return 1;
  }
  
  // 2. 使用 rapidjson 解析
  rapidjson::Document doc;
  doc.Parse(json.c_str());
  
  if (doc.HasParseError()) {
    SPDLOG_ERROR("doc HasParseError json: {}", json.c_str());
    return 1;
  }
  
  // 3. 遍历 JSON 对象的所有键值对
  for (rapidjson::Value::ConstMemberIterator it = doc.MemberBegin();
       it != doc.MemberEnd(); ++it) {
    std::string key = it->name.GetString();
    const rapidjson::Value& val = it->value;
    
    // 4. 类型分支处理
    if (val.IsInt64()) {
      // 整数同时存入两个 map：支持精确匹配(str) + 范围查询(dbl)
      str_kv_map_[key] = std::to_string(val.GetInt64());
      dbl_kv_map_[key] = double(val.GetInt64());
    } else if (val.IsDouble()) {
      dbl_kv_map_[key] = val.GetDouble();
    } else if (val.IsString()) {
      str_kv_map_[key] = val.GetString();
    } else if (val.IsBool()) {
      str_kv_map_[key] = std::to_string(val.GetBool() == true);
    } else if (val.IsArray()) {
      // 数组序列化为分号分隔的字符串
      std::stringstream ss;
      for (rapidjson::SizeType i = 0; i < val.Size(); ++i) {
        const rapidjson::Value& sub_val = val[i];
        if (i > 0) ss << ";";
        if (sub_val.IsInt64()) {
          ss << std::to_string(sub_val.GetInt64());
        } else if (sub_val.IsString()) {
          ss << sub_val.GetString();
        }
      }
      str_kv_map_[key] = ss.str();
    }
  }
  return 0;
}
```

#### 类型处理策略

| JSON 类型 | 存入 str_kv_map_ | 存入 dbl_kv_map_ | 原因 |
|-----------|------------------|------------------|------|
| `int64` | ✅ 转换为字符串 | ✅ 转换为 double | 支持精确匹配（字符串）和范围查询（数值） |
| `double` | ❌ | ✅ 保留精度 | 范围查询 |
| `string` | ✅ 原始值 | ❌ | 精确匹配 |
| `bool` | ✅ 转换为 "0" 或 "1" | ❌ | 精确匹配 |
| `array` | ✅ 序列化为 "a;b;c" | ❌ | 精确匹配（作为整体字符串） |

**关键设计洞察**：整数类型同时存入两个 Map 是一个实用的权衡。一方面，字符串精确匹配查询（`field = 42`）很常见；另一方面，范围查询（`price > 100 AND price < 500`）也需要数值类型。这个设计避免了重复解析，但增加了轻微的存储开销。

---

## 数据流全程追踪

让我们追踪一条完整的数据写入路径：

### 场景：用户添加一条记录，包含向量和字段

**Step 1: Python 层构建请求**

```python
# Python 代码
collection.add(
    vector=[0.1, 0.2, ...],
    fields={
        "price": 99.9,           # float → dbl_kv_map_
        "category": "book",      # string → str_kv_map_
        "rating": 5,             # int → both maps
        "is_featured": True,     # bool → str_kv_map_
        "tags": ["sci-fi", "classic"]  # array → str_kv_map_ = "sci-fi;classic"
    }
)
```

**Step 2: 序列化为 JSON 传递到 C++**

在 Python-C++ 边界，数据被序列化为 JSON 字符串：

```json
{
  "price": 99.9,
  "category": "book",
  "rating": 5,
  "is_featured": true,
  "tags": ["sci-fi", "classic"]
}
```

**Step 3: C++ 层解析**

```cpp
// 在 ScalarIndex::add_row_data() 中
FieldsDict fields;
fields.parse_from_json(request.fields_str);

// 解析后：
// str_kv_map_: {"category": "book", "rating": "5", "is_featured": "true", "tags": "sci-fi;classic"}
// dbl_kv_map_: {"price": 99.9, "rating": 5.0}
```

**Step 4: 索引写入**

```cpp
// ScalarIndex 根据字段类型分发到不同的索引结构
if (!fields.str_kv_map_.empty()) {
  field_sets_->add_field_data(fields.str_kv_map_, offset);  // 字符串 → Bitmap/DirIndex
}
if (!fields.dbl_kv_map_.empty()) {
  field_sets_->add_field_data(fields.dbl_kv_map_, offset);  // 数值 → RangedMap/Bitmap
}
```

---

## 设计决策与权衡

### 1. 双 Map 策略 vs 单异构 Map

**选择**：使用两个独立的 `unordered_map`（`str_kv_map_` 和 `dbl_kv_map_`）

**替代方案考虑**：
- 使用 `std::variant` 或 `std::any` 的单一 Map
- 使用 `std::unordered_map<std::string, std::variant<std::string, double>>`

**为何选择当前方案**：
- **性能**：访问时无需类型判断和动态类型转换，直接定位到正确的 Map
- **简洁性**：下游处理逻辑清晰分流，不需要 match/visitor 模式
- **权衡**：轻微的内存冗余（整数会在两个 Map 中各存一份），但在字段数量有限的场景下可接受

### 2. 整数类型双重存储

**设计**：当 JSON 值为整数时，既存入 `str_kv_map_`（字符串形式）又存入 `dbl_kv_map_`（浮点形式）

**权衡分析**：
- ✅ **优势**：单次解析同时支持精确查询和范围查询
- ❌ **代价**：存储空间翻倍（对于整数字段）
- **适用场景**：向量数据库中整数字段（如 ID、数量、评分）通常既需要精确匹配也需要范围过滤，这个设计很实用

### 3. 数组的字符串序列化

**设计**：JSON 数组被序列化为分号分隔的字符串（如 `["a", "b"]` → `"a;b"`）

**权衡分析**：
- ✅ **简单**：无需修改现有的字符串索引逻辑
- ❌ **限制**：只能做整体匹配，无法做数组成员查询
- **适用场景**：对于标签、类别等多值字段，通常只需要"包含某个值"的过滤，这种序列化方式足够

### 4. 错误处理策略

**设计**：`parse_from_json()` 返回 `int`，0 表示成功，非 0 表示失败

**权衡**：
- ✅ **轻量**：不需要异常机制，适合高性能路径
- ⚠️ **局限**：调用方必须检查返回值，否则可能使用未初始化的数据
- **建议**：新贡献者应特别注意检查返回值

---

## 使用指南与最佳实践

### 典型用法

```cpp
#include "index/detail/fields_dict.h"

// 1. 创建 FieldsDict
vectordb::FieldsDict fields;

// 2. 从 JSON 解析（通常来自 Python 层传递的字符串）
int ret = fields.parse_from_json(json_string);
if (ret != 0) {
  // 处理解析错误
  return;
}

// 3. 检查非空
if (!fields.empty()) {
  // 4. 访问数据
  if (fields.str_kv_map_.count("category")) {
    std::string category = fields.str_kv_map_.at("category");
  }
  if (fields.dbl_kv_map_.count("price")) {
    double price = fields.dbl_kv_map_.at("price");
  }
}

// 5. 调试输出
SPDLOG_INFO("Fields: {}", fields.to_string());
```

### 配置与扩展

`FieldsDict` 本身是一个简单的数据容器，**没有可配置项**。它的行为由以下因素决定：
- 输入 JSON 的结构
- `ScalarIndex` 的字段类型定义（元数据中的 `field_type`）

如果需要添加新的字段类型支持（如日期时间），修改 `parse_from_json()` 即可，但需要注意：
1. 决定存入哪个 Map（字符串还是数值）
2. 考虑下游索引是否支持该类型

---

## 边缘情况与陷阱

### 1. 空 JSON 字符串

```cpp
fields.parse_from_json("");  // 返回 1，但 fields 处于"空"状态
```

空字符串被当作成功（返回1表示"没有错误"），但不会填充任何数据。这是合理的行为，因为空的字段字典是合法的。

### 2. JSON 解析失败

```cpp
fields.parse_from_json("{invalid json");  // 返回 1，记录错误日志
```

如果 JSON 格式错误，会记录错误日志到 SPDLOG，但**不会抛出异常**。调用方必须检查返回值。

### 3. 数值精度损失

```cpp
// JSON: {"big_number": 9007199254740993}
// 存入 dbl_kv_map_ 时会损失精度（超过 2^53 的整数无法精确表示）
```

JavaScript/JSON 的 Number 类型是 IEEE 754 双精度浮点数，超过 `2^53` 的整数会有精度损失。这是 JSON 本身的限制，不是 FieldsDict 的问题。

### 4. 数组类型仅支持字符串和整数

```cpp
// JSON: {"values": [1.5, 2.5, 3.5]}  // 浮点数数组
// 解析结果：str_kv_map_["values"] = "" (空！)
```

当前实现只处理 `IsInt64()` 和 `IsString()` 的数组元素，浮点数数组会被忽略。这是一个潜在的功能限制。

### 5. 重复键的处理

```cpp
// JSON: {"price": 10, "price": 20}
// rapidjson 会保留最后一个值：price = 20
```

JSON 规范允许重复键（虽然不推荐），rapidjson 会保留最后出现的值。

---

## 相关模块参考

- **[scalar_index](native-engine-and-python-bindings-scalar-bitmap-and-field-dictionary-structures-scalar-index.md)**：使用 FieldsDict 的核心模块，负责将字段数据写入各类 Bitmap/RangedMap 索引
- **[bitmap_field_group](native-engine-and-python-bindings-scalar-bitmap-and-field-dictionary-structures-bitmap-field-group.md)**：字段索引的容器，管理 Bitmap、RangeMap、DirIndex 等多种索引结构
- **[dir_index](native-engine-and-python-bindings-scalar-bitmap-and-field-dictionary-structures-dir-index.md)**：字符串/路径字段使用的前缀树索引
- **[ranged_map](native-engine-and-python-bindings-scalar-bitmap-and-field-dictionary-structures-ranged-map.md)**：数值字段使用的范围索引

---

## 总结

`FieldsDict` 是 OpenViking 向量数据库引擎中一个看似简单但至关重要的模块。它扮演着**数据桥梁**的角色，将 Python 层的字段数据传递给 C++ 索引系统。其设计遵循了"简单、明确、性能"的平衡原则：

- **双 Map 设计**让类型分流清晰高效
- **整数双重存储**简化了查询场景
- **数组字符串序列化**保持了下游处理的简单性

对于新加入的开发者，重要的是理解这个模块不是"孤立的数据结构"，而是整个标量索引写入路径的第一环——它为下游的 Bitmap/RangedMap/DirIndex 索引提供正确分类的输入数据。