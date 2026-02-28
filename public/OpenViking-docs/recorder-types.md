# recorder-types

## 概述

`recorder-types` 定义了评估录制模块的所有数据类型和序列化逻辑。它像是整个模块的"词汇表"——定义了我们用什么词汇来描述一次 IO 操作。

---

## 枚举类型

### IOType

**用途**：区分操作所属的子系统

```python
class IOType(Enum):
    FS = "fs"           # 文件系统操作
    VIKINGDB = "vikingdb"  # 向量数据库操作
```

**为什么需要这个区分**：
- 文件系统和向量数据库的性能特征完全不同，需要分别统计
- 后续分析时可以用这个字段过滤特定子系统

---

### FSOperation

**用途**：文件系统的具体操作类型

```python
class FSOperation(Enum):
    READ = "read"      # 读取文件
    WRITE = "write"    # 写入文件
    LS = "ls"          # 列出目录
    STAT = "stat"      # 获取文件状态
    MKDIR = "mkdir"    # 创建目录
    RM = "rm"          # 删除文件
    MV = "mv"          # 移动文件
    GREP = "grep"      # 搜索文件内容
    TREE = "tree"      # 树形遍历
    GLOB = "glob"      # 模式匹配
```

**覆盖范围**：VikingFS 的核心文件操作都已包含。

---

### VikingDBOperation

**用途**：向量数据库的具体操作类型

```python
class VikingDBOperation(Enum):
    INSERT = "insert"
    UPDATE = "update"
    UPSERT = "upsert"
    DELETE = "delete"
    GET = "get"
    EXISTS = "exists"
    SEARCH = "search"
    FILTER = "filter"
    CREATE_COLLECTION = "create_collection"
    DROP_COLLECTION = "drop_collection"
    COLLECTION_EXISTS = "collection_exists"
    LIST_COLLECTIONS = "list_collections"
```

**覆盖范围**：涵盖了向量数据库的 CRUD 和元数据操作。

---

## 数据类

### AGFSCallRecord

**设计意图**：记录 VikingFS 操作内部调用的 AGFS（底层文件系统）请求。

想象一下：**当你调用 `fs.read("viking://docs/readme.md")` 时，VikingFS 内部可能会调用多次 AGFS API**——比如先检查权限、再读取内容、最后返回。`AGFSCallRecord` 就是为了捕获这些"隐藏"的调用，让你可以追溯完整的问题链路。

```python
@dataclass
class AGFSCallRecord:
    operation: str                    # AGFS 操作名，如 "get", "put"
    request: Dict[str, Any]           # 请求参数
    response: Optional[Any] = None    # 响应数据
    latency_ms: float = 0.0           # 延迟（毫秒）
    success: bool = True              # 是否成功
    error: Optional[str] = None       # 错误信息
```

**使用场景**：
- 定位 VikingFS 性能问题的根因（是 VikingFS 本身慢还是底层 AGFS 慢）
- 复现问题时还原完整的调用链

---

### IORecord

**用途**：一次完整的 IO 操作记录

这是整个模块最核心的数据结构——它定义了"一条记录长什么样"。

```python
@dataclass
class IORecord:
    timestamp: str                    # ISO 格式时间戳
    io_type: str                      # IO 类型（fs/vikingdb）
    operation: str                    # 操作名
    request: Dict[str, Any]           # 请求参数
    response: Optional[Any] = None    # 响应数据
    latency_ms: float = 0.0           # 延迟（毫秒）
    success: bool = True              # 是否成功
    error: Optional[str] = None       # 错误信息
    agfs_calls: List[AGFSCallRecord] = field(default_factory=list)
```

#### to_dict / from_dict

这两个方法实现了 JSON 序列化/反序列化：

```python
record = IORecord(...)
json_str = json.dumps(record.to_dict())  # 写入文件

# 从文件读取
data = json.loads(line)
record = IORecord.from_dict(data)
```

**序列化特殊处理**：
- `bytes` 类型会被编码为 `{"__bytes__": "<内容>"}`，保留可读性
- `datetime` 使用 ISO 格式字符串
- 嵌套对象会递归处理

---

## 序列化逻辑详解

### bytes 的特殊处理

```python
if isinstance(response, bytes):
    return {"__bytes__": response.decode("utf-8", errors="replace")}
```

**为什么需要特殊处理**：
- 二进制数据（如图片、PDF）无法直接 JSON 序列化
- 但我们希望保留可读内容用于分析
- 使用 `errors="replace"` 确保解码失败时不抛出异常

### 递归序列化

```python
def serialize_any(obj: Any) -> Any:
    if obj is None: return None
    if isinstance(obj, bytes): return {"__bytes__": ...}
    if isinstance(obj, dict): return {k: serialize_any(v) ...}
    if isinstance(obj, list): return [serialize_any(item) ...]
    if isinstance(obj, (str, int, float, bool)): return obj
    return str(obj)  # 兜底：转为字符串
```

这个递归逻辑确保了即使是复杂的嵌套对象，也能被转换为可 JSON 序列化的形式。

---

## 数据示例

一份完整的记录看起来像：

```json
{
  "timestamp": "2026-01-15T10:30:45.123456",
  "io_type": "fs",
  "operation": "read",
  "request": {
    "uri": "viking://docs/architecture.md"
  },
  "response": "# Architecture\n\nThis document describes...",
  "latency_ms": 45.2,
  "success": true,
  "error": null,
  "agfs_calls": [
    {
      "operation": "get",
      "request": {"path": "/docs/architecture.md"},
      "response": {"content": "..."},
      "latency_ms": 30.1,
      "success": true,
      "error": null
    }
  ]
}
```

---

## 设计权衡

### 为什么不使用 Pydantic 或 Marshmallow？

**选择**：使用标准库 `dataclasses`

**权衡**：
- **优点**：无外部依赖、轻量级、性能好
- **缺点**：验证能力弱、需手动处理序列化

**为什么适合**：这个模块在评估场景使用，不需要复杂的验证逻辑。`dataclasses` 足够满足需求。

### 为什么不把 AGFS 记录嵌入 VikingDB 操作？

**选择**：将 AGFS 调用作为独立列表存储

**权衡**：
- **优点**：结构清晰，可以独立分析每个 AGFS 调用
- **缺点**：嵌套层级更深

**为什么适合**：评估时经常需要分析"为什么这个 VikingFS 操作慢"，AGFS 调用详情是关键线索。

---

## 依赖关系

```
recorder-types
    ├── IOType (枚举)
    ├── FSOperation (枚举)
    ├── VikingDBOperation (枚举)
    ├── AGFSCallRecord (数据类)
    └── IORecord (数据类)
```

这些类型被 `recorder-core` 引用，用于构建和序列化记录。