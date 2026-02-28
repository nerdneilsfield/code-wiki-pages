# RAG 评估核心数据类型模块 (data_types)

## 概述

本模块定义了 OpenViking 评估系统的核心数据类型，是 RAG (Retrieval-Augmented Generation) 评估流水线的数据载体。模块位于 `openviking/eval/ragas/types.py`，使用 Pydantic 构建了一套从单一样本到数据集再到聚合结果的完整类型层级。

如果你把整个评估系统想象成一条流水线，那么这个模块就是流水线上承载"工件"的容器——它不关心评估如何发生，只关心如何正确地表示待评估的样本、评估后的结果、以及跨数据集的聚合统计。这类似于物流系统中的"货箱"：箱子本身不移动货物，但它定义了货物的规格、标签和堆叠方式。

## 架构角色

这个模块在整个评估系统中的角色是**数据契约定义者**。它不包含业务逻辑，仅作为纯数据类型存在，被 [BaseEvaluator](ragas-evaluation-core-base-evaluator.md)、[DatasetGenerator](ragas-evaluation-core-dataset-generator.md) 和 [RagasEvaluator](ragas-evaluation-core-ragas-config-and-evaluator.md) 三个核心组件使用。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RAG 评估流水线                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐ │
│  │ DatasetGenerator │───▶│   EvalDataset    │───▶│ BaseEvaluator    │ │
│  │ (生成评估样本)    │    │  (数据容器)       │    │ (执行评估)        │ │
│  └──────────────────┘    └──────────────────┘    └────────┬─────────┘ │
│                                                           │           │
│                                                           ▼           │
│                                                  ┌──────────────────┐ │
│                                                  │   EvalResult     │ │
│                                                  │ (单样本评估结果)   │ │
│                                                  └────────┬─────────┘ │
│                                                           │           │
│                                                           ▼           │
│                                                  ┌──────────────────┐ │
│                                                  │  SummaryResult   │ │
│                                                  │ (数据集聚合结果)   │ │
│                                                  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 类型层级设计

模块定义了四个核心类型，形成一个清晰的层级结构：

- **EvalSample** — 评估的最小单元，表示一个(query, context, response, ground_truth)元组
- **EvalResult** — 将 EvalSample 与其评估分数绑定，表示"这个样本评估后得到什么"
- **EvalDataset** — 样本的集合容器，提供便利的集合操作接口
- **SummaryResult** — 跨数据集的聚合结果，包含均值统计

这种设计遵循了"样本→结果→集合→聚合"的自然思维流程。每个类型职责单一，通过组合形成更复杂的数据结构。

## 核心组件详解

### EvalSample：评估的原子单元

```python
class EvalSample(BaseModel):
    query: str                              # 用户查询/问题
    context: List[str]                      # 检索到的上下文片段
    response: Optional[str]                 # LLM 生成的答案
    ground_truth: Optional[str]             # 参考/正确答案
    meta: Dict[str, Any]                    # 额外的元数据
```

**设计意图**：EvalSample 是评估的最小不可分单元。它采用"宽恕"的设计原则——`response` 和 `ground_truth` 都是可选的，这允许系统支持多种评估场景：

- **有标准答案的评估**：提供 ground_truth，计算精确匹配或语义相似度
- **无标准答案的评估**：仅评估 response 的质量属性（如 Faithfulness、Answer Relevancy）
- **冷启动评估**：甚至可以只有 query 和 context，用于测试检索质量

`meta` 字段是一个灵活的扩展点，允许携带来源信息、创建时间、评分权重等辅助数据，而不必修改核心结构。

### EvalResult：样本与分数的绑定

```python
class EvalResult(BaseModel):
    sample: EvalSample                      # 被评估的样本
    scores: Dict[str, float]                # 指标名称到分数的映射
    feedback: Optional[str]                 # 定性反馈或错误信息
```

**设计意图**：EvalResult 将"被评估的对象"与"评估的结果"明确关联。这种设计有几个实际好处：

1. **追溯性**：当看到某个分数时，可以立即追溯到原始样本，诊断异常case
2. **多指标支持**：使用 `Dict[str, float]` 而非固定字段，允许评估器返回任意数量的指标（RAGAS 默认返回 Faithfulness、Answer Relevancy、Context Precision、Context Recall 四个指标）
3. **错误传播**：`feedback` 字段允许评估器报告部分失败——即使某些指标计算失败，也能返回其他结果

### EvalDataset：样本的集合容器

```python
class EvalDataset(BaseModel):
    samples: List[EvalSample] = Field(default_factory=list)
    name: str = "default_dataset"
    description: Optional[str] = None
    
    def __len__(self) -> int:
        return len(self.samples)
```

**设计意图**：EvalDataset 不仅仅是一个列表封装，它还携带了数据集的元数据（name、description），这对于结果追踪和报告生成至关重要。`__len__` 方法的显式定义是为了让数据集可以无缝用于 `len()` 函数和迭代场景。

### SummaryResult：聚合统计

```python
class SummaryResult(BaseModel):
    dataset_name: str                       # 数据集名称
    sample_count: int                       # 样本数量
    mean_scores: Dict[str, float]           # 各指标的均值
    results: List[EvalResult]               # 完整的评估结果列表
```

**设计意图**：SummaryResult 代表了"评估的终点"——它包含了所有样本的详细结果以及聚合统计。`mean_scores` 使用简单的算术平均，这是 RAG 评估中的默认选择，因为它直观且计算成本低。

值得注意的是，结果列表被完整保留而非仅保留统计值。这种设计权衡了存储空间与灵活性——调用方可以事后计算中位数、标准差，或进行分组分析，而不必重新运行评估。

## 数据流分析

### 典型评估流程

完整的 RAG 评估流程如下：

```
1. 数据准备阶段
   └─▶ DatasetGenerator.generate_from_content() 
       └─▶ 返回 EvalDataset (含 EvalSample 列表)

2. RAG 执行阶段  
   └─▶ RAGQueryPipeline.query()
       └─▶ 填充 EvalSample.response 字段
       
3. 评估执行阶段
   └─▶ RagasEvaluator.evaluate_dataset(dataset)
       ├─▶ 将 EvalDataset 转换为 RAGAS 格式
       ├─▶ 调用 ragas.evaluate() 获取指标分数
       └─▶ 返回 SummaryResult

4. 结果消费阶段
   └─▶ SummaryResult.mean_scores / .results
       └─▶ 用于报告生成、可视化或持续监控
```

### 类型转换点

在 [RagasEvaluator.evaluate_dataset()](ragas-evaluation-core-ragas-config-and-evaluator.md) 中，可以看到类型转换的关键逻辑：

```python
# EvalDataset → RAGAS 内部格式
data = {
    "question": [s.query for s in dataset.samples],
    "contexts": [s.context for s in dataset.samples],
    "answer": [s.response or "" for s in dataset.samples],
    "ground_truth": [s.ground_truth or "" for s in dataset.samples],
}
ragas_dataset = Dataset.from_dict(data)

# RAGAS 结果 → EvalResult 列表
for i, sample in enumerate(dataset.samples):
    scores = {metric.name: float(df.iloc[i][metric.name]) ...}
    eval_results.append(EvalResult(sample=sample, scores=scores))
```

这种"平展-转换-重建"的过程是适配外部评估框架的常见模式。模块的类型设计正是为了支持这种转换：字段名称与 RAGAS 期望的键（question、contexts、answer、ground_truth）保持一致。

## 设计决策与权衡

### 1. Pydantic 而非数据类

选择 Pydantic (BaseModel) 而非 Python 内置的 `dataclass`，主要目的是利用其**运行时验证**和**序列化能力**。在评估流水线中，数据往往来自外部来源（文件、API、LLM 输出），Pydantic 可以自动：

- 验证必填字段是否存在
- 类型检查（如确保 scores 是 Dict[str, float]）
- 提供清晰的验证错误信息
- 无缝支持 JSON 序列化/反序列化

**权衡**：Pydantic 相比 dataclass 有一定的性能开销，但在评估场景中（批量处理、IO 密集），这通常是可接受的。

### 2. 灵活的指标分数存储

```python
scores: Dict[str, float] = Field(..., description="Metric names and their scores")
```

选择字典而非固定字段（如 `faithfulness: float, answer_relevancy: float`）是一种**开放封闭原则 (Open-Closed Principle)** 的体现：

- **开放**：新增指标不需要修改类型定义
- **封闭**：现有代码不需要感知新增的指标
- **灵活性**：不同评估器可以返回不同指标集

**权衡**：失去了静态类型检查的明确性（无法在编译时知道有哪些指标），但换取了系统可扩展性。

### 3. 可选的 response 和 ground_truth

如前所述，这两个字段的可选性是为了支持多种评估范式。但这也意味着调用方必须处理可能的 None 值——在 [RagasEvaluator](ragas-evaluation-core-ragas-config-and-evaluator.md) 中可以看到对空值的显式处理：

```python
"answer": [s.response or "" for s in dataset.samples],
"ground_truth": [s.ground_truth or "" for s in dataset.samples],
```

### 4. 保留完整结果列表

在 SummaryResult 中保留 `results: List[EvalResult]` 而非仅统计值，是基于**"计算即服务"**的理念：评估是昂贵的（涉及 LLM 调用），保留完整结果允许事后分析，而重新计算统计值是廉价的。

## 使用指南与最佳实践

### 创建 EvalSample

```python
from openviking.eval.ragas.types import EvalSample

# 完整构造
sample = EvalSample(
    query="什么是 OpenViking?",
    context=["OpenViking 是一个知识管理工具...", "它支持 RAG 检索..."],
    response="OpenViking 是一个基于 RAG 的知识管理工具。",
    ground_truth="OpenViking 是火山引擎开发的知识管理助手。",
    meta={"source": "docs/faq.md", "timestamp": "2026-01-15"}
)

# 最小构造（用于检索质量评估）
sample = EvalSample(
    query="如何添加文档?",
    context=["使用 client.add_resource() 方法..."]
)
```

### 创建 EvalDataset

```python
from openviking.eval.ragas.types import EvalDataset, EvalSample

dataset = EvalDataset(
    name="faq_evaluation",
    description="FAQ 页面的 RAG 质量评估",
    samples=[
        EvalSample(query="...", context=[...], response="...", ground_truth="..."),
        EvalSample(query="...", context=[...], response="...", ground_truth="..."),
    ]
)

# 使用 len() 获取样本数
print(f"数据集包含 {len(dataset)} 个样本")
```

### 处理评估结果

```python
# 从 SummaryResult 提取指标
summary: SummaryResult = await evaluator.evaluate_dataset(dataset)

# 打印均值分数
for metric, score in summary.mean_scores.items():
    print(f"{metric}: {score:.3f}")

# 遍历每个样本的详细结果
for result in summary.results:
    print(f"\nQuery: {result.sample.query}")
    print(f"Response: {result.sample.response}")
    for metric, score in result.scores.items():
        print(f"  {metric}: {score:.3f}")
    if result.feedback:
        print(f"  Feedback: {result.feedback}")
```

## 注意事项与陷阱

### 1. 空数据集处理

`BaseEvaluator._summarize()` 方法对空结果列表有特殊处理：

```python
if not results:
    return SummaryResult(
        dataset_name=name,
        sample_count=0,
        mean_scores={},
        results=[]
    )
```

如果你的评估流水线可能产生空数据集，调用方需要正确处理这种边界情况（mean_scores 将是空字典，而非抛出异常）。

### 2. 分数类型转换

RAGAS 返回的分数可能是 numpy 类型，在转换为 EvalResult 时需要显式转换为 Python 原生类型：

```python
scores[metric_name] = float(df.iloc[i][metric_name])
```

忽视这一点可能导致后续序列化（如 JSON 编码）失败。

### 3. context 是字符串列表

注意 `EvalSample.context` 的类型是 `List[str]`，每个元素是一个上下文片段。在某些场景下（如长文档），可能需要考虑分块策略——如果原始上下文超过 LLM 上下文窗口限制，评估结果可能不准确。

### 4. 元数据的一致性

当通过 `DatasetGenerator` 生成数据集时，`meta` 字段会自动填充来源信息。但如果手动构造 EvalSample，请确保 meta 的语义一致性——不同来源的数据混在一起时，报告可能产生误导。

## 依赖关系

### 上游依赖（谁调用这个模块）

| 模块 | 关系 |
|------|------|
| [BaseEvaluator](ragas-evaluation-core-base-evaluator.md) | 使用 EvalSample, EvalResult, EvalDataset, SummaryResult |
| [DatasetGenerator](ragas-evaluation-core-dataset-generator.md) | 返回 EvalDataset |
| [RagasEvaluator](ragas-evaluation-core-ragas-config-and-evaluator.md) | 使用所有四个类型进行输入输出转换 |
| [RAGQueryPipeline](retrieval-and-evaluation-retrieval-query-orchestration.md) | 输出结构可映射到 EvalSample |

### 下游依赖（这个模块调用谁）

本模块是纯数据定义，不直接依赖其他业务模块。它依赖：

- `pydantic.BaseModel` — 数据验证与序列化
- `typing` — 类型提示
- `typing.Any` — 动态类型支持

## 扩展点

如果需要扩展评估数据类型，推荐的方式是：

1. **继承现有类型**：如果只需要添加字段，可以创建子类
2. **使用 meta 字段**：对于评估器特定的配置或结果，使用 `EvalSample.meta` 或 `EvalResult.feedback` 传递
3. **新指标类型**：在 `EvalResult.scores` 字典中添加新的键值对

例如，如果需要添加置信度信息，可以这样扩展：

```python
class EvalSampleWithConfidence(EvalSample):
    confidence: Optional[float] = None
    
# 使用时
sample = EvalSampleWithConfidence(
    query="...",
    context=[...],
    confidence=0.92  # 新增字段
)
```

## 相关文档

- [BaseEvaluator](ragas-evaluation-core-base-evaluator.md) — 评估器抽象基类
- [DatasetGenerator](ragas-evaluation-core-dataset-generator.md) — 数据集生成器
- [RagasEvaluator](ragas-evaluation-core-ragas-config-and-evaluator.md) — RAGAS 评估器实现
- [RAGQueryPipeline](retrieval-and-evaluation-retrieval-query-orchestration.md) — RAG 查询流水线
- [RagasConfig](ragas-evaluation-core-ragas-config-and-evaluator.md) — 评估配置