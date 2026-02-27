# runtime_execution_engine

`runtime_execution_engine` 是 Compose Graph Engine 的“调度内核层”，核心围绕 `runner`、`chanCall`、`interruptTempInfo`。如果说 `graph` 在编译期做的是“画施工图”，这一层做的就是“按图施工”：把节点执行、依赖推进、分支选择、中断恢复串成一个稳定循环。

## 角色定位

- `chanCall`：每个节点的执行描述（执行体 `action`、数据去向 `writeTo`、分支去向 `writeToBranches`、控制依赖 `controls`、前后处理器）。
- `runner`：图实例运行时总调度器，负责：初始化 channel/task 管理器、提交任务、等待完成、计算下一批任务、处理中断与 checkpoint。
- `interruptTempInfo`：一次运行步内的中断暂存结构，聚合子图中断、超时取消、before/after 节点中断信息。

## 核心执行循环（`runner.run`）

`runner.run` 的心智模型可以理解为一个“事件驱动调度回路”：

1. 初始化 `channelManager` 与 `taskManager`。
2. 解析运行选项（节点 option、max steps、checkpoint 信息）。
3. 若存在 checkpoint，则恢复状态与待执行任务；否则从 `START` 计算第一批任务。
4. 进入循环：提交任务 -> 等待完成 -> 处理错误/中断 -> 计算下一批任务。
5. 任一批任务命中 `END`，返回图输出。

这套循环有两个保护阀：

- 非 DAG 模式下 `maxRunSteps` 防止环路失控；
- `ctx.Done()` 及时打断运行并回收任务。

## 中断与恢复语义

`runner` 同时支持三类中断来源：

- 显式节点前/后中断（`interruptBeforeNodes` / `interruptAfterNodes`）；
- 子图抛出的中断（`subGraphInterruptError`）；
- 外部取消（`WithGraphInterrupt` 注入 cancel channel）。

处理中断时，`handleInterrupt` / `handleInterruptWithSubGraphAndRerunNodes` 会把 channels、待重跑输入、状态快照等写入 checkpoint，并通过 `interruptError` 或 `subGraphInterruptError` 抛出。这样上层可以“暂停-恢复”，而不是“失败-重跑全部”。

## 设计取舍

- **正确性优先于吞吐**：中断路径会等待并清算已完成/取消任务，再构造一致 checkpoint，避免恢复后出现输入错位。
- **统一调度循环优先于特化路径**：invoke/transform 共享同一调度主干，只在 runWrapper 层切换，减少分叉逻辑。
- **恢复能力优先于内存轻量**：在可中断场景下，任务会持久化 `originalInput`（流会 copy），以保证 rerun 语义。

## 新贡献者高频坑点

1. `dag` 模式不能设置 `maxRunSteps`，在 `resolveMaxSteps` 会报错。
2. `completedTasks` 为空会触发 `no tasks to execute` 错误，通常是依赖推进或分支 skip 传播异常。
3. 中断恢复时 `skipPreHandler` 仅对特定节点生效（尤其子图）；不要假设 pre-handler 一定重跑。
4. 外部中断与内部 `compose.Interrupt()` 的输入持久化语义不同，排障时要先确认中断来源。
