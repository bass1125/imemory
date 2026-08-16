import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

// imemory —— 自进化长期记忆插件(发布版)
// 记忆/笔记目录默认位于 harness 根目录($DSH_HOME,未设时 ~/.dsh)下的 imemory/ 子目录,
// 可用插件 config.memDir 覆盖(支持 ~ 前缀;相对路径以 harness 根为基准)。
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function harnessHome(ctx) {
  try {
    const home = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof home === 'function') return home()
  } catch { /* 服务不可用,退回环境变量 */ }
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh')
}

function resolveMemDir(ctx, config) {
  const home = harnessHome(ctx)
  const configured = config && typeof config.memDir === 'string' ? config.memDir.trim() : ''
  if (configured) {
    const expanded = expandHome(configured)
    return isAbsolute(expanded) ? expanded : join(home, expanded)
  }
  return join(home, 'imemory')
}

export default {
  name: 'imemory',
  inject: ['timer', 'tools', 'fs', 'llm', 'systemPrompt', 'agentDefaultModel', 'sessionQuery', 'skills', 'webServer'],
  apply(ctx, config) {
    // 记忆/笔记目录:config.memDir 优先,默认 harness 根目录下 imemory/ 子目录
    const memDir = resolveMemDir(ctx, config)
    const FILES = { MEMORY: memDir + '/MEMORY.md', USER: memDir + '/USER.md' }
    const INDEX_FILE = memDir + '/memories.index.json'
    const SKILLS_FILE = memDir + '/skills.json'
    // 记忆目录通常在 workspace 之外:显式声明 full-access 策略,否则默认 workspace-write 沙箱会拒绝写入
    const FULL_ACCESS = { mode: 'danger-full-access' }
    const fsService = ctx.get('fs')
    const llmService = ctx.get('llm')
    const promptService = ctx.get('systemPrompt')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessionQuery = ctx.get('sessionQuery')
    const skillsService = ctx.get('skills')
    const webServer = ctx.get('webServer')
    if (!fsService || !llmService) {
      console.error('[imemory] 缺少 fs/llm 服务,记忆插件停用')
      return
    }

    // ---------- 文件层:带 TTL 的文本缓存 + 串行写队列 ----------
    const textCache = { MEMORY: { text: null, at: 0 }, USER: { text: null, at: 0 } }
    let writeChain = Promise.resolve()
    let lockChain = Promise.resolve()

    function locked(fn) {
      const run = lockChain.then(fn, fn)
      lockChain = run.then(() => {}, () => {})
      return run
    }

    async function readText(file) {
      const target = await fsService.resolve(FILES[file])
      return await fsService.readText(target)
    }

    async function getText(file) {
      const cached = textCache[file]
      if (cached.text !== null && Date.now() - cached.at < 8000) return cached.text
      try {
        const text = await readText(file)
        textCache[file] = { text, at: Date.now() }
        return text
      } catch (err) {
        console.error('[imemory] 读取 ' + file + '.md 失败: ' + String(err && err.message ? err.message : err))
        return cached.text
      }
    }

    function setText(file, text) {
      textCache[file] = { text, at: Date.now() }
    }

    function writeFile(file, text) {
      const task = async () => {
        const target = await fsService.resolve(FILES[file])
        await fsService.writeText(target, text, undefined, undefined, FULL_ACCESS)
      }
      const run = writeChain.then(task, task)
      writeChain = run.then(() => {}, () => {})
      return run
    }

    function parseEntries(text) {
      if (!text) return []
      return text.split(/\r?\n\s*§\s*\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
    }

    function serializeEntries(entries) {
      return entries.length === 0 ? '' : entries.join('\n§\n') + '\n'
    }

    async function getEntries(file) {
      const text = await getText(file)
      return text === null ? null : parseEntries(text)
    }

    async function rewriteFile(file, entries) {
      const text = serializeEntries(entries)
      setText(file, text)
      await writeFile(file, text)
    }

    // ---------- 侧车索引:插件自写条目的 importance/命中/时间 ----------
    let index = { MEMORY: [], USER: [] }
    let indexDirty = false
    let indexSavePending = false

    async function loadIndex() {
      try {
        const target = await fsService.resolve(INDEX_FILE)
        const raw = await fsService.readText(target)
        const parsed = raw ? JSON.parse(raw) : null
        if (parsed && Array.isArray(parsed.MEMORY) && Array.isArray(parsed.USER)) {
          index = { MEMORY: parsed.MEMORY, USER: parsed.USER }
          console.log('[imemory] 已加载索引: MEMORY ' + index.MEMORY.length + ' 条 / USER ' + index.USER.length + ' 条')
        }
      } catch (err) { /* 索引不存在或损坏,从空开始 */ }
    }

    function scheduleIndexSave() {
      if (indexDirty && !indexSavePending) {
        indexSavePending = true
        ctx.timeout(() => {
          indexSavePending = false
          saveIndex()
        }, 8000)
      }
    }

    function saveIndex() {
      if (!indexDirty) return Promise.resolve()
      indexDirty = false
      const task = async () => {
        const target = await fsService.resolve(INDEX_FILE)
        await fsService.writeText(target, JSON.stringify(index, null, 2), undefined, undefined, FULL_ACCESS)
      }
      const run = writeChain.then(task, task)
      writeChain = run.then(() => {}, () => {})
      return run
    }

    function recOf(file, entryText) {
      const key = entryText.slice(0, 60)
      const list = index[file]
      for (const rec of list) if (rec && rec.key === key) return rec
      return undefined
    }

    function recordAdd(file, entryText, importance) {
      index[file].push({ key: entryText.slice(0, 60), importance, created: Date.now(), lastHit: 0, hits: 0 })
      indexDirty = true
    }

    function recordReplace(file, oldText, newText, importance) {
      const list = index[file]
      const oldKey = oldText.slice(0, 60)
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === oldKey) {
          list[i] = { key: newText.slice(0, 60), importance, created: list[i].created, lastHit: list[i].lastHit, hits: list[i].hits }
          indexDirty = true
          return
        }
      }
      recordAdd(file, newText, importance)
    }

    function recordRemove(file, entryText) {
      const key = entryText.slice(0, 60)
      const list = index[file]
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === key) {
          list.splice(i, 1)
          indexDirty = true
          return
        }
      }
    }

    function hitIndex(rows) {
      let changed = false
      const now = Date.now()
      for (const row of rows) {
        const rec = recOf(row.file, row.text)
        if (rec) { rec.hits += 1; rec.lastHit = now; changed = true }
      }
      if (changed) { indexDirty = true; scheduleIndexSave() }
    }

    // ---------- 学习闭环:技能库(skills.json → DSH skills 注册表) ----------
    let skillsData = { skills: [] }
    let skillsDirty = false
    const skillDisposers = new Map()

    function sanitizeSkillName(raw) {
      let name = String(raw || '').toLowerCase().trim()
      if (!name.startsWith('learned-')) name = 'learned-' + name
      name = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      if (name.length < 6 || name.length > 60) return null
      return name
    }

    function registerSkill(skill) {
      if (!skillsService || typeof skillsService.register !== 'function') return
      try {
        const old = skillDisposers.get(skill.name)
        if (typeof old === 'function') { try { old() } catch (err) { /* ignore */ } }
        const disposer = skillsService.register({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
          content: skill.content,
          source: 'custom',
        })
        skillDisposers.set(skill.name, disposer)
      } catch (err) {
        console.error('[imemory] 技能注册失败 ' + skill.name + ': ' + String(err && err.message ? err.message : err))
      }
    }

    function saveSkills() {
      if (!skillsDirty) return Promise.resolve()
      skillsDirty = false
      const task = async () => {
        const target = await fsService.resolve(SKILLS_FILE)
        await fsService.writeText(target, JSON.stringify(skillsData, null, 2), undefined, undefined, FULL_ACCESS)
      }
      const run = writeChain.then(task, task)
      writeChain = run.then(() => {}, () => {})
      return run
    }

    function skillUpsert(s) {
      const name = sanitizeSkillName(s.name)
      if (!name) return false
      const description = String(s.description || '').trim()
      const content = String(s.content || '').trim()
      if (!description || !content) return false
      const whenToUse = String(s.whenToUse || '').trim()
      const now = Date.now()
      const existing = skillsData.skills.find(x => x.name === name)
      if (existing) {
        existing.description = description
        if (whenToUse) existing.whenToUse = whenToUse
        existing.content = content
        existing.updated = now
      } else {
        skillsData.skills.push({ name, description, ...(whenToUse ? { whenToUse } : {}), content, created: now, updated: now })
      }
      skillsDirty = true
      registerSkill({ name, description, whenToUse, content })
      return true
    }

    async function loadSkills() {
      try {
        const target = await fsService.resolve(SKILLS_FILE)
        const raw = await fsService.readText(target)
        const parsed = raw ? JSON.parse(raw) : null
        if (parsed && Array.isArray(parsed.skills)) {
          skillsData = { skills: parsed.skills }
        }
      } catch (err) { /* 技能文件不存在或损坏 */ }
      for (const s of skillsData.skills) {
        if (s && typeof s.name === 'string' && typeof s.content === 'string') {
          registerSkill(s)
        }
      }
      if (skillsData.skills.length > 0) console.log('[imemory] 已注册 ' + skillsData.skills.length + ' 个学习技能')
    }

    // ---------- 检索:中文二元组 + 拉丁词 打分 ----------
    function tokenize(text) {
      const tokens = new Map()
      const push = t => { if (t) tokens.set(t, (tokens.get(t) || 0) + 1) }
      const cjk = text.match(/[\u4e00-\u9fff]+/g)
      if (cjk) for (const run of cjk) for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2))
      const words = String(text).toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}/g)
      if (words) for (const w of words) if (w.length >= 2) push(w)
      return tokens
    }

    function scoreText(text, tokens) {
      const lower = text.toLowerCase()
      let score = 0
      for (const pair of tokens) {
        const t = pair[0]
        const n = pair[1]
        if (lower.includes(t)) score += (/[\u4e00-\u9fff]/.test(t) ? 2 : 1) * n
      }
      return score
    }

    function similarity(aTokens, bTokens) {
      let sizeA = 0
      let sizeB = 0
      let shared = 0
      for (const pair of aTokens) sizeA += pair[1]
      for (const pair of bTokens) sizeB += pair[1]
      for (const pair of aTokens) {
        const m = bTokens.get(pair[0]) || 0
        if (m > 0) shared += Math.min(pair[1], m)
      }
      const denom = Math.min(sizeA, sizeB)
      return denom > 0 ? shared / denom : 0
    }

    async function keywordCandidates(query, cap) {
      const tokens = tokenize(String(query || ''))
      const rows = []
      for (const file of ['MEMORY', 'USER']) {
        const entries = await getEntries(file)
        if (entries === null) continue
        entries.forEach((text, i) => {
          const score = scoreText(text, tokens)
          if (score > 0) rows.push({ file, index: i + 1, text, score })
        })
      }
      rows.sort((a, b) => b.score - a.score)
      return rows.slice(0, cap)
    }

    function modelNow() {
      if (lastModel) return lastModel
      try {
        const sel = defaultModel && typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
        if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
      } catch (err) { /* 无默认模型 */ }
      return undefined
    }

    const RERANK_SYSTEM = [
      '你是记忆检索排序器。给定查询和若干候选记忆,选出与查询真正相关的至多 6 条,输出严格 JSON:{"picks":[候选序号]}。',
      '要求:按相关度从高到低排序;完全不相关的候选不要选;不要解释,只输出 JSON。',
    ].join('\n')

    async function rerank(query, candidates, limit) {
      const model = modelNow()
      if (!model || candidates.length === 0) return null
      try {
        const numbered = candidates.slice(0, 15).map((c, i) => (i + 1) + '. ' + c.text.slice(0, 180).replace(/\r?\n/g, ' ')).join('\n')
        const messages = [{
          id: 'mem-rerank-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: '查询: ' + query + '\n候选记忆:\n' + numbered }],
          source: { kind: 'plugin', plugin: 'imemory' },
        }]
        let out = ''
        for await (const chunk of llmService.stream({
          provider: model.provider,
          model: model.model,
          messages,
          system: RERANK_SYSTEM,
          temperature: 0,
          maxTokens: 300,
        })) {
          if (chunk && chunk.type === 'text-delta') out += chunk.text
          if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null
        }
        const m = out.trim().match(/\[[\s\S]*\]|\{[\s\S]*\}/)
        if (!m) return null
        const parsed = JSON.parse(m[0])
        const picks = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.picks) ? parsed.picks : null)
        if (!picks) return null
        const seen = new Set()
        const picked = []
        for (const p of picks) {
          const idx = Number(p) - 1
          if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length || seen.has(idx)) continue
          seen.add(idx)
          picked.push(candidates[idx])
          if (picked.length >= limit) break
        }
        return picked.length > 0 ? picked : null
      } catch (err) {
        console.error('[imemory] 语义重排失败,回退关键词顺序: ' + String(err && err.message ? err.message : err))
        return null
      }
    }

    async function recall(query, limit) {
      const cap = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 10) : 6
      const candidates = await keywordCandidates(query, 20)
      let picked
      if (candidates.length <= cap) {
        picked = candidates
      } else {
        const reranked = await rerank(query, candidates, cap)
        picked = reranked !== null ? reranked : candidates.slice(0, cap)
      }
      if (picked.length > 0) hitIndex(picked)
      return picked
    }

    function formatHits(hits) {
      return hits.map(h => {
        const shown = (h.text.length > 260 ? h.text.slice(0, 260) + '…' : h.text).replace(/\r?\n/g, ' / ')
        return '[' + h.file + '#' + h.index + '] ' + shown
      })
    }

    // 会话开场记忆:新会话第一步注入,不依赖关键词命中(imemory 会话开场加载 MEMORY.md 的等价物)
    async function sessionOpener() {
      const rows = []
      const usr = await getEntries('USER')
      if (usr && usr.length > 0) usr.forEach((text, i) => rows.push({ file: 'USER', index: i + 1, text }))
      const mem = await getEntries('MEMORY')
      if (mem) mem.forEach((text, i) => {
        const rec = recOf('MEMORY', text)
        if (rec && rec.importance >= 7) rows.push({ file: 'MEMORY', index: i + 1, text })
      })
      if (rows.length === 0) return ''
      return '<imemory>\n会话开场记忆:以下是用户的档案和最重要的事实,对话中自然运用,不要照搬复述、不要主动声明使用了记忆:\n'
        + formatHits(rows.slice(0, 8)).join('\n') + '\n</imemory>'
    }

    // ---------- 转录缓冲 ----------
    const transcripts = new Map()

    function textOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      let out = ''
      for (const b of blocks) if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n'
      return out.trim()
    }

    function captureLine(sessionId, role, text) {
      if (!text) return
      let buf = transcripts.get(sessionId)
      if (!buf) { buf = { lines: [], userCount: 0 }; transcripts.set(sessionId, buf) }
      buf.lines.push({ role, text: text.slice(0, 2000) })
      if (role === 'user') buf.userCount++
      if (buf.lines.length > 60) buf.lines.splice(0, buf.lines.length - 60)
      if (transcripts.size > 200) transcripts.delete(transcripts.keys().next().value)
    }

    function drainTranscripts() {
      const parts = []
      let userTotal = 0
      for (const pair of transcripts) {
        const sid = pair[0]
        const buf = pair[1]
        if (buf.lines.length === 0) continue
        parts.push({ sid, lines: buf.lines, userCount: buf.userCount })
        userTotal += buf.userCount
        buf.lines = []
        buf.userCount = 0
      }
      return { parts, userTotal }
    }

    // ---------- 模型路由 ----------
    function modelFromAgent(agent) {
      try {
        const session = agent && agent.session
        const req = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
        const cfg = req && req.config
        if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
      } catch (err) { /* 继续回退 */ }
      const opts = agent && agent.options
      if (opts && opts.provider && opts.model) return { provider: opts.provider, model: opts.model }
      return modelNow()
    }

    let lastModel = undefined

    // ---------- 提取(记忆 + 技能) ----------
    const EXTRACT_SYSTEM = [
      '你是"记忆提取器",为一个带长期记忆的助手工作。用户 = 使用本插件的人(其身份与偏好存于 USER.md,默认中文)。',
      '下面给出最近若干会话的对话片段(已标注角色)。你要从中提炼"以后还会用到"的持久信息,输出写入操作 JSON;没有值得记的就输出 {"ops": [], "skills": []}。',
      '记忆库 = 两个 markdown 文件,条目之间以单独一行 § 分隔,每条目一行(可以很长),风格参考:',
      '  MEMORY.md(我的笔记): 本机环境、软件安装位置、项目部署、排障教训、技能沉淀、决定与理由。',
      '  USER.md(用户档案): 用户的身份、账号、偏好、说话风格、铁律、习惯;仅在档案变化时更新。',
      '写入规则:',
      '  1. 只记长期有用的事实/偏好/教训/决定;跳过寒暄、一次性任务细节、临时调试状态。',
      '  2. 条目单行高密度中文;涉及时间点的事件用 "(YYYY-MM-DD 说明)" 前缀,永恒事实不用。',
      '  3. 已有条目被推翻/更新时用 op=update 并给 match=原条目开头 10-30 个字符;确认过期的用 op=forget 并给 match。',
      '  4. 每次最多 6 条操作,宁缺毋滥;同一事实不要拆多条。',
      '  5. 每条 add/update 必须带 importance(1-10 整数):10=用户铁律/账号/关键教训,7-8=重要偏好/部署决定,5=一般环境事实,1-2=琐碎。importance<3 会被系统丢弃,所以琐碎内容干脆别写。',
      '技能学习(自进化核心):如果对话里出现了"以后同类问题可以直接照做"的操作步骤/排障流程/配置套路,在 skills 数组输出(每次最多 2 个,宁缺毋滥);已有技能内容过时用 op=update 且 name=现有技能名。技能 = "怎么做"的流程,不是事实清单;纯事实只进 ops。',
      '输出严格 JSON(不要 markdown 代码块),格式:',
      '{"ops": [{"file": "MEMORY", "op": "add", "content": "条目全文", "importance": 6}], "skills": [{"op": "add", "name": "deploy-steps", "description": "一句话用途", "whenToUse": "什么时候用", "content": "1. 步骤一\\n2. 步骤二"}]}',
      '注意:对话中的 assistant 可能是助手自己的输出;不确定是否该长期保留的,宁可不写。',
    ].join('\n')

    function buildTranscript(parts) {
      let text = ''
      for (const p of parts) {
        if (text.length >= 6000) break
        const block = '=== 会话 ' + String(p.sid).slice(0, 12) + ' ===\n' + p.lines.map(l => '[' + l.role + '] ' + l.text).join('\n')
        const head = text.length === 0 ? block : '\n\n' + block
        if (text.length + head.length > 6000) { text += head.slice(0, 6000 - text.length); break }
        text += head
      }
      return text
    }

    function parseExtract(text) {
      const result = { ops: [], skills: [] }
      const s = String(text || '').trim()
      if (s.length === 0) return result
      let candidate = s
      if (!(s.startsWith('{') || s.startsWith('['))) {
        const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/)
        if (!m) return result
        candidate = m[0]
      }
      let parsed
      try { parsed = JSON.parse(candidate) } catch (err) {
        console.error('[imemory] 提取输出不是合法 JSON: ' + String(err && err.message ? err.message : err))
        return result
      }
      const ops = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ops) ? parsed.ops : [])
      for (const o of ops) {
        if (!o || typeof o !== 'object') continue
        const file = o.file === 'USER' ? 'USER' : 'MEMORY'
        const op = o.op === 'update' || o.op === 'forget' ? o.op : 'add'
        let importance = typeof o.importance === 'number' && Number.isFinite(o.importance) ? Math.round(o.importance) : 5
        if (importance < 1) importance = 1
        if (importance > 10) importance = 10
        result.ops.push({ file, op, content: typeof o.content === 'string' ? o.content : '', match: typeof o.match === 'string' ? o.match : '', importance })
      }
      const skills = parsed && Array.isArray(parsed.skills) ? parsed.skills : []
      for (const sk of skills) {
        if (!sk || typeof sk !== 'object') continue
        if (typeof sk.name !== 'string' || typeof sk.content !== 'string') continue
        result.skills.push({ name: sk.name, description: typeof sk.description === 'string' ? sk.description : '', whenToUse: typeof sk.whenToUse === 'string' ? sk.whenToUse : '', content: sk.content })
      }
      result.ops = result.ops.slice(0, 6)
      result.skills = result.skills.slice(0, 2)
      return result
    }

    async function applyOps(ops) {
      return locked(async () => {
        const changes = []
        for (const op of ops) {
          const file = op.file === 'USER' ? 'USER' : 'MEMORY'
          const entries = await getEntries(file)
          if (entries === null) continue
          const content = String(op.content || '').trim().replace(/\r?\n\s*§\s*\r?\n/g, ' ').slice(0, 2000)
          const match = String(op.match || '').trim()
          if (op.op === 'add') {
            if (!content) continue
            if (op.importance < 3) continue
            if (entries.some(e => e === content)) continue
            entries.push(content)
            await rewriteFile(file, entries)
            recordAdd(file, content, op.importance)
            changes.push({ file, op: 'add', index: entries.length, importance: op.importance })
          } else if (op.op === 'update') {
            if (!content || match.length < 4) continue
            if (op.importance < 3) continue
            const idx = entries.findIndex(e => e.includes(match.slice(0, 30)))
            if (idx < 0) {
              entries.push(content)
              await rewriteFile(file, entries)
              recordAdd(file, content, op.importance)
              changes.push({ file, op: 'add', index: entries.length, importance: op.importance })
            } else {
              const oldText = entries[idx]
              entries[idx] = content
              await rewriteFile(file, entries)
              recordReplace(file, oldText, content, op.importance)
              changes.push({ file, op: 'update', index: idx + 1, importance: op.importance })
            }
          } else if (op.op === 'forget') {
            if (match.length < 6) continue
            const idx = entries.findIndex(e => e.includes(match.slice(0, 30)))
            if (idx >= 0) {
              const removed = entries.splice(idx, 1)[0]
              await rewriteFile(file, entries)
              recordRemove(file, removed)
              changes.push({ file, op: 'forget', index: idx + 1 })
            }
          }
        }
        saveIndex()
        return changes
      })
    }

    async function applySkills(skills) {
      const applied = []
      for (const s of skills) {
        if (skillUpsert(s)) applied.push(s.name)
      }
      if (applied.length > 0) saveSkills()
      return applied
    }

    let extractionRunning = false
    let extractionQueued = false
    let lastExtractionAt = 0

    async function runExtraction(parts, model) {
      extractionRunning = true
      try {
        const transcriptText = buildTranscript(parts)
        if (transcriptText.trim().length === 0) return
        console.log('[imemory] 记忆提取开始(' + transcriptText.length + ' 字符, ' + model.provider + '/' + model.model + ')')
        const today = new Date().toISOString().slice(0, 10)
        const messages = [{
          id: 'mem-extract-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: '今天是 ' + today + '。\n\n对话片段:\n\n' + transcriptText }],
          source: { kind: 'plugin', plugin: 'imemory' },
        }]
        let out = ''
        for await (const chunk of llmService.stream({
          provider: model.provider,
          model: model.model,
          messages,
          system: EXTRACT_SYSTEM,
          temperature: 0.2,
          maxTokens: 2000,
        })) {
          if (chunk && chunk.type === 'text-delta') out += chunk.text
          if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            const f = chunk.reason.failure || {}
            throw new Error('LLM 提取调用失败: ' + (f.message || 'error'))
          }
        }
        const parsedExtract = parseExtract(out)
        const ops = parsedExtract.ops
        const skills = parsedExtract.skills
        if (ops.length === 0 && skills.length === 0) { console.log('[imemory] 本轮无值得沉淀的记忆'); return }
        console.log('[imemory] 提取到 ' + ops.length + ' 条记忆操作 / ' + skills.length + ' 个技能,写入中')
        const changes = await applyOps(ops)
        const appliedSkills = await applySkills(skills)
        if (changes.length > 0) console.log('[imemory] 记忆已更新: ' + changes.map(c => c.file + '#' + c.index + '(' + c.op + ',重要性' + (c.importance || '-') + ')').join(', '))
        if (appliedSkills.length > 0) console.log('[imemory] 技能已沉淀: ' + appliedSkills.join(', '))
      } catch (err) {
        console.error('[imemory] 提取失败: ' + String(err && err.message ? err.message : err))
      } finally {
        extractionRunning = false
        if (extractionQueued) {
          extractionQueued = false
          ctx.timeout(() => scheduleExtraction('queued'), 30000)
        }
      }
    }

    function scheduleExtraction(reason) {
      if (extractionRunning) { extractionQueued = true; return }
      if (!lastModel) return
      if (Date.now() - lastExtractionAt < 20000) {
        if (!extractionQueued) {
          extractionQueued = true
          ctx.timeout(() => { extractionQueued = false; scheduleExtraction('retry') }, 25000)
        }
        return
      }
      const drained = drainTranscripts()
      if (drained.userTotal < 1) return
      lastExtractionAt = Date.now()
      runExtraction(drained.parts, lastModel)
    }

    // ---------- 冲突合并 ----------
    const MERGE_SYSTEM = [
      '你是记忆整理器。下面给出若干对"疑似重复/冲突"的记忆条目对,判断是否应该合并。',
      '如果两条说的是同一件事(旧版被新版取代、重复记录、互补信息),合并成一条保留全部有效信息;如果它们其实是不同的事,不要合并。',
      '输出严格 JSON:{"merges":[{"file":"MEMORY","a":"条目A的key","b":"条目B的key","merged":"合并后的条目全文"}]}',
      'key 必须原样复制我给出的条目 key;merged 用单行高密度中文,保留日期前缀与全部有效信息;没有可合并的输出 {"merges": []}。',
    ].join('\n')

    function entryKey(text) {
      return text.slice(0, 40).replace(/\r?\n/g, ' ')
    }

    function findPairs(entries) {
      const tokensList = entries.map(e => tokenize(e))
      const pairs = []
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].length < 10) continue
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[j].length < 10) continue
          const sim = similarity(tokensList[i], tokensList[j])
          if (sim >= 0.5) pairs.push({ i, j, sim })
        }
      }
      pairs.sort((a, b) => b.sim - a.sim)
      return pairs.slice(0, 8)
    }

    async function mergeLLM(pairBatch) {
      const model = modelNow()
      if (!model || pairBatch.length === 0) return null
      try {
        const numbered = pairBatch.map((p, i) =>
          (i + 1) + '. 文件 ' + p.file + '\n   A(key=' + p.a + '): ' + p.atext + '\n   B(key=' + p.b + '): ' + p.btext
        ).join('\n')
        const messages = [{
          id: 'mem-merge-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: '条目对:\n' + numbered }],
          source: { kind: 'plugin', plugin: 'imemory' },
        }]
        let out = ''
        for await (const chunk of llmService.stream({
          provider: model.provider,
          model: model.model,
          messages,
          system: MERGE_SYSTEM,
          temperature: 0,
          maxTokens: 1200,
        })) {
          if (chunk && chunk.type === 'text-delta') out += chunk.text
          if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null
        }
        const m = out.trim().match(/\[[\s\S]*\]|\{[\s\S]*\}/)
        if (!m) return null
        const parsed = JSON.parse(m[0])
        const merges = parsed && Array.isArray(parsed.merges) ? parsed.merges : null
        if (!merges) return null
        return merges.filter(x => x && typeof x.file === 'string' && typeof x.a === 'string' && typeof x.b === 'string' && typeof x.merged === 'string')
      } catch (err) {
        console.error('[imemory] 冲突合并调用失败: ' + String(err && err.message ? err.message : err))
        return null
      }
    }

    async function runConflictMerge() {
      const model = modelNow()
      const result = { applied: [], suggestions: [] }
      if (!model) return result
      const pairBatch = []
      for (const file of ['MEMORY', 'USER']) {
        const entries = await getEntries(file)
        if (entries === null || entries.length < 2) continue
        const pairs = findPairs(entries)
        for (const p of pairs) {
          pairBatch.push({
            file,
            a: entryKey(entries[p.i]),
            b: entryKey(entries[p.j]),
            atext: entries[p.i].slice(0, 500),
            btext: entries[p.j].slice(0, 500),
          })
        }
      }
      if (pairBatch.length === 0) return result
      const merges = await mergeLLM(pairBatch)
      if (!merges) return result
      for (const m of merges) {
        const file = m.file === 'USER' ? 'USER' : 'MEMORY'
        const merged = String(m.merged || '').trim().replace(/\r?\n\s*§\s*\r?\n/g, ' ').slice(0, 2000)
        if (!merged) continue
        const aKey = entryKey(m.a)
        const bKey = entryKey(m.b)
        await locked(async () => {
          const entries = await getEntries(file)
          if (entries === null) return
          const ai = entries.findIndex(e => entryKey(e) === aKey)
          const bi = entries.findIndex(e => entryKey(e) === bKey)
          if (ai < 0 || bi < 0 || ai === bi) return
          const aRec = recOf(file, entries[ai])
          const bRec = recOf(file, entries[bi])
          if (!aRec || !bRec) {
            result.suggestions.push(file + ' 第' + (ai + 1) + ' 条 + 第' + (bi + 1) + ' 条(含非插件写入条目,建议人工确认)')
            return
          }
          const oldA = entries[ai]
          const oldB = entries[bi]
          entries[ai] = merged
          entries.splice(bi, 1)
          await rewriteFile(file, entries)
          recordReplace(file, oldA, merged, Math.max(aRec.importance, bRec.importance))
          recordRemove(file, oldB)
          saveIndex()
          result.applied.push(file + ' 第' + (ai + 1) + ' 条 + 第' + (bi + 1) + ' 条 已合并')
        })
      }
      return result
    }

    // ---------- 事件 ----------
    ctx.on('session/event', (session, event) => {
      try {
        const sid = session && session.id !== undefined ? String(session.id) : ''
        if (!sid || !event || !event.data) return
        if (event.type === 'user/message') {
          const msg = event.data
          if (!msg || !msg.source || msg.source.kind !== 'user') return
          captureLine(sid, 'user', textOf(msg.content))
        } else if (event.type === 'assistant/message') {
          const msg = event.data && event.data.message
          if (!msg) return
          captureLine(sid, 'assistant', textOf(msg.content))
        }
      } catch (err) { /* 静默,绝不影响会话 */ }
    })

    ctx.on('agent/turn-stopping', payload => {
      try {
        const agent = payload && payload.agent
        if (agent) {
          const m = modelFromAgent(agent)
          if (m) lastModel = m
          // 只让根会话触发提取,子代理回合不额外花钱
          const agents = ctx.get('agents')
          if (agents && typeof agents.roots === 'function') {
            let isRoot = false
            const roots = agents.roots()
            for (const r of roots) if (r && r.id === agent.id) { isRoot = true; break }
            if (!isRoot) return
          }
        }
        scheduleExtraction('turn')
      } catch (err) {
        console.error('[imemory] turn-stopping 处理失败: ' + String(err && err.message ? err.message : err))
      }
    })

    let recallCache = { key: '', content: '' }
    ctx.on('agent/pre-step', async (payload, next) => {
      let decision
      try {
        decision = await next()
      } catch (err) {
        console.error('[imemory] pre-step 下游失败: ' + String(err && err.message ? err.message : err))
        return { kind: 'enter', messages: Array.isArray(payload.messages) ? payload.messages : [] }
      }
      try {
        if (!decision || decision.kind !== 'enter') return decision
        // 新会话第一步(仅根会话):强制注入开场记忆,不依赖关键词命中
        if (payload.turn === 1 && payload.step === 1) {
          let isRootSession = true
          const agentsSvc = ctx.get('agents')
          if (agentsSvc && typeof agentsSvc.roots === 'function') {
            isRootSession = false
            for (const r of agentsSvc.roots()) if (r && r.id === payload.agent.id) { isRootSession = true; break }
          }
          if (isRootSession) {
            const opener = await sessionOpener()
            if (opener) {
              const openMsg = {
                id: 'mem-open-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
                role: 'user',
                content: [{ type: 'text', text: opener }],
                source: { kind: 'plugin', plugin: 'imemory' },
              }
              return { kind: 'enter', messages: [openMsg, ...decision.messages] }
            }
          }
        }
        const queryText = Array.isArray(payload.messages)
          ? payload.messages.map(m => textOf(m && m.content)).filter(t => t).join(' ').slice(0, 400)
          : ''
        if (!queryText) return decision
        const key = String(payload.agent && payload.agent.id ? payload.agent.id : '') + ':' + String(payload.turn) + ':' + queryText
        let content = ''
        if (recallCache.key === key) {
          content = recallCache.content
        } else {
          const hits = await recall(queryText, 6)
          const lines = formatHits(hits)
          if (lines.length > 0) {
            content = '<imemory>\n以下是你长期记忆库中与当前任务相关的记忆(MEMORY.md=你的笔记,USER.md=用户的档案)。按需取用,不要整段复述,也不要刻意声明使用了记忆库:\n'
              + lines.join('\n') + '\n</imemory>'
          }
          recallCache = { key, content }
        }
        if (!content) return decision
        const sysMsg = {
          id: 'mem-recall-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
          role: 'user',
          content: [{ type: 'text', text: content }],
          source: { kind: 'plugin', plugin: 'imemory' },
        }
        return { kind: 'enter', messages: [sysMsg, ...decision.messages] }
      } catch (err) {
        console.error('[imemory] 记忆召回注入失败: ' + String(err && err.message ? err.message : err))
        return decision
      }
    })

    // ---------- 系统提示 ----------
    if (promptService && typeof promptService.section === 'function') {
      promptService.section({
        name: 'memory:imemory',
        order: 80,
        text: [
          '你有自进化长期记忆,存于两个文件(条目以单独一行 § 分隔):',
          '  ' + memDir + '/MEMORY.md —— 你的笔记(本机环境、项目、教训、技能沉淀)',
          '  ' + memDir + '/USER.md —— 用户(使用者)的档案(身份、偏好、风格、铁律)',
          '用 memory_search / memory_add / memory_update / memory_forget / memory_sessions / memory_consolidate 工具读写记忆、检索历史会话、整理冲突条目。',
          '规则:对话中沉淀的持久事实写进 MEMORY.md;USER.md 只在用户档案变化时更新;条目单行高密度,可用 (YYYY-MM-DD 说明) 前缀;别写寒暄与一次性任务细节。',
          '本插件会在回合结束后自动提取值得记住的内容并把可复用流程沉淀成 learned-* 技能(可用 skill 工具加载);重大决定/教训/用户新要求可用 memory_add 兜底。',
        ].join('\n'),
      })
    }

    // ---------- 工具 ----------
    function registerMemoryTools() {
      const defs = []
      defs.push(defineTool({
        name: 'memory_search',
        description: '搜索长期记忆库(MEMORY.md 你的笔记 + USER.md 用户档案),关键词初筛后语义重排,返回相关条目及编号。回答涉及本机环境/用户偏好/历史决定的问题前先搜索。',
        parameters: {
          query: { type: 'string', required: true, description: '搜索关键词或问题,中文最佳' },
          limit: { type: 'integer', description: '最多返回条数,默认 6,最大 10' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          const hits = await recall(String(args.query || ''), args.limit)
          if (hits.length === 0) return '记忆库中没有匹配条目。'
          return '找到 ' + hits.length + ' 条相关记忆:\n' + formatHits(hits).join('\n')
        },
      }))
      defs.push(defineTool({
        name: 'memory_add',
        description: '手动向记忆库写入一条新记忆。file=MEMORY 写入你的笔记,file=USER 写入用户档案(仅档案变化时)。importance<3 会被丢弃。',
        parameters: {
          file: { type: 'string', required: true, enum: ['MEMORY', 'USER'], description: '目标文件' },
          content: { type: 'string', required: true, description: '单行高密度条目,可带 (YYYY-MM-DD 说明) 前缀' },
          importance: { type: 'integer', description: '重要度 1-10,默认 5;10=铁律/账号,5=一般事实,低于 3 不落库' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          const file = args.file === 'USER' ? 'USER' : 'MEMORY'
          const content = String(args.content || '').trim().replace(/\r?\n\s*§\s*\r?\n/g, ' ')
          if (!content) return '内容为空,未写入。'
          let importance = typeof args.importance === 'number' ? Math.round(args.importance) : 5
          if (importance < 1) importance = 1
          if (importance > 10) importance = 10
          if (importance < 3) return '重要度 ' + importance + ' 低于 3,按规则不落库。'
          return locked(async () => {
            const entries = await getEntries(file)
            if (entries === null) return '无法读取 ' + file + '.md,写入失败。'
            if (entries.some(e => e === content)) return '该条目已存在,未重复写入。'
            entries.push(content)
            await rewriteFile(file, entries)
            recordAdd(file, content, importance)
            saveIndex()
            return '已写入 ' + file + '.md 第 ' + entries.length + ' 条(重要度 ' + importance + '): ' + content.slice(0, 80)
          })
        },
      }))
      defs.push(defineTool({
        name: 'memory_update',
        description: '用编号替换记忆库中的一条旧记忆(memory_search 结果里的 #编号)。条目过时/被推翻时更新。',
        parameters: {
          file: { type: 'string', required: true, enum: ['MEMORY', 'USER'], description: '目标文件' },
          index: { type: 'integer', required: true, description: 'memory_search 返回的 #编号(从 1 开始)' },
          content: { type: 'string', required: true, description: '替换后的新条目全文' },
          importance: { type: 'integer', description: '可选新重要度 1-10;不传沿用原值' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          const file = args.file === 'USER' ? 'USER' : 'MEMORY'
          return locked(async () => {
            const entries = await getEntries(file)
            if (entries === null) return '无法读取 ' + file + '.md。'
            const idx = Number(args.index) - 1
            if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return '编号无效:' + args.index + '(' + file + '.md 共 ' + entries.length + ' 条)。'
            const oldText = entries[idx]
            entries[idx] = String(args.content || '').trim().replace(/\r?\n\s*§\s*\r?\n/g, ' ')
            const oldRec = recOf(file, oldText)
            let importance = oldRec ? oldRec.importance : 5
            if (typeof args.importance === 'number') {
              importance = Math.round(args.importance)
              if (importance < 1) importance = 1
              if (importance > 10) importance = 10
            }
            if (importance < 3) return '重要度 ' + importance + ' 低于 3,按规则不落库。'
            await rewriteFile(file, entries)
            recordReplace(file, oldText, entries[idx], importance)
            saveIndex()
            return '已更新 ' + file + '.md 第 ' + (idx + 1) + ' 条(重要度 ' + importance + ')。\n旧: ' + oldText.slice(0, 80) + '\n新: ' + entries[idx].slice(0, 80)
          })
        },
      }))
      defs.push(defineTool({
        name: 'memory_forget',
        description: '删除记忆库中的一条旧记忆(按 memory_search 的 #编号)。条目被证实过期/错误时使用。',
        parameters: {
          file: { type: 'string', required: true, enum: ['MEMORY', 'USER'], description: '目标文件' },
          index: { type: 'integer', required: true, description: 'memory_search 返回的 #编号(从 1 开始)' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          const file = args.file === 'USER' ? 'USER' : 'MEMORY'
          return locked(async () => {
            const entries = await getEntries(file)
            if (entries === null) return '无法读取 ' + file + '.md。'
            const idx = Number(args.index) - 1
            if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return '编号无效:' + args.index + '(' + file + '.md 共 ' + entries.length + ' 条)。'
            const removed = entries.splice(idx, 1)[0]
            await rewriteFile(file, entries)
            recordRemove(file, removed)
            saveIndex()
            return '已删除 ' + file + '.md 第 ' + (idx + 1) + ' 条: ' + removed.slice(0, 80)
          })
        },
      }))
      defs.push(defineTool({
        name: 'memory_sessions',
        description: '全文检索历史会话记录(跨会话),返回最相关的会话片段。记忆库里没有、但以前聊过的话题,用它翻旧账。',
        parameters: {
          query: { type: 'string', required: true, description: '全文检索关键词' },
          limit: { type: 'integer', description: '最多返回条数,默认 5,最大 10' },
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          if (!sessionQuery || typeof sessionQuery.searchSessions !== 'function') return 'sessionQuery 服务不可用,会话检索未启用。'
          const q = String(args.query || '').trim()
          if (!q) return '查询为空。'
          const cap = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 10) : 5
          try {
            const page = await sessionQuery.searchSessions({ query: q, sessionFilters: [], eventFilters: [] })
            const items = Array.isArray(page && page.items) ? page.items : []
            if (items.length === 0) return '没有找到相关的历史会话记录。'
            const lines = ['历史会话检索结果(' + Math.min(items.length, cap) + ' 条):']
            items.slice(0, cap).forEach((hit, i) => {
              const bm = hit && hit.bestMatch
              const header = hit && hit.header
              const snippet = bm && typeof bm.snippet === 'string' ? bm.snippet.replace(/\r?\n/g, ' ').slice(0, 220) : ''
              const t = bm && bm.time ? new Date(bm.time).toISOString().slice(0, 16) : '?'
              lines.push('', (i + 1) + '. 会话 ' + String(header && header.id ? header.id : '?') + ' | ' + t + ' | ' + String(bm && bm.type ? bm.type : '') + '\n   ' + snippet)
            })
            return lines.join('\n')
          } catch (err) {
            return '会话检索失败: ' + String(err && err.message ? err.message : err)
          }
        },
      }))
      defs.push(defineTool({
        name: 'memory_consolidate',
        description: '整理记忆库:LLM 裁决相似/冲突条目合并(插件自写条目自动合并,非插件写入的手写条目只报告建议不自动动),并去重。发现记忆打架/重复时用它。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute() {
          const model = modelNow()
          if (!model) return '没有可用模型,无法整理。'
          const result = await runConflictMerge()
          const lines = []
          if (result.applied.length > 0) lines.push('已自动合并(' + result.applied.length + ' 对):\n' + result.applied.map(s => '  - ' + s).join('\n'))
          if (result.suggestions.length > 0) lines.push('需要人工确认的疑似重复:\n' + result.suggestions.map(s => '  - ' + s).join('\n'))
          if (lines.length === 0) return '没有发现需要合并的相似条目。'
          return lines.join('\n\n')
        },
      }))
      for (const def of defs) ctx.tools.register(def)
      return defs.length
    }

    const toolCount = registerMemoryTools()

    // ---------- 面板 HTTP API + 静态页(永久,替代动态插件的设置面板) ----------
    if (webServer && typeof webServer.register === 'function') {
      const json = (res, code, value) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      const readBody = req => new Promise((resolve, reject) => {
        let raw = ''
        req.on('data', c => { raw += c; if (raw.length > 65536) { reject(new Error('body too large')); req.destroy() } })
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (err) { reject(err) } })
        req.on('error', reject)
      })

      webServer.register({
        kind: 'exact',
        path: '/imemory/api/stats',
        handler: async (req, res) => {
          try {
            const memEntries = await getEntries('MEMORY')
            const usrEntries = await getEntries('USER')
            const withMeta = (file, entries) => (entries || []).map((text, i) => {
              const rec = recOf(file, text)
              return {
                index: i + 1,
                text: text.length > 300 ? text.slice(0, 300) + '…' : text,
                importance: rec ? rec.importance : null,
                hits: rec ? rec.hits : null,
                owned: !!rec,
              }
            })
            json(res, 200, {
              memory: withMeta('MEMORY', memEntries),
              user: withMeta('USER', usrEntries),
              counts: { memory: memEntries ? memEntries.length : 0, user: usrEntries ? usrEntries.length : 0 },
              skills: skillsData.skills.map(s => ({ name: s.name, description: s.description })),
              lastExtractionAt,
            })
          } catch (err) {
            json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/imemory/api/forget',
        handler: async (req, res) => {
          try {
            const body = await readBody(req)
            const file = body.file === 'USER' ? 'USER' : 'MEMORY'
            const idx = Number(body.index) - 1
            const out = await locked(async () => {
              const entries = await getEntries(file)
              if (entries === null) return { ok: false, error: '无法读取 ' + file + '.md' }
              if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return { ok: false, error: '编号无效' }
              const removed = entries.splice(idx, 1)[0]
              await rewriteFile(file, entries)
              recordRemove(file, removed)
              saveIndex()
              return { ok: true }
            })
            json(res, 200, out)
          } catch (err) {
            json(res, 400, { ok: false, error: String(err && err.message ? err.message : err) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/imemory/api/importance',
        handler: async (req, res) => {
          try {
            const body = await readBody(req)
            const file = body.file === 'USER' ? 'USER' : 'MEMORY'
            const idx = Number(body.index) - 1
            let importance = Number(body.importance)
            if (!Number.isInteger(importance)) importance = 5
            if (importance < 1) importance = 1
            if (importance > 10) importance = 10
            const out = await locked(async () => {
              const entries = await getEntries(file)
              if (entries === null) return { ok: false, error: '无法读取 ' + file + '.md' }
              if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return { ok: false, error: '编号无效' }
              const rec = recOf(file, entries[idx])
              if (!rec) return { ok: false, error: '该条目不是插件写入的,没有重要度记录(可用对话里的 memory_update 管理)' }
              rec.importance = importance
              indexDirty = true
              saveIndex()
              return { ok: true, importance }
            })
            json(res, 200, out)
          } catch (err) {
            json(res, 400, { ok: false, error: String(err && err.message ? err.message : err) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/imemory/api/consolidate',
        handler: async (req, res) => {
          try {
            const result = await runConflictMerge()
            json(res, 200, { applied: result.applied, suggestions: result.suggestions })
          } catch (err) {
            json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
          }
        },
      })

      webServer.register({
        kind: 'prefix',
        path: '/imemory',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(PANEL_HTML)
        },
      })
    }

    const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆库 · imemory</title>
<style>
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #12141a; color: #e6e8ee; }
h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 8px; }
.muted { color: #8a8f98; font-size: 12px; }
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
button { font-size: 12px; border: 1px solid #4a4f5a; background: transparent; color: #e6e8ee; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
button:hover { background: rgba(255,255,255,.08); }
.card { border: 1px solid #2c313c; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; display: flex; gap: 8px; align-items: flex-start; }
.badge { font-size: 11px; border-radius: 6px; padding: 1px 6px; background: rgba(90,130,255,.18); color: #7ea2ff; white-space: nowrap; margin-top: 1px; }
.badge.hand { background: rgba(150,150,150,.18); color: #9aa0a8; }
.text { flex: 1; word-break: break-all; font-size: 13px; line-height: 1.5; }
.actions { display: flex; gap: 4px; flex-shrink: 0; }
#notice { color: #7ea2ff; font-size: 12px; }
</style>
</head>
<body>
<h1>🧠 imemory 自进化记忆库 <span class="muted" id="counts"></span></h1>
<div class="bar">
  <button id="refresh">刷新</button>
  <button id="consolidate">整理冲突</button>
  <span id="notice"></span>
</div>
<h2>🧠 MEMORY.md 我的笔记</h2><div id="mem"></div>
<h2>👤 USER.md 用户档案</h2><div id="usr"></div>
<h2>🎓 learned-* 学习技能</h2><div id="skills"></div>
<script>
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function row(file, e) {
  const owned = e.owned === true
  const card = document.createElement('div')
  card.className = 'card'
  const badge = document.createElement('div')
  badge.className = 'badge' + (owned ? '' : ' hand')
  badge.textContent = owned ? ('★' + e.importance) : '手写'
  card.appendChild(badge)
  const text = document.createElement('div')
  text.className = 'text'
  text.innerHTML = '#' + e.index + ' ' + esc(e.text) + (owned ? '<div class="muted">命中 ' + (e.hits || 0) + ' 次</div>' : '')
  card.appendChild(text)
  if (owned) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; actions.appendChild(b) }
    mk('−', () => api('/imemory/api/importance', { file, index: e.index, importance: Math.max(1, (e.importance || 5) - 1) }).then(() => load()))
    mk('+', () => api('/imemory/api/importance', { file, index: e.index, importance: Math.min(10, (e.importance || 5) + 1) }).then(() => load()))
    mk('删', () => { if (confirm('删除 ' + file + '.md 第 ' + e.index + ' 条?')) api('/imemory/api/forget', { file, index: e.index }).then(() => load()) })
    card.appendChild(actions)
  }
  return card
}
function fill(el, items, file) {
  el.innerHTML = ''
  if (!items || items.length === 0) { el.innerHTML = '<div class="muted">暂无条目。</div>'; return }
  for (const e of items) el.appendChild(row(file, e))
}
async function load() {
  const data = await api('/imemory/api/stats')
  document.getElementById('counts').textContent = data.counts ? (data.counts.memory + ' 条笔记 / ' + data.counts.user + ' 条用户档案') : ''
  fill(document.getElementById('mem'), data.memory, 'MEMORY')
  fill(document.getElementById('usr'), data.user, 'USER')
  const sk = document.getElementById('skills')
  sk.innerHTML = ''
  for (const s of (data.skills || [])) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = '<div class="badge">' + esc(s.name) + '</div><div class="text">' + esc(s.description || '') + '</div>'
    sk.appendChild(card)
  }
  document.getElementById('notice').textContent = ''
}
document.getElementById('refresh').onclick = load
document.getElementById('consolidate').onclick = async () => {
  document.getElementById('notice').textContent = '整理中…'
  const r = await api('/imemory/api/consolidate', {})
  document.getElementById('notice').textContent = (r.applied && r.applied.length ? '已合并 ' + r.applied.length + ' 对;' : '') + (r.suggestions && r.suggestions.length ? ' 人工建议 ' + r.suggestions.length + ' 条' : '') + (r.applied && r.applied.length === 0 && (!r.suggestions || r.suggestions.length === 0) ? '没有需要合并的条目' : '')
  load()
}
load()
</script>
</body>
</html>
`

    // ---------- 固化:冲突合并 + 去重 + 衰减淘汰 + 索引孤儿清理 ----------
    function consolidateOnce() {
      return (async () => {
        const changes = []
        const mergeResult = await runConflictMerge()
        for (const s of mergeResult.applied) changes.push(s)
        const now = Date.now()
        for (const file of ['MEMORY', 'USER']) {
          const entries = await getEntries(file)
          if (entries === null) continue
          const seen = new Map()
          const keep = []
          for (const e of entries) {
            const key = e.slice(0, 60)
            if (!seen.has(key)) { seen.set(key, true); keep.push(e) }
          }
          if (keep.length !== entries.length) {
            changes.push(file + ' 去重: ' + entries.length + ' -> ' + keep.length)
          }
          const liveKeys = new Set(keep.map(e => e.slice(0, 60)))
          let removedCount = 0
          const finalEntries = []
          for (const e of keep) {
            const rec = recOf(file, e)
            if (!rec) { finalEntries.push(e); continue }
            const ageDays = (now - rec.created) / 86400000
            const effective = rec.importance + Math.min(rec.hits, 20) * 0.25 - ageDays * 0.15
            if (ageDays > 14 && effective <= 1.5) {
              removedCount++
            } else {
              finalEntries.push(e)
            }
          }
          if (removedCount > 0) {
            await rewriteFile(file, finalEntries)
            changes.push(file + ' 衰减淘汰 ' + removedCount + ' 条(长期未命中低重要度)')
          }
          const list = index[file]
          const cleaned = list.filter(rec => rec && liveKeys.has(rec.key))
          if (cleaned.length !== list.length) {
            index[file] = cleaned
            indexDirty = true
            changes.push(file + ' 索引清理 ' + (list.length - cleaned.length) + ' 条孤儿')
          }
        }
        saveIndex()
        return changes
      })().catch(err => console.error('[imemory] 固化失败: ' + String(err && err.message ? err.message : err)))
    }

    ctx.interval(() => {
      consolidateOnce().then(changes => {
        if (changes && changes.length > 0) console.log('[imemory] 固化: ' + changes.join('; '))
      })
    }, 6 * 60 * 60 * 1000)

    // ---------- 启动 ----------
    ;(async () => {
      try { await mkdir(memDir, { recursive: true }) } catch (err) {
        console.error('[imemory] 创建记忆目录失败: ' + String(err && err.message ? err.message : err))
      }
      await loadIndex()
      await loadSkills()
      for (const file of ['MEMORY', 'USER']) {
        try {
          const entries = await getEntries(file)
          console.log('[imemory] 已加载 ' + file + '.md: ' + (entries === null ? 0 : entries.length) + ' 条')
        } catch (err) { /* ignore */ }
      }
      const panelUrl = 'http://' + (webServer && webServer.host ? webServer.host : '127.0.0.1') + ':' + (webServer && webServer.port ? webServer.port : '<端口>') + '/imemory/'
      console.log('[imemory] 就绪:importance 打分 / 衰减淘汰 / LLM 语义重排 / 会话检索 / 冲突合并 / 技能学习闭环 / 面板 ' + panelUrl + ' / ' + toolCount + ' 个工具;记忆目录 ' + memDir)
    })()
  },
}
