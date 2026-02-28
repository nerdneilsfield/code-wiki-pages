# tui_tree_navigation_and_view_model 模块技术深度解析

## 1. 这个模块解决什么问题？

**问题空间**：OpenViking CLI 的 TUI 模式需要展示一个虚拟文件系统（使用 `viking://` 协议），这个系统存储在远程服务器上。每次用户展开一个目录，都可能触发网络请求。终端界面有严格的行数限制，用户期望流畅的导航体验——点击展开、上下移动光标、滚动查看。

**为什么 naive 方案行不通**：如果每次渲染都从根节点遍历整个树结构，性能无法接受。如果每次展开都重新请求所有数据，网络延迟会让界面卡顿。如果在内存中缓存所有数据，大型目录会耗尽内存。

**设计的核心洞察**：将「树的物理存储」与「树的逻辑展示」分离。`nodes` 向量保存完整的层级结构和所有缓存数据；`visible` 向量是按需计算的扁平视图。这样，渲染层只需要遍历一个线性数组，而树操作（展开、折叠）只需要修改节点状态标志并重建可见列表。

## 2. 思维模型：把 TUI 树导航想象成什么？

把这个模块想象成**机场的值机柜台**：

- **TreeNode** 是每个登机口——它有固定的位置（depth）、是否开放（expanded）、以及已经分配好的乘客列表（children）
- **VisibleRow** 是当前显示在电子屏上的航班信息——只显示那些「开放」的登机口，已经关闭的不显示
- **children_loaded** 类似于「该航班是否已经完成值机」——只有完成值机（loaded=true），乘客才能登机（显示在 visible 列表中）
- **node_index** 就是登机口的「登机口号」，比如「C3」——通过这个编号，你可以快速找到对应的物理登机口，无论它在机场的哪个位置
- **cursor** 是当前被选中的那行——类似电子屏上高亮的那班飞机
- **rebuild_visible()** 就是重新刷新电子屏显示

或者换一个更技术性的比喻：**TreeState 是一个「选择性展平」的引擎**。它维护一棵完整的树，但每次只把「当前应该可见的节点」提取到一个线性列表中。这类似于游戏开发中的「视锥体剔除」（frustum culling）——不渲染摄像机看不到的物体。

## 3. 数据是如何流经这个模块的？

### 核心数据流图

```
用户按 Enter 键展开目录
         │
         ▼
    App::handle_key(.toggle_expand)
         │
         ▼
    TreeState::toggle_expand(&client)
         │
         ├─► 通过 node_index 获取目标 TreeNode
         │         (get_node_mut 使用路径遍历)
         │
         ├─► 检查 children_loaded 标志
         │         │
         │         ├─► false → 发起网络请求
         │         │         HttpClient::ls(uri)
         │         │           │
         │         │           ▼
         │         │         解析 JSON → Vec<TreeNode>
         │         │           │
         │         │           ▼
         │         │         更新 node.children
         │         │         设置 children_loaded = true
         │         │
         │         └─► true → 跳过请求，使用缓存
         │
         ├─► 切换 node.expanded = !expanded
         │
         ▼
    rebuild_visible()
         │
         ├─► 清空 visible 向量
         │
         ├─► 递归遍历 nodes：
         │         对每个节点：
         │           - 如果 expanded=true，递归添加所有子节点
         │           - 如果 expanded=false，只添加自身
         │           - 每行记录 node_index 路径
         │
         ▼
    App::load_content_for_selected()
         │
         ▼
    渲染层读取 tree.visible、tree.cursor
```

### 关键路径详解

**路径一：初始化（用户打开 TUI）**

```
App::init("viking://")
  │
  ▼
TreeState::load_root(client, "viking://")
  │
  ├─► 检测到 is_root = true（viking:// 或 viking:///）
  │
  ├─► 遍历 ROOT_SCOPES = ["agent", "resources", "session", "user"]
  │     │
  │     ├─► 创建虚拟 FsEntry（如 viking://agent）
  │     │
  │     ├─► 立即调用 fetch_children() 预加载第一层
  │     │     └─► 发起 4 个并发 API 请求
  │     │
  │     └─► 设置 expanded = true（让用户 immediate 看到内容）
  │
  ▼
rebuild_visible() → 填充 visible 向量
  │
  ▼
App::load_content_for_selected() → 加载右侧内容面板
```

这里有一个**刻意为之的设计**：根级作用域被「迫不及待」地加载了第一层子节点。代价是启动时多 4 个网络请求；收益是用户打开 TUI 时立即看到有实质内容，而不是四个空目录。

**路径二：懒加载展开**

```
用户选中目录 → 按 Enter
  │
  ▼
toggle_expand(&client)
  │
  ▼
get_node_mut(nodes, index_path)
  │  // 例如 index_path = [0, 3, 1]
  │  // 找到：nodes[0].children[3].children[1]
  ▼
检查 node.children_loaded
  │
  ├─► false（从未展开过）
  │     │
  │     ▼
  │  fetch_children(client, uri)
  │     │
  │     ▼
  │  HTTP GET /api/v1/fs/ls?uri=...
  │     │
  │     ▼
  │  响应可能是一个数组 [FsEntry...] 
  │  或者是包装过的对象 {result: [...]}
  │     │
  │     ▼
  │  解析 → 转为 TreeNode
  │  排序：目录优先 → 字母顺序
  │     │
  │     ▼
  │  更新 node.children
  │  设置 children_loaded = true
  │
  └─► true（已经缓存）
        │
        ▼
     跳过网络请求
  │
  ▼
node.expanded = !node.expanded
  │
  ▼
rebuild_visible() → 重建可见列表
```

**路径三：光标移动**

```
用户按 j/k
  │
  ▼
move_cursor_up() / move_cursor_down()
  │
  ▼
更新 cursor 索引
  │
  ▼
adjust_scroll(viewport_height)
  │  // 保证光标在可视区域内
  │  // 类似于游戏摄像机跟随角色
  │
  ├─► cursor < scroll_offset
  │     └─► scroll_offset = cursor
  │
  ├─► cursor >= scroll_offset + viewport_height
  │     └─► scroll_offset = cursor - viewport_height + 1
  │
  └─► 否则保持不变
  │
  ▼
App::load_content_for_selected()
  │
  ▼
更新右侧内容面板
```

注意这里有一个**用户体验细节**：每次移动光标后，都会重新加载内容面板。这确保用户选中的文件/目录内容始终是最新的，代价是轻微的延迟。

## 4. 做了哪些设计取舍？

### 同步结构 + 异步方法

`TreeState` 本身是同步的结构体，但 `load_root()` 和 `toggle_expand()` 都是 `async` 方法。这是有意为之的：**将状态管理（同步）与网络请求（异步）分离**。

- **替代方案**：整个 `TreeState` 设计为异步 actor 或流式状态机
- **为什么没这样做**：
  1. 简化调用方（App）的状态管理——只需在事件循环中 `await`，无需处理复杂的状态订阅
  2. 终端场景下用户操作频率远低于网络延迟，异步不会成为瓶颈
  3. Rust 的 async/await 足够优雅

**潜在问题**：如果用户疯狂地快速展开/折叠目录，可能发起大量并发请求。当前没有请求去重或节流机制。

### 内存缓存 vs 重复网络请求

模块选择将已加载的子节点缓存在内存中：

```
展开 → 加载100个节点 → 折叠 → 再次展开 → 使用缓存（无网络请求）
```

**代价**：内存占用与目录大小成正比。极端情况下（如单目录包含数十万文件）可能 OOM。`node_limit=1000` 参数缓解了这个问题。

**如果是你，你会怎么选？** 每次展开都重新请求（慢但省内存），还是缓存（快但费内存）？当前选择是「快」。

### 全量重建 vs 增量更新

每次展开/折叠都调用 `rebuild_visible()`，重新遍历整个树：

```rust
pub fn rebuild_visible(&mut self) {
    self.visible.clear();
    for (i, node) in self.nodes.iter().enumerate() { ... }
}
```

- **为什么不增量更新**？TreeNode 的嵌套结构使得增量逻辑复杂，容易引入不一致。O(N) 复杂度对典型目录（几百到几千节点）完全可接受。
- **未来优化方向**：可以考虑增量更新，或使用虚拟化列表（如只渲染可视区域内的行）

### 错误静默处理

展开目录时网络请求失败，模块不会向用户显示错误：

```rust
Err(_) => {
    node.children_loaded = true;  // 避免反复重试
    // children 保持为空
}
```

用户只会看到空目录。**这是一种用户体验的权衡**：网络问题通常是暂时的，频繁弹窗会破坏沉浸感。但代价是用户可能不清楚为什么目录是空的。

### 硬编码根作用域

```rust
const ROOT_SCOPES: &'static [&'static str] = &["agent", "resources", "session", "user"];
```

这四个作用域是硬编码的，不是从 API 动态获取的。**好处**：实现简单，根级导航是系统核心，不太会剧烈变化。**代价**：未来新增顶级作用域需要同步修改 CLI 代码。

### 目录优先排序

```rust
nodes.sort_by(|a, b| {
    b.entry.is_dir.cmp(&a.entry.is_dir)
        .then_with(|| a.entry.name().to_lowercase().cmp(&b.entry.name().to_lowercase()))
});
```

先按 `is_dir` 降序（目录在前），再按名称字母顺序。使用 `.then_with()` 避免不必要的字符串比较——这是 micro-optimization，差异可忽略，但体现了「不只是正确，还要更好一点」的工程师素养。

## 5. 新人要注意什么？（Edge Cases 与 Gotchas）

### 1. children_loaded 的双重语义

```rust
pub children_loaded: bool,
```

`children` 向量为空可能是：
- **情况A**：这是一个文件（`children_loaded = true`），没有子节点是正常的
- **情况B**：这是一个目录，之前从未展开过（`children_loaded = false`）
- **情况C**：这是一个目录，展开过但服务器返回空数组（`children_loaded = true`）

调用方必须同时检查 `children_loaded` 和 `is_dir` 来区分。

### 2. node_index 的时效性

`VisibleRow::node_index` 在创建时被「冻结」。如果父节点的子节点顺序改变了，这个路径可能指向错误的位置。`rebuild_visible()` 执行后会重建所有路径，确保 fresh。

### 3. 异步上下文

- **同步方法**：`rebuild_visible()`, `move_cursor_up()`, `move_cursor_down()`, `adjust_scroll()`
- **异步方法**：`load_root()`, `toggle_expand()`

如果在同步上下文中调用异步方法，编译会失败。App 层需要正确处理这种混合。

### 4. 滚动边界保护

```rust
pub fn adjust_scroll(&mut self, viewport_height: usize) {
    if viewport_height == 0 { return; }
    // ...
}
```

防御 `viewport_height = 0` 的除零错误。虽然实际终端不太可能为 0，但保留了安全边际。

### 5. 大型目录卡顿

对于包含数千个节点的目录，`rebuild_visible()` 的 O(N) 复杂度会造成轻微卡顿。目前没有虚拟化优化。

### 6. 并发竞态

当前实现是**非线程安全**的。TUI 是单线程事件循环所以没问题，但如果未来要在其他场景重用 TreeState，需要加锁。

### 7. URI 解析边缘情况

```rust
pub fn name(&self) -> &str {
    let path = self.uri.trim_end_matches('/');
    path.rsplit('/').next().unwrap_or(&self.uri)
}
```

- `viking://` → 返回 `viking://`（因为没有 `/` 可 split）
- `viking://dir/` → 返回 `dir`
- `viking://dir//file` → 可能产生意外结果（双重斜杠）

---

## 依赖关系图

```
                                    ┌─────────────────────┐
                                    │    HttpClient       │
                                    │  (http_client 模块)  │
                                    └──────────┬──────────┘
                                               │
                                               │ ls() API 调用
                                               ▼
┌──────────────────┐    使用      ┌─────────────────────┐
│       App        │ ──────────► │    TreeState        │
│ (tui_application │             │                     │
│  _orchestration) │ ◄────────── │  - nodes: TreeNode  │
│                  │  visible    │  - visible: [Row]   │
│  - tree: TreeSt  │  渲染数据   │  - cursor           │
└──────────────────┘             └─────────────────────┘

依赖关系：
  TreeState → HttpClient (fetch_children 调用 ls)
  App → TreeState (初始化、事件处理、渲染数据消费)
  
上游模块：
  - tui_application_orchestration (App)
  
下游模块：
  - http_api_and_tabular_output (HttpClient)
```

---

## 相关模块

- [tui_application_orchestration](./tui_application_orchestration.md) — 上游模块，理解 App 如何编排 TreeState
- [http_client](./http_client.md) — 依赖的 HTTP 客户端实现，理解 `ls()` API 的完整签名

---

## 小结

这个模块解决的核心问题是在终端 UI 中高效展示和导航远程虚拟文件系统。通过「树形存储 + 平面视图」的双轨设计，它在保持层级关系完整性的同时，为渲染层提供了高效的线性数据结构。

关键的设计决策包括：懒加载策略（`children_loaded` 标志）、根级作用域的预加载、错误静默处理、以及全量重建可见列表。这些取舍共同构成了在终端约束下运作良好的用户体验。

对于新加入的开发者，需要特别注意 `children_loaded` 的双重语义、`node_index` 的时效性、以及同步/异步方法的调用上下文。理解这些「隐式契约」后，你将能够安全地修改或扩展这个模块。