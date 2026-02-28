# openviking.eval.ragas.generator 模块技术深度解析

## 模块概述

**dataset_generator** 模块是 OpenViking RAG 评估框架的核心组件之一，负责**生成评估数据集**。在 RAG（检索增强生成）系统的开发和迭代过程中，我们需要大量高质量的问答对来验证系统的性能——不仅需要验证检索质量，还需要验证生成答案的准确性和相关性。这个模块正是为了解决"从哪里获取评估数据"这个问题而设计的。

可以把 `DatasetGenerator` 想象成一个**数据工厂**：它接收原始内容（无论是来自 VikingFS 文件系统的文档，还是直接传入的文本字符串），然后利用 LLM 的能力自动生成结构化的问答三元组（question, answer, context）。这些三元组构成了 [EvalSample](./openviking-eval-ragas-types.md) 的核心字段，最终被送往 [BaseEvaluator](./openviking-eval-ragas-base-evaluator.md) 进行质量评估。

这个模块的设计理念是**声明式数据生成**：调用者只需指定数据源和期望的样本数量，生成器会自动处理内容分块、提示词构造、LLM 调用和结果解析等繁琐细节。

---

## 架构定位与数据流

### 在评估系统中的角色

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RAG 评估完整流程                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐      ┌──────────────────────┐      ┌───────────────┐  │
│  │  DatasetGenerator │ ──▶ │      EvalDataset     │ ──▶ │ BaseEvaluator │  │
│  │  (当前模块)        │      │  (见 types 文档)     │      │  (评估执行)    │  │
│  └──────────────────┘      └──────────────────────┘      └───────────────┘  │
│           │                                                    │              │
│           ▼                                                    ▼              │
│  ┌──────────────────┐                               ┌────────────────────┐   │
│  │ VikingFS / 原始文本 │                               │   SummaryResult    │   │
│  │   (数据源)         │                               │   (评估报告)       │   │
│  └──────────────────┘                               └────────────────────┘   │
│           │                                                                  │
│           ▼                                                                  │
│  ┌──────────────────┐                                                       │
│  │   LLM (VLM)     │                                                       │
│  │  (生成问答对)    │                                                       │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

从数据流的角度看，`DatasetGenerator` 位于评估流水线的**上游**。它解决的问题是"如何把非结构化的文档内容转换成结构化的评估样本"，而 [BaseEvaluator](./openviking-eval-ragas-base-evaluator.md) 解决的问题是"如何衡量一个 RAG 系统在给定样本上的表现"。

### 依赖关系分析

**该模块依赖（被调用方）：**
- [openviking.eval.ragas.types](./openviking-eval-ragas-types.md)：定义 `EvalDataset` 和 `EvalSample` 数据结构
- `openviking.storage.viking_fs.get_viking_fs`：VikingFS 文件系统接口，用于访问存储的文档资源
- LLM 接口（通过 `self.llm.get_completion_async`）：用于生成问答对

**依赖该模块（调用方）：**
- [RAGQueryPipeline](./openviking-eval-ragas-pipeline.md)：在完整的 RAG 评估流程中，先使用生成器创建测试数据集，再执行评估
- 评估脚本和 CLI 工具：直接实例化 `DatasetGenerator` 并调用生成方法

---

## 核心组件详解

### DatasetGenerator 类

```python
class DatasetGenerator:
    """
    Generates evaluation datasets from OpenViking resources.
    """
```

这个类是模块的唯一公开入口，采用了**简洁的工厂模式**设计。它提供两种数据生成路径：

#### 1. generate_from_viking_path 方法

```python
async def generate_from_viking_path(
    self,
    path: str,
    count: int = 5,
    scope: str = "resources",
    recursive: bool = True,
) -> EvalDataset:
```

**设计意图**：直接从 VikingFS 文件系统中指定路径读取文档内容并生成评估样本。这类似于一个"原地评估"的能力——用户可以针对已索引的文档目录快速生成测试数据。

**内部机制**：
- 构造 VikingFS URI：`viking://{scope}/{path}`
- 尝试列出目录中的文件（代码中为占位实现）
- 读取文件内容并进行必要的前处理
- 调用 LLM 生成问答对

**参数解析**：
| 参数 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `path` | str | 必填 | VikingFS 中的目录路径，如 `"docs/ai"` |
| `count` | int | 5 | 期望生成的样本数量 |
| `scope` | str | "resources" | VikingFS 的作用域 |
| `recursive` | bool | True | 是否递归搜索子目录 |

**返回值**：[EvalDataset](./openviking-eval-ragas-types.md) 对象，包含 `name`、`description` 和 `samples` 列表。

**注意**：当前实现中，`generate_from_viking_path` 方法的 VikingFS 文件列表逻辑是**占位实现**，实际返回空数据集。这反映了该方法的演进状态——接口已定义，但完整实现需要 VikingFS 提供稳定的目录列表 API。

#### 2. generate_from_content 方法

```python
async def generate_from_content(
    self,
    content: str,
    count: int = 3,
    source_name: str = "raw_content",
) -> EvalDataset:
```

**设计意图**：接收任意原始文本内容，生成结构化的评估样本。这是更通用的数据生成方式，适用于任何文本来源——可以直接传入文档内容、代码片段、会议记录等。

**内部机制**：
- 构建提示词，包含原始内容和要求生成的格式规范
- 调用 LLM 的异步接口 `get_completion_async` 获取响应
- 使用 `json_repair` 修复可能存在的不完整 JSON
- 解析 JSON 响应，构造 `EvalSample` 对象

**参数解析**：
| 参数 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `content` | str | 必填 | 原始文本内容 |
| `count` | int | 3 | 生成的问答对数量 |
| `source_name` | str | "raw_content" | 数据源名称，用于元数据 |

**核心提示词设计**：
```python
prompt = f"""
Given the following content, generate {count} question-answer pairs.
Each pair should include:
1. A question that can be answered using ONLY the provided content.
2. The correct answer based on the content.
3. The specific snippet/context from the content used to answer the question.

Format the output as a JSON list of objects:
[{{"question": "...", "answer": "...", "context": "..."}}, ...]

Content:
{content[:4000]}
"""
```

这里有一个重要的**工程约束**：内容被截断到前 4000 字符。这是因为 LLM 有上下文窗口限制，同时过长的内容会导致提示词成本激增。在实际应用中，可能需要更智能的**内容分块策略**——将长文档分割成多个片段，分别生成问答对，再合并到最终数据集中。

---

## 设计决策与权衡分析

### 1. 异步设计 vs 同步设计

**选择**：两个核心生成方法都使用了 `async def`，支持异步调用。

**理由**：LLM 调用是 IO 密集型操作，等待网络响应的时间远大于 CPU 计算时间。异步设计允许在生成多个样本时**并发**调用 LLM，显著提升吞吐量。在评估场景中，我们经常需要生成数百甚至数千个样本，同步阻塞模式会造成严重的性能瓶颈。

**权衡**：增加了调用方的复杂度。如果调用方是同步上下文（如传统的 Flask 路由），需要使用 `asyncio.run()` 或其他适配机制。

### 2. LLM 依赖的注入方式

**选择**：`DatasetGenerator` 接受一个可选的 `llm` 参数，依赖调用方注入。

```python
def __init__(self, llm: Optional[Any] = None):
    self.llm = llm
```

**理由**：
- **解耦**：生成器不关心 LLM 的具体实现，只要它提供 `get_completion_async` 方法即可。这使得同一套生成逻辑可以兼容不同的模型（GPT-4、Claude、本地模型等）。
- **灵活性**：调用方可以根据场景选择不同的模型——生成评估数据时可以用更便宜的模型，生产环境用更好的模型。
- **测试友好**：可以注入 mock LLM 进行单元测试。

**权衡**：接口松散，没有定义 LLM 的协议（Protocol）。如果调用方传入的 LLM 对象没有 `get_completion_async` 方法，运行时才会报错。

### 3. 错误处理的防御性策略

**选择**：方法内部使用了大量的 try-except 捕获异常，生成失败时返回**空数据集**而非抛出异常。

```python
except Exception as e:
    logger.error(f"Failed to generate samples: {e}")
    return EvalDataset(name=f"gen_{source_name}", samples=[])
```

**理由**：
- **优雅降级**：在评估流水线中，一个样本生成失败不应该导致整个任务中止。返回空数据集可以让评估流程继续运行，稍后可以通过日志追溯失败原因。
- **容错性**：网络不稳定、LLM 服务临时不可用等情况时有发生，防御性处理避免了单点故障。

**权衡**：可能掩盖真正的问题。如果 LLM 配置错误（如 API Key 过期），生成器会静默返回空数据集，用户可能很长时间后才意识到没有生成任何测试数据。建议在实际使用中添加更明确的失败指标。

### 4. JSON 修复的务实选择

**选择**：使用 `json_repair` 库来修复 LLM 返回的可能不完整的 JSON。

```python
from json_repair import repair_json
clean_json = repair_json(response)
data = json.loads(clean_json)
```

**理由**：LLM 的输出格式不稳定是一个**已知问题**。即使在提示词中明确要求 JSON 格式，模型仍可能：
- 输出的 JSON 外包裹 Markdown 代码块标记（```json ... ```）
- 缺少最后一个逗号或右括号
- 使用了全角引号而非半角引号

`json_repair` 库专门用于处理这类"脏"JSON，避免了手工编写脆弱的正则表达式解析逻辑。

---

## 使用指南与最佳实践

### 基本用法示例

```python
from openviking.eval.ragas.generator import DatasetGenerator

# 初始化生成器（需要注入 LLM）
generator = DatasetGenerator(llm=my_vlm_processor)

# 方式一：从原始文本生成
dataset = await generator.generate_from_content(
    content="""OpenViking is a RAG system that combines...
    It supports multiple document types including PDF, Markdown, and code.""",
    count=5,
    source_name="intro_doc"
)
print(f"生成了 {len(dataset.samples)} 个样本")

# 方式二：从 VikingFS 路径生成（当前为占位实现）
dataset = await generator.generate_from_viking_path(
    path="docs/ai",
    count=10,
    scope="resources"
)
```

### 连接到完整评估流程

```python
from openviking.eval.ragas.generator import DatasetGenerator
from openviking.eval.ragas.base import RagasEvaluator

# 1. 生成评估数据
generator = DatasetGenerator(llm=vlm)
dataset = await generator.generate_from_content(
    content=open("my_document.txt").read(),
    count=20
)

# 2. 执行评估
evaluator = RagasEvaluator(metrics=["faithfulness", "answer_correctness"])
summary = await evaluator.evaluate_dataset(dataset)

# 3. 查看结果
print(f"平均 faithfulness: {summary.mean_scores['faithfulness']}")
```

### 配置与扩展点

**LLM 选择**：可以通过替换不同的 LLM 实现来改变生成质量：
- 使用更强的模型（如 GPT-4）生成更高质量的问答对
- 使用本地模型降低成本
- 使用专为代码理解优化的模型处理代码文档

**提示词定制**：当前提示词是硬编码的。如果需要针对特定领域（如法律文档、医学报告）优化，可以考虑：
- 子类化 `DatasetGenerator`，覆盖生成逻辑
- 添加提示词模板配置

---

## 已知限制与注意事项

### 1. VikingFS 路径方法尚未完全实现

`generate_from_viking_path` 方法当前返回空数据集，因为 VikingFS 目录列表功能是占位实现。在使用此方法前，请确认 VikingFS API 已提供稳定的 `list` 或 `glob` 接口。

### 2. 内容长度限制

当前实现对输入内容有 4000 字符的硬截断限制。对于长文档，建议**先进行智能分块**，再对每个块调用 `generate_from_content`，最后合并结果：

```python
# 简化的分块策略示例
chunks = [content[i:i+4000] for i in range(0, len(content), 3500)]
all_samples = []
for chunk in chunks:
    ds = await generator.generate_from_content(chunk, count=3)
    all_samples.extend(ds.samples)
```

### 3. LLM 接口契约

当前代码假设 LLM 对象具有 `get_completion_async` 方法，但没有通过 Protocol 或 ABC 定义正式接口。传入不兼容的对象会导致运行时错误。建议在使用前进行类型检查或接口验证。

### 4. 生成质量的局限性

LLM 生成的问答对质量依赖于：
- 原始内容的清晰度和信息密度
- 提示词的设计
- LLM 本身的能力

自动生成的问答对可能存在**偏差**——问题可能过于简单，答案可能不够精确。在关键任务中，建议结合**人工审核**或使用更严格的评估协议。

---

## 未来演进方向

基于当前的代码状态和评估系统的需求，这个模块可能会在以下方向演进：

1. **完整的 VikingFS 集成**：实现目录递归遍历和文件内容读取
2. **智能内容分块**：根据文档结构（标题、段落、代码块）进行语义分块，而非简单字符截断
3. **多模态支持**：扩展支持 PDF、图像等非纯文本内容
4. **领域自适应提示词**：为不同文档类型（技术文档、法律文本、医学报告）提供专用提示词模板
5. **质量过滤机制**：添加自动检测问答对质量的启发式规则，过滤低质量样本

---

## 相关模块文档

- [openviking-eval-ragas-types](./openviking-eval-ragas-types.md) — 评估数据类型定义
- [openviking-eval-ragas-base-evaluator](./openviking-eval-ragas-base-evaluator.md) — 评估器抽象基类
- [openviking-eval-ragas-pipeline](./openviking-eval-ragas-pipeline.md) — RAG 查询流水线
- [openviking-eval-ragas-config](./openviking-eval-ragas-config.md) — RAGAS 评估配置