# imemory — DSH 自进化长期记忆插件  !!!!!!!!!!!!已经无法适应最新版dsh了！！！！！！！！！！

> **EN**: [English README](./README_EN.md)
>
> ⚠️ **版本状态**:本项目 2026-08-14 建项,次日即投入使用,至今已更迭 4 个版本。因高度个人定制化开发,当前发布版仍属**测试版**,接口与行为可能随迭代调整,敬请见谅。

`imemory` 是 DeepSeek Harness (DSH) 的自进化长期记忆插件:把"长期记忆"做成两个**纯文本文件**(`MEMORY.md` 你的笔记 + `USER.md` 用户档案,条目以单独一行 `§` 分隔),由 LLM 在回合结束后自动提炼值得记住的内容写入,并在每次对话步骤前自动召回相关记忆注入上下文;可复用的操作流程还会沉淀成 `learned-*` 技能。附带一个网页管理面板。

## ✨ 特性

- **回合后自动提取**:根会话每回合结束,LLM 从对话中提炼持久信息写入记忆(importance 打分 1-10,<3 自动丢弃,宁缺毋滥)
- **每步召回注入**:每次模型步骤前,关键词初筛 + LLM 语义重排(温度 0),把相关记忆注入上下文,不主动声明使用了记忆库
- **会话开场记忆**:新会话第一步注入用户档案 + 高重要度笔记
- **冲突合并 / 去重 / 衰减淘汰**:每 6 小时固化一次(自动合并插件自写条目;手动编辑的条目只给建议,不擅动)
- **技能学习闭环**:可复用流程沉淀为 `learned-*` 技能(skills.json → DSH 技能注册表,可用 `skill` 工具加载)
- **6 个工具**:`memory_search` / `memory_add` / `memory_update` / `memory_forget` / `memory_sessions` / `memory_consolidate`
- **网页管理面板**:`/imemory/`(浏览条目 / 命中次数 / 重要度升降 / 删除 / 整理冲突)
- **零依赖**:不 import 任何 `@deepseek-ai` 包,手动复制到任意路径、`link:` 安装、npm/git 安装都能直接加载
- **不挑 profile 类型**:`webServer` 是可选服务——web profile 自动挂管理面板,headless/tui 等无 web 服务的 profile 照常运行

## 🚀 快速开始(60 秒)

1. 把 `imemory.mjs` 复制到 profile 目录(以 web profile 为例):
   ```bash
   cp imemory.mjs ~/.dsh/profiles/web/imemory.mjs
   ```
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加:
   ```yaml
   - insert:
       - id: imemory
         name: ./imemory.mjs
   ```
3. 重启 dsh。启动日志出现 `[imemory] 就绪 ... 记忆目录 ...` 即成功。

## 📦 安装

目标 DSH 版本:`0.1.0-rc.6`(Node ≥ 20)。两种方式任选:

### 方式 A:手动挂载(推荐,免构建、免 npm)

1. 复制 `imemory.mjs` 到你的 profile 目录,例如 `~/.dsh/profiles/web/imemory.mjs`
2. 在 profile 的 `cordis.patch.yml`(没有就新建)末尾追加挂载行:

```yaml
- insert:
    - id: imemory
      name: ./imemory.mjs
      # 可选:自定义记忆目录(默认见下文"配置")
      # config:
      #   memDir: ~/.dsh/my-memories
```

3. 重启 dsh(或见"热重载说明")。

### 方式 B:作为 bundle 安装(npm / git)

```bash
# 发布到 npm 后:
dsh plugin --profile web add imemory

# 或直接装 git 仓库:
dsh plugin --profile web add https://github.com/bass1125/imemory.git
```

包内 `dsh.bundle.patch` 声明会自动把插件挂进 bundle 栈,无需手改 profile 文件。若 profile 里已有方式 A 的手动挂载行,先删掉,避免双挂。

### 热重载说明

- **改 `memDir` 等挂载条配置**:DSH 的 `watchUserPatches` 会盯 profile 的 `cordis.patch.yml`,保存即热生效,无需重启。
- **改 `imemory.mjs` 模块本体**:模块文件不在监视范围,需重启 dsh;若不想重启,可在 insert 行的 `name` 加查询串强制重新导入,例如 `name: ./imemory.mjs?v=2`。

## ⚙️ 配置

插件通过挂载条里的 `config` 配置,目前只有一项 `memDir`(记忆/笔记目录):

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `memDir` | `$DSH_HOME/imemory/`(未设 `$DSH_HOME` 时 `~/.dsh/imemory/`) | 记忆文件所在目录;支持 `~` 前缀;相对路径以 harness 根为基准 |

```yaml
- insert:
    - id: imemory
      name: ./imemory.mjs
      config:
        memDir: ~/.dsh/my-memories   # 绝对或 ~ 开头路径
        # memDir: my-memories        # 相对路径 → $DSH_HOME/my-memories
```

插件启动时会自动创建该目录。

## 🗂 记忆目录布局

`harness 根目录` = `$DSH_HOME` 环境变量,未设置时默认 `~/.dsh`(Windows 下为 `C:\Users\<你>\.dsh`)。**路径不写死**,任何机器上开箱即用:

| 文件 | 说明 |
| --- | --- |
| `<memDir>/MEMORY.md` | 你的笔记(本机环境、项目、教训、技能沉淀) |
| `<memDir>/USER.md` | 用户档案(身份、偏好、风格、铁律),仅档案变化时更新 |
| `<memDir>/memories.index.json` | 侧车索引(插件自写条目的重要度 / 命中次数 / 时间) |
| `<memDir>/skills.json` | 学习到的 `learned-*` 技能 |

> 记忆文件是纯文本,随时可手动编辑;`§` 单独一行作条目分隔符,条目内不要出现孤立 `§` 行。

## ✅ 验证安装

- 新会话第一步会收到 `<imemory>` 开场记忆块
- 模型工具列表出现 6 个 `memory_*` 工具
- 面板:`http://<dsh-host>:<dsh-port>/imemory/`(web profile;端口见启动日志 `[imemory] 管理面板: ...`)

## 🔬 行为细节

- **提取**:仅根会话触发(子代理回合不额外消耗);同一会话 20 秒冷却;每轮最多 6 条记忆操作 / 2 个技能
- **召回**:每步关键词打分,候选 ≤15 条走 LLM 语义重排(温度 0);无模型可用时回退纯关键词
- **固化**:每 6 小时执行冲突合并 + 去重 + 衰减淘汰(>14 天且有效分 ≤1.5 的低价值条目淘汰)+ 索引孤儿清理
- **重要度**:1-10;`memory_add` 或提取时 <3 直接丢弃;命中次数会提高条目有效分
- **与 Hermes 兼容**:记忆文件格式与 Hermes 的记忆库一致(§ 分隔)——之前用 Hermes 写过记忆的话,把 `memDir` 指向现有记忆目录即可无缝沿用

## 🛠 开发

```
imemory/
├─ imemory.mjs       插件本体(单文件,零构建,零依赖)
├─ package.json      bundle 声明(dsh.bundle.patch)+ 元信息
├─ cordis.patch.yml  官方安装通道的挂载补丁
├─ README.md / README_EN.md
└─ LICENSE
```

## 📄 License

MIT
