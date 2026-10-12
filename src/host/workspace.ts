// ============================================================
// 模块一:作品管理(原 dsh-woody-workspace 宿主逻辑,行为不变)
// 路由:/api/woody/config、/api/woody/workspace/*
// ============================================================

import { readdirSync, mkdirSync, rmSync, renameSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCRIPT_DIRS, bootLog, loadConfig, saveConfig, normPath,
  makeSafeRegistry, type WorkspaceLike,
} from './shared'

const DEFAULT_DATA_ROOT = 'D:\\WooDy-DSH\\作品'
// AGENTS 模板:随插件分发(templates/,即 lib 的上一级)
const AGENTS_TPL_PATH = fileURLToPath(new URL('../templates/AGENTS-模板.md', import.meta.url))

export interface HostEnv {
  ctx: any
  input: any
  json: (res: any, code: number, data: unknown) => void
  readBody: (req: any) => Promise<any>
}

/** 当前数据根(patch/自检传入 > config.json > 默认值);可运行中切换 */
export function createWorkspaceModule(env: HostEnv) {
  const { ctx, json, readBody } = env
  const { safeRegistryList, safeRegistryCall } = makeSafeRegistry(ctx)
  let dataRoot = resolve(String(env.input?.dataRoot || '') || (loadConfig() as any).dataRoot || DEFAULT_DATA_ROOT)
  // 用户名:填进新建作品的 AGENTS.md(身份节);输入 > 配置文件 > 空
  let userName = String(env.input?.userName ?? '').trim() || String((loadConfig() as any).userName ?? '').trim()

  /** 渲染 AGENTS.md:用户名/作品名占位符;未设置的用户名整行移除,占位符记号不带给 AI */
  function renderAgents(workName: string): string | null {
    try {
      let tpl = readFileSync(AGENTS_TPL_PATH, 'utf-8')
      const uname = userName.trim()
      if (uname) tpl = tpl.replaceAll('{{用户名}}', uname)
      tpl = tpl.replaceAll('{{作品名}}', workName)
      tpl = tpl.split('\n').filter((line) => !line.includes('{{')).join('\n').replace(/\n{3,}/g, '\n\n')
      return tpl
    } catch { return null }
  }

  /** 生成作品的 AGENTS.md(已存在则跳过,绝不覆盖) */
  function writeAgents(dir: string, workName: string): boolean {
    const target = join(dir, 'AGENTS.md')
    if (existsSync(target)) return false
    const tpl = renderAgents(workName)
    if (tpl === null) { bootLog('AGENTS.md 生成失败（模板不可读）：' + dir); return false }
    writeFileSync(target, tpl, 'utf-8')
    return true
  }

  function validName(name: unknown): boolean {
    return /^[\u4e00-\u9fff《》\w-]{1,50}$/.test(String(name ?? '').trim())
  }

  async function listWorks() {
    if (!existsSync(dataRoot)) return []
    const entries = readdirSync(dataRoot, { withFileTypes: true })
    // 目录与符号链接都算作品(junction 形式的目录 isDirectory() 为 false)
    const dirs = entries.filter((ent) => ent.isDirectory() || ent.isSymbolicLink())
    const workspaces = await safeRegistryList()
    const items = dirs.map((ent) => {
      const dir = join(dataRoot, ent.name)
      const ws = workspaces.find((w) => normPath(w.path) === normPath(dir))
      return {
        // 显示名取工作区标题(重命名只改标题 → 目录不动 → 历史会话保留);
        // 未注册的目录回落到目录名
        name: ws?.title || ent.name,
        dirName: ent.name,
        path: dir,
        workspaceId: ws?.id ?? null, sessions: ws?.sessionIds?.length ?? 0,
        orphan: false,
      }
    })
    // 孤儿注册:DSH 里还登记着、但目录已经不在了的工作区
    const known = new Set(items.map((i) => normPath(i.path)))
    const rootNorm = normPath(dataRoot)
    for (const ws of workspaces) {
      const p = String(ws?.path ?? '')
      if (!p) continue
      const pn = normPath(p)
      if (pn === rootNorm || !pn.startsWith(rootNorm + '\\')) continue
      if (known.has(pn)) continue
      items.push({
        name: p.split('\\').pop() || p,
        dirName: p.split('\\').pop() || p,
        path: p,
        workspaceId: ws?.id ?? null,
        sessions: ws?.sessionIds?.length ?? 0,
        orphan: true,
      })
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  /** 处理本模块路由;未匹配返回 false */
  async function handle(pathname: string, req: any, res: any, port: number): Promise<boolean> {
    // 数据存放位置:读取当前值 / 修改(修改即切换作品管理所在目录)
    if (pathname === '/api/woody/config') {
      if (req.method === 'GET') {
        json(res, 200, { dataRoot, exists: existsSync(dataRoot), port, userName })
        return true
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const next = String(body.dataRoot ?? '').trim()
        if (!next) { json(res, 400, { error: '数据存放位置不能为空' }); return true }
        const nextResolved = resolve(next)
        // 目录不存在时自动创建(首次切换到新位置)
        try { if (!existsSync(nextResolved)) mkdirSync(nextResolved, { recursive: true }) } catch (e: any) {
          json(res, 400, { error: '无法创建该目录：' + String(e?.message ?? e) }); return true
        }
        dataRoot = nextResolved
        if (body.userName !== undefined) userName = String(body.userName).trim()
        saveConfig({ dataRoot: nextResolved, userName })
        bootLog('数据存放位置已切换为：' + nextResolved)
        ctx.logger?.info?.(`[woody-studio] 数据存放位置切换为：${nextResolved}`)
        json(res, 200, { dataRoot, exists: true, userName })
        return true
      }
      json(res, 405, { error: 'method' }); return true
    }

    if (pathname === '/api/woody/workspace/list') {
      if (req.method !== 'GET') { json(res, 405, { error: 'method' }); return true }
      json(res, 200, { items: await listWorks() })
      return true
    }

    if (pathname === '/api/woody/workspace/create') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return true }
      const body = await readBody(req)
      const name = String(body.name ?? '').trim()
      if (!validName(name)) { json(res, 400, { error: '作品名不合法（限中文/字母/数字/书名号，1-50 字）' }); return true }
      const dir = join(dataRoot, name)
      if (existsSync(dir)) { json(res, 409, { error: `作品「${name}」已存在` }); return true }
      for (const d of SCRIPT_DIRS) mkdirSync(join(dir, d), { recursive: true })
      writeFileSync(join(dir, '待定.md'), `# ${name}\n\n（创作从这里开始）\n`, 'utf-8')
      // 作品资料天生 3 个 MD(参考实现模板)
      const now = new Date()
      const p2 = (v: number): string => String(v).padStart(2, '0')
      const ts = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`
      const tsLine = `> 最后修改：${ts}\n\n`
      writeFileSync(join(dir, '作品资料', '作品信息.md'), tsLine +
        `# 作品基本信息\n\n## 必填\n\n- **书名**：${name}\n- **类型**：（待补充）\n- **市场定位**：（待补充）\n- **总集数规划**：（待补充）\n- **单集时长**：（待补充）\n- **细纲字数**：（待补充）字/集\n- **剧本字数**：（待补充）字/集\n\n## 选填\n\n- **目标平台**：（待补充）\n- **核心卖点**：（待补充）\n`, 'utf-8')
      writeFileSync(join(dir, '作品资料', '世界观.md'), tsLine + '# 世界观设定\n\n（待补充）\n', 'utf-8')
      writeFileSync(join(dir, '作品资料', '角色.md'), tsLine + '# 角色档案\n\n（待补充）\n', 'utf-8')
      // 系统提示词:AGENTS.md(DSH 会话在作品目录开会话时自动加载;模板随插件分发,
      // 占位符按配置填充;生成失败不影响建作品,2026-10-10 用户要求)
      writeAgents(dir, name)
      // 注册为 DSH 工作区(可选增强:注册表不可用时作品仍可用,只是不登记)
      const existing = await safeRegistryCall('resolveByPath', dir)
      const ws = existing ?? await safeRegistryCall('create', dir, name)
      const workspaceId = (ws as WorkspaceLike)?.id ?? null
      ctx.logger?.info?.(`[woody-studio] 创建作品「${name}」：${dir}（workspaceId=${workspaceId}）`)
      json(res, 200, { name, path: dir, workspaceId })
      return true
    }

    if (pathname === '/api/woody/workspace/delete') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return true }
      const body = await readBody(req)
      const name = String(body.name ?? '').trim()
      if (!validName(name)) { json(res, 400, { error: '作品名不合法' }); return true }
      const dir = join(dataRoot, name)
      // 先取注册:目录与注册二者有一即可处理(支持清理「有注册、无目录」的孤儿)
      const existing = await safeRegistryCall('resolveByPath', dir)
      if (!existsSync(dir) && !existing) { json(res, 404, { error: `作品「${name}」不存在` }); return true }
      // 删作品 = 删目录 + 删工作区注册;会话做什么处理由 DSH 原生机制决定,
      // 插件不额外干预(不调用 archiveSession)。
      if (existing) await safeRegistryCall('delete', (existing as WorkspaceLike).id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      ctx.logger?.info?.(`[woody-studio] 删除作品「${name}」：目录与工作区注册已移除（会话交由 DSH 原生处理）`)
      json(res, 200, { deleted: true })
      return true
    }

    if (pathname === '/api/woody/workspace/rename') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return true }
      const body = await readBody(req)
      // 用 path 定位(唯一),而不是名字(显示名与目录名可能不同)
      const targetPath = String(body.path ?? '').trim()
      const newName = String(body.newName ?? '').trim()
      if (!targetPath) { json(res, 400, { error: '缺少作品路径' }); return true }
      if (!validName(newName)) { json(res, 400, { error: '作品名不合法（限中文/字母/数字/书名号，1-50 字）' }); return true }
      const dir = resolve(targetPath)
      // 安全边界:只能在当前数据存放位置内操作
      const rootNorm = normPath(dataRoot)
      if (normPath(dir) !== rootNorm && !normPath(dir).startsWith(rootNorm + '\\')) {
        json(res, 400, { error: '该路径不在当前数据存放位置内' }); return true
      }
      if (!existsSync(dir)) { json(res, 404, { error: '作品目录不存在' }); return true }

      const existing = await safeRegistryCall('resolveByPath', dir)
      if (existing && typeof (existing as WorkspaceLike).setTitle === 'function') {
        // 已注册为 DSH 工作区:按官方语义【只改标题,目录不动】——
        // 会话归属由「会话目录 == 工作区路径」决定,路径不变 → 历史对话完整保留。
        const conflict = (await safeRegistryList()).some(
          (w) => w.id !== (existing as WorkspaceLike).id && String(w.title ?? '') === newName,
        )
        if (conflict) { json(res, 409, { error: `已有作品叫「${newName}」` }); return true }
        try {
          await (existing as WorkspaceLike).setTitle!(newName)
        } catch (e: any) {
          json(res, 500, { error: 'DSH 拒绝改名：' + String(e?.message ?? e) }); return true
        }
        ctx.logger?.info?.(`[woody-studio] 重命名（改标题）：${dir} → 「${newName}」（目录不变，历史对话保留）`)
        json(res, 200, { renamed: true, name: newName, dirName: dir.split('\\').pop(), path: dir, mode: 'title' })
        return true
      }

      // 未注册为工作区:没有会话归属问题,直接改目录名
      const newDir = join(dataRoot, newName)
      if (existsSync(newDir)) { json(res, 409, { error: `作品「${newName}」已存在` }); return true }
      renameSync(dir, newDir)
      ctx.logger?.info?.(`[woody-studio] 重命名（改目录，未注册工作区）：${dir} → ${newDir}`)
      json(res, 200, { renamed: true, name: newName, dirName: newName, path: newDir, mode: 'directory' })
      return true
    }

    return false
  }

  /** 开机巡检(幂等):数据根下的作品目录,未注册的自动登记进注册表,
   *  缺 AGENTS.md 的按当前配置补生成(作品名=目录名)。迁入旧作品/手工拷贝的目录都靠它纳管。 */
  async function ensureWorks(): Promise<void> {
    try {
      const items = await listWorks()
      let registered = 0, generated = 0
      for (const it of items) {
        if (it.orphan) continue
        if (it.workspaceId == null) {
          const ws = await safeRegistryCall('create', it.path, it.dirName)
          if (ws) registered++
        }
        if (writeAgents(it.path, it.dirName)) generated++
      }
      const parts: string[] = []
      if (registered) parts.push(`登记作品 ${registered} 部`)
      if (generated) parts.push(`补生成 AGENTS.md ${generated} 份`)
      if (parts.length) {
        bootLog('开机巡检：' + parts.join(','))
        ctx.logger?.info?.('[woody-studio] 开机巡检：' + parts.join(','))
      }
    } catch (e: any) {
      bootLog('开机巡检失败（不影响运行）：' + String(e?.message ?? e))
    }
  }

  return { handle, getDataRoot: () => dataRoot, ensureWorks }
}
