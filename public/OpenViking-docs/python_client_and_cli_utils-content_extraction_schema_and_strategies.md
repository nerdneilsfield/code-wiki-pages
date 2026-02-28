# content_extraction_schema_and_strategies 模块文档

## 模块概述

`content_extraction_schema_and_strategies` 模块（位于 `openviking_cli/utils/extractor.py`）是 OpenViking 系统中用于内容提取的数据类型定义层。把它想象成一座桥梁的"桥墩"——它本身不处理复杂的业务逻辑，但为上层的文档解析、视觉语言模型（VLM）处理和多模态内容理解提供了稳定的数据结构支撑。

这个模块解决的问题非常直接：当你从 PDF、扫描件或其他文档中提取内容时，你需要一种统一的方式来描述"这是一张图片"、"那是一个表格"、"这段是纯文本"。如果没有统一的类型定义，每个开发者可能用不同的数据结构来表示这些信息，导致系统内部充满了脆弱的字符串比较和隐式约定。这个模块通过枚举（Enum）和数据类（dataclass）提供了**类型安全、字段完整、自描述的数据结构**，让整个系统的数据流动变得可预测、可调试。

## 架构角色与数据流

### 在系统中的位置

从模块树结构来看，这个模块位于 `python_client_and_cli_utils` 的核心组件层，被多个下游模块依赖：

```
python_client_and_cli_utils
├── content_extraction_schema_and_strategies (当前模块)
│   └── 被 openviking/parse/vlm.py 导入使用
├── llm_and_rerank_clients
│   └── StructuredLLM 处理结构化输出
└── configuration_models_and_singleton
    └── VLMConfig 配置视觉语言模型
```

### 数据流动全景

理解这个模块的最好方式是追踪一条典型的数据流：

1. **PDF 解析阶段**：`PDFParser`（位于 `openviking/parse/parsers/pdf.py`）读取 PDF 文件，调用 pdfplumber 或 MinerU API 进行转换
2. **内容提取阶段**：解析器识别出图片、表格、文本等不同内容类型，填充 `ExtractionResult` 及其包含的 `ImageInfo` / `TableInfo` 对象
3. **VLM 理解阶段**：`VLMProcessor`（位于 `openviking/parse/vlm.py`）接收这些结构化对象，调用视觉语言模型进行深度理解
4. **结果输出阶段**：最终的结构化理解结果（L0/L1/L2 抽象层级）被存入向量数据库或返回给调用方

```
PDF文件 
    → PDFParser.parse() 
    → ExtractionResult (ImageInfo[], TableInfo[]) 
    → VLMProcessor.understand_image/table()
    → VLMResult (abstract/overview/detail_text)
    → 存入向量库或返回
```

## 核心组件详解

### 枚举类型：分类的边界

#### ContentType — 内容类型分类

```python
class ContentType(Enum):
    TEXT_ONLY = "text_only"
    IMAGE_ONLY = "image_only"
    MIXED = "mixed"
```

这个枚举回答的问题是："这个文档的主要内容是什么？"设计者选择用简单的三分类是因为在实际场景中，绝大多数文档都可以归类为：纯文本、纯图片（扫描件）、或图文混合。使用 `MIXED` 作为兜底类型避免了无限扩张的分类体系。

**使用场景**：在 `VLMProcessor.batch_analyze_document()` 中，系统根据 `content_type` 决定是否需要调用视觉模型。如果 `ContentType == TEXT_ONLY`，可以跳过昂贵的 VLM 调用，直接进行文本分析。

#### PDFSubType — PDF 子类型细分

```python
class PDFSubType(Enum):
    TEXT_NATIVE = "text_native"      # 原生文字 PDF
    IMAGE_SLIDE = "image_slide"      # PPT 导出的图片幻灯片
    IMAGE_SCAN = "image_scan"        # 扫描件
    MIXED_NATIVE = "mixed_native"    # 混合类型
```

这个枚举解决了一个实际问题：不是所有 PDF 都是平等的。一份"原生文字 PDF"可以轻松提取文本，而"扫描件"需要通过 OCR 或 VLM 才能理解。`PDFSubType` 帮助下游系统选择正确的处理策略——对于 `IMAGE_SCAN`，系统会自动启用 VLM 进行页面理解。

#### MediaType — 媒体内容类型

```python
class MediaType(Enum):
    IMAGE = "image"
    TABLE = "table"
    CHART = "chart"
    FORMULA = "formula"
```

这个枚举超出了简单的"图片 vs 文本"二分法，区分了**需要不同处理策略的视觉元素**。图表（chart）和公式（formula）通常需要专门的提示词或后处理来正确理解。比如，VLM 处理表格时可能会使用"table_understanding"提示词模板，而处理普通图片时使用"image_understanding"模板。

#### MediaStrategy — 提取策略选择

```python
class MediaStrategy(Enum):
    TEXT_ONLY = "text_only"           # 纯文本提取
    EXTRACT_AND_REPLACE = "extract"   # 提取后替换（保留位置信息）
    FULL_PAGE_VLM = "full_page_vlm"   # 整页 VLM 分析
```

这是模块中最具"策略性"的枚举。它回答的不是"这是什么"，而是"怎么处理它"。在 `openviking/parse/base.py` 中有一个 `calculate_media_strategy()` 函数会根据图片数量和行数自动计算合适的策略：

- **text_only**：文档以文本为主，图片很少或没有
- **extract**：图片数量适中，单独提取后用 VLM 理解
- **full_page_vlm**：图片密集型文档（图片占比 > 30% 或图片数 ≥ 5），适合整页分析

这种策略模式避免了"一个策略打天下"的困境，让系统能够根据内容特征自适应选择最优处理路径。

### 数据类：结构化的内容描述

#### ImageInfo — 图片元数据

```python
@dataclass
class ImageInfo:
    path: Path
    page: int
    position: Tuple[float, float, float, float]  # (x0, y0, x1, y1) 页面坐标
    media_type: MediaType = MediaType.IMAGE
    width: int = 0
    height: int = 0
    format: str = "png"
    context: str = ""           # 周围文本上下文（用于 VLM 理解）
    placeholder: str = ""       # 占位符文本
```

`ImageInfo` 的设计体现了几个关键决策：

1. **position 字段**：使用 `(x0, y0, x1, y1)` 四元组而非简单的"第几个图片"，因为在 PDF 中图片位置对理解内容语义很重要（比如一张流程图的顺序）
2. **context 字段**：这是为 VLM 准备的关键字段——图片周围的文本可以帮助视觉模型更准确地理解图片内容（比如图表的坐标轴说明）
3. **默认值设计**：除了 `path`、`page`、`position` 这三个必需字段外，其他都是可选的，这反映了提取过程中信息的不完整性（早期阶段可能不知道图片尺寸）

#### TableInfo — 表格元数据

```python
@dataclass
class TableInfo:
    path: Path
    page: int
    position: Tuple[float, float, float, float]
    raw_data: Optional[List[List[str]]] = None  # 结构化表格数据
    media_type: MediaType = MediaType.TABLE
    rows: int = 0
    cols: int = 0
    context: str = ""
    placeholder: str = ""

    def has_structured_data(self) -> bool:
        return self.raw_data is not None and len(self.raw_data) > 0
```

`TableInfo` 有一个独特的设计：`raw_data` 字段可以包含已解析的结构化表格数据（如二维数组）。这个设计的原因是：有些 PDF 解析器（如 pdfplumber）可以直接提取表格的行列数据，不需要通过 VLM。当 `raw_data` 存在时，系统可以直接生成 Markdown 表格，而无需调用昂贵的视觉模型。

`has_structured_data()` 方法是这种"优先使用结构化数据"策略的体现——在 `VLMProcessor.understand_table()` 中，如果表格已有结构化数据，直接使用；否则才回退到 VLM 理解。

#### ExtractionResult — 提取结果容器

```python
@dataclass
class ExtractionResult:
    text_content: str
    images: List[ImageInfo] = field(default_factory=list)
    tables: List[TableInfo] = field(default_factory=list)
    content_type: ContentType = ContentType.TEXT_ONLY
    page_count: int = 0
    meta: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
```

这是整个模块的"收官"数据结构。它采用**组合模式**：一个 `ExtractionResult` 包含文本内容、所有图片的元数据、所有表格的元数据，以及一些辅助信息。

设计亮点：

1. **content_type 字段**：自动推断内容类型，避免调用方手动判断
2. **warnings 字段**：这是一个防御性设计——提取过程中可能遇到各种问题（部分图片解析失败、表格结构异常等），通过 warnings 记录而非抛出异常，让调用方决定如何处理
3. **meta 字段**：使用 `Dict[str, Any]` 提供扩展性，允许不同解析器嵌入自定义元数据

## 设计决策与权衡

### 1. 纯数据模型，无业务逻辑

这个模块只定义数据结构，不包含任何处理逻辑。这是有意的设计选择：将**"数据是什么"**（schema）和**"数据怎么用"**（logic）分离。

**权衡**：这种分离增加了模块数量，但带来了更好的可测试性和模块化。开发者可以单独测试数据类的序列化/反序列化，而不需要 mock 复杂的业务逻辑。

### 2. 使用 dataclass 而非 Pydantic

模块使用 Python 标准库的 `dataclass` 而非更强大的 Pydantic `BaseModel`。

**权衡**：这是一个**面向简单性**的选择。dataclass 足够满足数据容器的需求，且没有运行时验证的开销。但如果未来需要更复杂的验证逻辑（比如 `page` 必须 >= 0），可能需要迁移到 Pydantic。

### 3. 位置坐标使用浮点数元组

`position` 字段定义为 `Tuple[float, float, float, float]` 而非专门的 Position 类。

**权衡**：这遵循了"不过度设计"原则。如果将来需要更多位置相关方法（如计算面积、检测重叠），可以重构为独立的类。但目前，简单的元组足够且易于序列化。

### 4. 字符串枚举值

所有枚举使用字符串值（如 `"text_only"`）而非默认值（整数）。

**权衡**：这主要是为了**调试友好**和**跨语言兼容**。当你在日志或调试器中看到 `ContentType.TEXT_ONLY` 时，直接显示字符串值而非数字，更容易理解。而且，如果未来需要与 JavaScript 或其他语言的服务交互，字符串 JSON 序列化更直观。

## 使用指南与最佳实践

### 创建 ExtractionResult

```python
from pathlib import Path
from openviking_cli.utils.extractor import (
    ExtractionResult, ImageInfo, TableInfo, 
    ContentType, MediaType
)

# 创建图片信息
img = ImageInfo(
    path=Path("/tmp/doc/page1_fig1.png"),
    page=0,
    position=(100.0, 200.0, 400.0, 500.0),
    width=300,
    height=300,
    context="Figure 1 shows the system architecture"
)

# 创建表格信息（带结构化数据）
tbl = TableInfo(
    path=Path("/tmp/doc/page2_table1.png"),
    page=1,
    position=(50.0, 100.0, 550.0, 400.0),
    raw_data=[["Name", "Age"], ["Alice", "30"], ["Bob", "25"]],
    rows=3,
    cols=2
)

# 创建提取结果
result = ExtractionResult(
    text_content="# Document Title\n\nThis is the main text...",
    images=[img],
    tables=[tbl],
    content_type=ContentType.MIXED,
    page_count=10
)
```

### 根据 MediaStrategy 选择处理方式

```python
from openviking.parse.base import calculate_media_strategy

# 根据内容特征自动计算策略
strategy = calculate_media_strategy(
    image_count=len(extraction_result.images),
    line_count=len(extraction_result.text_content.splitlines())
)

if strategy == "full_page_vlm":
    # 使用整页 VLM 分析
    results = await vlm_processor.batch_understand_pages(page_images)
elif strategy == "extract":
    # 逐个提取并理解图片/表格
    for img in extraction_result.images:
        img_result = await vlm_processor.understand_image(img.path, img.context)
else:
    # 纯文本处理
    text_result = extraction_result.text_content
```

## 注意事项与陷阱

### 1. 坐标系单位

`ImageInfo.position` 和 `TableInfo.position` 使用的是 PDF 原始坐标（通常以点为单位，72 DPI）。如果需要在屏幕上渲染或转换到其他坐标系，需要进行比例转换。

### 2. page 字段的起始值

代码中 `page` 字段使用 **0-based 索引**（即第一页是 `page=0`），但在与用户交互时（如日志、UI），通常需要显示 **1-based**（第一页显示为"第 1 页"）。注意在 `VLMProcessor` 中有 `page + 1` 的转换：

```python
f"Image {i + 1}: Located on page {img.page + 1}"
```

### 3. raw_data 的空值判断

使用 `TableInfo.has_structured_data()` 方法而非直接检查 `raw_data`，因为这个方法同时检查了非空和长度：

```python
# 正确做法
if table.has_structured_data():
    # 使用 raw_data

# 错误做法（可能遗漏空数组情况）
if table.raw_data:
    # raw_data 可能是空列表 []，这在布尔上下文中是 False
```

### 4. 路径序列化

`ImageInfo.path` 和 `TableInfo.path` 使用 `pathlib.Path` 对象。在跨进程通信（如异步任务序列化）时，需要确保 Path 可以被正确序列化。标准做法是在传输前转换为字符串：

```python
# 序列化
data = {"path": str(img.path), "page": img.page, ...}

# 反序列化
img = ImageInfo(path=Path(data["path"]), page=data["page"], ...)
```

## 相关模块参考

- **[parse/base.md](parse/base.md)** — 定义了 `calculate_media_strategy()` 函数和文档解析的基础抽象
- **[python_client_and_cli_utils-llm_and_rerank_clients.md](python_client_and_cli_utils-llm_and_rerank_clients.md)** — `StructuredLLM` 类处理 LLM 结构化输出
- **[python_client_and_cli_utils-configuration_models_and_singleton.md](python_client_and_cli_utils-configuration_models_and_singleton.md)** — `VLMConfig` 配置视觉语言模型
- **[model_providers_embeddings_and_vlm-vlm_abstractions_factory_and_structured_interface.md](model_providers_embeddings_and_vlm-vlm_abstractions_factory_and_structured_interface.md)** — VLM 工厂和基础接口