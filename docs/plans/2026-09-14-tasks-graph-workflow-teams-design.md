# 任务管理页重构：工作流图 + Agent Teams + 后台任务抽屉（v0.20 设计）

日期：2026-09-14　分支：`feat/tasks-graph-workflow-teams`

## 背景与目标

DSH 0.1.5-rc.2 引入两个新的可观测面：**workflow**（`dsh-tool-workflow` 的 run/agent 生命周期事件）与 **Agent Teams**（实验层，`ctx.agentTeams` 的共享任务板）。任务管理页（原「子代理拓扑」）系统性地接纳两者，并按用户确认的「简洁后现代主义」方向重构为 **Variant D 工作流图**：分层节点 + 贝塞尔连线、拖拽平移、滚轮缩放、右下角控制条、已完成节点折叠聚合、点击浮窗取代页内 dock。

用户确认的关键交互决策（问答摘要）：

1. 数据范围 = 当前会话树（主代理 + 全部后代）。
2. 节点点击 = 跳转转录；ⓘ = 详情浮窗。
3. 后台任务输出 = 锚定浮窗（替换页内底部 dock）。
4. 自动折叠**只**作用于后台任务抽屉，阈值 8 个代理；图节点的折叠是「已完成」语义的折叠聚合，点击展开、控制条可再折叠。
5. 图/树切换按钮在**两种模式下都可用**（mockup 的 toggle 藏在画布容器内、树模式下无法切回——真实实现把控制条移出滚动面）。
6. 默认视图由设置 select 决定（默认工作流图），页内切换为临时态。
7. 任务板 v1 只做基础操作（完成/重开/删除/改派/新建/编辑，CAS）。

## 数据源事实（侦察结论）

### Workflow

- **没有**服务注册表 / 持久化 / HTTP 接口；只有调用方会话日志里的 4 个会话事件：`tool-workflow/run-start | agent-start | agent-end | run-end`。
- 只有**顶层 run** 落事件（`exec.parent === undefined`），嵌套 run 不可见——与官方 `dsh-client-ui-workflow-run` 面板折叠的恰好是同 4 类事件，因此插件折叠结果与官方面板一致。
- run 的 member agent 是普通子会话（catalog 里有行），`childId` 即子会话 id——图模式把它们**重挂**到 run 节点下；catalog 里没有的 member 用 run 自带数据合成占位节点。

### Agent Teams（实验层）

- 只在 `~/.dsh-web` 类 profile 的实验 bundle 里存在；`ctx.get('agentTeams')` 缺席时返回 `undefined`（不抛）——**结构性降级**的支点。
- TeamId ≡ lead SessionId；`tryMembership(agent)` 命中后 `remoteView(agent) → {members, tasks}`；`remoteCreateTask` / `remoteUpdateTask`（CAS，`expectedRevision`，冲突走 `team-task-conflict` union 返回而非抛错）。
- 成员上限 8、任务上限 256；teammate = lead 的可续接子会话（`member.id` = 子会话 id，与拓扑树天然关联）。
- `~/.dsh/task-board/ledger-v2.json` 与 Agent Teams **无关**（名字误导，已核证）。
- 官方团队面板是 read-mostly + 手动刷新——客户端 5s 轮询（仅页面可见时）不是过度设计。

### Jobs

沿用既有：`jobsBySession` push 镜像 + `jobs.output` 事件回放（不碰模型游标）+ 两击终止。

## 架构

```
host 半（src/）
  workflow-runs.ts    纯折叠 foldWorkflowRuns(events, originSessionId) → WorkflowRunView[]
  workflow-routes.ts  workflows.list：树枚举 + 存储日志与 live 镜像按 seq 去重合并
  team-routes.ts      teams.view / taskCreate / taskUpdate：结构镜像 Remote 词汇，三分支降级
client 半（src/client/）
  tasks-model.ts      统一视图模型（图/树共用）：catalog 走树、run 重挂、team 富化、fold 聚合
  tasks-graph-layout.ts  免依赖 tidy-tree 分层布局（<100 节点无需虚拟化；bundle 纯度禁图库）
  TasksGraph.tsx      画布：pan / wheel-zoom-to-cursor / 相位虚线框 / 控制条（图树切换+折叠+缩放）
  TasksTree.tsx       树模式：缩进行 + 键盘导航（官方 catalog 配方）
  TasksPopovers.tsx   节点详情 / run 详情 / 团队任务板（CAS 操作）
  JobsDrawer.tsx      底部抽屉（≥8 代理自动折叠，手动优先）+ 输出浮窗（回放，尾钉）
  AnchoredPopover.tsx 锚定浮窗：geometry + 关闭契约（沿用 selection-popup 的 #425 修复）
  tool-icons.tsx      工具字形映射（宿主 primitives 图标，currentColor）
```

### 降级矩阵（可证伪）

| 环境 | workflows.list | teams.view | 页面表现 |
|---|---|---|---|
| 无 workflow/无 team（3384 桌面 profile r） | `{runs: []}`（200，空而非错） | `{available:false}` | 图/树照常，无 run 节点、无团队 chip |
| 有 team 无 workflow（3080） | `{runs: []}` | `{available:true, team:{...}}` | roster 富化节点 + chip + 任务板 |
| 有 workflow | 折叠结果 | — | run 节点 + 相位框 + member 重挂 |
| subagents 服务缺席 | 仅折叠 root | 不影响 | 旧快照退化行为 |

## 关键取舍

- **零实验包 import**：`context-types.ts` 结构镜像 `TeamService` 的 Remote 词汇；`ctx.get('agentTeams')` 探活在路由内。实验层缺席时 mutation 抛 503 `team-error`（与 `subagents-unavailable` 同形）。
- **workflow 无事件 = 空列表不是错误**：旧会话/无 workflow 会话静默为空（jobs 镜像同款语义）。
- **fold 规则**：per-parent 的「已完成/出错的**叶子** agent」折叠为一个聚合节点；当前会话、teammate、有子节点的、run 节点**永不折叠**（折叠父节点会藏住活跃分支）。
- **树/图同一模型**：fold 状态、团队富化、run 重挂两种模式共享——不会视觉漂移。
- **控制条移出滚动面**：图模式的缩放按钮与图/树切换都在视图容器级（绝对定位右下），树模式下缩放按钮不渲染但切换在（mockup bug 的教训，有测试守护）。
- **页内视图切换是临时态**，默认视图走 `tasksViewMode` pref（schemastery `z.union([z.const('graph'), z.const('tree')])`——schemastery 无 `z.enum`）。
- **AnchoredPopover 不复用 primitives 的 HoverCard**：浮窗需要持久交互（任务板表单、输出滚动），HoverCard 是悬停语义；关闭契约（外部 mousedown / Escape / anchor 离屏的 IntersectionObserver）沿用 selection-popup 已验证的模式。
- **主题硬阴影用 `color-mix(in srgb, var(--dsw-alias-border-l1) 55%, transparent)`**：后现代硬投影但颜色全部出自令牌（theme.spec 只守 `color:`，皮肤契约的精神照旧满足）。

## 实施偏差记录

1. **诊断行（diagnostic catalog entries）从模型中省略**：旧树逐 parent 渲染 corrupt/unavailable 行；新模型跳过它们，目录加载失败改由页头横幅「N 个分支加载失败 + 重试（逐个 refresh）」统一承载。理由：诊断行罕见（通常是 side-chat 遗产），逐 parent 内联会破坏图的 tidy 布局；横幅保留可达性与重试。
2. **catalog `state:'error'` 不再逐层内联**，同上进横幅。
3. **loadin rows**：图模式无「加载中占位卡」；树模式保留 `summaryBackedLoading` 的 loading 行。图模式靠 5s 轮询自然收敛。
4. **子代理 keyboard 导航保留在树模式**；图模式节点 `tabIndex=-1`（平移/缩放下 tab 序无意义，树模式是可达性面）。
5. **本地 `pnpm test:mount` 需要绕过桌面 shim**：桌面版 `~/.local/bin/dsh` shim 回退到桌面捆绑 CLI 且**不尊重 `DSH_HOME`**（`dsh plugin add` 会写到真实 `~/.dsh` profile——本次亲历，把真实 profile web 的 better-sidebar 指到了本分支 tarball）。正确姿势与 CI 一致：`DSH_CMD="npx -y --package @deepseek-ai/dsh@0.1.5-rc.2 dsh" pnpm test:mount`。
6. **测试断言从 `container.textContent` 迁到 `document.body`**：输出浮窗 portal 到 body（#425 契约），jobs-view 套件相应更新。
7. **fold 聚合节点的 aria-label 带计数文本**：与控制条的 fold 切换按钮消歧（两者同文案会导致 a11y 选择器歧义）。

## 验证

- `pnpm typecheck` / `pnpm vitest run`（1401：新增 fold/路由/模型/布局/页面交互 58 个用例）/ `pnpm build` 全绿。
- `pnpm test:mount`（钉版 npx CLI）：见实施偏差 5。
- 真机：3384（profile r，无实验层）验证降级矩阵左列；3080（~/.dsh-web）验证 teams/workflow 实景。
