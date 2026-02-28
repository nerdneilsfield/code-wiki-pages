# 语义重复检测模块 (semantic_duplicate_detection) 技术深度解析

## 1. 问题背景与模块定位

### 1.1 问题空间

在 issue 管理系统中，重复 issue 是一个普遍存在的问题。传统的精确重复检测（如 [exact_duplicate_detection](cmd-bd-duplicates.md)）仅能识别内容完全相同的 issue，然而实际场景中存在大量**语义相似但表述不同**的 issue：

- 同一个问题被不同用户用不同措辞描述
- 同一功能的需求被多次提出但细节略有差异
- 相似的 bug 报告在不同时间点提交

这些语义重复 issue 会导致：
- 工作重复和资源浪费
- 分散的讨论和决策
- 难以追踪问题的整体进展

### 1.2 解决方案

`semantic_duplicate_detection` 模块通过两种互补的方法解决这个问题：

1. **机械方法**：基于 token 级别的文本相似度计算，快速且无需外部依赖
2. **AI 方法**：使用 Claude LLM 进行语义级别的比较，更准确但需要 API 调用

## 2. 核心架构与数据流

### 2.1 架构概览

```mermaid
flowchart TD
    A[用户调用 find-duplicates] --> B[参数解析与验证]
    B --> C[获取 issues 列表]
    C --> D{方法选择}
    D -->|mechanical| E[机械相似度计算]
    D -->|ai| F[AI 语义比较]
    E --> G[结果排序与限制]
    F --> G
    G --> H[输出展示]
    
    subgraph 机械方法
        E1[预 token 化]
        E2[Jaccard 相似度]
        E3[Cosine 相似度]
        E4[平均得分]
        E1 --> E2
        E1 --> E3
        E2 --> E4
        E3 --> E4
    end
    
    subgraph AI 方法
        F1[机械预过滤]
        F2[候选对限制]
        F3[分批 AI 分析]
        F4[结果解析]
        F1 --> F2
        F2 --> F3
        F3 --> F4
    end
    
    E --> 机械方法
    F --> AI 方法
```

### 2.2 核心数据结构

```go
// duplicatePair 表示一对潜在重复的 issue
type duplicatePair struct {
    IssueA     *types.Issue `json:"issue_a"`
    IssueB     *types.Issue `json:"issue_b"`
    Similarity float64      `json:"similarity"`  // 0.0-1.0 的相似度分数
    Method     string       `json:"method"`      // "mechanical" 或 "ai"
    Reason     string       `json:"reason,omitempty"`  // AI 方法提供的解释
}
```
