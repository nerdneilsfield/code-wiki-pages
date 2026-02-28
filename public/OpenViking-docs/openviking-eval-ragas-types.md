# openviking.eval.ragas.types — RAG 评估数据模型

> 本模块定义了 OpenViking RAG 评估系统的核心数据类型。从评估样本的原始输入到最终的聚合统计，这些类型贯穿整个评估管道的每一个环节。

## 问题空间：为什么需要这些类型

在构建一个 RAG（检索增强生成）评估系统时，我们面临一个核心挑战：**如何结构化地描述"一次评估"所需的所有信息，以及评估结果的产出形式**。

想象一下医生诊断病情：医生需要知道病人的症状（query）、检查报告（context）、诊断结果（response），以及最终确认的正确诊断（ground_truth）。类似地，评估一个 RAG 系统需要：

1. **输入**：用户问题 + 检索到的上下文 + 系统生成的答案 + 标准参考答案
2. **输出**：针对每个输入的计算得分 + 整个数据集的统计摘要

如果用散乱的字典或元组传递这些信息，代码会迅速变得难以维护。`types.py` 模块的核心价值在于：**它为评估管道各环节之间提供了稳定的数据契约**。生成器知道输出什么格式，评估器知道输入什么格式，消费者知道能从结果中期待什么字段。

## 核心抽象：四类数据类型的角色

这四个类型构成了一个分层的数据结构体系，每个类型都有其独特的语义角色：

```
EvalDataset (容器)
    │
    ├── samples: List[EvalSample] (多个样本)
    │
    └── name: str (数据集标识)
              │
              └── EvalSample (单个评估单元)
                  │
                  ├── query: str (用户问题)
                  ├── context: List[str] (检索到的上下文)
                  ├── response: Optional[str] (系统生成答案)
                  ├── ground_truth: Optional[str] (参考答案)
                  └── meta: Dict[str, Any] (元数据)
                              │
                              └── EvalResult (评估结果)
                                  │
                                  ├── sample: EvalSample (原始输入的引用)
                                  ├── scores: Dict[str, float] (各项指标得分)
                                  └── feedback: Optional[str] (定性反馈)
                                              │
                                              └── SummaryResult (聚合统计)
                                                  │
                                                  ├── dataset_name: str
                                                  ├── sample_count: int
                                                  ├── mean_scores: Dict[str, float]
                                                  └── results: List[EvalResult]
```

这种设计的核心洞察是：**评估结果需要保留对原始样本的引用**。当你在查看某个得分时，很可能需要追溯这个得分是怎么来的——原始的问题是什么、检索到了什么上下文。`EvalResult.sample` 字段直接嵌入原始 `EvalSample`，使得这种追溯成为 O(1) 操作，无需维护额外的映射表。

## 数据流：评估管道的生命周期

让我们追踪一条数据从生到死的完整路径：

### 第一阶段：数据集生成

`DatasetGenerator` 从原始文档或 VikingFS 路径中提取内容，利用 LLM 生成问答对，最终产出 `EvalDataset`：

```python
# 见 generator.py 中的 generate_from_content 方法
samples.append(
    EvalSample(
        query=item["question"],           # 用户问题
        ground_truth=item["answer"],       # 标准答案
        context=[item["context"]],         # 上下文片段（列表！）
        meta={"source": source_name}       # 血缘追踪
    )
)
dataset = EvalDataset(name=f"gen_{source_name}", samples=samples)
```

注意 `context` 是一个 **列表**而非单个字符串。这是因为 RAG 检索通常返回 top-k 个结果，每个结果都是一个独立的上下文片段。

### 第二阶段：评估执行

`BaseEvaluator` 或其实现类 `RagasEvaluator` 接收 `EvalDataset`，对每个样本计算指标，最终返回 `SummaryResult`：

```python
# 见 __init__.py 中 RagasEvaluator.evaluate_dataset 的核心逻辑
data = {
    "question": [s.query for s in dataset.samples],
    "contexts": [s.context for s in dataset.samples],  # 嵌套列表
    "answer": [s.response or "" for s in dataset.samples],
    "ground_truth": [s.ground_truth or "" for s in dataset.samples],
}
# RAGAS 库执行评估...
# 产出结果 DataFrame，转换为 EvalResult 列表
for i, sample in enumerate(dataset.samples):
    scores = {metric.name: float(df.iloc[i][metric.name]) for metric in self.metrics}
    eval_results.append(EvalResult(sample=sample, scores=scores))
```

### 第三阶段：结果聚合

`BaseEvaluator._summarize` 方法将多个 `EvalResult` 聚合成 `SummaryResult`：

```python
# 计算每个指标的平均分
metric_sums: Dict[str, float] = {}
for res in results:
    for metric, score in res.scores.items():
        metric_sums[metric] = metric_sums.get(metric, 0.0) + score

count = len(results)
mean_scores = {m: s / count for m, s in metric_sums.items()}
```

## 设计决策与权衡

### 1. Pydantic 作为数据验证层

选择 Pydantic 并非偶然。在一个涉及外部 LLM 调用、文件读取、网络请求的评估管道中，数据格式错误是常见的失败原因。Pydantic 提供了：

- **运行时验证**：`query` 必须是字符串，`context` 必须是字符串列表
- **类型提示**：IDE 能够提供完整的代码补全
- **序列化便利**：直接导出为 JSON 用于报告生成

这减少了评估器中的防御性代码（不需要每次访问字段时检查 `isinstance`），代价是极小的初始化开销。

### 2. 可选字段的设计哲学

`response` 和 `ground_truth` 都是 `Optional[str]`。这反映了一个重要洞察：**评估可以只关注检索质量，无需生成环节**。

当你只想评估"检索器是否找到了相关上下文"时，你可以只提供 `query` 和 `context`，让 `response` 和 `ground_truth` 为 `None`。这种灵活性使得同一套类型可以服务于不同的评估场景。

### 3. 嵌入而非引用

`EvalResult` 包含 `sample: EvalSample` 而非 `sample_id: str`。这是有意为之的设计：

- **优点**：无需维护 ID 映射，结果自包含，序列化/反序列化更简单
- **代价**：每个结果都携带完整的样本数据，有轻微的内存开销

在典型的评估场景中（几千到几万条样本），这个空间开销是可以接受的。代码的清晰度和调试的便利性才是主要考量。

### 4. 简单聚合策略

`mean_scores` 只做简单的算术平均。这是**最小可用设计**：

- 没有标准差、置信区间、分位数等统计指标
- 没有按子集分组的能力（如"只看某个文档类型的得分"）

这些功能可以后续在 `SummaryResult` 基础上扩展。保持核心类型简单，让消费者根据需要添加复杂度。

## 使用指南与最佳实践

### 创建评估样本

```python
from openviking.eval.ragas.types import EvalSample, EvalDataset

# 手动创建
sample = EvalSample(
    query="什么是 RAG?",
    context=["RAG 是检索增强生成的缩写...", "它结合了检索和生成..."],
    response="RAG = Retrieval-Augmented Generation",
    ground_truth="RAG 是检索增强生成，一种结合外部知识检索的语言模型增强技术",
    meta={"source": "wiki", "chunk_id": "doc_001"}
)

# 批量创建数据集
dataset = EvalDataset(
    name="rag_benchmark_v1",
    description="RAG 评估基准数据集",
    samples=[sample1, sample2, sample3]
)
```

### 处理评估结果

```python
# 遍历每个样本的结果
for result in summary_result.results:
    print(f"问题: {result.sample.query}")
    print(f"得分: {result.scores}")
    if result.feedback:
        print(f"反馈: {result.feedback}")

# 访问聚合统计
print(f"平均得分: {summary_result.mean_scores}")
```

### 常见陷阱

**陷阱 1：context 必须是列表**

```python
# 错误
sample = EvalSample(query="?", context="单字符串")  # ❌

# 正确
sample = EvalSample(query="?", context=["字符串1", "字符串2"])  # ✓
```

**陷阱 2：response/ground_truth 为 None 时的处理**

当评估纯检索任务时，这些字段为 `None` 是合法的。评估器需要处理这种情况：

```python
# 在 RagasEvaluator 中可以看到这种处理
"answer": [s.response or "" for s in dataset.samples]
```

**陷阱 3：mean_scores 只包含有数据的指标**

如果某些样本缺少某些指标的得分，`mean_scores` 计算时会跳过 `NaN` 值：

```python
# 见 __init__.py 中的逻辑
valid_scores = df[metric_name].dropna()
if len(valid_scores) > 0:
    mean_scores[metric_name] = float(valid_scores.mean())
```

这意味着如果有任何样本缺少某个指标，该指标就不会出现在 `mean_scores` 中。

## 依赖关系图

```
                    ┌─────────────────────────────┐
                    │    DatasetGenerator         │
                    │  (generator.py)             │
                    └──────────────┬──────────────┘
                                   │
                                   ▼ creates
                    ┌─────────────────────────────┐
                    │      EvalSample             │◄────────────┐
                    │  (types.py - 本模块)        │             │
                    └──────────────┬──────────────┘             │
                                   │                             │
           ┌───────────────────────┼───────────────────────┐    │
           │                       │                       │    │
           ▼                       ▼                       ▼    │
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ BaseEvaluator    │  │ RagasEvaluator   │  │  RAGEvaluator    │
│ (base.py)        │  │ (__init__.py)    │  │  (rag_eval.py)   │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                      │
         └─────────────────┬───┘                      │
                           │                          │
                           ▼                          │
                    ┌─────────────────────┐           │
                    │    EvalResult       │           │
                    │  (types.py - 本模块) │           │
                    └──────────┬──────────┘           │
                               │                      │
                               └────────┬─────────────┘
                                        ▼
                         ┌─────────────────────────────┐
                         │      SummaryResult          │
                         │  (types.py - 本模块)         │
                         └─────────────────────────────┘
```

## 相关模块

- **[openviking.eval.ragas.base](openviking-eval-ragas-base.md)** — 评估器基类，定义 `evaluate_sample` 和 `evaluate_dataset` 接口
- **[openviking.eval.ragas.generator](openviking-eval-ragas-generator.md)** — 数据集生成器，从原始内容创建 `EvalDataset`
- **[openviking.eval.ragas.ragas_evaluator](openviking-eval-ragas-ragas-evaluator.md)** — RAGAS 框架的具体实现
- **[openviking.eval.ragas.pipeline](openviking-eval-ragas-pipeline.md)** — RAG 查询管道，与评估系统集成

## 延伸思考

这个模块的设计体现了**数据模型先行**的思想。在构建复杂的评估管道之前，先定义好数据的形状，让各个组件围绕这些类型构建。这种方法的优势在于：

1. **接口清晰**：类型即文档
2. **可测试性**：可以单独对类型进行序列化/反序列化测试
3. **可扩展性**：添加新字段（如添加 `EvalSample.citations` 用于引用验证）时影响范围可控

未来的扩展方向可能包括：
- 支持多轮对话评估（添加 `conversation_history` 字段）
- 支持多语言评估（添加 `language` 字段）
- 支持细粒度评分（`scores` 从 `Dict[str, float]` 扩展为 `Dict[str, ScoreDetail]`）