# issue_hydration_scan（`internal/storage/dolt/issue_scan.go`）

这个文件体量小，但在架构里是“防漂移接头”。它解决的是：`types.Issue` 字段越来越多时，查询列与扫描顺序极易失配，导致隐蔽 bug。

## 为什么存在

如果每个查询点都手写一份 `SELECT ...` + `Scan(...)`，几个月后一定出现：

- 某处忘了新字段，读出来是零值。
- 列顺序变了，`Scan` 错位。
- nullable/time/json 字段在不同路径处理不一致。

`issue_scan.go` 用两件事控制这个风险：

1. `issueSelectColumns`：定义“完整 issue 读取”的标准列清单。
2. `scanIssueFrom(issueScanner)`：统一从 `*sql.Row` 或 `*sql.Rows` 扫描并做类型/nullable 映射。

## 抽象设计

`issueScanner` 接口只要求 `Scan(dest ...any) error`，它同时兼容 `*sql.Row` 与 `*sql.Rows`。这是一种低成本多态：不引入泛型，不复制扫描逻辑。

## 关键实现语义

- `created_at` / `updated_at` 是 TEXT 列，必须 `parseTimeString`。
- `ephemeral` / `pinned` / `is_template` / `crystallizes` 用 `sql.NullInt64` 映射布尔。
- `waiters` 字段用 `parseJSONStringArray` 反序列化。
- `metadata` 仅在非空且不为 `{}` 时写入 `issue.Metadata`。

## 贡献者注意

- 新增 `types.Issue` 字段时，必须同时更新 `issueSelectColumns` 与 `scanIssueFrom` 的 `Scan` 顺序与映射。
- 该文件是多个读取路径共用组件，改动会影响广；建议配套回归测试覆盖单行读取与多行读取两种路径。
