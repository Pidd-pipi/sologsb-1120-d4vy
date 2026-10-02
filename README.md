# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test,snapshot}.ts
        ├── stores/{clock,part,step,snapshot}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView}.vue
        └── utils/{db,timeCalc,id,crossTab}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/tests/:clockId` | 走时测试录入与多方位均值计算，生成走时单文本 | TimekeepingTest |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 五张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`snapshots`（修复快照）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：新增 `snapshots` 表，为每台已建档钟表补一份 `init` 初始快照；**既有走时测试不补绑快照，保持「无快照只读」**，不再作为完成依据。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序、1 份初始快照与 1 次绑定该快照的走时测试。

## 快照绑定与失效（v3）

修复时常见两个标签页并行：一边回退清洗/调工序顺序，另一边还开着旧走时单。为避免台账把旧测试当成完成依据，走时测试、工序与零件决定被绑成同一份**修复快照**：

- **快照内容**：每份快照记下保存时的步骤序列（顺序号 + 状态）与零件处理结果（磨损 + 决定），每台钟表版本从 1 起单调递增。
- **测试绑定**：保存走时测试时绑定当前快照版本，走时单文本同时导出快照版本、工序序列与零件处理。
- **失效触发**：步骤回退、顺序调整、增删工序、零件决定/磨损变化都会生成新快照，旧测试**立即失效**，台账分栏即时重算（完成步骤属正常推进，不触发失效）。
- **并发仲裁**：两个标签页同时提交时以快照版本为准——测试保存在 IndexedDB 事务内重读当前版本，版本过期即拒绝提交并保留已录入读数，确认变更后可一键绑定最新快照再交。
- **跨标签页同步**：任一标签页写入后通过 `BroadcastChannel` 广播，其他页面立即重载重算。
- **旧测试只读与复测**：无快照的旧测试只读、不计入完成依据；点「复测」可把旧读数载入表单，提交后生成带 `retestOf` 溯源链的新记录，钟表详情页可查看完整快照历史。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，含快照版本、工序序列与零件处理，可复制或下载 txt。
- **快照版本仲裁**：测试保存绑定快照版本，过期提交被拒绝并保留读数；旧测试失效后需复测生成可追溯新记录。
