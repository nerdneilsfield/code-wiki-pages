# base_evaluator 模块技术深度解析

## 概述

`base_evaluator` 模块是 OpenViking 评估框架的核心抽象层，它定义了一套用于评估检索增强生成（RAG）系统质量的接口契约。如果你刚刚加入团队，可能会有疑问：为什么需要这样一个基础类？直接写评估函数不行吗？

这个模块的存在解决了一个根本性问题：**RAG 系统的评估是多维度、多层次的**。一次完整的评估既需要关注单个查询的效果（检索到的上下文是否相关？生成的答案是否准确？），也需要汇总整个数据集上的整体表现（平均得分是多少？哪些指标存在短板？）。如果没有统一的抽象，不同的评估器会各自为政，难以复用、难以对比、也难以扩展。

`BaseEvaluator` 采用模板方法模式，为所有具体评估器提供了一个「评估流水线」的骨架：接收单个样本进行评分 → 将多个样本批量评估 → 汇总统计。它不关心你用什么样的指标（ faithfulness、answer_relevancy、context_precision 还是自定义指标），只关心评估的流程和控制流。

---

## 架构角色与数据流

### 模块定位

在 OpenViking 的整体架构中，`base_evaluator` 位于评估与度量模块的核心位置。它的上游是被评估的数据集生成器（`DatasetGenerator`）和 RAG 查询管道（`RAGQueryPipeline`），下游是具体的评估实现（如 `RagasEvaluator`）和结果消费者（报表生成、日志记录等）。

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ DatasetGenerator │───▶│   BaseEvaluator  │───▶│ SummaryResult   │
│ (生成评估样本)   │    │ (评估器基类)     │    │ (汇总报告)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              △
                              │ 继承
                              │
                       ┌──────┴──────┐
                       │ RagasEvaluator │
                       │ (具体实现)    │
                       └─────────────┘
```

### 核心抽象

`BaseEvaluator` 定义了两个核心方法：

1. **`evaluate_sample(sample: EvalSample) -> EvalResult`** — 抽象方法，每个子类必须实现。它接收一个评估样本（包含查询、检索到的上下文、生成的答案和标准答案），返回一个包含各项指标得分的评估结果。

2. **`evaluate_dataset(dataset: EvalDataset) -> SummaryResult`** — 模板方法，提供批量评估的默认实现。它遍历数据集中的所有样本，调用 `evaluate_sample`，然后将结果汇总为统计摘要。

这两个方法构成了评估的「原子操作」和「批量操作」的抽象层次。上层调用方可以根据场景选择评估单个样本或批量评估整个数据集，而无需关心内部的实现细节。

### 数据类型契约

理解这个模块还需要理解它依赖的四个核心数据类型（定义在 `types.py` 中）：

- **EvalSample**：单个评估样本，包含 `query`（用户问题）、`context`（检索到的上下文列表）、`response`（RAG 系统生成的答案）、`ground_truth`（标准答案，可选）以及 `meta`（额外元数据）。
  
- **EvalResult**：单个样本的评估结果，包含原始样本引用、一个 `scores` 字典（指标名到分数的映射）以及可选的 `feedback`（定性反馈或错误信息）。

- **EvalDataset**：样本集合，一个简单的容器类型，带有 `samples` 列表、`name` 和可选的 `description`。

- **SummaryResult**：批量评估的汇总结果，包含数据集名称、样本数量、各指标的平均分以及完整的逐样本结果列表。

这种数据类型的设计遵循了「数据流清晰」的原则：样本进来，结果出去，中间是评估逻辑。每个类型都有明确的职责，不携带额外的状态。

---

## 设计决策与权衡

### 选择抽象基类而非接口

`BaseEvaluator` 使用 Python 的 `ABC`（抽象基类）而非纯协议（Protocol），这是一个有意识的设计选择。原因在于：评估器不仅需要定义方法签名，还需要提供**可复用的默认实现**。`evaluate_dataset` 的批量评估逻辑和 `_summarize` 的汇总逻辑可以在基类中实现，具体评估器只需关注单个样本的评估逻辑。

当然这也意味着如果需要完全不同的批量处理策略（例如并行评估），子类需要覆盖 `evaluate_dataset`。目前的设计选择是：先提供最简单的顺序实现，后续如有性能需求再考虑扩展。这种「先简单后优化」的思想在评估框架中是合理的，因为评估任务通常不是实时敏感的。

### 异步设计

所有评估方法都是 `async` 的。这并非过度设计，而是因为评估过程本质上是 I/O 密集型的：调用 LLM 获取答案、计算嵌入向量、访问外部 API 都涉及网络等待。如果使用同步方法，批量评估会变成串行的性能瓶颈。虽然当前基类的默认实现是顺序的，但 async 为后续的并行化改造留下了空间（可以借助 `asyncio.gather` 或 `aiohttp` 实现真正的并发评估）。

### 简单的聚合策略

基类提供的 `_summarize` 方法只计算**算术平均数**。这是一个有意为之的简化。评估框架的复杂度需要在「提供足够的统计信息」和「保持简单易用」之间取得平衡。平均值是最直观、最容易理解的汇总统计，适用于大多数场景。如果需要更复杂的统计（如中位数、分位数、标准差），子类可以覆盖 `_summarize` 或在 `evaluate_dataset` 中实现自定义逻辑。

---

## 使用指南

### 创建自定义评估器

如果你需要实现一个自定义的评估指标（例如专门评估代码检索效果的指标），只需要继承 `BaseEvaluator` 并实现 `evaluate_sample` 方法：

```python
from openviking.eval.ragas.base import BaseEvaluator
from openviking.eval.ragas.types import EvalSample, EvalResult

class CodeRetrievalEvaluator(BaseEvaluator):
    """评估代码检索质量的评估器。"""
    
    async def evaluate_sample(self, sample: EvalSample) -> EvalResult:
        # 假设我们有一个自定义的代码相关性评分函数
        relevance_score = await self._compute_code_relevance(
            query=sample.query,
            contexts=sample.context,
            ground_truth=sample.ground_truth
        )
        
        # 可以返回多个指标
        scores = {
            "code_relevance": relevance_score,
            "context_length": len("".join(sample.context))
        }
        
        return EvalResult(
            sample=sample,
            scores=scores
        )
    
    async def _compute_code_relevance(self, query, contexts, ground_truth):
        # 这里放置你的评估逻辑
        # 可能是基于字符串匹配、AST 分析、或者调用外部服务
        pass
```

然后可以这样使用：

```python
evaluator = CodeRetrievalEvaluator()
result = await evaluator.evaluate_dataset(dataset)
print(result.mean_scores)  # 打印各指标的平均分
```

### 批量评估的性能考虑

当前的默认实现是**顺序执行**的。如果你的评估涉及大量样本或调用外部服务，可能会感到性能不足。有几种优化途径：

1. **子类覆盖 `evaluate_dataset`**：在子类中实现并行评估逻辑，使用 `asyncio.gather` 并发处理多个样本。
   
2. **使用 `RagasEvaluator`**：如果你使用 RAGAS 框架，它已经内置了并发评估支持（通过 `max_workers` 和 `batch_size` 参数配置）。

3. **分片处理**：将大型数据集拆分为小批次，分别调用 `evaluate_dataset`，然后手动合并结果。

---

## 依赖分析与集成点

### 上游依赖

`BaseEvaluator` 依赖以下模块：

- `openviking.eval.ragas.types`：提供 `EvalSample`、`EvalResult`、`EvalDataset`、`SummaryResult` 四个核心类型。这是评估数据的「契约」，所有评估器都必须遵循这些类型规范。
  
- Python 标准库 `abc`：提供抽象方法定义能力。

值得注意的是，`BaseEvaluator` 并没有依赖任何特定的 LLM 提供商、嵌入模型或外部服务。它是完全自主的抽象层，可以与任何评估逻辑配合使用。

### 下游使用方

目前已知的具体实现是 `RagasEvaluator`（定义在 `__init__.py` 中），它扩展了 `BaseEvaluator` 并集成了 RAGAS 框架的评估能力。此外，`rag_eval.py` 中的 `run_ragas_evaluation` 函数也展示了如何使用评估器：

```python
ragas_eval = RagasEvaluator()
ragas_result = await ragas_eval.evaluate_dataset(dataset)
```

如果你需要创建新的评估器（例如基于特定领域的指标），只需遵循同样的模式：继承 `BaseEvaluator`，实现 `evaluate_sample`，然后在业务代码中实例化并调用。

---

## 潜在陷阱与注意事项

### 1. 空数据集处理

`_summarize` 方法对空结果列表做了特殊处理：直接返回 `sample_count=0` 和空的 `mean_scores`。这是合理的安全防护，但调用方需要注意，空数据集不会触发任何评估逻辑，可能导致某些预期的副作用（如日志记录、指标上报）被跳过。

### 2. 异步上下文要求

由于方法是异步的，调用方必须使用 `await` 或 `asyncio.run()` 来执行评估。如果在同步上下文中直接调用，会得到 `RuntimeWarning: coroutine was never awaited`。

### 3. 指标命名一致性

`EvalResult.scores` 是一个字典，键是指标名称（字符串），值是分数（float）。基类本身不强制指标命名规范，但如果与 `RagasEvaluator` 配合使用，建议使用 RAGAS 标准的指标名称（如 `faithfulness`、`answer_relevancy`、`context_precision`、`context_recall`），以便结果可以与其他 RAGAS 评估进行对比。

### 4. 默认实现不并行

再次强调：`evaluate_dataset` 的默认实现是顺序遍历样本。对于小规模数据集这不是问题，但对于数百个样本的评估任务，性能可能不理想。如果这是你的使用场景，请考虑覆盖该方法实现并行评估。

---

## 相关模块参考

- **[ragas_evaluation_core](./ragas_evaluation_core.md)** — RAGAS 评估核心模块，包含配置、评估器和数据集生成器。
  
- **[ragas_config_and_evaluator](./ragas_config_and_evaluator.md)** — RAGAS 配置与具体评估器实现。

- **[data_types](./data_types.md)** — 评估数据类型定义（EvalSample、EvalResult、EvalDataset、SummaryResult）。

- **[retrieval_query_orchestration](./retrieval_query_orchestration.md)** — RAG 查询管道，与评估模块上游配合使用。

- **[evaluation_recording_and_storage_instrumentation](./evaluation_recording_and_storage_instrumentation.md)** — 评估结果记录与存储 instrumentation。