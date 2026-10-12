// ============================================================
// 组件②:文件管理 · 浏览器端(原 dsh-woody-files v2,行为不变)
// 只在原生「工作区文件」面板工具栏扩展点注册三个按钮:
//   ＋新建 / ↑上传 / 🗑删除,全部作用于当前目录(props.absolutePath)。
// 仅当该目录位于剧本工作区内时才显示(is-script 判定)。
// ============================================================
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { api, apiPost } from './shared'

const CSS = `
.wfa-wrap { display: inline-flex; align-items: center; gap: 2px; }
.wfa-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  padding: 0; border: none; border-radius: 6px; background: transparent; color: inherit;
  opacity: .72; font-size: 13px; line-height: 1; cursor: pointer; transition: all .15s; }
.wfa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); opacity: 1; }
.wfa-btn:disabled { opacity: .32; cursor: not-allowed; }
.wfa-mask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.3); }
.wfa-box { width: 330px; max-width: 92vw; max-height: 76vh; overflow: auto; padding: 18px;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-overlay, #2a2a2e);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24)); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.42); font-size: 13px; }
.wfa-box h3 { margin: 0 0 4px; font-size: 14px; font-weight: 700; }
.wfa-dir { font-size: 11px; opacity: .55; word-break: break-all; margin-bottom: 12px; line-height: 1.5; }
.wfa-box label { display: block; font-size: 12px; opacity: .75; margin: 12px 0 4px; font-weight: 600; }
.wfa-box input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 10px;
  font-size: 13px; color: inherit; background: var(--dsw-alias-bg-base, rgba(0,0,0,.16));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 8px; }
.wfa-box input[type=text]:focus { outline: none; border-color: var(--dsw-static-deepseek-450, #4d6bfe);
  box-shadow: 0 0 0 3px rgba(77,107,254,.16); }
.wfa-tabs { display: flex; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  border-radius: 8px; overflow: hidden; margin-bottom: 4px; }
.wfa-tabs button { flex: 1; padding: 8px 0; font-size: 13px; border: none; cursor: pointer;
  background: transparent; color: inherit; opacity: .6; }
.wfa-tabs button.on { background: var(--dsw-static-deepseek-450, #4d6bfe); color: #fff; opacity: 1; font-weight: 600; }
.wfa-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.wfa-actions button { padding: 7px 16px; font-size: 13px; border-radius: 8px; cursor: pointer;
  color: inherit; background: rgba(128,128,128,.14);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24)); }
.wfa-actions button:hover { background: rgba(128,128,128,.22); }
.wfa-actions .primary { background: var(--dsw-static-deepseek-450, #4d6bfe); color: #fff; border-color: transparent; font-weight: 600; }
.wfa-actions .danger { background: #e34d59; color: #fff; border-color: transparent; font-weight: 600; }
.wfa-list { max-height: 210px; overflow: auto; margin-top: 8px; padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24)); border-radius: 8px; }
.wfa-item { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px;
  cursor: pointer; font-size: 12px; }
.wfa-item:hover { background: rgba(128,128,128,.12); }
.wfa-item.locked { opacity: .45; cursor: default; }
.wfa-item span.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wfa-err { color: #e5697a; font-size: 12px; margin-top: 10px; line-height: 1.6; }
.wfa-ok { color: #4d6bfe; font-size: 12px; }
@keyframes wfaPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(227,77,89,.45); } 50% { box-shadow: 0 0 0 5px rgba(227,77,89,0); } }
`

interface Entry { name: string; path: string; isDir: boolean }

/** 顶层受保护目录:不参与删除(保护剧作骨架) */
const SYSTEM_DIRS = ['大纲', '记忆', '剧本', '细纲', '作品资料']

/**
 * 原生「工作区文件」面板工具栏上的三个按钮。
 * props.absolutePath = 该面板当前显示的目录(由槽位注入)。
 */
function WoodyFileActions(props: any): React.ReactElement | null {
  const dir: string = String(props?.absolutePath ?? '')
  const [isScript, setIsScript] = useState(false)
  const [modal, setModal] = useState<'' | 'new' | 'delete'>('')
  const [kind, setKind] = useState<'file' | 'folder'>('file')
  const [name, setName] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [marked, setMarked] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fileInput = useRef<any>(null)

  // 条件显示:只有当前目录位于剧本工作区内才渲染按钮
  useEffect(() => {
    let alive = true
    if (!dir) { setIsScript(false); return }
    void (async () => {
      try {
        const d = await api('/api/woody/files/is-script?dir=' + encodeURIComponent(dir))
        if (alive) setIsScript(!!d.isScriptWorkspace)
      } catch { if (alive) setIsScript(false) }
    })()
    return () => { alive = false }
  }, [dir])

  const flash = useCallback((m: string) => { setOk(m); window.setTimeout(() => setOk(''), 2500) }, [])
  const fail = useCallback((e: any) => setErr(String(e?.message ?? e)), [])

  const loadEntries = useCallback(async (): Promise<void> => {
    const d = await api('/api/woody/files/list?dir=' + encodeURIComponent(dir))
    setEntries(d.items || [])
    setMarked([])
  }, [dir])

  const doCreate = async (): Promise<void> => {
    const nm = name.trim()
    if (!nm) return
    setBusy(true)
    try {
      if (kind === 'folder') await apiPost('/api/woody/files/mkdir', { dir, name: nm })
      else await apiPost('/api/woody/files/write', { dir, name: nm.includes('.') ? nm : nm + '.md', content: '' })
      setModal(''); setName(''); setErr(''); flash('✓ 已创建')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const doUpload = (files: any[]): void => {
    if (!files.length) return
    setBusy(true)
    void (async () => {
      try {
        for (const f of files) {
          const b64: string = await new Promise((res, rej) => {
            const r = new FileReader()
            r.onload = () => res(String(r.result).split(',')[1] || '')
            r.onerror = () => rej(new Error('读取文件失败'))
            r.readAsDataURL(f)
          })
          await apiPost('/api/woody/files/upload', { dir, name: f.name, contentBase64: b64 })
        }
        setErr(''); flash(`✓ 已上传 ${files.length} 个文件`)
      } catch (e) { fail(e) } finally { setBusy(false) }
    })()  // ← 必须立即调用!少写 () 时打包器把整个函数体按死代码删除,
          //   上传静默失效且 busy 永久卡 true(2026-10-07 审查实锤事故)
  }

  // 删除分两步:第一次点击只进入待确认,再点一次才执行。
  // 不用 window.confirm——Electron 下原生确认框关闭后会造成全局焦点错乱,
  // 官方 Lexical 输入框随后可能"点击打不了字"(切会话/切窗口才恢复)。
  const doDelete = (): void => {
    if (!marked.length) return
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    void doDeleteConfirmed()
  }

  const doDeleteConfirmed = async (): Promise<void> => {
    if (!marked.length) return
    setBusy(true)
    try {
      const d = await apiPost('/api/woody/files/delete', { paths: marked })
      if (d.failed && d.failed.length) setErr('部分失败：' + d.failed.map((f: any) => f.error).join('；'))
      else setErr('')
      flash(`✓ 已删除 ${(d.deleted || []).length} 项`)
      await loadEntries()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  if (!isScript) return null

  const toggleMark = (path: string): void =>
    setMarked((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev.concat(path)))

  return createElement('span', { className: 'wfa-wrap' },
    createElement('style', null, CSS),

    // 三个按钮:外观贴近原生工具栏按钮
    createElement('button', {
      className: 'wfa-btn', title: '新建文件 / 文件夹', disabled: busy,
      onClick: () => { setErr(''); setOk(''); setKind('file'); setName(''); setModal('new') },
    }, '＋'),
    createElement('button', {
      className: 'wfa-btn', title: '上传文件到当前目录', disabled: busy,
      onClick: () => { setErr(''); setOk(''); if (fileInput.current) fileInput.current.click() },
    }, '↑'),
    createElement('button', {
      className: 'wfa-btn', title: '删除文件 / 文件夹', disabled: busy,
      onClick: () => {
        setErr(''); setOk(''); setConfirming(false); setModal('delete')
        void loadEntries().catch(fail)
      },
    }, '🗑'),

    ok ? createElement('span', { className: 'wfa-ok', style: { marginLeft: 6 } }, ok) : null,

    // 隐藏的多选文件输入(上传用)
    createElement('input', {
      ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
      onChange: (ev: any) => { doUpload(Array.from(ev.target.files || [])); ev.target.value = '' },
    }),

    // 新建弹窗
    modal === 'new' ? createElement('div', {
      className: 'wfa-mask',
      onClick: (ev: any) => { if (ev.target === ev.currentTarget) setModal('') },
      onKeyDown: (ev: any) => { if (ev.key === 'Escape') setModal('') },
    },
      createElement('div', { className: 'wfa-box' },
        createElement('h3', null, '新建'),
        createElement('div', { className: 'wfa-dir' }, dir),
        createElement('div', { className: 'wfa-tabs' },
          createElement('button', { className: kind === 'file' ? 'on' : '', onClick: () => setKind('file') }, '文件'),
          createElement('button', { className: kind === 'folder' ? 'on' : '', onClick: () => setKind('folder') }, '文件夹')),
        createElement('label', null, kind === 'file' ? '文件名（默认 .md）' : '文件夹名'),
        createElement('input', {
          type: 'text', value: name, autoFocus: true,
          placeholder: kind === 'file' ? '第01集' : '新文件夹',
          onChange: (ev: any) => setName(ev.target.value),
          onKeyDown: (ev: any) => { if (ev.key === 'Enter') void doCreate() },
        }),
        err ? createElement('div', { className: 'wfa-err' }, err) : null,
        createElement('div', { className: 'wfa-actions' },
          createElement('button', { onClick: () => setModal('') }, '取消'),
          createElement('button', { className: 'primary', disabled: busy || !name.trim(), onClick: () => void doCreate() }, '创建'))))
      : null,

    // 删除弹窗:列出当前目录内容供勾选
    modal === 'delete' ? createElement('div', {
      className: 'wfa-mask',
      onClick: (ev: any) => { if (ev.target === ev.currentTarget) setModal('') },
      onKeyDown: (ev: any) => { if (ev.key === 'Escape') setModal('') },
    },
      createElement('div', { className: 'wfa-box' },
        createElement('h3', null, '删除'),
        createElement('div', { className: 'wfa-dir' }, dir),
        entries.length === 0
          ? createElement('div', { className: 'wfa-dir' }, '（这个目录是空的）')
          : createElement('div', { className: 'wfa-list' },
              entries.map((e) => {
                const locked = e.isDir && SYSTEM_DIRS.includes(e.name)
                const on = marked.includes(e.path)
                return createElement('div', {
                  key: e.path, className: 'wfa-item' + (locked ? ' locked' : ''),
                  title: locked ? '剧本骨架目录，受保护' : e.path,
                  onClick: () => { if (!locked) toggleMark(e.path) },
                },
                  createElement('input', { type: 'checkbox', checked: on, disabled: locked, readOnly: true }),
                  createElement('span', null, e.isDir ? '📁' : '📄'),
                  createElement('span', { className: 'nm' }, e.name))
              })),
        err ? createElement('div', { className: 'wfa-err' }, err) : null,
        createElement('div', { className: 'wfa-actions' },
          createElement('button', { onClick: () => setModal('') }, '取消'),
          createElement('button', {
            className: 'danger', disabled: busy || marked.length === 0, onClick: doDelete,
            style: confirming ? { animation: 'wfaPulse 1s infinite' } : undefined,
          }, confirming ? '再点一次确认删除' : `删除${marked.length ? ' (' + marked.length + ')' : ''}`))))
      : null,
  )
}

/** 注册文件面板工具栏按钮 */
export function applyFiles(ctx: any): void {
  try {
    // 挂进原生「工作区文件」面板的工具栏(官方扩展点)
    ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
      name: 'sidebar.right.tab.files.actions',
      id: 'dsh-woody-studio',
      // 槽位把当前显示的目录通过 absolutePath 传下来
      inject: (props: any) => ({ absolutePath: props?.absolutePath }),
    }, WoodyFileActions))
    ctx.logger?.info?.('[woody-studio] 文件管理组件就绪：原生「工作区文件」工具栏 新建/上传/删除 已挂载')
  } catch (e: any) {
    ctx.logger?.error?.('[woody-studio] 文件管理组件初始化失败：' + String(e?.message ?? e))
  }
}
