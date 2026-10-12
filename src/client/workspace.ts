// ============================================================
// 组件①:作品管理 · 浏览器端(原 dsh-woody-workspace,行为不变)
// 槽位注册:sidebar.panellist(侧栏导航项)+ main(主区域面板)
// 2026-10-03 三合一迁移:删除确认从原生 window.confirm 改为两段式
// 页面内确认(Electron 原生对话框会引发全局焦点错乱——官方 Lexical
// 输入框"点击打不了字",插件②实测教训)。
// ============================================================
import { createElement, useCallback, useEffect, useState } from 'react'
import { WOODY_LOGO_PNG } from '../woody-logo'
import { api, apiPost } from './shared'

const PANEL_ID = 'woody-works'
// 界面显示名:品牌由 logo 表达,文字只写功能名
const PANEL_TITLE = '作品管理'

// ── 样式(继承官方文字色;仅使用带 fallback 的官方变量)──
const S: Record<string, React.CSSProperties> = {
  page: { padding: '24px 32px', maxWidth: 720, margin: '0 auto', fontFamily: 'inherit', color: 'inherit',
    height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, margin: 0 },
  btnPrimary: {
    background: 'var(--dsw-static-deepseek-450, #4b7bec)', color: '#fff', border: 'none', borderRadius: 12,
    padding: '9px 18px', fontSize: 14, cursor: 'pointer',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 8,
    maxHeight: '52vh', overflowY: 'auto', paddingRight: 4 },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
  },
  rowName: { fontSize: 15, display: 'flex', alignItems: 'center', gap: 10 },
  rowBtns: { display: 'flex', gap: 6 },
  btnSmall: {
    background: 'transparent', color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
    borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  },
  btnDanger: {
    background: 'transparent', color: '#e5697a', border: '1px solid rgba(229,105,122,0.5)',
    borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  },
  btnDangerSolid: {
    background: '#e34d59', color: '#fff', border: 'none',
    borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
  },
  input: {
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))', color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    borderRadius: 8, padding: '6px 10px', fontSize: 14, outline: 'none', width: 220,
  },
  err: { color: '#e5697a', fontSize: 13, marginTop: 10 },
  hint: { opacity: 0.6, fontSize: 13, marginTop: 16 },
  section: {
    marginBottom: 22, padding: '12px 16px', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))',
  },
  sectionLabel: { fontSize: 12, opacity: 0.65, marginBottom: 8 },
  pathBox: {
    fontSize: 13, padding: '5px 10px', borderRadius: 8,
    background: 'var(--dsw-alias-bg-base, rgba(0,0,0,0.18))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
    maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
}

interface WorkItem {
  name: string
  dirName?: string
  path: string
  workspaceId: string | null
  sessions: number
  orphan?: boolean
}

// ── 目录选择器(官方原生对话框,2026-10-03 用户要求图形化选择) ──
// 机制照官方 dsh-client-ui-directory-picker-native:桌面模式用宿主注入的
// 全局 __DSH_DIRECTORY_PICKER__.pick()(返回 Promise<路径|null>,取消=null);
// 浏览器模式走官方 uiWorkspace.pickDirectory()(运行时安全取,不进 inject 防阻塞)。
// 都不可用时返回 null,界面回落到手动输入。
let pickDirectory: (() => Promise<string | null>) | null = null

function setupDirectoryPicker(ctx: any): void {
  try {
    const desktop = (globalThis as any).__DSH_DIRECTORY_PICKER__
    if (desktop && typeof desktop.pick === 'function') {
      pickDirectory = () => Promise.resolve(desktop.pick())
      return
    }
  } catch {}
  try {
    const uw: any = ctx?.get?.('uiWorkspace')
    if (uw && typeof uw.pickDirectory === 'function') pickDirectory = () => Promise.resolve(uw.pickDirectory())
  } catch {}
}

// 品牌 logo:内联 PNG(位图)。
// 为什么不用 SVG:DSH 页面的全局样式会覆盖 SVG 的填充色(fill 属性优先级最低
// → logo 变纯黑,已实测复现);SVG 走 data URI 在该环境下同样未能幸免。
// 位图不含任何 fill 引用,颜色在任何环境下都稳定。
function WoodyLogo({ width, height }: { width: number; height: number }): React.ReactElement {
  return createElement('img', {
    src: WOODY_LOGO_PNG, width, height, alt: 'woody',
    style: { display: 'block', width, height },
  })
}

function WorksIcon(): React.ReactElement {
  // 侧栏项:与面板标题同一枚 woody 文字 logo(按侧栏行高取满,保持 620:292 比例)
  return createElement(WoodyLogo, { width: 70, height: 33 })
}

function WorksPanel(): React.ReactElement {
  const [items, setItems] = useState<WorkItem[] | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // 两段式删除确认:记录待确认的作品名(原生 confirm 有 Electron 焦点前科,弃用)
  const [confirming, setConfirming] = useState<string | null>(null)
  // 数据存放位置
  const [dataRoot, setDataRoot] = useState('')
  const [editingRoot, setEditingRoot] = useState(false)
  const [rootDraft, setRootDraft] = useState('')
  // AI 助手身份(用户名):填进新建作品自带的 AGENTS.md 系统提示词
  const [userName, setUserName] = useState('')
  const [userDraft, setUserDraft] = useState('')

  // 待确认态几秒后自动撤销,防止误触常驻
  useEffect(() => {
    if (!confirming) return
    const t = window.setTimeout(() => setConfirming(null), 4000)
    return () => window.clearTimeout(t)
  }, [confirming])

  const load = useCallback(async () => {
    try {
      const d = await api('/api/woody/workspace/list')
      setItems(d.items || [])
      setErr('')
    } catch (e: any) {
      setItems([])
      setErr('加载失败：' + (e.message || e))
      return
    }
    try {
      const c = await api('/api/woody/config')
      setDataRoot(c.dataRoot || '')
      setUserName(c.userName || '')
      setUserDraft(c.userName || '')
    } catch { /* 配置读取失败不影响作品列表 */ }
  }, [])
  useEffect(() => { void load() }, [load])

  /** 保存 AI 助手身份(用户名);随数据位置一起提交(端点要求 dataRoot) */
  async function saveUser(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const d = await apiPost('/api/woody/config', { dataRoot, userName: userDraft.trim() })
      setUserName(String(d.userName ?? userDraft.trim()))
      setUserDraft(String(d.userName ?? userDraft.trim()))
      setErr('')
    } catch (e: any) { setErr('保存用户名失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  async function saveRoot(): Promise<void> {
    if (!rootDraft.trim() || busy) return
    setBusy(true)
    try {
      const d = await apiPost('/api/woody/config', { dataRoot: rootDraft.trim() })
      setDataRoot(d.dataRoot || rootDraft.trim())
      setEditingRoot(false)
      setErr('')
      await load()
    } catch (e: any) { setErr('修改数据存放位置失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  /** 图形化选择数据存放位置(官方原生文件夹选择对话框);取消/不可用则不打扰 */
  async function chooseRoot(): Promise<void> {
    if (busy) return
    if (!pickDirectory) {
      // 选择器不可用:回落手动输入
      setRootDraft(dataRoot); setEditingRoot(true); setErr('')
      return
    }
    setBusy(true)
    let picked: string | null = null
    try { picked = await pickDirectory() }
    catch { picked = null }
    if (picked === null || picked === undefined || !String(picked).trim()) { setBusy(false); return }
    try {
      const d = await apiPost('/api/woody/config', { dataRoot: String(picked).trim() })
      setDataRoot(d.dataRoot || String(picked).trim())
      setEditingRoot(false)
      setErr('')
      await load()
    } catch (e: any) { setErr('修改数据存放位置失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  async function create(): Promise<void> {
    if (!newName.trim() || busy) return
    setBusy(true)
    try {
      await apiPost('/api/woody/workspace/create', { name: newName.trim() })
      setNewName(''); setCreating(false); setErr('')
      await load()
    } catch (e: any) { setErr('创建失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  async function remove(name: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await apiPost('/api/woody/workspace/delete', { name })
      setMenuFor(null); setConfirming(null); setErr('')
      await load()
    } catch (e: any) { setErr('删除失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  async function rename(item: WorkItem): Promise<void> {
    if (!renameValue.trim() || busy) return
    setBusy(true)
    try {
      // 用 path 定位(显示名可能已改过,不唯一;path 唯一可靠)
      await apiPost('/api/woody/workspace/rename', { path: item.path, newName: renameValue.trim() })
      setRenaming(null); setMenuFor(null); setErr('')
      await load()
    } catch (e: any) { setErr('重命名失败：' + (e.message || e)) } finally { setBusy(false) }
  }

  const rows = (items || []).map((it) =>
    createElement('div', { key: it.path, style: it.orphan ? { ...S.row, opacity: 0.7 } : S.row },
      renaming === it.path
        ? createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            createElement('input', { style: S.input, value: renameValue, autoFocus: true,
              onChange: (ev) => setRenameValue(ev.target.value),
              onKeyDown: (ev) => { if (ev.key === 'Enter') void rename(it); if (ev.key === 'Escape') setRenaming(null) } }),
            createElement('button', { style: S.btnSmall, onClick: () => void rename(it), disabled: busy }, '确定'),
            createElement('button', { style: S.btnSmall, onClick: () => setRenaming(null) }, '取消'))
        : it.orphan
          ? createElement('div', { style: S.rowName, title: it.path },
              createElement('span', null, '⚠️'),
              createElement('span', null, it.name),
              createElement('span', { style: { opacity: 0.55, fontSize: 12 } }, '（目录已不在，仅在 DSH 中残留注册）'))
          : createElement('div', {
              // 纯展示:打开对话走官方流程(左侧栏工作区 → 会话 / 新会话选工作区),
              // 这里不做跳转(官方没有按路径打开工作区的 URL 入口)
              style: { ...S.rowName, cursor: 'default' },
              title: it.path,
            },
              createElement('span', null, '📁'),
              createElement('span', null, it.name),
              // 重命名只改显示名、目录名不变:两者不同时标注目录名,便于对文件
              it.dirName && it.dirName !== it.name
                ? createElement('span', { style: { opacity: 0.45, fontSize: 12 } }, `（目录：${it.dirName}）`)
                : null,
              it.sessions > 0 ? createElement('span', { style: { opacity: 0.5, fontSize: 12 } }, `(${it.sessions} 会话)`) : null),
      createElement('div', { style: S.rowBtns },
        it.orphan
          ? [ confirming === it.name
              ? createElement('button', { key: 'c', style: S.btnDangerSolid,
                  title: '再点一次确认清理', onClick: () => void remove(it.name) }, '再点一次确认')
              : createElement('button', { key: 'cl', style: S.btnDanger,
                  title: '移除 DSH 里的残留注册（目录已不存在，不影响任何文件）',
                  onClick: () => setConfirming(it.name) }, '清理'),
              confirming === it.name
                ? createElement('button', { key: 'x', style: S.btnSmall, onClick: () => setConfirming(null) }, '×')
                : null ]
          : menuFor === it.path
            ? [ createElement('button', { key: 'rn', style: S.btnSmall,
                  onClick: () => { setRenameValue(it.name); setRenaming(it.path) } }, '重命名'),
                confirming === it.name
                  ? createElement('button', { key: 'del', style: S.btnDangerSolid,
                      title: '再点一次确认删除（将删除其全部文件并归档其会话）',
                      onClick: () => void remove(it.name) }, '再点一次确认')
                  : createElement('button', { key: 'del', style: S.btnDanger,
                      title: '删除作品（其全部文件与工作区注册）',
                      onClick: () => setConfirming(it.name) }, '删除'),
                createElement('button', { key: 'x', style: S.btnSmall, onClick: () => { setMenuFor(null); setConfirming(null) } }, '×') ]
            : createElement('button', { style: S.btnSmall, onClick: () => setMenuFor(it.path) }, '⋯'))))

  return createElement('div', { style: S.page },
    createElement('div', { style: S.header },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
        createElement(WoodyLogo, { width: 104, height: 49 }),
        createElement('h1', { style: S.title }, PANEL_TITLE)),
      createElement('button', { style: S.btnPrimary,
        onClick: () => { setCreating(!creating); setErr('') } }, creating ? '收起' : '＋ 新建作品')),
    creating && createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center' } },
      createElement('input', { style: { ...S.input, width: 280 }, placeholder: '输入作品名，如：测试4号',
        value: newName, autoFocus: true,
        onChange: (ev) => setNewName(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter') void create() } }),
      createElement('button', { style: S.btnPrimary, onClick: () => void create(), disabled: busy || !newName.trim() }, '创建')),
    err && createElement('div', { style: S.err }, err),
    // ── 数据存放位置(管理所有作品所在目录)──
    createElement('div', { style: S.section },
      createElement('div', { style: S.sectionLabel }, '数据存放位置'),
      editingRoot
        ? createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            createElement('input', { style: { ...S.input, width: 380 }, value: rootDraft, autoFocus: true,
              placeholder: '例如 D:\\WooDy-DSH\\作品',
              onChange: (ev) => setRootDraft(ev.target.value),
              onKeyDown: (ev) => { if (ev.key === 'Enter') void saveRoot(); if (ev.key === 'Escape') setEditingRoot(false) } }),
            createElement('button', { style: S.btnPrimary, onClick: () => void saveRoot(), disabled: busy }, '保存'),
            createElement('button', { style: S.btnSmall, onClick: () => setEditingRoot(false) }, '取消'))
        : createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            createElement('code', { style: S.pathBox, title: dataRoot }, dataRoot || '（读取中…）'),
            createElement('button', { style: S.btnPrimary, disabled: busy, title: '打开文件夹选择对话框',
              onClick: () => void chooseRoot() }, '修改'),
            createElement('button', { style: S.btnSmall, title: '手动输入路径',
              onClick: () => { setRootDraft(dataRoot); setEditingRoot(true); setErr('') } }, '手动输入'))),
    createElement('div', { style: S.section },
      createElement('div', { style: S.sectionLabel }, 'AI 助手身份（用户名）'),
      createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        createElement('input', { style: { ...S.input, width: 220 }, value: userDraft,
          placeholder: '例如：你的笔名（留空则提示词里不写身份）',
          onChange: (ev) => setUserDraft(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === 'Enter') void saveUser() } }),
        createElement('button', { style: S.btnPrimary, disabled: busy || userDraft.trim() === userName, onClick: () => void saveUser() }, '保存')),
      createElement('div', { style: S.hint }, '新作品自带的 AGENTS.md 系统提示词会填入这个名字；只对之后新建的作品生效。')),
    items === null
      ? createElement('div', { style: S.hint }, '加载中…')
      : items.length === 0
        ? createElement('div', { style: S.hint }, '该位置下还没有作品。点「＋ 新建作品」创建第一个剧本工作区。')
        : createElement('div', { style: S.list }, rows),
    createElement('div', { style: S.hint },
      '新建的作品会生成 大纲 / 记忆 / 剧本 / 细纲 / 作品资料 目录骨架，并注册为 DSH 工作区。'))
}

/** 注册作品管理的侧栏项与主面板 */
export function applyWorkspace(ctx: any): void {
  // 防御:客户端初始化异常不得影响整个界面加载
  try {
    setupDirectoryPicker(ctx)
    // 主区域面板:点侧栏项时显示
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID,
    }, WorksPanel))
    // 侧栏导航项:与「插件」「自动化任务」同级
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 20,
      label: () => PANEL_TITLE,
    }, WorksIcon))
    ctx.logger?.info?.('[woody-studio] 作品管理组件就绪：侧栏项 + 主面板已注册')
  } catch (e: any) {
    ctx.logger?.error?.('[woody-studio] 作品管理组件初始化失败：' + String(e?.message ?? e))
  }
}
