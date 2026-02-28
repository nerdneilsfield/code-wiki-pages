# document_loader_contracts_and_options-interface 子模块

## 概述

本子模块定义了 Eino 文档处理系统的**核心抽象契约**。如果说整个文档摄取系统是一家公司，那么这个子模块就是公司的"职位描述"——它定义了有哪些岗位、每个岗位的职责是什么，但不管谁来坐这个位置。

**核心职责**：
- 定义文档的来源（Source）
- 定义加载器的抽象接口（Loader）
- 定义转换器的抽象接口（Transformer）

---

## 核心组件

### Source —— 文档的"地址"

```go
type Source struct {
    URI string
}
```

**设计意图**：

`Source` 是整个文档处理流水线的起点。它极简的设计是有意为之的：

1. **单一职责**：只携带"去哪里找文档"的信息，不包含任何处理逻辑
2. ** URI 泛化**：URI 不仅限于 HTTP URL，还可以是：
   - 本地文件路径：`file:///path/to/document.pdf`
   - 云存储路径：`s3://bucket/document.docx`
   - 任意可寻址的资源
3. **服务可达性保证**：文档注释中明确要求"确保 URI 可以被服务访问"，这意味着 Source 的使用者需要自己处理 URI 的解析和访问

**类比**：把 `Source` 想象成一张写有地址的明信片。邮递员（Loader）不需要知道这个地址背后是什么房子，只需要知道把明信片送到指定位置即可。

### Loader 接口 —— 文档加载的统一契约

```go
type Loader interface {
    Load(ctx context.Context, src Source, opts ...LoaderOption) ([]*schema.Document, error)
}
```

**设计意图**：

`Loader` 接口是整个模块最核心的抽象。它的设计体现了几个关键考量：

| 设计决策 | 理由 |
|----------|------|
| **返回切片** `[]*schema.Document` | 一个 Source 可能包含多个文档（如一个 ZIP 文件），也可能是单一文档，统一返回切片简化调用方逻辑 |
| **可变选项** `opts ...LoaderOption` | 使用函数式选项模式，允许加载器接受灵活的配置，同时保持 API 简洁 |
| **返回 error** | 加载失败是常态（文件不存在、格式损坏、网络超时），错误必须显式处理 |

**与 Parser 的关系**：

Loader 和 Parser 是合作关系，但职责不同：
- **Loader**：负责从 Source 获取原始内容（可能是二进制流、HTML 字符串等）
- **Parser**：负责解析原始内容为结构化的 Document

一个典型的实现可能同时扮演两个角色，也可能在 Loader 内部调用独立的 Parser。

### Transformer 接口 —— 文档转换的统一契约

```go
type Transformer interface {
    Transform(ctx context.Context, src []*schema.Document, opts ...TransformerOption) ([]*schema.Document, error)
}
```

**设计意图**：

`Transformer` 接口的存在是为了支持文档的后处理流水线。常见的转换操作包括：

| 转换类型 | 说明 | 示例 |
|----------|------|------|
| **分割** | 将大文档拆分为小块 | 文档切分器（Chunker） |
| **过滤** | 移除不符合条件的文档 | 长度过滤、元数据过滤 |
| **增强** | 为文档添加额外信息 | 添加嵌入向量、标注 |

**设计一致性**：

`Transformer` 的签名与 `Loader` 保持高度一致：
- 都是可变选项模式
- 都返回 `[]*schema.Document`
- 都接受 `context.Context`

这种一致性允许它们被串联成处理链：

```go
// 伪代码：文档处理流水线
docs, err := loader.Load(ctx, source)
docs, err = chunker.Transform(ctx, docs)
docs, err = filter.Transform(ctx, docs)
```

---

## 数据流

```
Source (URI)
    │
    ▼
Loader.Load()
    │
    ├─ 获取原始内容 (HTTP/本地文件/云存储)
    │
    ├─ (可选) 调用 Parser 解析
    │
    └─ 返回 []*schema.Document
            │
            ▼
     Transformer.Transform()
            │
            ├─ 转换逻辑 (切分/过滤/增强)
            │
            └─ 返回处理后的文档
```

---

## 与其他组件的关系

| 组件 | 关系 |
|------|------|
| **Source** | Loader 的输入参数，Transformer 的输入可能来自 Loader 的输出 |
| **LoaderOption** | Loader 接口的可变参数，为加载过程提供配置 |
| **TransformerOption** | Transformer 接口的可变参数，为转换过程提供配置 |
| **schema.Document** | Loader 返回、Transformer 处理的基本单元 |

---

## 实现注意事项

### 实现 Loader 接口

```go
type MyLoader struct {
    // 内部状态
}

func (m *MyLoader) Load(ctx context.Context, src document.Source, opts ...document.LoaderOption) ([]*schema.Document, error) {
    // 1. 提取通用选项
    commonOpts := document.GetLoaderCommonOptions(&document.LoaderOptions{}, opts...)
    
    // 2. 提取实现特定选项
    myOpts := document.GetLoaderImplSpecificOptions(&MyOptions{}, opts...)
    
    // 3. 加载逻辑
    // ...
    
    return docs, nil
}
```

### 实现 Transformer 接口

```go
func (t *MyTransformer) Transform(ctx context.Context, src []*schema.Document, opts ...document.TransformerOption) ([]*schema.Document, error) {
    myOpts := document.GetTransformerImplSpecificOptions(&MyTransformOptions{}, opts...)
    
    // 转换逻辑
    // ...
    
    return result, nil
}
```

---

## 小结

这个子模块建立的抽象层是整个文档处理系统的基础：

1. **Source** 提供了统一的文档寻址方式
2. **Loader** 定义了如何从各种来源获取文档
3. **Transformer** 定义了如何对文档进行流水线处理

这三个抽象共同构成了"文档摄取"的骨架，使得框架可以：
- 轻松扩展新的加载器类型
- 自由组合转换步骤
- 保持 API 的一致性和可预测性