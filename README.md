# imemory —— DSH 自进化长期记忆插件

`imemory` 是 DeepSeek Harness (DSH) 的自进化长期记忆插件:它把"长期记忆"做成两个纯文本文件(MEMORY.md 你的笔记 + USER.md 用户档案,条目以单独一行 `§` 分隔),由 LLM 在回合结束后自动提取值得记住的内容写入,并在每次对话步骤前自动召回相关记忆注入上下文;可复用的操作流程还会沉淀成 `learned-*` 技能。附带一个网页管理面板,可浏览、调重要度、删除、整理冲突。

> 记忆文件格式与 Hermes 的记忆库兼容(条目以单独一行 `§` 分隔):如果你之前用 Hermes 写过记忆,把 `memDir` 指向现有记忆目录即可无缝沿用。

## 特性

- **回合后自动提取**:根会话每回合结束,LLM 从对话中提炼持久信息写入记忆(importance 打分,<3 自动丢弃;宁缺毋滥)
- **每步召回注入**:每次模型步骤前,关键词初筛 + LLM 语义重排,把相关记忆注入上下文(不主动声明使用了记忆库)
- **会话开场记忆**:新会话第一步注入用户档案 + 高重要度笔记
- **冲突合并/去重/衰减淘汰**:每 6 小时固化一次(仅自动合并插件自写条目,手动编辑的条目只给建议)
- **技能学习闭环**:可复用流程沉淀为 `learned-*` 技能(skills.json → DSH 技能注册表,可用 `skill` 工具加载)
- **6 个工具**:`memory_search` / `memory_add` / `memory_update` / `memory_forget` / `memory_sessions` / `memory_consolidate`
- **网页管理面板**:`/imemory/`(条目 / 命中次数 / 重要度升降 / 删除 / 整理冲突)
- **零依赖**:不 import 任何 `@deepseek-ai` 包,手动复制到任意路径、`link:` 安装、npm/git 安装都能直接加载
- **不挑 profile 类型**:`webServer` 是可选服务——web profile 自动挂管理面板,无 web 服务的 headless/tui 等 profile 也照常运行

## 记忆目录(发布版路径规则)

记忆与笔记**不写死绝对路径**,默认存放在 **harness 根目录**下:

| 文件 | 默认位置 |
| --- | --- |
| 记忆目录 | `$DSH_HOME/imemory/`(未设 `$DSH_HOME` 时即 `~/.dsh/imemory/`) |
| 你的笔记 | `<memDir>/MEMORY.md` |
| 用户档案 | `<memDir>/USER.md` |
| 侧车索引 | `<memDir>/memories.index.json`(插件自写条目的重要度/命中/时间) |
| 学习技能 | `<memDir>/skills.json` |

`harness 根目录` = `$DSH_HOME` 环境变量;未设置时默认 `~/.dsh`(Windows 下为 `C:\Users\<你>\.dsh`)。

### 自定义记忆目录(config.memDir)

在挂载条的 `config` 里写 `memDir` 即可覆盖,支持 `~` 前缀;相对路径以 harness 根为基准:

```yaml
- insert:
    - id: imemory
      name: ./imemory.mjs
      config:
        memDir: ~/.dsh/my-memories        # 绝对或 ~ 开头路径
        # memDir: my-memories             # 相对路径 → $DSH_HOME/my-memories
```

插件启动时会自动创建该目录。

## 安装

目标 DSH 版本:`0.1.0-rc.6`(Node >= 20)。两种方式任选:

### 方式 A:手动挂载(推荐,免构建、免 npm)

1. 把 `imemory.mjs` 复制到你的 profile 目录,例如 `~/.dsh/profiles/web/imemory.mjs`(以 web profile 为例,下同)。
2. 在 profile 的 `cordis.patch.yml`(没有就新建)末尾追加:

```yaml
- insert:
    - id: imemory
      name: ./imemory.mjs
```

3. 重启 dsh(或见下文"热重载说明")。启动日志出现 `[imemory] 就绪 ... 记忆目录 ...` 即成功。

### 方式 B:作为 bundle 安装(npm / git)

```bash
# 发布到 npm 后:
dsh plugin --profile web add imemory

# 或直接装 git 仓库:
dsh plugin --profile web add https://github.com/<你的用户名>/imemory.git
```

包内的 `dsh.bundle.patch` 声明会自动把插件挂进 bundle 栈,无需手改 profile 文件。若 profile 里已有方式 A 的手动挂载行,先删掉避免双挂。

### 热重载说明

- **改 `memDir` 等挂载条配置**:DSH 的 `watchUserPatches` 会盯 profile 的 `cordis.patch.yml`,保存即热生效,无需重启。
- **改 `imemory.mjs` 模块本体**:模块文件不在监视范围,需重启 dsh 加载;若不想重启,可在 patch 的 insert 行给 `name` 加查询串强制重新导入,例如 `name: ./imemory.mjs?v=2`。

## 验证

- 新会话第一步会收到 `<imemory>` 开场记忆块
- 模型工具列表出现 6 个 `memory_*` 工具
- 面板:`http://<dsh-host>:<dsh-port>/imemory/`(当前实例端口可在启动日志 `[imemory] 就绪 ... 面板 <url>` 里看到)

## 行为细节

- **提取**:仅根会话触发(子代理回合不额外消耗);同一会话 20 秒冷却,最多 6 条操作/2 个技能/轮
- **召回**:每步查询关键词打分,候选 ≤15 条走 LLM 语义重排(温度 0),无模型时回退纯关键词
- **固化**:每 6 小时执行冲突合并 + 去重 + 衰减淘汰(>14 天且有效分 ≤1.5 的低价值条目淘汰)+ 索引孤儿清理
- **重要度**:1-10;`memory_add`/提取时 <3 直接丢弃;命中次数会提高条目有效分
- **记忆文件是纯文本**,随时可手动编辑;`§` 单独一行作分隔符,条目内不要出现孤立 `§` 行

## 开发

```
imemory/                      # 本仓库(发布版)
├─ imemory.mjs                # 插件本体(单文件,零构建)
├─ package.json               # bundle 声明 + 元信息
├─ cordis.patch.yml           # bundle 挂载补丁
├─ README.md
└─ LICENSE
```

## License

MIT
