# openviking-core-skill-loader 技术深潜

## 概述

`skill_loader` 模块是 OpenViking 系统中最"质朴"的组件之一——它只负责一件事：**将 SKILL.md 文件解析为结构化的 Python 字典**。如果你把整个系统想象成一个信息料理机，那么 SkillLoader 就是那个把原料切成标准形状的刀工环节：简单、确定性、不可或缺。

这个模块解决的问题看似trivial，实则关乎系统的可扩展性边界：OpenViking 需要一种方式来捕获外部"技能"（即 AI 可以调用的能力单元），而 SKILL.md 是一种人类可读、机器可解析的格式。选择 Markdown + YAML frontmatter 的组合，是因为它既满足了文档化的需求（开发者可以直接阅读），又提供了结构化元数据（程序可以处理）。

## 架构定位与数据流向

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────┐
│                      SkillProcessor                             │
│  (处理技能上传的完整工作流：解析 → 生成 Overview → 写入存储)      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SkillLoader                                  │
│  (核心职责：将 SKILL.md 文本反序列化为 dict)                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼ 返回 {"name": ..., "description": ..., "content": ..., ...}
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Context 对象      VikingFS 存储      向量化索引
```

SkillLoader 处于 [SkillProcessor](openviking-utils-skill-processor.md) 的上游，是技能 ingestion 流水线的第一道工序。从依赖图来看：

- **上游调用者**：`SkillProcessor._parse_skill()` 是唯一的直接消费者
- **下游消费者**：解析结果被送往 `Context` 构建、VikingFS 持久化、向量化索引等多个方向

这种"单点输入、多点输出"的模式正是我们选择保持 SkillLoader 极简的原因——它不知道也不关心数据后续如何被使用。

### 数据契约

输入：`SKILL.md` 文件内容（字符串或文件路径）

```markdown
---
name: my-skill
description: 这是一个示例技能
allowed-tools:
  - tool_a
  - tool_b
tags:
  - 示例
  - 测试
---

# 技能内容

这里是技能的详细说明和执行步骤...
```

输出：标准化的 Python 字典

```python
{
    "name": "my-skill",
    "description": "这是一个示例技能",
    "content": "# 技能内容\n\n这里是技能的详细说明和执行步骤...",
    "source_path": "/path/to/SKILL.md",  # 仅在 load() 时填充
    "allowed_tools": ["tool_a", "tool_b"],  # 字段名从 YAML 的 allowed-tools 转换
    "tags": ["示例", "测试"],
}
```

## 组件详解

### SkillLoader 类

这是模块唯一的公开类型，采用**无状态类方法**的设计模式。所有操作都是 `classmethod`，意味着你不需要实例化就能调用：

```python
skill_dict = SkillLoader.load("/path/to/SKILL.md")
# 或者
skill_dict = SkillLoader.parse(raw_markdown_string)
```

#### FRONTMATTER_PATTERN

```python
FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
```

这个正则表达式是模块的核心"切割器"。理解它的行为很重要：

- `^---\s*\n` — 匹配 opening delimiter（开头的三个短横线 + 可选空白 + 换行）
- `(.*?)` — **非贪婪**捕获 frontmatter 内容（YAML 部分）
- `\n---\s*\n` — 匹配 closing delimiter
- `(.*)$` — 捕获剩余的 body 内容（Markdown 部分）
- `re.DOTALL` — 让 `.` 匹配换行符，否则 `.*?` 遇到第一个换行就停了

**设计意图**：使用非贪婪匹配 `.*?` 是关键。如果改成贪婪匹配 `\n---\s*\n` 之后的内容会被错误捕获。这种模式假设 frontmatter 是文件的第一个区块，且有明确的 `--- ... ---` 包裹。

#### load() 方法

```python
@classmethod
def load(cls, path: str) -> Dict[str, Any]:
    """Load Skill from file and return as dict."""
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"Skill file not found: {path}")

    content = file_path.read_text(encoding="utf-8")
    return cls.parse(content, source_path=str(file_path))
```

这是一个**门面方法**（Facade），它封装了"从文件到字典"的完整路径。内部步骤：
1. 验证文件存在性
2. 读取文件内容（固定 UTF-8 编码）
3. 委托给 `parse()` 处理
4. 填充 `source_path` 字段（用于溯源）

**边界注意**：如果文件不存在，直接抛出 `FileNotFoundError`。调用者可以选择捕获或让它向上传播。

#### parse() 方法

```python
@classmethod
def parse(cls, content: str, source_path: str = "") -> Dict[str, Any]:
    """Parse SKILL.md content and return as dict."""
    frontmatter, body = cls._split_frontmatter(content)

    if not frontmatter:
        raise ValueError("SKILL.md must have YAML frontmatter")

    meta = yaml.safe_load(frontmatter)
    if not isinstance(meta, dict):
        raise ValueError("Invalid YAML frontmatter")

    if "name" not in meta:
        raise ValueError("Skill must have 'name' field")
    if "description" not in meta:
        raise ValueError("Skill must have 'description' field")

    return {
        "name": meta["name"],
        "description": meta["description"],
        "content": body.strip(),
        "source_path": source_path,
        "allowed_tools": meta.get("allowed-tools", []),
        "tags": meta.get("tags", []),
    }
```

这是模块的**核心转换逻辑**。几个关键设计决策：

1. **强制 frontmatter**：如果没有 frontmatter，直接失败。这确保了每个技能都有结构化元数据。

2. **必需字段验证**：`name` 和 `description` 是必须存在的。缺少则抛出 `ValueError`。这是一种**fail-fast**策略——尽早暴露格式错误。

3. **字段名转换**：YAML 中使用 `allowed-tools`（kebab-case，符合 YAML 惯例），但输出 dict 使用 `allowed_tools`（snake_case，符合 Python 惯例）。这种映射是隐式的，需要使用者注意。

4. **可选字段默认值**：`allowed_tools` 和 `tags` 没有默认值则为空列表 `[]`，而不是 `None`。这是为了下游处理的一致性——调用者不需要做 `None` 检查。

5. **body 清理**：使用 `.strip()` 去除首尾空白，这是一个防御性处理，避免意外的空行影响后续处理。

#### _split_frontmatter() 方法

```python
@classmethod
def _split_frontmatter(cls, content: str) -> Tuple[Optional[str], str]:
    """Split frontmatter and body."""
    match = cls.FRONTMATTER_PATTERN.match(content)
    if match:
        return match.group(1), match.group(2)
    return None, content
```

这是一个纯粹的字符串操作，不涉及 YAML 解析。它的职责是**判定格式是否存在**，如果存在则分割。

**边界情况**：如果文件根本没有 frontmatter（即不包含 `---` 分隔符），返回 `(None, content)`。此时 `parse()` 会检测到 `frontmatter` 为 `None` 而抛出错误。

#### to_skill_md() 方法

```python
@classmethod
def to_skill_md(cls, skill_dict: Dict[str, Any]) -> str:
    """Convert skill dict to SKILL.md format."""
    frontmatter: dict = {
        "name": skill_dict["name"],
        "description": skill_dict.get("description", ""),
    }

    yaml_str = yaml.dump(frontmatter, allow_unicode=True, sort_keys=False)

    return f"---\n{yaml_str}---\n\n{skill_dict.get('content', '')}"
```

这是 `parse()` 的**逆操作**。提供这种双向转换能力是有价值的：
- 允许系统从存储中读取技能后重新序列化
- 便于调试和日志输出
- 支持技能的"导出"功能

**注意**：`allowed_tools` 和 `tags` 在序列化时被丢弃了。这是因为 `to_skill_md` 设计上只保留核心字段。如果需要保留完整信息，需要扩展此方法。

## 设计决策与权衡

### 1. 无状态 vs 有状态

**选择**：使用 `@classmethod` 而不是实例方法，不维护任何实例状态。

**理由**：解析 SKILL.md 是一个纯函数式的操作——给定相同输入，总产生相同输出。引入实例状态只会增加复杂性（为什么要存储已解析的内容？缓存？生命周期？）。保持无状态让这个模块：
- 线程安全（可以并发调用）
- 易于测试（不需要 mock 对象）
- 行为可预测（没有隐藏状态）

**代价**：如果你需要在同一实例上缓存解析结果，需要在调用方实现。

### 2. 简洁验证 vs 严格验证

**选择**：只验证必需字段（name, description），对 content 内容不做任何验证。

**理由**：这个模块的定位是"解析"而非"校验"。内容是否合法应该由下游处理（比如 SkillProcessor 调用 VLM 生成 Overview 时自然会处理）。过早添加验证会导致：
- 验证逻辑与业务规则耦合
- 格式演进时需要频繁修改解析器
- 限制使用场景（比如允许"草稿"状态的技能）

**代价**：无效内容可能直到运行时才暴露。如果你的场景需要预校验，可以在外层包装验证逻辑。

### 3. 正则 vs 专用解析器

**选择**：使用单行正则表达式解析 frontmatter 边界。

**替代方案**：可以使用专门的 frontmatter 库（如 `python-frontmatter`），或实现更复杂的 Finite State Machine。

**理由**：对于这个特定格式（`--- ... ---`），正则已经足够。且：
- 无额外依赖（只需要标准库 `re`）
- 性能好（单次匹配，无对象创建）
- 足够精确（除非遇到病态输入）

**代价**：正则的灵活性有限。如果未来格式变成多行 frontmarker 或支持多种分隔符，需要重写。

## 依赖关系图

```
openviking.core.skill_loader.SkillLoader
├── 被调用者（输入依赖）：
│   ├── pathlib.Path — 文件路径操作
│   ├── re — 正则表达式匹配
│   └── yaml.safe_load — YAML 解析
│
└── 调用者（输出消费者）：
    └── openviking.utils.skill_processor.SkillProcessor._parse_skill()
        ├── → 构建 Context 对象 (openviking.core.context.Context)
        ├── → 写入 VikingFS (openviking.storage.viking_fs.VikingFS)
        └── → 向量化索引 (openviking.storage.vikingdb_manager.VikingDBManager)
```

## 使用示例与扩展

### 基础用法

```python
from openviking.core.skill_loader import SkillLoader

# 从文件加载
skill = SkillLoader.load("/workspace/skills/my-skill/SKILL.md")

# 从字符串解析
raw_md = """---
name: example
description: 示例技能
tags: [test]
---

# 内容
这里是大纲和指令。
"""
skill = SkillLoader.parse(raw_md)

# 序列化回 MD 格式（用于导出）
exported = SkillLoader.to_skill_md(skill)
```

### 扩展点：添加字段验证

如果你的场景需要更严格的预校验，可以在 SkillLoader 基础上包装：

```python
class ValidatedSkillLoader:
    @staticmethod
    def load_validated(path: str) -> Dict[str, Any]:
        skill = SkillLoader.load(path)
        
        # 自定义验证：内容不能为空
        if not skill["content"].strip():
            raise ValueError(f"Skill '{skill['name']}' has empty content")
        
        # 自定义验证：allowed_tools 不能超过限制
        if len(skill.get("allowed_tools", [])) > 10:
            raise ValueError(f"Skill '{skill['name']}' exceeds tool limit")
        
        return skill
```

### 扩展点：支持更多输出字段

如果需要保留更多元数据，可以扩展返回字典：

```python
def parse_extended(cls, content: str, source_path: str = "") -> Dict[str, Any]:
    result = cls.parse(content, source_path)
    
    # 添加额外的派生字段
    result["word_count"] = len(result["content"].split())
    result["has_tools"] = len(result.get("allowed_tools", [])) > 0
    
    return result
```

## 边缘情况与陷阱

### 1. 字段名映射陷阱

YAML 中的 `allowed-tools` 映射到 Python dict 的 `allowed_tools`（下划线转换），但 `tags` 保持不变。调用方需要知道这个不对称：

```python
skill = SkillLoader.parse(content)
skill["allowed_tools"]  # ✓ 正确
skill["allowed-tools"]  # ✗ 不存在，会抛出 KeyError
skill["tags"]           # ✓ 正确
```

### 2. 空内容的边界处理

`parse()` 对 body 使用 `.strip()`，这意味着纯空白内容会变成空字符串 `""`，而不是保留原始空白。如果需要区分"没有内容"和"内容全是空格"，需要在调用方额外处理。

### 3. frontmatter 位置假设

正则假设 frontmatter 必须在文件最开头（`^` 锚定）。以下格式会解析失败：

```markdown
# 注释或说明
---
name: skill
description: desc
---
```

如果要支持"前置注释"，需要修改正则或采用更复杂的解析策略。

### 4. 多段 frontmatter

当前实现不支持多段 frontmatter。如果遇到以下格式，第二段内容会被忽略：

```markdown
---
name: skill
---
some content
---
name: another  # 这会被忽略
---
```

### 5. YAML 注入风险

使用 `yaml.safe_load()` 是安全的（它不会执行 arbitrary code），但如果将来有人试图支持更复杂的 YAML 特性（如自定义标签），需要注意安全性。

## 测试参考

模块的功能在集成测试中有覆盖，见 [tests/client/test_skill_management.py](../tests/client/test_skill_management.md)。测试用例展示了：

- 从文件路径加载（`test_add_skill_from_file`）
- 从原始字符串加载（`test_add_skill_from_string`）
- 从目录加载（`test_add_skill_from_directory`，依赖 SkillLoader 读取目录内的 SKILL.md）

## 相关文档

- [SkillProcessor](openviking-utils-skill-processor.md) — SkillLoader 的主要调用者，完整展示解析后的数据如何被处理
- [Session](openviking-session-session.md) — 了解技能如何在会话中被追踪使用
- [Context 系统](openviking-core-context.md) — 技能作为 Context 的一种类型被管理