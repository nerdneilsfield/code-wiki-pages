# dir_index 模块技术深度解析

## 模块概述

**dir_index** 模块是向量数据库标量索引系统中一个专门用于处理**路径前缀查询**的组件。想象一下这样的场景：你有一个文件系统索引，其中每条记录关联了一个文件路径（如 `/home/user/documents/report.pdf`），现在你想查询"所有位于 `/home/user/documents` 路径下的记录"。如果使用普通的倒排索引，你需要遍历所有以该前缀开头的路径，效率极低。**DirIndex** 通过构建一个**前缀树（Trie）**结构，将路径查询的时间复杂度从 O(n) 降低到 O(k)，其中 k 是路径的深度。

从架构角度来看，DirIndex 是整个位图过滤体系的一部分。它与 [bitmap](src-index-detail-scalar-bitmap-holder-bitmap.md)（位图索引）和 [ranged_map](src-index-detail-scalar-bitmap-holder-ranged_map.md)（范围索引）共同构成了三种不同的标量字段索引类型。这种"三分天下"的设计允许系统根据字段的查询特性选择最合适的索引结构。

## 核心抽象与数据结构

### TrieNode：前缀树的节点

```cpp
struct TrieNode {
  std::string path_segment_;        // 当前节点代表的路径段（如 "docs"）
  TrieNode* parent_ = nullptr;      // 父节点指针，用于回溯
  std::unordered_map<std::string, std::unique_ptr<TrieNode>> children_;  // 子节点集合
  bool is_leaf_ = false;            // 是否是完整路径的终点
};
```

**设计意图**：每个节点只存储一个路径段（如 `home`、`user`、`docs`），而非整个路径。这种设计的优势在于：
- **公共前缀压缩**：路径 `/home/user/docs` 和 `/home/user/readme.txt` 会共享 `home` 和 `user` 两个节点，大幅节省内存
- **高效前缀查询**：要查找 `/home/user` 下的所有路径，只需从根节点向下遍历两層，然后收集所有叶子节点即可

### DirIndex：路径索引管理器

```cpp
class DirIndex {
 public:
  void add_key(const std::string& key);  // 添加路径键
  void get_merged_bitmap(const std::string& path_prefix, int depth,
                         std::unordered_set<std::string>& unique_bitmaps) const;
  // 序列化与反序列化
  virtual void serialize_to_stream(std::ofstream& output);
  virtual void parse_from_stream(std::ifstream& input);
 private:
  std::unique_ptr<TrieNode> root_ = std::make_unique<TrieNode>("", nullptr);
  // ... 辅助方法
};
```

**核心职责**：
1. **路径插入**：`add_key` 方法将完整路径分解为段并插入 Trie
2. **前缀查询**：`get_merged_bitmap` 收集满足前缀条件的所有完整路径
3. **持久化**：支持将整个索引树序列化为二进制流

## 数据流分析

### 写入路径数据

```
调用者 (如 FieldBitmapGroup)
         │
         ▼
FieldBitmapGroup::add_field_data(field_str, offset)
         │
         ├── 路径规范化：normalize_path_key() 确保以 "/" 开头
         │
         ├── DirIndex::add_key(norm_key)  ──► 构建 Trie 结构
         │        │
         │        └── split_path("/home/user/docs") → ["home", "user", "docs"]
         │              │
         │              └── 逐层创建/查找 TrieNode
         │
         └── Bitmap::Set(offset)  ──► 位图中记录该 offset
```

### 读取前缀匹配的所有路径

```
调用者 (如搜索请求)
         │
         ▼
get_merged_bitmap("/home/user", depth=2, unique_bitmaps)
         │
         ├── find_node("/home/user")  ──► 定位到 "user" 节点
         │
         └── collect_bitmaps_recursive_optimized()
                │
                ├── 当前深度 < max_depth 时继续遍历子节点
                ├── 若是叶子节点 (is_leaf_==true)，将完整路径加入结果集
                │
                └── 返回所有匹配的完整路径集合
```

## 与其他模块的依赖关系

### 上游调用者

DirIndex 主要被 [bitmap_field_group](src-index-detail-scalar-bitmap-holder-bitmap_field_group.md) 模块调用：

- **BitmapGroupBase** 构造函数中，如果 `type_id_ == kBitmapGroupDir`，会创建一个 `DirIndexPtr dir_index_`
- **FieldBitmapGroup::add_field_data()** 在添加字符串类型字段时，会判断是否需要使用 DirIndex 进行路径规范化和索引
- **get_bitmap_by_prefix()** 方法调用 `dir_index_->get_merged_bitmap()` 实现前缀匹配

### 横向依赖

- **Bitmap**：DirIndex 返回路径列表后，需要结合 Bitmap 才能获取实际的记录偏移量。Bitmap 使用 [CRoaring](https://github.com/RoaringBitmap/CRoaring) 库实现高效的位图运算
- **io_utils**：序列化时使用 `write_str` 和 `write_bin` 进行二进制读写

### 关键数据契约

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `add_key(path)` | 完整路径字符串 | 无 | 在 Trie 中创建/更新节点 |
| `get_merged_bitmap(prefix, depth, output)` | 路径前缀 + 深度限制 | 填充 unique_bitmaps 集合 | 只读 |
| `serialize_to_stream(ofstream)` | 文件流 | 二进制数据写入文件 | 文件内容被修改 |

## 设计决策与权衡

### 1. 为什么使用 Trie 而非哈希表？

如果只做精确匹配，哈希表 O(1) 的查询速度显然更快。但这里的核心场景是**前缀查询**：

```
查询：/home/user/* 下的所有记录
哈希表方案：需要遍历所有键，逐一检查是否以该前缀开头 → O(n)
Trie 方案：从根节点向下走两格，收集所有叶子 → O(k)，k 为前缀深度
```

对于拥有上百万条路径记录的系统，这种差异是决定性的。

### 2. 为什么用 `unique_ptr` 而非 `shared_ptr`？

Trie 树的父子关系是**严格的树结构**，不存在循环引用。每个子节点只被一个父节点拥有，使用 `unique_ptr` 可以：
- 避免内存泄漏（自动释放）
- 减少引用计数开销
- 语义上更准确地表达"独占拥有"关系

### 3. 路径规范化的处理

代码中有一个关键的处理：

```cpp
static std::string normalize_path_key(const std::string& key) {
  if (key.empty() || key[0] == '/') {
    return key;
  }
  return "/" + key;  // 强制以 "/" 开头
}
```

这意味着 `home/user/docs` 和 `/home/user/docs` 被视为相同路径。**设计理由**：用户提供路径时可能忘记输入前导斜杠，这种不一致性不应该影响查询结果。

### 4. 深度参数的设计

`get_merged_bitmap` 中的 `depth` 参数允许用户控制查询的深度：

```cpp
void get_merged_bitmap(const std::string& path_prefix, int depth, ...);
// depth = -1: 不限制深度，遍历到最底层
// depth = 0:  只返回精确匹配当前前缀的路径
// depth = N:  向下遍历最多 N 层
```

**权衡**：这个设计允许在"精确匹配"和"递归子目录"之间灵活切换，但也增加了 API 的复杂度。

## 使用示例与扩展点

### 基本使用

```cpp
// 1. 创建 DirIndex（通常由 BitmapGroupBase 构造函数处理）
DirIndexPtr dir_index = std::make_shared<DirIndex>();

// 2. 添加路径（每条记录对应一个 offset）
dir_index->add_key("/home/user/documents/report.pdf");
dir_index->add_key("/home/user/documents/presentation.pptx");
dir_index->add_key("/home/user/images/photo.jpg");

// 3. 前缀查询：获取 /home/user/documents 下的所有路径
std::unordered_set<std::string> paths;
dir_index->get_merged_bitmap("/home/user/documents", -1, paths);
// 结果：["/home/user/documents/report.pdf", "/home/user/documents/presentation.pptx"]

// 4. 结合 Bitmap 获取 offset
// (这部分由 BitmapGroupBase 的 get_bitmap_by_prefix 处理)
```

### 在 FieldBitmapGroup 中的集成

```cpp
// 当字段类型为目录类型时，BitmapFieldGroup 会自动使用 DirIndex
FieldBitmapGroup field_group("file_system", "file_path", kBitmapGroupDir);

// 添加数据时，会同时更新 DirIndex 和 Bitmap
field_group.add_field_data("/home/user/docs/report.pdf", 0);  // offset=0
field_group.add_field_data("/home/user/docs/readme.txt", 1);  // offset=1

// 查询时自动利用 DirIndex
BitmapPtr result = field_group.get_bitmap_by_prefix("/home/user/docs");
```

## 边界情况与注意事项

### 1. 空路径与根路径

```cpp
if (path.empty() || path == "/") {
  return segments;  // 返回空集合，表示根节点
}
```

空路径或单个 `/` 会被解析为空段列表，对应根节点本身。

### 2. 路径中的重复斜杠

`split_path` 方法使用 `std::getline(ss, seg, '/')` 按 `/` 分割，但不会处理 `//` 这种情况。如果路径是 `/home//user`，会生成 `["home", "", "user"]`，其中空字符串会成为 Trie 的一个节点。这可能是设计缺陷，取决于上层是否保证路径规范化。

### 3. 序列化时的递归深度

序列化过程会递归遍历整个 Trie 树：

```cpp
void serialize_recursive(const TrieNode* node, std::ofstream& output) const {
  write_str(output, node->path_segment_);
  write_bin(output, node->is_leaf_);
  size_t children_num = node->children_.size();
  write_bin(output, children_num);
  for (const auto& pair : node->children_) {
    serialize_recursive(pair.second.get(), output);
  }
}
```

对于极深的路径（如 `/a/b/c/d/...`），递归深度可能达到数百层，虽然 C++ 默认栈空间足够，但在大规模数据场景下需要注意。

### 4. 内存占用

每个 TrieNode 包含：
- `std::string path_segment_`：路径段字符串
- `unordered_map`：子节点哈希表
- 指针和布尔值

对于数百万条路径的场景，内存占用可能成为瓶颈。一种优化方向是使用**字典压缩**（将字符串映射为整数 ID）。

## 相关文档

- [bitmap](src-index-detail-scalar-bitmap-holder-bitmap.md) — 位图索引的基础实现
- [bitmap_field_group](src-index-detail-scalar-bitmap-holder-bitmap_field_group.md) — 位图组的统一管理接口，DirIndex 在其中被使用
- [ranged_map](src-index-detail-scalar-bitmap-holder-ranged_map.md) — 数值范围索引，用于范围查询场景