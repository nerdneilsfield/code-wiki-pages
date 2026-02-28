# skill_loader 模块技术深度解析

## 概述

`skill_loader` 模块是 OpenViking 系统中最"轻量级"但却至关重要的组件之一。它的核心职责极其简洁：**解析 SKILL.md 文件，将其转换为系统可用的结构化数据**。如果你把 OpenViking 想象成一个"AI 能力增强平台"，那么 SkillLoader 就是那个负责"读取技能说明书"的组件——它把人类编写的 Markdown 格式技能文档，翻译成系统可以理解、索引、执行的字典结构。

这个模块解决的问题并不复杂，但它的存在揭示了一个重要的设计洞察：**技能的描述方式（SKILL.md）与系统的使用方式（结构化数据）之间需要一个清晰的契约**。SkillLoader 定义了这个契约的"解析侧"，确保无论技能文档如何编写（只要遵循约定格式），系统都能一致地提取出 `name`、`description`、`content`、`allowed_tools`、`tags` 等关键字段。

---

## 架构定位与数据流

### 在系统中的位置

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenViking 系统                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐                          ┌──────────────────┐    │
│  │ SkillLoader  │◄────── 解析 SKILL.md ────│  examples/skills/ │   │
│  └──────┬───────┘                          └──────────────────┘    │
│         │                                                           │
│         ▼                                                           │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  返回 Dict[str, Any]                                          │ │
│  │  {                                                            │ │
│  │    "name": str,           # 技能名称                          │ │
│  │    "description": str,    # 技能描述                          │ │
│  │    "content": str,        # 技能正文                          │ │
│  │    "source_path": str,    # 源文件路径                        │ │
│  │    "allowed_tools": list, # 允许使用的工具列表                │ │
│  │    "tags": list           # 标签列表                          │ │
│  │  }                                                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │   Session    │  │   Context    │  │  VikingDB (向量存储)    │   │
│  │  (会话管理)   │  │  (统一上下文) │  │  (语义索引)            │   │
│  └──────────────┘  └──────────────┘  └────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

从模块树的角度看，`skill_loader` 位于 `core_context_prompts_and_sessions` 这一顶层分类下，与 `Session`、`Context`、`DirectoryDefinition` 等核心抽象平列。这表明它不是一个边缘工具模块，而是**基础设施层的核心组件**——任何需要加载技能的地方都会依赖它。

### 数据流向

1. **输入**：文件系统中的 `SKILL.md` 文件（如 `examples/skills/adding-resource/SKILL.md`）
2. **处理**：SkillLoader 解析文件内容，提取 YAML frontmatter 和 Markdown body
3. **输出**：标准化的 Python 字典，携带 `name`、`description`、`content` 等字段
4. **下游消费**：
   - `Session.used()` 方法会记录技能的使用情况
   - `Context` 类将技能数据转化为可向量化的上下文对象
   - VikingDB 将技能存入向量数据库，支持语义检索

---

## 核心组件：SkillLoader 类

### 设计哲学：静态方法为主

SkillLoader 被设计为一个**无状态的工具类**，所有方法都是 `@classmethod`。这意味着：
- 不需要实例化就能使用：`SkillLoader.load("path/to/SKILL.md")`
- 线程安全：没有任何共享可变状态
- 测试友好：纯函数式逻辑，易于单元测试

这种设计选择体现了"关注点分离"的原则：**技能加载是一个独立的、确定性的转换过程，不应该携带任何运行时状态**。如果你需要管理技能的生命周期，那应该是调用者（Session 或 Context 管理器）的职责，而不是 SkillLoader 本身。

### 核心方法解析

#### `load(path: str) -> Dict[str, Any]`

这是最常用的入口方法，负责从文件路径加载技能。它做了两件事：

1. **文件存在性检查**：使用 `Path(path).exists()` 验证文件是否存在。如果不存在，抛出 `FileNotFoundError`。这是一个防御性检查——与其让文件读取失败产生难以追踪的错误，不如在入口处明确失败。

2. **读取与解析**：调用 `read_text(encoding="utf-8")` 读取内容，然后委托给 `parse()` 方法。这种分层设计（load → parse）非常有价值，因为它允许：
   - 从文件加载：需要 `load()`
   - 从数据库/网络加载：直接调用 `parse()`，复用解析逻辑

```python
# 典型用法示例
skill = SkillLoader.load("examples/skills/adding-resource/SKILL.md")
print(skill["name"])           # "adding-resource"
print(skill["description"])    # "Add resources to OpenViking..."
```

#### `parse(content: str, source_path: str = "") -> Dict[str, Any]`

这是核心解析逻辑，采用**三阶段处理**：

**阶段一：Frontmatter 提取**

使用正则表达式 `r"^---\s*\n(.*?)\n---\s*\n(.*)$"` 提取 YAML frontmatter 和 body。这个正则的设计很精巧：
- `^---\s*\n`：匹配开头的 `---` + 可选空白 + 换行
- `(.*?)`：非贪婪匹配，捕获 YAML 内容
- `\n---\s*\n`：匹配结尾的 `---` + 可选空白 + 换行
- `(.*)$`：捕获剩余的 Markdown body

关键点：**非贪婪匹配 `(.*?)`** 确保即使 body 中包含 `---` 也不会被误匹配。`re.DOTALL` 标志让 `.` 匹配换行符，这是处理多行 YAML 的必要条件。

**阶段二：YAML 解析**

```python
meta = yaml.safe_load(frontmatter)
```

使用 `yaml.safe_load()` 而非 `yaml.load()` 是一个重要的安全决策——它防止了通过 YAML 注入 Python 对象的潜在风险。

**阶段三：字段校验**

```python
if "name" not in meta:
    raise ValueError("Skill must have 'name' field")
if "description" not in meta:
    raise ValueError("Skill must have 'description' field")
```

这是**强制性的契约检查**。任何 SKILL.md 文件都必须包含 `name` 和 `description` 字段，否则解析失败。这种"快速失败"（fail-fast）的设计避免了将错误延迟到下游处理时才暴露。

#### `_split_frontmatter(content: str) -> Tuple[Optional[str], str]`

这是一个私有辅助方法，封装了正则匹配的细节。返回值为 `(frontmatter, body)` 元组：
- 如果找到 frontmatter：返回 `(yaml_content, markdown_body)`
- 如果没有 frontmatter：返回 `(None, full_content)`

这种设计允许 `parse()` 方法在 frontmatter 不存在时给出明确的错误信息，而不是无声地跳过或产生奇怪的行为。

#### `to_skill_md(skill_dict: Dict[str, Any]) -> str`

这是**反向转换**方法：将解析后的字典重新序列化为 SKILL.md 格式。这是一个对称操作，使得 SkillLoader 既可以"读取"技能，也可以"写出"技能。

```python
# 序列化示例
skill = SkillLoader.load("path/to/SKILL.md")
reconstructed = SkillLoader.to_skill_md(skill)
# reconstructed 现在是可以写回文件的 Markdown 字符串
```

---

## SKILL.md 文件格式约定

理解 SkillLoader 的最佳方式是看一个实际的 SKILL.md 文件：

```markdown
---
name: adding-resource
description: Add resources to OpenViking, aka. ov. Use when an agent needs to add files, URLs, or external knowledge during interactions. Trigger this tool when 1. sees keyword "ovr"; 2. is explicitly requested adding files or knowledge; 3. identifies valuable resources worth importing
compatibility: CLI configured at `~/.openviking/ovcli.conf`
---

# OpenViking (OV) `add-resource`

The `ov add-resource` command imports external resources into OpenViking's context database — supporting local files, directories, URLs, and remote repositories. Resources are automatically processed with semantic analysis and organized under the `viking://resources/` namespace.

## When to Use

- Importing project documentation, code repositories, or reference materials
...
```

这个格式被称为 **YAML Frontmatter** 模式，是静态站点生成器（如 Jekyll、Hugo）常用的约定。选择这个格式有几个原因：

1. **机器可读**：YAML 结构化数据易于解析和验证
2. **人类可读**：即使不懂技术的人也能编辑 frontmatter
3. **与 Markdown 共存**：正文使用纯 Markdown，不受 YAML 语法影响
4. **元数据与内容分离**：便于系统索引（name、description）与人类阅读（body）分开处理

---

## 设计决策与权衡

### 1. 为什么不用更复杂的格式？

你可以想象一个更复杂的技能定义格式——比如 JSON Schema 验证、嵌套的 tool 定义、甚至专门的 DSL。但 OpenViking 选择了一个极简方案：

| 选择 | 替代方案 | 权衡 |
|------|----------|------|
| YAML Frontmatter | JSON 文件 | YAML 更适合包含多行字符串和注释 |
| 扁平结构 | 嵌套 Schema | 简单、易扩展、便于快速迭代 |
| 运行时解析 | 编译时生成 | 更灵活，支持动态加载 |

这种"足够好"（good enough）的哲学贯穿整个模块：**不要过度设计**。技能描述本质上是一个配置问题，YAML frontmatter 已经足够表达需求。

### 2. 为什么强制要求 name 和 description？

在 `parse()` 方法中，这两个字段是强制性校验的：

```python
if "name" not in meta:
    raise ValueError("Skill must have 'name' field")
if "description" not in meta:
    raise ValueError("Skill must have 'description' field")
```

这是因为：
- **`name`**：是技能的唯一标识符，用于在向量数据库中检索
- **`description`**：是技能的"语义锚点"，用于语义相似度计算

如果缺少这两个字段，技能就无法被正确索引和检索。让错误在解析阶段暴露，而不是等到运行时才发现"某个技能无法被搜索到"。

### 3. 为什么允许 optional 字段？

`allowed_tools` 和 `tags` 是可选的：

```python
"allowed_tools": meta.get("allowed-tools", []),
"tags": meta.get("tags", []),
```

这体现了**渐进式增强**的设计理念：
- 最简单的技能只需要 name + description
- 如果你想限制工具权限，加上 allowed-tools
- 如果你想标签分类，加上 tags

这种设计降低了编写技能的成本——你不需要为一个简单技能填写所有字段。

---

## 与其他模块的交互

### 向上依赖：谁调用 SkillLoader？

根据模块树结构，SkillLoader 被导出在 `openviking/core/__init__.py` 中，意味着它会被以下模块使用：

1. **Session 模块**：`Session.used()` 方法记录技能使用情况，需要从 SkillLoader 获取技能元数据
2. **Context 模块**：`Context` 类将技能数据转换为可向量化的对象时，需要先通过 SkillLoader 解析
3. **目录初始化**：`DirectoryInitializer` 在初始化 agent 技能目录时，可能需要加载技能文件

### 向下依赖：SkillLoader 依赖什么？

- `pathlib.Path`：Python 标准库，用于跨平台文件路径处理
- `re`：正则表达式，用于 frontmatter 提取
- `yaml`：第三方库，用于 YAML 解析

值得注意的是，SkillLoader **不依赖任何业务逻辑模块**——这正是"工具类"设计的目标：保持纯粹的转换逻辑，与业务解耦。

---

## 扩展点与注意事项

### 扩展方式

如果你想修改 SKILL.md 的解析逻辑，有几个扩展点：

1. **添加新字段**：在 `parse()` 方法的返回字典中添加新字段，并在 `to_skill_md()` 中同步序列化
2. **修改 Frontmatter 格式**：调整 `FRONTMATTER_PATTERN` 正则表达式
3. **添加验证规则**：在字段校验阶段添加更多检查

### 潜在 Gotchas

1. **编码问题**：
   ```python
   content = file_path.read_text(encoding="utf-8")
   ```
   明确指定 UTF-8 编码。如果技能文件使用其他编码（如 GBK），读取会失败。建议在文档中明确说明"请使用 UTF-8 编码保存 SKILL.md"。

2. **Frontmatter 必须紧贴开头**：
   ```python
   FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
   ```
   正则使用 `^` 锚定开头，意味着 frontmatter 必须是文件的前几个字符。文件开头的任何空白字符（如 BOM 或多余空行）都会导致匹配失败。

3. **YAML 语法限制**：
   Frontmatter 中的内容必须符合 YAML 语法。例如：
   ```yaml
   # 正确
   tags: [python, api, cli]
   
   # 正确
   tags:
     - python
     - api
     - cli
   
   # 错误（Python 风格列表在 YAML 中无效）
   tags: python, api, cli
   ```

4. **空 body 处理**：
   如果 SKILL.md 只有 frontmatter 没有 body，`parse()` 会返回空字符串作为 `content`。这通常是合法的（一个只有元数据的技能），但调用者需要做好处理空字符串的准备。

---

## 测试建议

为 SkillLoader 编写测试时，应该覆盖以下场景：

1. **正常路径**：标准格式的 SKILL.md 文件
2. **缺少字段**：name 或 description 缺失
3. **无效 YAML**：frontmatter 语法错误
4. **无 frontmatter**：纯 Markdown 文件
5. **多行内容**：description 包含换行符
6. **特殊字符**：内容中包含 YAML 保留字符（如 `:`、`#`）
7. **编码问题**：非 UTF-8 编码文件
8. **文件不存在**：路径指向不存在的文件
9. **Roundtrip**：load → to_skill_md → load 应该产生相同结果

---

## 参考资料

- [core_context_prompts_and_sessions 模块](core_context_prompts_and_sessions.md) - 了解技能在上下文体系中的定位
- [session_runtime 模块](session_runtime.md) - 了解 Session.used() 如何追踪技能使用
- [directory_definition 模块](core_context_prompts_and_sessions-session_runtime_and_skill_discovery-directory_definition.md) - 了解 `viking://agent/skills` 目录结构
- 示例技能文件：`examples/skills/adding-resource/SKILL.md`、`examples/skills/adding-memory/SKILL.md`