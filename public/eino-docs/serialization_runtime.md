# serialization_runtime（`internal/serialization/serialization.go`）

`serialization_runtime` 是 Internal Utilities 里最“基础但危险”的一层：它解决的是 **“把 `any/interface{}` 里的运行时真实类型安全地落盘，再安全地还原”**。如果没有它，跨中断恢复（checkpoint）、跨模块传递动态数据时，系统很容易退化成“只有 JSON 值，没有类型语义”，最终在恢复阶段出现类型错配。

## 它要解决的核心问题

想象一个场景：图执行/Agent 被中断，系统要把状态序列化后恢复。状态里有 `map[any]any`、`[]interface{}`、多层指针、以及实现了自定义 JSON marshal 的结构体。如果只做普通 JSON：

- 结构值能写出去，但**类型信息会丢失**；
- 恢复时最多拿到 `map[string]any`、`float64` 之类“弱类型”结果；
- 指针层级、具体结构体类型无法准确复原。

`InternalSerializer` 的思路是：不仅保存值，还保存“类型骨架（type descriptor）”。

## 心智模型：两层包裹的“快递箱”

可以把它想成快递系统：

- `JSONValue` 是箱子里的“货物”（实际数据）
- `valueType` 是箱子外的“运单标签”（类型元信息）
- `internalStruct` 是统一包装格式（货物+标签+子节点）

这样恢复时不是盲猜，而是按标签精确拆箱。

## 关键结构

### `InternalSerializer`
对外门面，提供：

- `Marshal(v any) ([]byte, error)`
- `Unmarshal(data []byte, v any) error`

其中 `Unmarshal` 明确要求 `v` 是非 nil 指针，否则直接报错（这是很重要的契约）。

### `internalStruct`
递归节点结构，支持三种承载形态：

- `JSONValue`：基础值或可直接 JSON 编解码的值
- `MapValues`：用于 map/struct 的字段集合
- `SliceValues`：用于 slice/array

### `valueType`
类型描述树，记录：

- `PointerNum`（指针层级）
- `SimpleType` / `StructType`（注册类型名）
- map key/value 的递归类型
- slice 元素的递归类型

## 数据流（端到端）

```mermaid
flowchart LR
    A[调用方 any 值] --> B[InternalSerializer.Marshal]
    B --> C[internalMarshal 递归]
    C --> D[internalStruct + valueType]
    D --> E[sonic.Marshal 输出 bytes]

    E --> F[InternalSerializer.Unmarshal]
    F --> G[unmarshal + internalUnmarshal]
    G --> H[reflect 构造目标值]
    H --> I[写回调用方指针]
```

关键点在 `internalMarshal/internalUnmarshal`：它们是成对设计的“编码器/解码器内核”。

## 非显然设计决策与权衡

1. **选择 `reflect` + 注册表（`m` / `rm`）而非纯 JSON schema**
   - 好处：Go 侧类型恢复能力强，可处理指针层级、容器嵌套。
   - 代价：必须提前 `GenericRegister`，未注册类型会报 `unknown type`。

2. **区分 `SimpleType` 与 `StructType`**
   - 目的：结构体既可能走“字段递归”路径，也可能走“自定义 JSON Marshaler”路径。
   - `checkMarshaler` 检测类型是否同时实现 `json.Marshaler/json.Unmarshaler`，若是则直接走 JSONValue。

3. **nil/zero 处理偏保守**
   - `internalMarshal` 在特定条件下返回 `nil` 节点，避免写出冗余字段。
   - 反序列化时遇到 `nil` 会回填目标类型零值，优先保持可赋值语义。

4. **map key 统一先序列化成字符串**
   - 通过 `sonic.MarshalString` + `sonic.UnmarshalString` 处理 key。
   - 优点：统一存储模型；
   - 代价：key 编解码失败会在恢复时暴露（错误更早、更显式）。

## 与系统其它模块的连接

- [Schema Core Types](Schema%20Core%20Types.md) 中 `schema.RegisterName` / `schema.Register` 会调用 `serialization.GenericRegister`，把 schema 类型注入该模块注册表。
- [ADK Interrupt](ADK%20Interrupt.md) 的 checkpoint 目前可见是 `encoding/gob` 主路径（`adk.chatmodel.gobSerializer` 也走 gob），说明框架在“通用恢复”与“内部序列化”上采用了并存策略。

> 仅根据当前给出的代码可确认：`schema/serialization.go` 明确调用了 `serialization.GenericRegister`。

## 新贡献者要注意的坑

- **未注册类型不可恢复**：出现 `unknown type` 基本是忘记 `RegisterName/Register`。
- **`Unmarshal` 目标必须是可设置的非 nil 指针**。
- **只处理导出字段**：struct 反序列化走 `setStructFields`，非导出字段不会参与。
- **数组越界会显式报错**：`setSliceElems` 对 array 做了边界检查。
- **全局注册表并发写风险**：`m/rm` 是全局 map，注册通常在 `init` 阶段完成；运行中动态注册需谨慎。

## 参考

- [Internal Utilities](Internal%20Utilities.md)
- [Schema Core Types](Schema%20Core%20Types.md)
- [ADK Interrupt](ADK%20Interrupt.md)
