# base_evaluator 模块技术深度解析

## 概述

`base_evaluator` 模块是 OpenViking 评估框架的核心抽象层，位于 `openviking.eval.ragas.base` 包中。它定义了一个通用的评估接口，使系统能够对 RAG（检索增强生成）系统的输出进行量化评估。简单来说，这个模块解决的是"如何知道一个 RAG 系统好不好"的问题——它提供了标准的评估契约，让不同的评估实现可以插拔式地替换。

在实际的 RAG 应用中，我们经常需要回答这样的问题：检索到的上下文是否 relevant？生成的答案是否faithful（忠实于上下文）？答案是否正确？这些都需要量化的指标来衡量。BaseEvaluator 就是为这个问题提供一个统一的抽象入口。

---

## 架构位置与依赖关系

```
retrieval_and_evaluation/
└── ragas_evaluation_core/
    ├── base_evaluator (当前模块)
    ├── ragas_config_and_evaluator/
    │   ├── RagasConfig
    │   └── RagasEvaluator (BaseEvaluator 的实现)
    ├── dataset_generator/
    │   └── DatasetGenerator (生成 EvalSample)
    └── data_types/
        ├── EvalSample
        ├── EvalResult
        ├── EvalDataset
        └── SummaryResult
```

### 数据流全景图

```
用户代码 / 评估任务
         │
         ▼
   ┌─────────────┐
   │ EvalDataset │ ← 由 DatasetGenerator 或手动构建
   └─────────────┘
         │
         ▼
   ┌───────────────────┐
   │ BaseEvaluator     │ ← 抽象接口
   │ (evaluate_dataset)│
   └───────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 RAGAS    其他实现
评估器     (可扩展)
    │
    ▼
┌─────────────────────┐
│ SummaryResult       │ ← 聚合结果
│ (mean_scores, etc.) │
└─────────────────────┘
```

---

## 核心抽象设计

### BaseEvaluator 类

BaseEvaluator 是一个抽象基类（ABC），它定义了两个核心方法的契约：

```python
class BaseEvaluator(ABC):
    @abstractmethod
    async def evaluate_sample(self, sample: EvalSample) -> EvalResult:
        """评估单个样本"""
        pass

    async def evaluate_dataset(self, dataset: EvalDataset) -> SummaryResult:
        """评估整个数据集"""
        pass
```

这里有一个**微妙但重要的设计决策**：虽然 `evaluate_sample` 是抽象方法（必须由子类实现），但 `evaluate_dataset` 提供了默认实现。这个默认实现采用顺序处理的简单策略——它遍历数据集中的每个样本，依次调用 `evaluate_sample`，然后聚合结果。

**为什么要这样设计？**

这种设计体现了 API 设计中的"里氏替换原则"和"开放封闭原则"的平衡。默认实现保证了最基础的可用性——如果你只需要简单的顺序评估，不需要重写任何方法。但同时，子类可以override `evaluate_dataset` 来实现更高效的处理策略。例如，`RagasEvaluator` 正是这样做的：它override了 `evaluate_dataset` 方法，利用 RAGAS 框架的批量处理和并行计算能力，在内部将整个数据集一次性传递给 RAGS 进行评估。

---

## 数据模型契约

BaseEvaluator 与四个核心数据类型紧密配合，理解它们的职责对理解整个评估流程至关重要：

### EvalSample — 评估的原子单元

```python
class EvalSample(BaseModel):
    query: str              # 用户查询/问题
    context: List[str]      # 检索到的上下文片段
    response: Optional[str] # LLM 生成的答案
    ground_truth: Optional[str]  # 参考/正确答案（可选）
    meta: Dict[str, Any]    # 额外元数据
```

这个模型的设计反映了一个重要的评估理念：RAG 系统的质量取决于三个核心组件的交互——查询（Query）、上下文（Context）和答案（Response）。ground_truth 字段是可选的，这很重要，因为某些指标（如 Faithfulness）不需要参考答案，它们只需要评估答案是否忠实于提供的上下文。

### EvalResult — 单样本评估结果

```python
class EvalResult(BaseModel):
    sample: EvalSample      # 原始样本的引用
    scores: Dict[str, float]  # 指标名称到分数的映射
    feedback: Optional[str] # 定性反馈或错误信息
```

使用字典而非固定字段来存储分数是一个灵活的设计选择。不同的评估器可能计算不同的指标——RAGAS 默认提供 Faithfulness、Answer Relevancy、Context Precision、Context Recall 等，而自定义评估器可能添加其他指标如精确率、召回率或自定义业务指标。

### EvalDataset — 样本集合

```python
class EvalDataset(BaseModel):
    samples: List[EvalSample]
    name: str = "default_dataset"
    description: Optional[str] = None
```

### SummaryResult — 聚合结果

```python
class SummaryResult(BaseModel):
    dataset_name: str
    sample_count: int
    mean_scores: Dict[str, float]  # 每个指标的平均分
    results: List[EvalResult]      # 每个样本的详细结果
```

---

## 设计决策与权衡

### 决策一：抽象基类 vs 协议（Protocol）

BaseEvaluator 使用 `ABC`（抽象基类）而非 Python 的 `Protocol`（结构化类型）。这是一个经过权衡的选择。

抽象基类的优势在于：
- 可以提供默认实现（如 `evaluate_dataset`）
- 强制子类实现特定方法（`evaluate_sample`）
- 在 Python 中更广泛被理解和接受

如果使用 Protocol，虽然在类型检查上更"松散"（只检查方法签名，不要求继承），但无法提供默认实现，每个评估器都需要自己实现整个评估流程。

**当前选择适合的场景**：OpenViking 的评估框架需要支持不同的评估后端（RAGAS 是第一个，也可能有其他），默认实现的顺序处理可以作为"降级方案"或"参考实现"。

### 决策二：同步的 _summarize 方法

注意 `_summarize` 是一个同步方法，而非 async：

```python
def _summarize(self, name: str, results: List[EvalResult]) -> SummaryResult:
    """聚合结果 into a summary."""
    # ... 简单的数学聚合操作
```

这是一个务实的选择。聚合操作只是简单的数学计算（求和、平均），不涉及 I/O 操作或复杂计算。将其设为同步方法可以避免异步调度的开销，代码意图也更清晰。这种"在 async 函数中调用同步函数"的模式是安全的，因为同步代码不会阻塞事件循环——只有当心代码包含阻塞 I/O 或 CPU 密集型操作时才需要担心。

### 决策三：空结果处理

在 `_summarize` 中，空结果列表会返回一个"零分" SummaryResult：

```python
if not results:
    return SummaryResult(
        dataset_name=name,
        sample_count=0,
        mean_scores={},
        results=[]
    )
```

这种宽容的设计避免了除零错误，但调用者需要自行判断 `sample_count == 0` 的情况。另一种选择是抛出异常，但这会增加调用者的负担。这是一个风格选择，OpenViking 选择了更宽容的"空安全"处理。

---

## 使用场景与扩展点

### 场景一：使用 RAGAS 框架评估

最常见的使用方式是使用 `RagasEvaluator`，它继承了 BaseEvaluator 并利用 RAGAS 框架提供行业标准的 RAG 评估指标：

```python
from openviking.eval.ragas import RagasEvaluator, EvalDataset, EvalSample

# 构建评估数据集
dataset = EvalDataset(
    name="my_eval_set",
    samples=[
        EvalSample(
            query="什么是 OpenViking?",
            context=["OpenViking 是一个 AI 助手..."],
            response="OpenViking 是一个 AI 助手平台。",
            ground_truth="OpenViking 是一个 AI 助手平台。"
        ),
    ]
)

# 初始化评估器（需要安装 ragas 和 datasets）
evaluator = RagasEvaluator()

# 执行评估
result = await evaluator.evaluate_dataset(dataset)
print(result.mean_scores)
```

### 场景二：自定义评估指标

如果需要添加自定义评估指标或使用不同的评估框架，可以继承 BaseEvaluator：

```python
class CustomEvaluator(BaseEvaluator):
    async def evaluate_sample(self, sample: EvalSample) -> EvalResult:
        # 实现自定义评估逻辑
        custom_score = self._compute_custom_metric(sample)
        return EvalResult(
            sample=sample,
            scores={"custom_metric": custom_score}
        )
```

### 场景三：批量处理优化

如果评估的数据量很大，可以考虑override `evaluate_dataset` 来实现批量处理或并行评估：

```python
async def evaluate_dataset(self, dataset: EvalDataset) -> SummaryResult:
    # 使用 asyncio.gather 并行评估
    tasks = [self.evaluate_sample(s) for s in dataset.samples]
    results = await asyncio.gather(*tasks)
    return self._summarize(dataset.name, results)
```

---

## 与其他模块的交互

### 上游：数据集生成

`DatasetGenerator` 模块负责生成 `EvalSample`。它可以从原始文本内容或 VikingFS 路径创建评估数据集。这一步通常发生在评估之前，准备待评估的查询-上下文-答案三元组。

### 上游：RAG 查询管道

`RAGQueryPipeline` 负责执行完整的 RAG 流程：添加文档、检索上下文、生成答案。它的输出可以直接用作 `EvalSample` 的来源。

### 下游：结果消费

评估结果（`SummaryResult`）通常用于：
- 生成评估报告
- 监控 RAG 系统质量
- A/B 测试不同配置
- 触发告警或自动调优

---

## 潜在陷阱与注意事项

### 1. LLM 依赖

RAGAS 评估需要 LLM 来计算某些指标（如 Faithfulness、Answer Relevancy）。如果不配置 LLM，评估会失败。确保通过环境变量或配置对象提供了有效的 LLM 凭据。

### 2. 异步调用约定

BaseEvaluator 的方法都是异步的。调用时需要使用 `await`：

```python
# 正确
result = await evaluator.evaluate_dataset(dataset)

# 错误 - 会返回 coroutine 对象而非结果
result = evaluator.evaluate_dataset(dataset)
```

### 3. 大数据集的性能

默认的 `evaluate_dataset` 实现是顺序处理的。对于大规模评估任务（数百或数千个样本），建议使用 `RagasEvaluator` 或自行实现批量处理。

### 4. 指标可用性

不同的评估器可能支持不同的指标。RAGAS 提供的指标包括 Faithfulness、Answer Relevancy、Context Precision、Context Recall。在使用结果前，应检查 `mean_scores` 字典中是否存在所需的指标。

### 5. 空上下文处理

如果 `EvalSample` 的 `context` 字段为空列表，某些指标可能返回 NaN 或产生警告。这是正常的 RAG 边界情况——系统无法从空上下文中检索任何内容。

---

## 参考资料

- [RAGAS 官方文档](https://docs.ragas.io/) — 了解 Faithfulness、Answer Relevancy 等指标的具体定义
- [openviking.eval.ragas.types](./ragas-evaluation-core-data-types.md) — 数据类型详细定义
- [openviking.eval.ragas.generator](./ragas-evaluation-core-dataset-generator.md) — 数据集生成器
- [openviking.eval.ragas.pipeline](./retrieval-query-orchestration.md) — RAG 查询管道