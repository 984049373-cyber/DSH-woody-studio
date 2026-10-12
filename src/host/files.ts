// ============================================================
// 模块二:文件 + 版本数据服务(原 dsh-woody-files 宿主逻辑,行为不变)
// 路由:/api/woody/files/*(识别/文件树/读写/保存/版本/恢复/地址解析)
// ============================================================

import {
  readdirSync, mkdirSync, rmSync, renameSync, existsSync, writeFileSync,
  readFileSync, statSync, unlinkSync,
} from 'node:fs'
import { join, resolve, dirname, basename, extname } from 'node:path'
import {
  SCRIPT_DIRS, bootLog, normPath, naturalCompare, makeSafeRegistry,
  isScriptWorkspaceDir, parseFileAddress, type WorkspaceLike,
} from './shared'

/** 每个文件保留的历史版本上限(超出删最旧;用户拍板 20 份,2026-10-03) */
const VERSION_KEEP = 20
/** 快照文件名:`文件名.YYYYMMDD-HHMMSS.md`;同秒防撞时 `文件名.ts-2.md` */
const SNAP_RE = /\.(\d{8}-\d{6})(?:-\d+)?\.md$/
/** 文件树只展示这些类型(与原版一致) */
const VISIBLE_EXTS = new Set(['.md', '.docx'])
const HIDDEN_NAMES = new Set(['.versions', '.hermes_session'])

/** 当前时刻 → 快照时间戳标签(本地时间 YYYYMMDD-HHMMSS,与原版一致) */
function snapTS(): string {
  const n = new Date()
  const p = (v: number): string => String(v).padStart(2, '0')
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`
}

/** 同秒防撞(移植原版 2026-09-17 修复):同名时自动加 -2/-3 序号,保证永不覆盖 */
function uniqueSnapshotPath(versionsDir: string, baseName: string, ts: string): string {
  let candidate = join(versionsDir, `${baseName}.${ts}.md`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(versionsDir, `${baseName}.${ts}-${n}.md`)
    n += 1
  }
  return candidate
}

/** 快照按修改时间旧→新排序(带序号的文件名字符串序不可靠,原版教训) */
function sortByMtime(versionsDir: string, files: string[]): string[] {
  return files.sort((a, b) => statSync(join(versionsDir, a)).mtimeMs - statSync(join(versionsDir, b)).mtimeMs)
}

/** 列出某文件的全部快照(旧→新;匹配规则兼容同秒序号段) */
function listSnapshots(versionsDir: string, baseName: string): string[] {
  if (!existsSync(versionsDir)) return []
  const files = readdirSync(versionsDir)
    .filter((f) => f.startsWith(baseName + '.') && SNAP_RE.test(f))
    .filter((f) => f.replace(SNAP_RE, '') === baseName)
  return sortByMtime(versionsDir, files)
}

export interface HostEnv {
  ctx: any
  input: any
  json: (res: any, code: number, data: unknown) => void
  readBody: (req: any) => Promise<any>
}

export function createFilesModule(env: HostEnv) {
  const { ctx, json, readBody } = env
  const { safeRegistryList } = makeSafeRegistry(ctx)

  /** 按会话 id 反查它所属的工作区(用官方注册表,不碰会话存储) */
  const findWorkspaceBySession = async (sessionId: string): Promise<WorkspaceLike | undefined> => {
    if (!sessionId) return undefined
    const all = await safeRegistryList()
    return all.find((w) => (w.sessionIds ?? []).includes(sessionId))
  }

  /** 路径安全守卫:目标路径必须位于某个「剧本工作区」目录之下。所有文件接口先过这里。 */
  const guardPath = async (target: string): Promise<{ ok: boolean; workPath?: string; error?: string }> => {
    if (!target || typeof target !== 'string') return { ok: false, error: '缺少路径' }
    const targetNorm = normPath(resolve(target))
    const all = await safeRegistryList()
    for (const w of all) {
      const wp = String(w.path ?? '')
      if (!wp) continue
      const wpNorm = normPath(wp)
      if (targetNorm !== wpNorm && !targetNorm.startsWith(wpNorm + '\\')) continue
      if (!isScriptWorkspaceDir(wp)) continue
      return { ok: true, workPath: wp }
    }
    return { ok: false, error: '该路径不在任何剧本工作区内（已拒绝）' }
  }

  /** 处理本模块路由;未匹配返回 false */
  async function handle(pathname: string, req: any, res: any, query: URLSearchParams): Promise<boolean> {
    if (!pathname.startsWith('/api/woody/files/')) return false

    // ① 识别:当前会话是否属于剧本工作区
    if (pathname === '/api/woody/files/context') {
      const sessionId = String(query.get('sessionId') ?? '')
      const ws = await findWorkspaceBySession(sessionId)
      if (!ws || !ws.path) {
        bootLog(`context 查询：sessionId=${sessionId || '(空)'} → 该会话不属于任何工作区`)
        json(res, 200, { isScriptWorkspace: false, reason: '该会话不属于任何工作区' })
        return true
      }
      const ok = isScriptWorkspaceDir(ws.path)
      bootLog(`context 查询：sessionId=${sessionId} → 工作区「${ws.title ?? ''}」${ws.path} → ${ok ? '是剧本工作区 ✓' : '缺少剧本骨架 ✗'}`)
      json(res, 200, {
        isScriptWorkspace: ok,
        workPath: ok ? ws.path : undefined,
        workName: ok ? (ws.title || basename(ws.path)) : undefined,
        reason: ok ? undefined : '该工作区目录缺少剧本骨架（大纲/记忆/剧本/细纲/作品资料）',
      })
      return true
    }

    // ② 文件树
    if (pathname === '/api/woody/files/list') {
      const dir = String(query.get('dir') ?? '')
      const guard = await guardPath(dir)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) { json(res, 200, { items: [] }); return true }
      const items = readdirSync(dir)
        .filter((n) => !n.startsWith('.') && !HIDDEN_NAMES.has(n))
        .map((n) => {
          const full = join(dir, n)
          let isDir = false
          try { isDir = statSync(full).isDirectory() } catch { return null }
          if (!isDir && !VISIBLE_EXTS.has(extname(n).toLowerCase())) return null
          return { name: n, path: full, isDir }
        })
        .filter((x): x is { name: string; path: string; isDir: boolean } => x !== null)
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : naturalCompare(a.name, b.name)))
      json(res, 200, { items, dir })
      return true
    }

    // ③ 读文件
    if (pathname === '/api/woody/files/read') {
      const target = String(query.get('path') ?? '')
      const guard = await guardPath(target)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!existsSync(target)) { json(res, 404, { error: '文件不存在' }); return true }
      if (extname(target).toLowerCase() === '.docx') { json(res, 400, { error: '暂不支持预览 .docx，请下载后查看' }); return true }
      json(res, 200, { content: readFileSync(target, 'utf-8'), path: target })
      return true
    }

    // ④ 按目录判断是否位于某个剧本工作区内
    if (pathname === '/api/woody/files/is-script') {
      const dir = String(query.get('dir') ?? '')
      if (!dir) { json(res, 200, { isScriptWorkspace: false }); return true }
      const dirNorm = normPath(resolve(dir))
      let hit = false
      for (const w of await safeRegistryList()) {
        const wp = String(w.path ?? '')
        if (!wp) continue
        const wpNorm = normPath(wp)
        if (dirNorm !== wpNorm && !dirNorm.startsWith(wpNorm + '\\')) continue
        if (isScriptWorkspaceDir(wp)) { hit = true; break }
      }
      json(res, 200, { isScriptWorkspace: hit })
      return true
    }

    // ⑤ 新建文件夹
    if (pathname === '/api/woody/files/mkdir') {
      const body = await readBody(req)
      const dir = String(body.dir ?? '')
      const nm = String(body.name ?? '').trim()
      const guard = await guardPath(dir)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!nm || /[\\/:*?"<>|]/.test(nm)) { json(res, 400, { error: '名称不合法' }); return true }
      const target = join(dir, nm)
      if (existsSync(target)) { json(res, 409, { error: '同名文件或文件夹已存在' }); return true }
      mkdirSync(target, { recursive: true })
      json(res, 200, { created: target })
      return true
    }

    // ⑥ 新建文件(不覆盖;保存走 save)
    if (pathname === '/api/woody/files/write') {
      const body = await readBody(req)
      const dir = String(body.dir ?? '')
      const nm = String(body.name ?? '').trim()
      const content = String(body.content ?? '')
      const guard = await guardPath(dir)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!nm || /[\\/:*?"<>|]/.test(nm)) { json(res, 400, { error: '名称不合法' }); return true }
      const target = join(dir, nm)
      if (existsSync(target)) { json(res, 409, { error: '同名文件已存在' }); return true }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf-8')
      json(res, 200, { created: target })
      return true
    }

    // ⑦ 重命名
    if (pathname === '/api/woody/files/rename') {
      const body = await readBody(req)
      const target = String(body.path ?? '')
      const newName = String(body.newName ?? '').trim()
      const guard = await guardPath(target)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!newName || /[\\/:*?"<>|]/.test(newName)) { json(res, 400, { error: '名称不合法' }); return true }
      if (!existsSync(target)) { json(res, 404, { error: '目标不存在' }); return true }
      const dest = join(dirname(target), newName)
      if (existsSync(dest)) { json(res, 409, { error: '同名文件或文件夹已存在' }); return true }
      renameSync(target, dest)
      json(res, 200, { renamed: dest })
      return true
    }

    // ⑧ 删除(支持批量;删除 .md 时快照一并清理,原版语义)
    if (pathname === '/api/woody/files/delete') {
      const body = await readBody(req)
      const paths: string[] = Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : [])
      if (paths.length === 0) { json(res, 400, { error: '没有指定要删除的路径' }); return true }
      const deleted: string[] = []
      const failed: { path: string; error: string }[] = []
      for (const p of paths) {
        const guard = await guardPath(p)
        if (!guard.ok) { failed.push({ path: p, error: guard.error ?? '不在剧本工作区内' }); continue }
        try {
          if (existsSync(p) && statSync(p).isFile() && extname(p).toLowerCase() === '.md') {
            const versionsDir = join(dirname(p), '.versions')
            const baseName = basename(p).replace(/\.md$/i, '')
            for (const vf of listSnapshots(versionsDir, baseName)) {
              try { unlinkSync(join(versionsDir, vf)) } catch {}
            }
          }
          rmSync(p, { recursive: true, force: true }); deleted.push(p)
        }
        catch (e: any) { failed.push({ path: p, error: String(e?.message ?? e) }) }
      }
      json(res, 200, { deleted, failed })
      return true
    }

    // ⑨ 上传(JSON + base64 内容;界面侧读取文件后编码发送)
    if (pathname === '/api/woody/files/upload') {
      const body = await readBody(req)
      const dir = String(body.dir ?? '')
      const nm = String(body.name ?? '').trim()
      const b64 = String(body.contentBase64 ?? '')
      const guard = await guardPath(dir)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!nm || /[\\/:*?"<>|]/.test(nm)) { json(res, 400, { error: '文件名不合法' }); return true }
      const target = join(dir, nm)
      if (existsSync(target)) { json(res, 409, { error: '同名文件已存在' }); return true }
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, Buffer.from(b64, 'base64'))
      json(res, 200, { uploaded: target })
      return true
    }

    // ⑩ 正式保存(覆盖写 + 版本快照)—— 编辑组件的保存通道。
    //   与 ⑥write(新建不覆盖)语义区分;快照与最新一份内容相同则不重复存。
    if (pathname === '/api/woody/files/save') {
      const body = await readBody(req)
      const target = String(body.path ?? '')
      const content = String(body.content ?? '')
      const guard = await guardPath(target)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!existsSync(target)) { json(res, 404, { error: '文件不存在（新建请用文件面板的＋按钮）' }); return true }
      if (extname(target).toLowerCase() !== '.md') { json(res, 400, { error: '仅支持保存 .md 文件' }); return true }
      writeFileSync(target, content, 'utf-8')
      const dir = dirname(target)
      const versionsDir = join(dir, '.versions')
      const baseName = basename(target).replace(/\.md$/i, '')
      if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true })
      const existing = listSnapshots(versionsDir, baseName)
      let versionSaved = false
      const latestContent = existing.length > 0 ? readFileSync(join(versionsDir, existing[existing.length - 1]), 'utf-8') : null
      if (latestContent === null || latestContent !== content) {
        writeFileSync(uniqueSnapshotPath(versionsDir, baseName, snapTS()), content, 'utf-8')
        versionSaved = true
      }
      const updated = listSnapshots(versionsDir, baseName)
      while (updated.length > VERSION_KEEP) { unlinkSync(join(versionsDir, updated.shift() as string)) }
      json(res, 200, { ok: true, versionSaved, versionCount: updated.length })
      return true
    }

    // ⑪ 版本列表(新→旧,最多 20 份)
    if (pathname === '/api/woody/files/versions') {
      const target = String(query.get('path') ?? '')
      const guard = await guardPath(target)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      const versionsDir = join(dirname(target), '.versions')
      const baseName = basename(target).replace(/\.md$/i, '')
      const snaps = listSnapshots(versionsDir, baseName).slice(-VERSION_KEEP).reverse()
      const list = snaps.map((vf) => {
        const m = vf.match(SNAP_RE)
        const ts = m ? m[1] : ''
        const formatted = ts.length === 15
          ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`
          : ts
        return { ts, formatted, file: vf }
      })
      json(res, 200, list)
      return true
    }

    // ⑫ 恢复版本:先把当前内容备份成快照(防恢复错),再写入所选版本
    if (pathname === '/api/woody/files/restore-version') {
      const body = await readBody(req)
      const target = String(body.path ?? '')
      const ts = String(body.ts ?? '')
      const guard = await guardPath(target)
      if (!guard.ok) { json(res, 403, { error: guard.error }); return true }
      if (!existsSync(target)) { json(res, 404, { error: '文件不存在' }); return true }
      const versionsDir = join(dirname(target), '.versions')
      if (!existsSync(versionsDir)) { json(res, 404, { error: '没有版本历史' }); return true }
      const baseName = basename(target).replace(/\.md$/i, '')
      let snapshotPath = join(versionsDir, `${baseName}.${ts}.md`)
      if (!existsSync(snapshotPath)) {
        // 同秒多份快照 ts 相同:回退取序号最小的那份(原版语义)
        const numbered = readdirSync(versionsDir)
          .filter((f) => f.startsWith(`${baseName}.${ts}-`) && f.endsWith('.md'))
          .sort()
        if (numbered.length === 0) { json(res, 404, { error: '指定版本不存在' }); return true }
        snapshotPath = join(versionsDir, numbered[0])
      }
      const currentContent = readFileSync(target, 'utf-8')
      const snaps = listSnapshots(versionsDir, baseName)
      const latestContent = snaps.length > 0 ? readFileSync(join(versionsDir, snaps[snaps.length - 1]), 'utf-8') : null
      if (latestContent === null || latestContent !== currentContent) {
        writeFileSync(uniqueSnapshotPath(versionsDir, baseName, snapTS()), currentContent, 'utf-8')
      }
      const snapshotContent = readFileSync(snapshotPath, 'utf-8')
      writeFileSync(target, snapshotContent, 'utf-8')
      const updated = listSnapshots(versionsDir, baseName)
      while (updated.length > VERSION_KEEP) { unlinkSync(join(versionsDir, updated.shift() as string)) }
      json(res, 200, { ok: true, content: snapshotContent, versionCount: updated.length })
      return true
    }

    // ⑬ 地址解析:官方文件预览的 resourceAddress → 绝对路径 + 是否剧本工作区。
    //   官方对会话文件用 dsh-resource://file/session/<会话id>/<相对路径> 的虚拟地址。
    if (pathname === '/api/woody/files/resolve') {
      const addr = String(query.get('addr') ?? '')
      const parsed = parseFileAddress(addr)
      if (!parsed) { json(res, 200, { isScriptWorkspace: false, reason: '无法识别的文件地址' }); return true }
      if (parsed.scope === 'session') {
        const ws = await findWorkspaceBySession(String(parsed.sessionId ?? ''))
        if (!ws || !ws.path) {
          bootLog(`resolve：会话 ${parsed.sessionId} 不属于任何工作区（${parsed.path}）`)
          json(res, 200, { isScriptWorkspace: false, reason: '该会话不属于任何工作区' })
          return true
        }
        // 真实路径 = 工作区目录 + 相对路径;再过 guardPath(前缀钳制 + 五骨架校验)
        const abs = resolve(join(ws.path, parsed.path))
        const guard = await guardPath(abs)
        if (!guard.ok) {
          bootLog(`resolve：${abs} 不在剧本工作区内（工作区「${ws.title ?? ''}」缺骨架或路径越界）`)
          json(res, 200, { isScriptWorkspace: false, reason: '该工作区不是剧本工作区' })
          return true
        }
        json(res, 200, { isScriptWorkspace: true, absolutePath: abs, workPath: guard.workPath })
        return true
      }
      // absolute 形式:直接按路径判定
      const guard = await guardPath(parsed.path)
      if (!guard.ok) { json(res, 200, { isScriptWorkspace: false, reason: '该路径不在剧本工作区内' }); return true }
      json(res, 200, { isScriptWorkspace: true, absolutePath: resolve(parsed.path), workPath: guard.workPath })
      return true
    }

    json(res, 404, { error: 'not found: ' + pathname })
    return true
  }

  return { handle }
}
