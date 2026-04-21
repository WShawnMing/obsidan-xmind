# Obsidian 思维导图插件技术方案

## 1. 技术目标

在 Obsidian 插件体系内实现一个自定义思维导图视图，围绕 Markdown 文件完成以下闭环：

1. 读取 Markdown 文件
2. 解析成树结构
3. 渲染为思维导图
4. 编辑树结构
5. 回写为 Markdown
6. 在不生成独立脑图内容文件的前提下持久化 layout 元数据

## 2. 总体架构

建议采用以下模块划分：

1. `plugin`：Obsidian 插件入口，负责注册命令、视图、设置页。
2. `mindmap-view`：自定义 `ItemView`，负责容器生命周期和 UI 挂载。
3. `markdown-parser`：把 Markdown AST 转为统一脑图树结构。
4. `mindmap-model`：插件内部的标准节点模型。
5. `inline-tokenizer`：解析节点标题中的 `[[wiki link]]` 和普通文本片段。
6. `layout-engine`：计算节点位置和连线。
7. `renderer`：基于 SVG 或 HTML/SVG 混合渲染节点和连线。
8. `editor-actions`：新增、删除、改名、排序、重挂载等操作。
9. `markdown-serializer`：把脑图树结构重新生成 Markdown。
10. `layout-store`：持久化节点 layout 元数据和画布视口。
11. `tree-reconciler`：文件刷新后把旧 layout 映射到新树结构。
12. `sync-manager`：管理文件读取、变更监听、回写冲突和刷新。
13. `settings`：主题、默认布局、自动刷新等设置。

## 3. 推荐技术选型

## 3.1 语言与构建

1. TypeScript
2. 基于 Obsidian 官方插件模板
3. `esbuild` 或官方常见构建方式

## 3.2 Markdown 解析

推荐使用基于 `remark` / `mdast` 的解析方式。

原因：

1. 能可靠区分标题、列表、段落、代码块等结构。
2. 后续做回写和增量更新更容易。
3. 比基于正则的解析方式稳定很多。

## 3.3 布局与渲染

MVP 推荐：

1. 自定义树布局
2. SVG 渲染连线
3. HTML 或 SVG 渲染节点内容

原因：

1. 思维导图是典型树结构，不需要上来就引入重型图编辑框架。
2. SVG 缩放和平移实现清晰，适合首版。
3. 后续要做主题、折叠、动画也比较容易扩展。

备选：

1. `d3-hierarchy` 负责树布局
2. 自己实现节点渲染层

不建议首版就做：

1. 完整自由画布
2. 任意连接线编辑
3. 复杂自动避让系统

## 4. 数据模型

建议统一抽象一个中间层，避免 UI 直接依赖 Markdown AST。

```ts
export interface MindMapNode {
  id: string;
  layoutKey: string;
  text: string;
  tokens?: MindMapInlineToken[];
  links?: MindMapWikiLink[];
  children: MindMapNode[];
  collapsed?: boolean;
  note?: string;
  source?: {
    filePath: string;
    startLine?: number;
    endLine?: number;
    kind: "heading" | "list" | "document";
    depth?: number;
  };
  meta?: {
    checked?: boolean;
    tags?: string[];
    priority?: number;
  };
}

export interface MindMapInlineToken {
  type: "text" | "wikilink";
  raw: string;
  text: string;
}

export interface MindMapWikiLink {
  raw: string;
  target: string;
  subpath?: string;
  alias?: string;
  exists?: boolean;
}

export interface MindMapNodeLayout {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  manualPosition?: boolean;
  manualSize?: boolean;
}
```

设计原则：

1. `text` 存节点标题原文，保留原始 Markdown inline 语法，包括 `[[wiki link]]`。
2. `tokens` / `links` 是渲染层和交互层使用的解析结果，不替代 `text`。
3. `note` 存正文备注。
4. `source` 记录原始 Markdown 映射信息，方便回写和定位。
5. `layoutKey` 用于 layout 元数据匹配，不向 Markdown 正文写入额外节点 id。
6. `meta` 预留后续节点状态扩展。

## 4.1 内容模型与布局模型分离

这是本插件最重要的架构原则之一：

1. Markdown 负责内容真相。
2. MindMapNode 负责运行时内容表示。
3. layout 数据单独存储，不混进 Markdown 主内容。

也就是说：

1. 节点文本、层级、顺序来自 Markdown。
2. 节点位置、尺寸、画布视口来自 layout store。
3. 脑图视图是“内容模型 + layout 模型”的组合投影。

## 5. Markdown 解析方案

## 5.1 解析流程

1. 读取当前文件文本。
2. 用 Markdown parser 生成 AST。
3. 遍历 AST，抽取标题树和列表树。
4. 解析节点标题中的 inline 内容，提取 `[[wiki link]]` token。
5. 转换为统一 `MindMapNode` 树结构。
6. 将未结构化内容归并到最近节点的 `note` 中。

## 5.2 推荐规则

1. 如果存在 `H1`，优先以第一个 `H1` 作为根节点。
2. 如果不存在 `H1`，则以文件名作为根节点。
3. 标题作为结构骨架。
4. 标题下的列表作为该标题的子树。
5. 普通段落作为当前节点备注。
6. 标题和列表项中的 `[[wiki link]]` 保留为节点标题原文的一部分。

## 5.3 AST 到脑图的核心映射

1. `heading` -> 节点
2. `list` -> 容器，不直接对应节点
3. `listItem` -> 节点
4. `paragraph` -> 当前节点备注
5. `[[...]]` 片段 -> 节点 inline token

## 5.4 特殊处理

1. 标题层级跳跃时，挂到最近合法父级。
2. 混合列表缩进不规范时，尽量容错，但要记录 warning。
3. 文档中只有普通段落没有层级结构时，生成单根节点视图并提示“未检测到可展开层级”。
4. 对 `[[Missing Note]]` 这类未解析链接，保留原始文本并标记 `exists = false`。

## 5.5 inline wiki link 处理

建议使用“原文保留 + 渲染时分词”的方式：

1. `text` 中始终保存原始标题文本。
2. 渲染时再把 `[[Note]]`、`[[Note|Alias]]` 切成 token。
3. 点击 token 时调用 Obsidian 打开对应笔记。
4. 编辑节点时允许用户直接输入 wiki link 语法。
5. 回写 Markdown 时直接输出 `text`，不做语义降级。
6. 链接目标解析优先走 Obsidian 的 link resolution，而不是插件自己硬编码路径映射。

这样能保证：

1. 不丢失原始写法。
2. 文本编辑体验与 Obsidian 原生语法一致。
3. 节点既是文字节点，也是笔记入口。

实现上建议优先使用：

1. `getLinkpath(linktext)` 提取 wikilink 的 linkpath
2. `app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)` 解析当前上下文下的目标文件
3. `app.workspace.openLinkText(linktext, sourcePath, ...)` 打开目标笔记

如果未来插件支持在脑图内重命名或移动笔记，则应优先调用 `app.fileManager.renameFile(...)`，因为 Obsidian API 明确说明要用它来确保链接自动改名，而不是直接调用 `vault.rename(...)`。

## 6. 回写 Markdown 方案

## 6.1 零中间产物原则

插件不生成独立脑图内容文件。

也就是说，不引入：

1. `.xmind`
2. `.mindmap.json`
3. 独立的脑图副本 Markdown

允许的额外持久化数据只有：

1. layout 元数据
2. 视图状态
3. 插件设置

## 6.2 基本策略

首版建议采用“整树重建当前文档结构”的方式，而不是复杂 patch。

也就是：

1. 从内存中的脑图树重新生成 Markdown。
2. 用统一规则输出标题和列表。
3. 覆盖当前文件内容或覆盖结构化部分。

优点：

1. 实现简单。
2. 行为可预测。
3. 适合首版快速闭环。

风险：

1. 可能影响用户原有格式细节。
2. 难保留复杂自定义排版。

## 6.3 首版建议的回写边界

建议只保证以下内容可稳定回写：

1. 标题文本
2. 标题层级
3. 列表项文本
4. 列表层级
5. 节点顺序
6. 标题中的 `[[wiki link]]` 原文

以下内容首版不承诺精准保真：

1. 复杂段落排版
2. 表格位置
3. 代码块位置
4. 引用块和分隔线

## 6.4 layout 持久化策略

为了满足“无中间产物”要求，又不污染 Markdown 正文，建议把 layout 存在插件私有数据中。

推荐存储内容：

1. 节点位置 `x/y`
2. 节点尺寸 `width/height`
3. 是否为手动位置 / 手动尺寸
4. 画布 viewport
5. 折叠状态

推荐键结构：

1. 第一层：`filePath`
2. 第二层：`layoutKey`

文件级迁移规则：

1. 对 note 本身的 rename / move，监听 vault 的 `rename` 事件，把该文件对应的 layout bucket 从旧路径迁移到新路径。
2. 不依赖内容指纹去“猜”文件是否还是同一篇；如果事件链路之外无法确定，就不做迁移。
3. 这部分行为尽量贴近 Obsidian wikilink 的思路：路径变化由官方的文件重命名机制驱动，而不是插件自行扫描全文做宽松匹配。

`layoutKey` 生成建议：

1. 基于节点来源类型
2. 基于祖先路径
3. 基于同层序号
4. 基于节点文本归一化结果

注意：

1. 因为不把 node id 写回 Markdown，layout 匹配必须通过重解析后的树协调完成。
2. layout 恢复必须是保守的，只接受唯一且稳定的命中。
3. 用户大幅重写文档时，部分节点 layout 可能无法继承。
4. 无法匹配或匹配存在歧义时，应直接删除失效 layout 并回退自动布局，而不是猜测性复用。

## 6.4.1 layout 失效清理策略

建议把“删除失效 layout”作为显式规则，而不是容错分支。

规则如下：

1. 新树中存在唯一命中的 `layoutKey`，则继承 layout。
2. 新树中不存在对应节点，删除旧 layout 记录。
3. 新树中出现多个可能命中，视为歧义，删除该旧 layout 记录。
4. 文件被 rename / move 时，仅迁移文件级 bucket，不额外猜测节点级 layout。
5. 文件被彻底改写后，旧 layout 大量失效是可接受结果，系统应自动回到纯自动布局。

## 6.5 冲突处理

需要处理两类冲突：

1. 用户在 Markdown 视图中已修改文件，但脑图内存数据未刷新。
2. 插件正在回写时，文件被外部变更。

建议：

1. 保存前比较文件 `mtime` 或缓存版本。
2. 检测到冲突时提示用户“刷新脑图”或“强制覆盖”。

## 7. 视图设计

建议提供一个单独的自定义 view type，例如：

`mindmap-view`

视图内部包含：

1. 顶部工具栏：刷新、定位当前文件、切换主题、导出
2. 中央画布：脑图渲染区域
3. 可选右侧面板：节点属性

视图还需要提供两个明确模式或语义：

1. 内容编辑语义：会改 Markdown。
2. 布局编辑语义：只改 layout。

## 8. 命令设计

建议首版注册以下命令：

1. `Open mind map for current note`
2. `Refresh current mind map`
3. `Insert child node`
4. `Insert sibling node`
5. `Delete selected node`
6. `Toggle collapse`
7. `Reveal source in markdown`
8. `Open linked note under cursor`
9. `Reset selected node layout`

## 9. 交互实现建议

## 9.1 节点选择

1. 维护单一选中节点状态。
2. 选中后高亮节点。
3. 工具栏和快捷键都依赖该状态。

## 9.2 平移缩放

1. 使用一个 viewport 状态维护 `x/y/scale`。
2. 鼠标滚轮控制缩放。
3. 拖动画布控制平移。
4. 刷新数据时尽量保留 viewport。

## 9.3 折叠

1. 节点状态里维护 `collapsed`。
2. 折叠时布局只计算可见子树。

## 9.4 拖拽与布局调整

拖拽建议分两类处理：

1. 布局拖拽：直接改变节点位置，不改内容结构。
2. 结构拖拽：改变父子关系或同级顺序，会回写 Markdown。

建议默认拖拽优先做布局拖拽，结构调整通过专用手柄、快捷键或上下文菜单触发。

## 9.5 结构调整

首版建议只支持两类：

1. 同父节点内排序
2. 拖到另一个节点下作为子节点

并加限制：

1. 只有在目标层级能明确序列化为 Markdown 时才允许落下。

## 9.6 wiki link 交互

1. 节点内 `[[...]]` token 提供 hover 和 click 态。
2. 点击时优先调用 Obsidian 的文件解析和打开能力。
3. 对不存在的目标文件使用未解析样式。
4. 节点编辑完成后立即重新分词并更新链接态。
5. 对重命名或移动后的目标文件，不自己维护旧路径映射，优先依赖 Obsidian 的 link resolution 结果。

## 10. 性能要求

MVP 可先按以下标准设计：

1. 500 节点内操作流畅
2. 全量重排耗时可接受
3. 常规笔记刷新在 200ms 到 500ms 级别

性能优化顺序建议：

1. 只布局可见节点
2. 降低不必要的整树重绘
3. 事件节流
4. 大图延迟加载次要 UI

## 11. Obsidian 集成点

需要重点使用的 API：

1. `Plugin`
2. `ItemView`
3. `WorkspaceLeaf`
4. `TFile`
5. `Vault`
6. `MarkdownView`
7. `addCommand`
8. `registerEvent`

关键集成动作：

1. 打开当前活动 Markdown 文件对应的脑图视图
2. 监听文件修改事件
3. 保存插件设置和视图状态
4. 解析和打开 wiki link 对应笔记
5. 监听 vault `rename` 事件迁移文件级 layout bucket

## 12. 建议的目录结构

```text
src/
  main.ts
  types.ts
  settings.ts
  commands/
  view/
    mindmap-view.ts
    toolbar.ts
  model/
    node.ts
    actions.ts
    tree-reconciler.ts
  parser/
    markdown-parser.ts
    ast-to-tree.ts
    inline-tokenizer.ts
  serializer/
    tree-to-markdown.ts
  layout/
    tree-layout.ts
    layout-store.ts
  render/
    svg-renderer.ts
    node-renderer.ts
  sync/
    sync-manager.ts
  utils/
```

## 13. 测试策略

建议至少覆盖：

1. Markdown 解析单测
2. Markdown 序列化单测
3. 标题 / 列表混合场景快照测试
4. 关键编辑动作的树结构测试
5. wiki link 解析和回写测试
6. layout 重绑定与典型回写冲突测试

重点测试样例：

1. 只有标题
2. 只有列表
3. 标题 + 列表混合
4. 层级跳跃
5. 空文档
6. 含代码块和表格
7. 标题含 `[[Note]]`
8. 标题含 `[[Note|Alias]]`
9. 外部改 Markdown 后 layout 重绑定

## 14. 风险点

1. Markdown 语法很自由，用户文档可能并不规范。
2. 脑图编辑和 Markdown 回写之间天然存在结构约束。
3. 若不向 Markdown 写入稳定 node id，layout 的跨次匹配只能做到保守继承，无法保证全量保留。
4. 若首版过度追求“像 XMind 一样自由”，实现复杂度会陡增。

因此建议先明确产品原则：

“这是一个以 Markdown 为主数据源的结构化脑图插件，不是完全脱离文本的自由画布工具。”

## 15. 推荐里程碑

## Milestone 1：可视化

1. 插件能打开脑图视图
2. 当前 Markdown 能解析成树
3. 节点中的 wiki link 能识别和点击
4. 能显示、缩放、折叠

## Milestone 2：可编辑

1. 节点增删改
2. 内容回写和 layout 持久化
3. 成功回写 Markdown

## Milestone 3：可用

1. 主题和快捷键完善
2. 更自由布局和尺寸调整
3. 联动体验优化
4. 导出能力

## 16. 结论

最稳妥的技术路线是：

1. 以当前 Markdown 文件为唯一内容主数据源
2. 通过 AST 解析生成统一脑图树模型，并保留标题中的 wiki link 原文
3. 在 Obsidian 自定义视图中做树形脑图渲染和链接跳转
4. 用受控编辑能力回写 Markdown
5. 把 layout 作为唯一额外持久化产物存入插件数据；能唯一稳定映射时继承，不能映射时直接删除

这条路线最符合你的需求，也最适合先做出一个真的能用的第一版。
