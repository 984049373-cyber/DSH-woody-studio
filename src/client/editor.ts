// ============================================================
// 组件③:剧本编辑器 · 浏览器端(原 dsh-woody-editor,行为不变)
// 在官方「文件预览」面板的模式菜单注册「编辑」模式 —— 官方正规机制。
// priority:'plugin'(非 builtin)排在官方内置模式之前 → .md 文件
// 点开自动进入编辑模式(官方排序规则源码实证:rank builtin=0 其余=1,
// rank 降序)。仅剧本工作区可编辑,否则空态。
// 数据走同插件的 files 模块;Vditor 静态资源走同服务 /vditor/*。
// ============================================================
import { createElement, useEffect, useRef, useState } from 'react'
import { BIRD_DENSE, BIRD_PLAIN } from '../woody-bird'
import { api, apiPost, apiBase } from './shared'

const VIEWER_ID = 'woody-editor'

/** 每个作品最近一次的阅读位置:编辑器若被外部触发重建(如文件监听重载),
 *  重挂载后按此原地恢复(2026-10-11 保存刷新排查) */
const lastScrollByPath = new Map<string, number>()

// 极简内联图标(描边跟随按钮文字色;不用外链图标字体)
const svgIcon = (paths: string): React.ReactElement =>
  createElement('span', {
    style: { display: 'inline-flex', width: 14, height: 14, flexShrink: 0 },
    dangerouslySetInnerHTML: { __html: `<svg viewBox="0 0 16 16" width="14" height="14">${paths}</svg>` },
  })
const ICON_SAVE = svgIcon('<path d="M3 2h8l3 3v9H3z M6 2v5h6V2 M6 14v-4h4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>')
const ICON_HISTORY = svgIcon('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>')
const ICON_REFRESH = svgIcon('<path d="M13.5 8A5.5 5.5 0 1 1 11 3.4M13.5 1.8v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')
const ICON_LIST = svgIcon('<path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="2.5" cy="4" r="1.1" fill="currentColor"/><circle cx="2.5" cy="8" r="1.1" fill="currentColor"/><circle cx="2.5" cy="12" r="1.1" fill="currentColor"/>')

/**
 * 官方文件地址解析(照官方 parseFileAddress 移植,源码实证):
 *   dsh-resource://file/session/<会话id>/<相对路径> → 会话文件(经 files/resolve 换算绝对路径)
 *   dsh-resource://file/absolute/<绝对路径>          → 绝对路径文件
 */
export function parseResourceAddress(addr: string): { scope: string; sessionId?: string; path: string } | null {
  const P = 'dsh-resource://file/'
  try {
    if (!addr.startsWith(P)) return null
    const end = addr.search(/[?#]/)
    const body = addr.slice(P.length, end === -1 ? undefined : end)
    const [scope, ...rest] = body.split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (!id || segments.length === 0) return null
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return null
      if (unc) return { scope, path: `//${segments.join('/')}` }
      return { scope, path: /^[a-zA-Z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
    return null
  } catch { return null }
}

// ── Vditor 库动态加载(幂等,全局一次;资源在同服务 /vditor/*) ──
let libPromise: Promise<void> | null = null
async function ensureVditorLib(): Promise<any> {
  if ((globalThis as any).Vditor) return (globalThis as any).Vditor
  if (!libPromise) libPromise = (async () => {
    const base = await apiBase()
    await new Promise<void>((res, rej) => {
      const l = document.createElement('link')
      l.rel = 'stylesheet'; l.href = `${base}/vditor/dist/index.css`
      l.onload = () => res(); l.onerror = () => rej(new Error('Vditor 样式加载失败'))
      document.head.appendChild(l)
    })
    await new Promise<void>((res, rej) => {
      const s = document.createElement('script')
      s.src = `${base}/vditor/dist/index.min.js`
      s.onload = () => res(); s.onerror = () => rej(new Error('Vditor 脚本加载失败'))
      document.head.appendChild(s)
    })
  })()
  await libPromise
  return (globalThis as any).Vditor
}

/** DSW 明暗探测(2026-10-07 修正):官方主题变量挂在 body 上,深色标记是
 *  body[data-ds-dark-theme] 属性——此前从 html 读变量永远为空,导致深色
 *  模式下引用卡片白底、编辑器误用浅色主题。属性标记优先,亮度兜底也改读 body。 */
function detectDark(): boolean {
  try {
    const body = document.body
    if (body && body.hasAttribute('data-ds-dark-theme')) return true
    const el = body ?? document.documentElement
    const v = getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base').trim()
    const m = v.match(/[\d.]+/g)
    if (m && m.length >= 3) {
      const [r, g, b] = m.map(Number)
      return (r * 0.299 + g * 0.587 + b * 0.114) < 128
    }
  } catch {}
  return false
}

// ── 样式(参考实现移植;底色/边框/文字用官方
//    --dsw-* 变量跟随 DSH 主题,特有按钮/语义色按明暗内置两套) ──
const CSS = `
.wed-fill { box-sizing: border-box; width: 100%; height: 100%; display: flex; flex-direction: column; }
.wed-fill.dark { --w-btn-bg: rgba(255,255,255,.07); --w-btn-text:#F5F5F4; --w-cta-bg:#FAFAFA; --w-cta-text:#0A0A0C;
  --w-accent:#56C2FF; --w-accent-soft:rgba(86,194,255,.14); --w-text:#F5F5F4; --w-text-2:#A1A1A6; --w-text-3:#6E6E73;
  --w-border:rgba(255,255,255,.09); --w-border-strong:rgba(255,255,255,.16); --w-panel:rgba(255,255,255,.055); }
.wed-fill.light { --w-btn-bg:#FFFFFF; --w-btn-text:#1F2329; --w-cta-bg:#1F2329; --w-cta-text:#FFFFFF;
  --w-accent:#4D6BFE; --w-accent-soft:rgba(77,107,254,.10); --w-text:#1F2329; --w-text-2:#646A73; --w-text-3:#8F959E;
  --w-border:#E8E8E2; --w-border-strong:#D8D8D0; --w-panel:#FFFFFF; }

.wed-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  color: var(--dsw-alias-label-secondary, var(--w-text-3)); font-size: var(--dsh-content-font-size-secondary, 13px); padding: 24px; text-align: center; }
.wed-empty .big { font-size: 15px; color: var(--dsw-alias-label-primary, inherit); }
.wed-empty .path { opacity: .7; word-break: break-all; max-width: 90%; }

/* ── 第一排工具栏(原版 editor-toolbar)── */
.wed-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-shrink: 0; flex-wrap: wrap;
  background: var(--dsw-alias-bg-base, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, var(--w-border)); }
.wed-toolbar .bird { height: 16px; flex-shrink: 0; }
.wed-toolbar .file-path { flex: 1; font-size: 13px; font-weight: 600; min-width: 80px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-primary, var(--w-text-2)); }
.wed-toolbar .dirty-dot { width: 8px; height: 8px; border-radius: 50%; background: #FFC531; flex-shrink: 0; }
.wed-toolbar .save-feedback { font-size: 12px; color: #59D499; flex-shrink: 0; }
.wed-toolbar .save-feedback.err { color: #FF6363; }
.wed-toolbar .char-count { font-size: 11px; color: var(--w-text-3); flex-shrink: 0; }
.wed-toolbar button { background: var(--w-btn-bg); color: var(--w-btn-text); border: 1px solid var(--w-border);
  border-radius: 99px; padding: 5px 11px; font-size: 12px; cursor: pointer;
  transition: all .18s cubic-bezier(.22,1,.36,1); display: inline-flex; align-items: center; gap: 4px; }
.wed-toolbar button:hover:not(:disabled) { border-color: var(--w-border-strong); transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,.14); }
.wed-toolbar button:active:not(:disabled) { transform: translateY(0); }
.wed-toolbar button:disabled { opacity: .4; cursor: not-allowed; }
.wed-toolbar button.save-btn { background: var(--w-cta-bg); color: var(--w-cta-text); border-color: var(--w-cta-bg); font-weight: 600; }
.wed-toolbar button.danger-btn { background: #FF6363; color: #fff; border-color: transparent; font-weight: 600; }
.wed-toolbar button .badge { background: color-mix(in srgb, currentColor 18%, transparent); border-radius: 99px; padding: 0 6px; font-variant-numeric: tabular-nums; }

/* ── 横幅 ── */
.wed-banner { display: flex; align-items: center; gap: 8px; padding: 5px 12px; font-size: 12px; flex-shrink: 0;
  background: var(--w-accent-soft);
  border-bottom: 1px solid var(--dsw-alias-border-l1, var(--w-border)); }
.wed-banner.warn { background: rgba(255,197,49,.14); }
.wed-banner .grow { flex: 1; }
.wed-banner button { padding: 2px 10px; font-size: 12px; border-radius: 99px; cursor: pointer;
  border: 1px solid var(--w-border-strong); background: var(--w-btn-bg); color: var(--w-btn-text); }

/* ── 编辑区(原版 editor-vditor 全套)── */
.wed-vditor { flex: 1; min-height: 0; overflow: hidden; position: relative; }
.wed-vditor .vditor { border: none; height: 100%; background: transparent; }
.wed-vditor .vditor-toolbar { background: transparent; border-bottom: 1px solid var(--dsw-alias-border-l1, var(--w-border));
  border-radius: 0; position: relative; z-index: 10; padding-left: 0 !important; }
.wed-vditor .vditor-toolbar__item { border-radius: 6px; }
.wed-vditor .vditor-toolbar__item button { color: var(--w-text-2); border-radius: 6px; transition: all .15s; }
.wed-vditor .vditor-toolbar__item button:hover { color: var(--w-text); }
.wed-vditor .vditor-toolbar__divider { border-radius: 99px; }
.wed-vditor .vditor-wysiwyg { background: transparent; color: var(--w-text); font-family: var(--dsw-font, inherit); }
.wed-vditor .vditor-wysiwyg p, .wed-vditor .vditor-wysiwyg h1, .wed-vditor .vditor-wysiwyg h2,
.wed-vditor .vditor-wysiwyg h3, .wed-vditor .vditor-wysiwyg li, .wed-vditor .vditor-wysiwyg blockquote { color: var(--w-text); }
.wed-vditor .vditor-reset { color: var(--w-text); }

/* ── 大纲:显隐用自定义 class(不碰 Vditor 内部 toggle,原版方案)── */
.wed-vditor .vditor-outline { background: var(--w-panel); border-right: 1px solid var(--w-border); font-size: 13px; overflow-y: auto; }
.wed-vditor .vditor-outline.woody-outline-hide { display: none !important; }
.wed-vditor .vditor-outline__content { padding: 6px 6px 12px; }
.wed-vditor .vditor-outline__content ul { list-style: none; padding-left: 0; margin: 0; }
.wed-vditor .vditor-outline__content ul ul { padding-left: 13px; }
.wed-vditor .vditor-outline__content li > span[data-target-id] { border-radius: 6px; }
.wed-vditor .vditor-outline__item--current { background: var(--w-accent-soft) !important; color: var(--w-accent) !important; font-weight: 600; }
.wed-vditor .vditor:not(.vditor--fullscreen) .vditor-reset { padding-left: 22px; }
@keyframes woody-outline-in { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
.wed-vditor .vditor:not(.vditor--fullscreen) .vditor-outline {
  position: absolute !important; top: 8px; left: 36px; bottom: 8px;
  width: 210px; max-width: 60%; z-index: 8;
  border-radius: 14px !important;
  background: color-mix(in srgb, var(--w-panel) 72%, transparent);
  backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--w-border-strong) 80%, transparent);
  box-shadow: 0 8px 32px rgba(0,0,0,.16);
  animation: woody-outline-in .22s cubic-bezier(.22,1,.36,1);
}
.wed-vditor .vditor--fullscreen .vditor-outline {
  margin: 12px 4px 12px 12px; border-radius: 14px !important;
  background: color-mix(in srgb, var(--w-panel) 82%, transparent);
  backdrop-filter: blur(12px); border: 1px solid var(--w-border);
}

/* ── 大纲呼出把手:平时小竖条,hover 展开,active 高亮(原版全套)── */
.wed-outline-tab {
  position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  z-index: 12; width: 14px; height: 40px;
  border: none; border-radius: 0 99px 99px 0;
  background: color-mix(in srgb, var(--w-text-3) 30%, transparent);
  color: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .22s cubic-bezier(.22,1,.36,1);
}
.wed-outline-tab:hover {
  width: 30px; height: 56px;
  background: color-mix(in srgb, var(--w-panel) 80%, transparent);
  backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%);
  border: 1px solid var(--w-border-strong); border-left: none;
  box-shadow: 4px 0 12px rgba(0,0,0,.10);
  color: var(--w-accent);
}
.wed-outline-tab.active {
  width: 30px; height: 56px;
  background: var(--w-accent); color: #fff;
  border: none; box-shadow: 4px 0 12px color-mix(in srgb, var(--w-accent) 40%, transparent);
}
.wed-outline-tab svg { opacity: 0; transform: scale(.6); transition: all .22s; }
.wed-outline-tab:hover svg, .wed-outline-tab.active svg { opacity: 1; transform: scale(1); }

/* ── 版本弹窗(纯 DOM)── */
.wed-mask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.3); }
.wed-box { width: 320px; max-width: 92vw; max-height: 72vh; overflow: auto; padding: 18px;
  color: var(--dsw-alias-label-primary, var(--w-text)); background: var(--dsw-alias-bg-overlay, #2a2a2e);
  border: 1px solid var(--w-border-strong); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.42); font-size: 13px; }
.wed-box h3 { margin: 0 0 10px; font-size: 14px; font-weight: 700; }
.wed-vlist { display: flex; flex-direction: column; gap: 2px; }
.wed-vitem { padding: 7px 10px; border-radius: 8px; cursor: pointer; font-variant-numeric: tabular-nums; }
.wed-vitem:hover { background: var(--w-accent-soft); }
.wed-vitem.none { text-align: center; opacity: .6; cursor: default; }
.wed-acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.wed-acts button { background: var(--w-btn-bg); color: var(--w-btn-text); border: 1px solid var(--w-border);
  border-radius: 99px; padding: 5px 12px; font-size: 12px; cursor: pointer; }

/* ── 引用条(照原版 cited-bar/cited-chip 移植;--cite-c 由卡片内联注入) ── */
.wed-cites { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px 10px; flex-shrink: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, var(--w-border));
  max-height: 40%; overflow-y: auto; }
.wed-cites-head { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--w-text-2); }
.wed-cites-head .grow { flex: 1; }
.wed-cites-head button { background: var(--w-cta-bg); color: var(--w-cta-text); border: none; border-radius: 99px;
  padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
.wed-chip { display: flex; gap: 10px; align-items: stretch;
  background: var(--w-panel); border: 1px solid var(--w-border); border-radius: 12px; padding: 9px 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,.12); transition: box-shadow .2s, border-color .2s; }
.wed-chip:hover { box-shadow: 0 4px 16px rgba(0,0,0,.18); border-color: var(--w-border-strong); }
.wed-chip .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.wed-chip .head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.wed-chip .no { width: 18px; height: 18px; border-radius: 99px; flex-shrink: 0;
  background: var(--cite-c); color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; }
.wed-chip .fname { font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.wed-chip .fname.clickable { cursor: pointer; }
.wed-chip .fname.clickable:hover { text-decoration: underline; color: var(--dsw-static-deepseek-450, #4b7bec); }
.wed-chip .fileicon { color: var(--w-text-3); display: flex; flex-shrink: 0; }
.wed-chip .close { background: none; border: none; color: var(--w-text-3); padding: 3px; border-radius: 8px;
  display: flex; transition: all .15s; flex-shrink: 0; cursor: pointer; }
.wed-chip .close:hover { color: #FF6363; background: rgba(255,99,99,.14); }
.wed-chip .snippet { font-size: 12.5px; color: var(--w-text-2); line-height: 1.65; cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.wed-chip .snippet.expanded { -webkit-line-clamp: unset; }
.wed-chip .opinion-input { width: 100%; box-sizing: border-box;
  background: var(--dsw-alias-bg-base, rgba(0,0,0,.16)); color: var(--w-text);
  border: 1px solid var(--w-border); border-radius: 8px; padding: 7px 10px; font-size: 13px; outline: none;
  transition: border-color .15s, box-shadow .15s; font-family: inherit; }
.wed-chip .opinion-input:focus { border-color: var(--w-accent); box-shadow: 0 0 0 3px var(--w-accent-soft); }
.wed-chip .opinion-input::placeholder { color: var(--w-text-3); }

/* ── 引用条浮层形态:钉在官方输入卡正上方,宽度对齐 ──
   实底不透明(用户反馈:半透明会把消息流文字透上来,难看) */
.wed-cites-dock { position: fixed; z-index: 100; max-height: 46vh; overflow-y: auto;
  background: #17171Bf2; backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid var(--w-border-strong); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
  padding: 0 12px 10px; border-bottom: none; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.wed-fill.light .wed-cites-dock { background: #FFFFFFf5; }
/* 醒目标题条:一眼知道引用期间主消息写这里 */
.wed-cites-title { display: flex; align-items: center; gap: 8px; padding: 9px 2px 8px; font-size: 13px; font-weight: 700;
  color: var(--w-text); border-bottom: 1px solid var(--w-border); margin-bottom: 8px; }
.wed-cites-title::before { content: ''; width: 4px; height: 16px; border-radius: 99px; background: var(--w-accent); flex-shrink: 0; }
.wed-cites-title .sub { font-weight: 400; font-size: 12px; color: var(--w-text-2); }

/* ── 官方输入框引导遮罩(引用期间盖住官方输入卡,消除"在哪输入"歧义) ── */
.wed-composer-cover { position: fixed; z-index: 99; border-radius: 14px;
  background: #0E0E11ee; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--w-text-2); font-size: 13px; cursor: pointer;
  border: 1px dashed var(--w-border-strong); }
.wed-fill.light .wed-composer-cover { background: #F7F7F4ee; }

/* ── 引用条内的主消息输入+发送(原版输入区形态) ── */
.wed-cites-send { display: flex; gap: 8px; align-items: flex-end; margin-top: 8px; }
.wed-main-input { flex: 1; box-sizing: border-box; resize: vertical; min-height: 44px; max-height: 40vh;
  background: var(--dsw-alias-bg-base, rgba(0,0,0,.16)); color: var(--w-text);
  border: 1px solid var(--w-border); border-radius: 10px; padding: 8px 10px;
  font-size: 13px; font-family: inherit; outline: none; line-height: 1.5;
  transition: border-color .15s, box-shadow .15s; }
.wed-main-input:focus { border-color: var(--w-accent); box-shadow: 0 0 0 3px var(--w-accent-soft); }
.wed-send-btn { background: var(--w-cta-bg); color: var(--w-cta-text); border: none; border-radius: 99px;
  padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
.wed-send-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.2); }
.wed-send-btn:disabled { opacity: .4; cursor: not-allowed; }

.wed-msg-cites { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; max-width: 100%; }
.wed-msg-cites.dark { --w-btn-bg: rgba(255,255,255,.07); --w-btn-text:#F5F5F4; --w-text:#F5F5F4; --w-text-2:#A1A1A6; --w-text-3:#6E6E73;
  --w-border:rgba(255,255,255,.09); --w-border-strong:rgba(255,255,255,.16); --w-panel:rgba(255,255,255,.055); }
.wed-msg-cites.light { --w-text:#1F2329; --w-text-2:#646A73; --w-text-3:#8F959E;
  --w-border:#E8E8E2; --w-border-strong:#D8D8D0; --w-panel:#FFFFFF; }
.wed-msg-cites .wed-chip { background: var(--w-panel, transparent); box-shadow: none; }
.wed-msg-raw { display: none; }
.wed-msg-cites .opinion { font-size: 12px; color: var(--w-text); display: flex; align-items: baseline; gap: 6px; line-height: 1.5; }
.wed-msg-cites .opinion .tag { flex-shrink: 0; background: color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 6px; padding: 0 6px; font-size: 11px; opacity: .8; }

/* ── 统计弹窗表格(照原版 stats-table) ── */
.wed-stats { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.wed-stats td { padding: 4px 8px; font-size: 13px; border-bottom: 1px solid var(--w-border); }
.wed-stats .lbl { color: var(--w-text-3); }
.wed-stats .val { color: var(--w-text); text-align: right; font-variant-numeric: tabular-nums; }
.wed-stats .pct { color: var(--w-accent); text-align: right; width: 60px; }

/* ── 行号栏(勾选引用 v4):行号=MD 源文件真实行号;点击勾一行/拖动勾一段/Shift 点首尾 ── */
.wed-vditor.gutter-on .vditor-reset { padding-left: 64px !important; }
.wed-vditor.gutter-on .vditor:not(.vditor--fullscreen) .vditor-outline { left: 56px; }
.wed-gutter { position: absolute; left: 0; top: 0; bottom: 0; width: 50px; z-index: 7;
  pointer-events: none; overflow: hidden; }
.wed-gutter .wg-inner { position: absolute; left: 0; top: 0; width: 100%; will-change: transform; }
.wg-chip { position: absolute; left: 5px; width: 40px; height: 20px; margin-top: -10px;
  display: flex; align-items: center; justify-content: center; gap: 2px;
  font-size: 11px; line-height: 1; color: var(--w-text-3); font-variant-numeric: tabular-nums;
  border-radius: 6px; cursor: pointer; pointer-events: auto; user-select: none;
  border: 1px solid transparent; transition: background .12s, color .12s; }
.wg-chip:hover, .wg-chip.range-hint { background: var(--w-accent-soft); color: var(--w-accent); }
.wg-chip.checked { background: var(--w-accent); color: #fff; font-weight: 700; }
.wg-chip.checked::before { content: '✓'; font-size: 10px; }
/* 被引用的行:chip 染上引用色(内联注入),粗体以示区分;行号即高亮,正文不画色块 */
.wg-chip.cited { font-weight: 700; }
.wed-gutter.disabled { opacity: .32; }
.wed-gutter.disabled .wg-chip { pointer-events: none; cursor: not-allowed; }

/* ── 勾选浮动条(有勾选行时浮现于编辑区左下) ── */
.wed-tickbar { position: absolute; left: 58px; bottom: 16px; z-index: 13;
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 12px;
  font-size: 12px; color: var(--w-text);
  background: color-mix(in srgb, var(--w-panel) 90%, transparent);
  border: 1px solid var(--w-border-strong); box-shadow: 0 8px 24px rgba(0,0,0,.18);
  backdrop-filter: blur(12px) saturate(150%); -webkit-backdrop-filter: blur(12px) saturate(150%); }
.wed-tickbar.disabled { opacity: .55; }
.wed-tickbar button { background: var(--w-cta-bg); color: var(--w-cta-text); border: none;
  border-radius: 99px; padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
.wed-tickbar button.ghost { background: var(--w-btn-bg); color: var(--w-btn-text); border: 1px solid var(--w-border); }
.wed-tickbar button:disabled { opacity: .45; cursor: not-allowed; }

/* ── 行号徽标(引用条内显示「第 X–Y 行」;消息卡片侧样式在 MSG_CSS) ── */
.wed-chip .lines-badge { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums;
  border-radius: 6px; padding: 1px 6px; font-weight: 700; white-space: nowrap;
  background: color-mix(in srgb, var(--cite-c) 16%, transparent); color: var(--cite-c); }
`

// ── 工具 ──
const fileDirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))
const fileNameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const hanCount = (t: string): number => (t.match(/[一-鿿]/g) || []).length
const draftKey = (p: string): string => 'woody-draft:' + p

interface Draft { content: string; savedAt: number; baseContent: string }

// ── 引用(照原版 2026-08-04 卡片化方案) ──
// 6 色循环,明暗两套(原版 --cite-1..6);深浅判定在组件内传入
const CITE_COLORS_LIGHT = ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2']
const CITE_COLORS_DARK = ['#56C2FF', '#59D499', '#FFC531', '#FF6363', '#BF8AF9', '#5EEAD4']

export function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export interface CiteRange { s: number; e: number }  // 1-based 闭区间行段

export interface CiteItem {
  id: string; path: string; name: string; text: string; snippet: string
  head: string; tail: string; color: string; instruction: string; _expanded?: boolean
  // v4 行号引用(2026-10-10 用户拍板:勾行引用,不贴原文省 token;划选引用已移除):
  lines?: CiteRange[]   // 勾选的行段
  anchor?: string       // 首行开头若干字(摘要 + 发送时行号校验锚)
  linesText?: string    // 勾选行原文(仅降级兜底用,正常不发送)
}

/** 行号去重合并:排序后把连续行并成闭区间(纯函数,自检用) */
export function mergeLineTicks(ticks: number[]): CiteRange[] {
  const sorted = Array.from(new Set(ticks)).filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b)
  const out: CiteRange[] = []
  for (const n of sorted) {
    const last = out[out.length - 1]
    if (last && n === last.e + 1) last.e = n
    else out.push({ s: n, e: n })
  }
  return out
}

/** 行段 → 「12–18、25、40–52」(纯函数,自检用) */
export function formatLineRanges(ranges: CiteRange[]): string {
  return ranges.map((r) => (r.s === r.e ? String(r.s) : `${r.s}–${r.e}`)).join('、')
}

/** 行号整体平移并夹回文件范围(发送时行号漂移修正;纯函数,自检用) */
export function shiftRanges(ranges: CiteRange[], delta: number, maxLine: number): CiteRange[] {
  const out: CiteRange[] = []
  for (const r of ranges) {
    const s = Math.max(1, r.s + delta)
    const e = Math.min(maxLine, r.e + delta)
    if (s <= e) out.push({ s, e })
  }
  return out
}

const normCmp = (s: string): string => String(s || '').replace(/\s+/g, '')

/** 发送时行号校验:在 aroundLine 附近 ±40 行窗口内找 anchor 所在行(纯函数,自检用)。
 *  命中返回 1-based 行号;找不到返回 0(调用方降级为附带原文)。
 *  两个坑(2026-10-10 用户实测抓到第一个):
 *  ① 摘要截断时末尾带展示用省略号「…」,不剥掉则被截断的锚永远匹配失败 → 全部降级带原文;
 *  ② 首行若是标题/列表,源行带 #/- 前缀,比对前先剥标记。 */
export function locateAnchorLine(srcLines: string[], anchor: string, aroundLine: number, window = 40): number {
  const stripMarker = (s: string): string => s.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
  const a = normCmp(stripMarker(String(anchor || ''))).replace(/(?:…|⋯|\.{3})+$/, '').slice(0, 24)
  if (!a) return 0
  const around = Math.max(1, Math.min(srcLines.length, Math.round(aroundLine) || 1))
  for (let d = 0; d <= window; d++) {
    for (const j of d === 0 ? [around - 1] : [around - 1 - d, around - 1 + d]) {
      if (j < 0 || j >= srcLines.length) continue
      const line = normCmp(stripMarker(srcLines[j]))
      if (!line) continue
      if (line.startsWith(a) || (a.length >= 6 && line.includes(a))) return j + 1
    }
  }
  return 0
}

// 引用列表持久化(localStorage):官方标签页切换会卸载我们的组件,
// 内存态会丢——持久化后切走再回来引用仍在(原版是主程序页面内存)。
const CITES_KEY = 'woody-cites'
function loadCites(): CiteItem[] {
  try {
    const arr = JSON.parse(localStorage.getItem(CITES_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function saveCites(list: CiteItem[]): void {
  try { localStorage.setItem(CITES_KEY, JSON.stringify(list)) } catch {}
}

/** 引用载荷 v4(2026-10-10 勾行引用):
 *  行号引用:引用[n] 要求 / 文件[n] / 位置[n]：第 X–Y、Z 行（「首行摘要」） —— 不贴原文,
 *  AI 按行号直读直改,省 token 也免去"读全文再找位置"的弯路(用户拍板的动机);
 *  摘要锚用于防漂移:AI 一对就知道行号有没有失效。
 *  历史文字引用(旧卡片未发送的/降级的)仍走 v3 内容[n] 行。
 *  键名演进:@file:(2026-10-03) → @文件:(10-07 上半) → 无@(10-07,官方 projectUserText
 *  会劫持一切 @ 记号) → v4 行号(10-10)。任何版本载荷中都不得出现 @。 */
export function buildCiteBlocks(cites: CiteItem[]): string {
  return cites.map((c, i) => {
    const head = `引用[${i + 1}] 要求：${(c.instruction || '').trim() || '（未填写）'}\n文件[${i + 1}]：${c.path}`
    if (c.lines && c.lines.length) {
      const anchor = (c.anchor || '').trim()
      return `${head}\n位置[${i + 1}]：第 ${formatLineRanges(c.lines)} 行` + (anchor ? `（「${anchor}」）` : '')
    }
    return `${head}\n内容[${i + 1}]：${c.text}`
  }).join('\n\n')
}

/**
 * 从消息原文反解析引用块(四兼容:v4 行号 / v3 无@ / 历史 @文件: / 更早 @file:)。
 * 返回主文本 + 引用数组(消息流卡片渲染用;色按序号循环重排)。
 */
export function parseCiteBlocks(raw: string): { mainText: string; cites: { path: string; name: string; text: string; instruction: string; location?: string }[] } {
  const v4Idx = (raw || '').indexOf('引用[')
  const atIdx = (raw || '').indexOf('@[')
  const firstIdx = v4Idx < 0 ? atIdx : atIdx < 0 ? v4Idx : Math.min(v4Idx, atIdx)
  if (firstIdx < 0) return { mainText: (raw || '').trim(), cites: [] }
  const mainText = raw.slice(0, firstIdx).trim()
  const cites: { path: string; name: string; text: string; instruction: string; location?: string }[] = []
  const pushText = (instruction: string, path: string, text: string): void => {
    let ins = (instruction || '').trim()
    if (ins === '（未填写）') ins = ''
    cites.push({ path: path.trim(), name: path.trim().split(/[\\/]/).pop() || path.trim(), text: (text || '').trim(), instruction: ins })
  }
  // v4(2026-10-10 起):行号 + 摘要锚,不贴原文;与 v3 混排时两段各归各(都无条件扫描)
  const reV4 = /引用\[(\d+)\] 要求：([^\n]*)\n文件\[\d+\]：([^\n]+)\n位置\[\d+\]：第 ([^\n（）]+?) 行(?:（「([\s\S]*?)」）)?(?=\n\n引用\[\d+\]|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = reV4.exec(raw)) !== null) {
    const before = cites.length
    pushText(m[2], m[3], m[5] || '')
    if (cites.length > before) cites[cites.length - 1].location = '第 ' + m[4].trim() + ' 行'
  }
  // v3(2026-10-07 起):无 @,官方 projectUserText 不劫持
  const reV3 = /引用\[(\d+)\] 要求：([^\n]*)\n文件\[\d+\]：([^\n]+)\n内容\[\d+\]：([\s\S]*?)(?=\n\n引用\[\d+\]|\s*$)/g
  while ((m = reV3.exec(raw)) !== null) pushText(m[2], m[3], m[4])
  // 历史格式兜底:@文件:(2026-10-03~07) 与 @file:(更早)
  if (!cites.length) {
    const reLegacy = /@\[(\d+)\] 要求：([^\n]*)\n@(?:文件|file):([^\n]+)\n@内容：([\s\S]*?)(?=\n\n@\[\d+\]|\s*$)/g
    while ((m = reLegacy.exec(raw)) !== null) pushText(m[2], m[3], m[4])
  }
  return { mainText, cites }
}

// ── 消息流引用卡片渲染(发送后把 @[n] 文本块渲染成卡片) ──
// 官方消息组件无渲染扩展点——采用「只读监听 + 视觉注入」:
// MutationObserver 监听用户消息([data-chat-flow-kind=user],源码实证标记),
// 识别含引用块格式的文本节点 → 原文包进隐藏 span 保真 → 注入卡片 DOM。
// 官方重渲染会重建节点冲掉注入,observer 再次触发自愈;不修改官方任何状态。
let chatCiteObserver: MutationObserver | null = null
const CITE_MSG_COLORS = ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2']

function pickCitePalette(): string[] {
  // 明暗判定统一走 detectDark(2026-10-07 修正——此前自己读 html,永远读空,
  // 深色模式下消息卡片被误判为浅色 → 白底)
  return detectDark()
    ? ['#56C2FF', '#59D499', '#FFC531', '#FF6363', '#BF8AF9', '#5EEAD4']
    : CITE_MSG_COLORS
}

/** 消息流卡片的独立样式表(2026-10-07 审查修复):
 *  此前卡片样式只存在于编辑器组件的 <style> 里——编辑器没挂载时(重启后
 *  直接翻旧消息)卡片无样式、.wed-msg-raw 藏不住原文,裸载荷文本露出。
 *  现在插件启动时全局挂载本样式(见 applyEditor),不依赖任何组件存活;
 *  规则全部收在 .wed-msg-cites 作用域下,不影响编辑器自己的界面。 */
const MSG_CSS = `
.wed-msg-raw { display: none; }
.wed-msg-cites { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; max-width: 100%; }
.wed-msg-cites.dark { --w-text:#F5F5F4; --w-text-2:#A1A1A6; --w-text-3:#6E6E73;
  --w-border:rgba(255,255,255,.09); --w-border-strong:rgba(255,255,255,.16); --w-panel:rgba(255,255,255,.055); }
.wed-msg-cites.light { --w-text:#1F2329; --w-text-2:#646A73; --w-text-3:#8F959E;
  --w-border:#E8E8E2; --w-border-strong:#D8D8D0; --w-panel:#FFFFFF; }
.wed-msg-cites .wed-chip { display: flex; gap: 10px; align-items: stretch;
  background: var(--w-panel, transparent); border: 1px solid var(--w-border); border-radius: 12px; padding: 9px 12px;
  box-shadow: none; }
.wed-msg-cites .wed-chip .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.wed-msg-cites .wed-chip .head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.wed-msg-cites .wed-chip .no { width: 18px; height: 18px; border-radius: 99px; flex-shrink: 0;
  background: var(--cite-c); color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; }
.wed-msg-cites .wed-chip .fname { font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.wed-msg-cites .wed-chip .fname.clickable { cursor: pointer; }
.wed-msg-cites .wed-chip .fname.clickable:hover { text-decoration: underline; color: var(--dsw-static-deepseek-450, #4b7bec); }
.wed-msg-cites .wed-chip .fileicon { color: var(--w-text-3); display: flex; flex-shrink: 0; }
.wed-msg-cites .wed-chip .snippet { font-size: 12.5px; color: var(--w-text-2); line-height: 1.65; cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.wed-msg-cites .wed-chip .snippet.expanded { -webkit-line-clamp: unset; }
.wed-msg-cites .opinion { font-size: 12px; color: var(--w-text); display: flex; align-items: baseline; gap: 6px; line-height: 1.5; }
.wed-msg-cites .opinion .tag { flex-shrink: 0; background: color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 6px; padding: 0 6px; font-size: 11px; opacity: .8; }
.wed-msg-cites .lines-badge { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; border-radius: 6px; padding: 1px 6px;
  background: color-mix(in srgb, var(--cite-c) 16%, transparent); color: var(--cite-c); font-weight: 700; white-space: nowrap; }
`

// ── 消息卡片文件名点击 → 官方右侧栏打开该文件(.md 走本插件编辑器) ──
// sidebarRight 服务在 applyEditor 里认领(官方 ui-chat 同款:ctx.sidebarRight.openResource)。
let sidebarRightSvc: { openResource: (addr: string) => void } | null = null

/** 官方 session 文件地址(逐段移植 ui-chat 的 sessionFileAddress + encodeSegment):
 *  绝对路径作尾段是官方认可的地址形态(fileAddressFor 对 cwd 外绝对路径即如此)。 */
function citeFileAddress(absPath: string): string | null {
  let sid = ''
  try { sid = String(JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId || '') } catch {}
  if (!sid || !absPath) return null
  const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':')
  const norm = absPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${enc(sid)}/${norm.split('/').map(enc).join('/')}`
}

function buildMsgCiteCard(c: { path: string; name: string; text: string; instruction: string; location?: string }, ci: number): HTMLElement {
  const colors = pickCitePalette()
  const card = document.createElement('div')
  card.className = 'wed-chip'
  card.style.setProperty('--cite-c', colors[ci % colors.length])
  const body = document.createElement('div'); body.className = 'body'
  const head = document.createElement('div'); head.className = 'head'
  const no = document.createElement('span'); no.className = 'no'; no.textContent = String(ci + 1)
  const icon = document.createElement('span'); icon.className = 'fileicon'; icon.textContent = '📄'
  const fname = document.createElement('span'); fname.className = 'fname'; fname.textContent = c.name; fname.title = c.path
  // 文件名可点击:官方 sidebarRight.openResource 打开(.md 默认进本插件编辑器);
  // 服务或会话 id 拿不到时退化为纯展示(title 里仍能看到完整路径)
  const addr = citeFileAddress(c.path)
  if (addr && sidebarRightSvc) {
    fname.classList.add('clickable')
    fname.title = c.path + '（点击打开）'
    fname.addEventListener('click', (ev) => {
      ev.stopPropagation()
      try { sidebarRightSvc?.openResource(addr) } catch {}
    })
  }
  head.append(no, icon, fname)
  // v4 行号引用:位置徽标(第 X–Y 行)+ 摘要锚当摘要;无原文可展开
  if (c.location) {
    const badge = document.createElement('span'); badge.className = 'lines-badge'; badge.textContent = c.location
    head.append(badge)
  }
  const snippet = document.createElement('div'); snippet.className = 'snippet'; snippet.textContent = c.text
  if (c.text) {
    snippet.title = '点击展开全文'
    snippet.addEventListener('click', () => snippet.classList.toggle('expanded'))
  }
  body.append(head, snippet)
  if (c.instruction) {
    const op = document.createElement('div'); op.className = 'opinion'
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '要求'
    op.append(tag, document.createTextNode(c.instruction))
    body.append(op)
  }
  card.appendChild(body)
  return card
}

function renderCitesInUserNode(node: Node): void {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue || ''
    // 检测标记:v4(引用[/位置[)、v3(引用[/内容[)与历史格式(@[/@内容：)任一命中即尝试反解析;
    // 无 @ 格式下官方 projectUserText 不会再把文本切成引用块 → 文本节点完整可辨
    const hasHead = raw.includes('引用[') || raw.includes('@[')
    const hasBody = raw.includes('内容[') || raw.includes('位置[') || raw.includes('@内容：')
    if (!hasHead || !hasBody) continue
    const parsed = parseCiteBlocks(raw)
    if (!parsed.cites.length) continue
    // 原文包进隐藏 span 保真(官方数据无损);主文本可见;卡片注入其后
    const host = document.createElement('span')
    const main = document.createElement('span')
    if (parsed.mainText) main.textContent = parsed.mainText + '\n\n'
    const rawKeep = document.createElement('span'); rawKeep.className = 'wed-msg-raw'; rawKeep.textContent = raw
    const cards = document.createElement('div')
    cards.className = 'wed-msg-cites ' + (pickCitePalette() === CITE_MSG_COLORS ? 'light' : 'dark')
    parsed.cites.forEach((c, ci) => cards.appendChild(buildMsgCiteCard(c, ci)))
    host.append(main, rawKeep, cards)
    n.parentNode?.replaceChild(host, n)
    // 2026-10-07 修复:此处不再广播「引用已消耗」。旧消息被官方重画时同样会
    // 走到这里,原实现会把编辑器里正在编写的新引用误清空;清空职责只归发送
    // 链路(sendCites 成功后广播),本函数纯渲染。
    return
  }
}

function installChatCiteRenderer(): void {
  if (chatCiteObserver) return
  if (typeof document === 'undefined' || !document.querySelector) return // 非浏览器环境(自检)防御
  const scan = (): void => {
    for (const el of Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))) {
      if (el.querySelector('.wed-msg-cites')) continue
      renderCitesInUserNode(el)
    }
  }
  const start = (): void => {
    scan()
    chatCiteObserver = new MutationObserver(() => scan())
    chatCiteObserver.observe(document.body, { childList: true, subtree: true })
  }
  if (document.body) start()
  else window.addEventListener('DOMContentLoaded', start, { once: true })
}

function readDraft(path: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(path))
    if (!raw) return null
    const d = JSON.parse(raw)
    if (typeof d?.content !== 'string') return null
    return { content: d.content, savedAt: Number(d.savedAt) || 0, baseContent: String(d.baseContent ?? '') }
  } catch { return null }
}
function clearDraft(path: string): void { try { localStorage.removeItem(draftKey(path)) } catch {} }

// ============================================================
// 编辑器主体(仅剧本工作区内的 .md 文件会走到这里)
// ============================================================
function WoodyEditor(props: { filePath: string }): React.ReactElement {
  // 统一正斜杠(宿主 resolve 返回 Windows 反斜杠;内部与草稿键都以正斜杠为准)
  const filePath: string = String(props.filePath || '').replaceAll('\\', '/')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [han, setHan] = useState(0)
  const [feedback, setFeedback] = useState<{ msg: string; err?: boolean } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [viewingTS, setViewingTS] = useState('')
  const [versionCount, setVersionCount] = useState(0)
  const [showVersions, setShowVersions] = useState(false)
  const [versions, setVersions] = useState<{ ts: string; formatted: string; file: string }[]>([])
  const [dark, setDark] = useState(false)
  // 大纲(原版行为):非全屏默认隐藏,左缘把手呼出;进全屏默认显示
  const [outlineShow, setOutlineShow] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fsObserverRef = useRef<MutationObserver | null>(null)
  // 引用(跨文件共享,localStorage 持久化;高亮只画当前文件的)
  const [cites, setCites] = useState<CiteItem[]>(() => loadCites())
  const [citeMain, setCiteMain] = useState<string>(() => { try { return localStorage.getItem('woody-cites-main') || '' } catch { return '' } })
  const reapplyTimerRef = useRef<number>(0)
  // 引用条停靠位置(官方输入卡矩形;null=找不到,回落编辑器面板内)
  const [dock, setDock] = useState<{ left: number; top: number; width: number; height: number; bottom: number } | null>(null)
  const mainInputRef = useRef<HTMLTextAreaElement | null>(null)
  // ── 行号栏勾选引用(v4,2026-10-10 用户拍板)──
  // 纯 ref 态(命令式 DOM,不走 React 渲染;勾选数走 state 驱动浮动条)
  const [tickCount, setTickCount] = useState(0)
  const gutterRef = useRef<HTMLDivElement | null>(null)            // 行号栏根元素
  const gutterInnerRef = useRef<HTMLDivElement | null>(null)       // 平移层(跟随滚动)
  const gutterScrollerRef = useRef<HTMLElement | null>(null)       // 绑了滚动同步的可编辑元素
  const lineMapRef = useRef<{ chips: { el: HTMLElement; span: CiteRange | null }[]; srcLines: string[] } | null>(null)
  const tickRef = useRef<Set<number>>(new Set())                   // 勾选的 chip 下标
  const lastClickRef = useRef<number>(-1)                          // Shift 点首尾的"首"
  const dragRef = useRef<{ start: number; last: number; moved: boolean } | null>(null)
  const gutterTimerRef = useRef<number>(0)
  const gutterRetriesRef = useRef(0)
  // 统计弹窗(打开时算一次)
  const [showStats, setShowStats] = useState(false)
  const [statsRows, setStatsRows] = useState<{ label: string; value: string; pct?: string }[]>([])

  const boxRef = useRef<HTMLDivElement | null>(null)      // Vditor 容器(常驻,绝不重挂)
  const vdRef = useRef<any>(null)                          // Vditor 实例(非响应式)
  const loadingRef = useRef(true)                          // 装载抑制(setValue 回声不算输入)
  const lastSetMdRef = useRef('')                          // 回声抑制
  const draftTimerRef = useRef<number>(0)
  const fbTimerRef = useRef<number>(0)
  const baseContentRef = useRef('')                        // 磁盘内容基准(草稿冲突检测)
  const darkRef = useRef(false)

  const flash = (msg: string, err = false): void => {
    setFeedback({ msg, err })
    window.clearTimeout(fbTimerRef.current)
    fbTimerRef.current = window.setTimeout(() => setFeedback(null), 2200)
  }

  const setEditable = (on: boolean): void => {
    const vd = vdRef.current
    try {
      const el = vd?.vditor?.wysiwyg?.element
      if (el) el.contentEditable = String(on)
    } catch {}
  }

  /** 大纲显隐:自定义 class 控制(不碰 Vditor 内部 toggle,原版方案) */
  const applyOutlineDisplay = (show: boolean): void => {
    try {
      const box = boxRef.current
      const out = box?.querySelector('.vditor-outline')
      out?.classList.toggle('woody-outline-hide', !show)
    } catch {}
  }
  const toggleOutline = (): void => {
    setOutlineShow((v) => { applyOutlineDisplay(!v); return !v })
  }
  /** 全屏联动(原版方案):监听 .vditor 的 class,进全屏默认显示大纲、退全屏默认收起 */
  const bindFullscreenWatcher = (): void => {
    try {
      const vd = boxRef.current?.querySelector('.vditor')
      if (!vd || (vd as any).__fsBound) return
      ;(vd as any).__fsBound = true
      const obs = new MutationObserver(() => {
        const fs = vd.classList.contains('vditor--fullscreen')
        setIsFullscreen(fs)
        setOutlineShow((prev) => {
          if (fs !== prev) applyOutlineDisplay(fs)
          return fs
        })
      })
      obs.observe(vd, { attributes: true, attributeFilter: ['class'] })
      fsObserverRef.current = obs
    } catch {}
  }
  /** 非全屏:点击大纲/把手以外区域自动收起(原版行为) */
  const onEditorAreaClick = (ev: MouseEvent): void => {
    const t = ev.target as HTMLElement
    if (isFullscreen || !outlineShow) return
    if (t.closest('.vditor-outline') || t.closest('.wed-outline-tab')) return
    setOutlineShow(false)
    applyOutlineDisplay(false)
  }

  // ============================================================
  // 引用标记(v4,2026-10-10 用户拍板):不做文字高亮,只做「行号高亮」——
  // 被引用的行,左侧行号 chip 染上该引用的颜色;同一行被多条引用覆盖时,
  // 显最后一条(最新)的颜色。正文里不画任何色块。
  // (旧版「平铺文本视图 + LCS 锚定位 + 文字 span 高亮」整套已随划选引用移除)
  // ============================================================
  const paintCiteMarks = (): void => {
    try {
      const inner = gutterInnerRef.current
      const map = lineMapRef.current
      if (!inner || !map) return
      const mine = cites.filter((c) => c.path === filePath && c.lines && c.lines.length)
      for (const chip of Array.from(inner.children) as HTMLElement[]) {
        const i = (chip as any).__idx
        if (typeof i !== 'number') continue
        const sp = map.chips[i]?.span
        if (!sp) continue
        let owner: CiteItem | null = null
        for (const h of mine) {
          if (h.lines!.some((r) => sp.s <= r.e && r.s <= sp.e)) owner = h
        }
        chip.classList.toggle('cited', !!owner)
        if (owner) {
          chip.style.background = owner.color
          chip.style.borderColor = owner.color
          chip.style.color = '#fff'
        } else {
          chip.style.background = ''
          chip.style.borderColor = ''
          chip.style.color = ''
        }
      }
    } catch {}
  }
  // 旧名兼容:引用变化/文件切换 → 重画行号标记
  const applyHighlights = paintCiteMarks

  const scheduleReapply = (): void => {
    window.clearTimeout(reapplyTimerRef.current)
    reapplyTimerRef.current = window.setTimeout(applyHighlights, 150)
  }

  /** 装载内容(当前文档):干净起点 + 恢复可编辑(原版只读死锁教训)。
   *  保持阅读位置:重新装载会把视图拉回顶部,读长文本时很伤(2026-10-11 用户反馈);
   *  全新打开时位置为 0,恢复无感。 */
  const loadContent = (content: string): void => {
    const vd = vdRef.current
    if (!vd) return
    let keep = -1
    try { const el = vd.vditor?.wysiwyg?.element; if (el) keep = el.scrollTop } catch {}
    // 跨重建恢复:编辑器若被外部触发重挂载(如文件监听重载),按记忆的位置原地恢复
    const remembered = lastScrollByPath.get(filePath)
    if (remembered !== undefined && remembered > keep) keep = remembered
    loadingRef.current = true
    lastSetMdRef.current = content
    vd.setValue(content)
    setDirty(false)
    setHan(hanCount(content))
    window.setTimeout(() => {
      loadingRef.current = false
      if (keep > 0) { try { const el = vd.vditor?.wysiwyg?.element; if (el) el.scrollTop = keep } catch {} }
    }, 0)
    scheduleReapply()
    scheduleGutterRebuild()   // 干净态 → 重建块↔行映射与行号栏
    clearTicks()              // 新装载的内容与旧勾选无关
  }

  /** 输入处理(双通道共用):置脏 + 草稿定时。
   *  勾选只属于「已保存内容」:从干净态打出第一个字起,行号勾选即作废(用户拍板的防漂移语义) */
  const onInputValue = (value: string): void => {
    if (loadingRef.current || value === lastSetMdRef.current) return
    lastSetMdRef.current = value
    if (!dirty) clearTicks()
    setDirty(true)
    setHan(hanCount(value))
    // 草稿:输入停 2s 自动存(不写盘、不生成版本——正式保存才落盘+快照)
    window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey(filePath), JSON.stringify({
          content: value, savedAt: Date.now(), baseContent: baseContentRef.current,
        }))
      } catch {}
    }, 2000)
  }

  /** 正式保存(Ctrl+S / 保存按钮):强制同步最新值(Vditor 回调防抖教训) */
  const doSave = async (): Promise<void> => {
    const vd = vdRef.current
    if (!vd) return
    if (viewingTS) { await doRestore(viewingTS); return }
    const latest = vd.getValue()
    if (latest !== lastSetMdRef.current) onInputValue(latest)
    if (!dirty) { flash('没有需要保存的修改'); return }
    try {
      // 保持阅读位置:保存流程中的重建/重排不应把视图拉回第一行(2026-10-11 用户反馈)
      const scrollEl = (): HTMLElement | null => { try { return vdRef.current?.vditor?.wysiwyg?.element ?? null } catch { return null } }
      const keep = scrollEl()?.scrollTop ?? -1
      const restore = (): void => { const el = scrollEl(); if (el && keep >= 0 && el.scrollTop !== keep) el.scrollTop = keep }
      const d = await apiPost('/api/woody/files/save', { path: filePath, content: latest })
      baseContentRef.current = latest
      lastSetMdRef.current = latest
      setDirty(false)
      setVersionCount(Number(d.versionCount) || 0)
      clearDraft(filePath)
      setDraft(null)
      flash(d.versionSaved ? `✓ 已保存（第 ${d.versionCount} 个版本）` : '✓ 已保存')
      scheduleGutterRebuild()   // 回到干净态 → 行号栏恢复可勾选并重对齐
      // 记录阅读位置:万一外部触发编辑器重建,重挂载后按此原地恢复
      try { if (keep >= 0) lastScrollByPath.set(filePath, keep) } catch {}
      void apiBase().then((b) => fetch(b + '/api/woody/debug/log?msg=' + encodeURIComponent('save ' + filePath))).catch(() => {})
      // 多重兜底恢复阅读位置:短文档一次就够,长文档重建/重排更慢,
      // 按 180/400/800ms 分批复位,确保最后一拍落在所有异步动作之后
      requestAnimationFrame(restore)
      window.setTimeout(restore, 180)
      window.setTimeout(restore, 400)
      window.setTimeout(restore, 800)
    } catch (e: any) { flash('保存失败：' + String(e?.message ?? e), true) }
  }

  /** 刷新(原版语义:从磁盘重新加载)。有未保存修改时先落一份草稿再重读,防丢字 */
  const doReload = async (): Promise<void> => {
    try {
      const vd = vdRef.current
      if (vd && dirty) {
        try {
          localStorage.setItem(draftKey(filePath), JSON.stringify({
            content: vd.getValue(), savedAt: Date.now(), baseContent: baseContentRef.current,
          }))
        } catch {}
      }
      setViewingTS('')
      setEditable(true)
      const d = await api('/api/woody/files/read?path=' + encodeURIComponent(filePath))
      baseContentRef.current = String(d.content ?? '')
      loadContent(baseContentRef.current)
      void api('/api/woody/files/versions?path=' + encodeURIComponent(filePath))
        .then((v) => { setVersions(v); setVersionCount(Array.isArray(v) ? v.length : 0) }).catch(() => {})
      flash('已从磁盘重新加载')
    } catch (e: any) { flash('读取失败：' + String(e?.message ?? e), true) }
  }

  // ── 行号栏勾选引用(v4,2026-10-10 用户拍板,替代划选引用)──
  // 编辑器左侧浮现行号(=MD 源文件真实行号);点击勾一行/按住拖动勾一段/Shift 点首尾勾区间;
  // 有未保存修改时整栏变灰不可点(行号只对磁盘文件有意义);保存后立刻恢复。
  // 块↔行映射在「干净态」(装载/保存后)用 getValue() 重建,勾选到的就是磁盘上那几行。

  const filePathRef = useRef(filePath)
  filePathRef.current = filePath

  /** MD 行标记剥离(供块↔行匹配:行文本去掉 #/-/>/序号 后与块文本比对) */
  const stripMdMarker = (line: string): string =>
    line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')

  /** 块↔源文件行映射:按顺序消费源行,块文本(去空白)与行文本(去标记去空白)互相包含即命中。
   *  表格吞后续 | 行;列表按 li 数吞行;``` 围栏吞到收尾。 screenplay 文档(段落/标题为主)1 块=1 行。 */
  const buildBlockLineMap = (vd: any): { chips: { el: HTMLElement; span: CiteRange | null }[]; srcLines: string[] } | null => {
    try {
      const el: HTMLElement | null = vd?.vditor?.wysiwyg?.element ?? null
      if (!el) return null
      const srcLines = String(vd.getValue() || '').split('\n')
      const blocks = Array.from(el.querySelectorAll(':scope > [data-block]')) as HTMLElement[]
      const chips: { el: HTMLElement; span: CiteRange | null }[] = []
      let cursor = 0
      for (const block of blocks) {
        const bt = normCmp(block.textContent || '')
        if (!bt) { chips.push({ el: block, span: null }); continue }
        let found = -1
        const limit = Math.min(srcLines.length, cursor + 400)
        for (let j = cursor; j < limit; j++) {
          const raw = srcLines[j] || ''
          if (!raw.trim()) continue
          const lt = normCmp(stripMdMarker(raw))
          if (!lt) continue
          if (lt === bt || (bt.length >= 4 && lt.includes(bt)) || (lt.length >= 4 && bt.includes(lt))) { found = j; break }
        }
        if (found < 0) { chips.push({ el: block, span: null }); cursor = Math.min(cursor + 1, srcLines.length); continue }
        let end = found
        if (block.tagName === 'TABLE') {
          while (end + 1 < srcLines.length && /^\s*\|/.test(srcLines[end + 1] || '')) end++
        } else if (block.tagName === 'UL' || block.tagName === 'OL') {
          let need = Math.max(0, block.querySelectorAll(':scope > li').length - 1)
          while (need > 0 && end + 1 < srcLines.length) { end++; if ((srcLines[end] || '').trim()) need-- }
        } else if (block.tagName === 'PRE' && /^\s*```/.test(srcLines[found] || '')) {
          while (end + 1 < srcLines.length && !/^\s*```\s*$/.test(srcLines[end + 1] || '')) end++
          if (end + 1 < srcLines.length) end++
        }
        chips.push({ el: block, span: { s: found + 1, e: end + 1 } })
        cursor = end + 1
      }
      return { chips, srcLines }
    } catch { return null }
  }

  const syncGutterScroll = (): void => {
    try {
      const el = (vdRef.current?.vditor?.wysiwyg?.element ?? null) as HTMLElement | null
      const inner = gutterInnerRef.current
      if (el && inner) inner.style.transform = 'translateY(' + (-el.scrollTop) + 'px)'
    } catch {}
  }

  const coveredLineCount = (): number => {
    const map = lineMapRef.current
    if (!map) return 0
    let n = 0
    for (const i of tickRef.current) {
      const sp = map.chips[i]?.span
      if (sp) n += sp.e - sp.s + 1
    }
    return n
  }

  const refreshTickStyles = (): void => {
    const inner = gutterInnerRef.current
    if (!inner) return
    for (const c of Array.from(inner.children) as HTMLElement[]) {
      if (typeof (c as any).__idx === 'number') c.classList.toggle('checked', tickRef.current.has((c as any).__idx))
    }
  }

  const paintGutterRange = (a: number, b: number): void => {
    const inner = gutterInnerRef.current
    if (!inner) return
    const lo = Math.min(a, b), hi = Math.max(a, b)
    for (const c of Array.from(inner.children) as HTMLElement[]) {
      const i = (c as any).__idx
      if (typeof i === 'number') c.classList.toggle('range-hint', i >= lo && i <= hi)
    }
  }
  const clearGutterHint = (): void => {
    const inner = gutterInnerRef.current
    if (!inner) return
    for (const c of Array.from(inner.children) as HTMLElement[]) c.classList.remove('range-hint')
  }

  const clearTicks = (): void => {
    tickRef.current.clear()
    refreshTickStyles()
    setTickCount(0)
  }

  /** 行号栏按下:普通点击=勾/取消一行;按住拖动=勾一段;Shift+点击=勾 [上次点击, 本次] 区间 */
  const onGutterMouseDown = (ev: MouseEvent): void => {
    try {
      const chip = (ev.target as HTMLElement).closest?.('.wg-chip') as HTMLElement | null
      if (!chip) return
      ev.preventDefault()
      const idx = (chip as any).__idx as number
      const startIdx = ev.shiftKey && lastClickRef.current >= 0 ? lastClickRef.current : idx
      dragRef.current = { start: startIdx, last: idx, moved: false }
      paintGutterRange(startIdx, idx)
      const move = (ev2: MouseEvent): void => {
        const d = dragRef.current
        if (!d) return
        const t2 = document.elementFromPoint(ev2.clientX, ev2.clientY) as HTMLElement | null
        const c2 = t2?.closest?.('.wg-chip') as HTMLElement | null
        if (c2 && typeof (c2 as any).__idx === 'number') {
          const i2 = (c2 as any).__idx as number
          if (i2 !== d.last) d.moved = true
          d.last = i2
          paintGutterRange(d.start, d.last)
        }
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        const d = dragRef.current
        dragRef.current = null
        clearGutterHint()
        if (!d) return
        if (d.moved) {
          for (let i = Math.min(d.start, d.last); i <= Math.max(d.start, d.last); i++) tickRef.current.add(i)
        } else if (ev.shiftKey && lastClickRef.current >= 0) {
          for (let i = Math.min(lastClickRef.current, idx); i <= Math.max(lastClickRef.current, idx); i++) tickRef.current.add(i)
        } else if (tickRef.current.has(idx)) {
          tickRef.current.delete(idx)
        } else {
          tickRef.current.add(idx)
        }
        lastClickRef.current = idx
        refreshTickStyles()
        setTickCount(coveredLineCount())
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    } catch {}
  }

  const teardownGutter = (): void => {
    const b = gutterBoundRef.current
    if (b) {
      try { b.parent.removeEventListener('scroll', b.onScroll, true) } catch {}
      try { window.removeEventListener('resize', b.onResize) } catch {}
    }
    gutterBoundRef.current = null
    try { gutterRef.current?.remove() } catch {}
    gutterRef.current = null
    gutterInnerRef.current = null
    lineMapRef.current = null
    tickRef.current.clear()
    lastClickRef.current = -1
    setTickCount(0)
    try { boxRef.current?.closest('.wed-vditor')?.classList.remove('gutter-on') } catch {}
  }

  /** (重)建行号栏:映射 + chip 定位 + 灰显态。装载/保存后调用;DOM 常驻复用。
   *  未就绪(phase 还在 loading)时不放弃也不拆除——挂起重试,等 setPhase('ready')
   *  生效后自然建起(2026-10-10 用户实测:开文件时行号栏不出现,点刷新才出现,
   *  就是初始化时序里 phase 闭包过期导致首建被跳过)。 */
  const rebuildGutter = (): void => {
    try {
      const vd = vdRef.current
      const el: HTMLElement | null = vd?.vditor?.wysiwyg?.element ?? null
      if (!el || !el.parentElement || viewingTS) { teardownGutter(); return }
      if (phase !== 'ready') {
        if (gutterRetriesRef.current < 80) {
          gutterRetriesRef.current += 1
          window.clearTimeout(gutterTimerRef.current)
          gutterTimerRef.current = window.setTimeout(() => { gutterApiRef.current?.rebuild() }, 100)
        }
        return
      }
      gutterRetriesRef.current = 0
      // 重建过程中保持阅读位置(长文档重建耗时,期间任何重排都不应拉动视图;
      // 2026-10-11 用户反馈:保存后长文档跳回第一行,短文档正常——即此处的时序差)
      let keepScroll = -1
      try { keepScroll = el.scrollTop } catch {}
      lineMapRef.current = buildBlockLineMap(vd)
      const parent = el.parentElement
      try { if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative' } catch {}
      let gutter = gutterRef.current
      if (!gutter || !gutter.isConnected || gutter.parentElement !== parent) {
        teardownGutter()
        gutter = document.createElement('div')
        gutter.className = 'wed-gutter'
        const inner = document.createElement('div')
        inner.className = 'wg-inner'
        gutter.appendChild(inner)
        parent.appendChild(gutter)
        gutterRef.current = gutter
        gutterInnerRef.current = inner
        const onScroll = (): void => gutterApiRef.current?.ssync()
        const onResize = (): void => gutterApiRef.current?.schedule()
        parent.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        gutter.addEventListener('mousedown', (ev) => gutterApiRef.current?.mdown(ev))
        gutter.addEventListener('wheel', (ev) => gutterApiRef.current?.wheel(ev), { passive: false })
        gutterBoundRef.current = { parent, onScroll, onResize }
      }
      // 内容让位:加大左内边距(先加类再量位置)
      try { boxRef.current?.closest('.wed-vditor')?.classList.add('gutter-on') } catch {}
      gutter.classList.toggle('disabled', dirty)
      gutter.title = dirty ? '有未保存的修改，保存后可勾选行号引用' : ''
      const inner = gutterInnerRef.current!
      inner.innerHTML = ''
      const map = lineMapRef.current
      if (map) {
        const elRect = el.getBoundingClientRect()
        for (let i = 0; i < map.chips.length; i++) {
          const chip = map.chips[i]
          const sp = chip.span
          if (!sp) continue
          const c = document.createElement('div')
          c.className = 'wg-chip' + (tickRef.current.has(i) ? ' checked' : '')
          const r = chip.el.getBoundingClientRect()
          c.style.top = (r.top - elRect.top + el.scrollTop) + 'px'
          c.textContent = String(sp.s)
          ;(c as any).__idx = i
          c.title = sp.s === sp.e
            ? `第 ${sp.s} 行 · 点击勾选，按住拖动勾一段`
            : `第 ${sp.s}–${sp.e} 行 · 点击勾选，按住拖动勾一段`
          inner.appendChild(c)
        }
      }
      if (keepScroll > 0 && el.scrollTop !== keepScroll) el.scrollTop = keepScroll
      syncGutterScroll()
      paintCiteMarks()   // chip 重建后立刻恢复引用染色
    } catch {}
  }

  const scheduleGutterRebuild = (): void => {
    window.clearTimeout(gutterTimerRef.current)
    // 经 gutterApiRef 调最新实现:调度时的闭包可能带着过期 phase(开文件时序的教训)
    gutterTimerRef.current = window.setTimeout(() => { gutterApiRef.current?.rebuild() }, 120)
  }

  const onGutterWheel = (ev: WheelEvent): void => {
    try {
      const el = vdRef.current?.vditor?.wysiwyg?.element
      if (el) { el.scrollTop += ev.deltaY; ev.preventDefault() }
    } catch {}
  }

  /** 勾选 → 生成一条引用块:一次勾选(散行/多段)合并为一个引用块(用户拍板);
   *  附首行摘要锚(发送时校验行号漂移用)与勾选行原文(仅降级兜底,不主动发送)。 */
  const citeFromTicks = (): void => {
    const map = lineMapRef.current
    if (!map) return
    const idxs = Array.from(tickRef.current).filter((i) => map.chips[i]?.span).sort((a, b) => a - b)
    if (!idxs.length) return
    const lines: number[] = []
    for (const i of idxs) {
      const sp = map.chips[i].span!
      for (let l = sp.s; l <= sp.e; l++) lines.push(l)
    }
    const ranges = mergeLineTicks(lines)
    if (!ranges.length) return
    const firstRaw = (map.srcLines[ranges[0].s - 1] || '').trim()
    const anchor = firstRaw.length > 16 ? firstRaw.slice(0, 16) + '…' : firstRaw
    const linesText = ranges.map((r) => map.srcLines.slice(r.s - 1, r.e).join('\n')).join('\n')
    const label = '第 ' + formatLineRanges(ranges) + ' 行'
    const path = filePathRef.current
    const id = path + '#L' + ranges[0].s + '-' + ranges[ranges.length - 1].e + '#' + djb2(linesText)
    if (cites.some((c) => c.id === id)) {
      clearTicks()
      flash('这些行已经在引用里了')
      return
    }
    const palette = darkRef.current ? CITE_COLORS_DARK : CITE_COLORS_LIGHT
    const next = cites.concat({
      id, path, name: fileNameOf(path), text: anchor,
      snippet: label + ' · ' + (anchor || '（空行）'),
      head: '', tail: '', color: palette[cites.length % palette.length], instruction: '', _expanded: false,
      lines: ranges, anchor, linesText,
    })
    saveCites(next)
    setCites(next)
    clearTicks()
    flash(`✓ 已引用${label}（共 ${lines.length} 行），在下方发送框填写要求后发送`)
  }

  // 包装器注册表:行号栏 DOM 事件只绑一次,经此转发到每轮渲染的最新实现
  const gutterApiRef = useRef<{
    rebuild: () => void; schedule: () => void; teardown: () => void
    mdown: (ev: MouseEvent) => void; ssync: () => void; wheel: (ev: WheelEvent) => void
  } | null>(null)
  const gutterBoundRef = useRef<{ parent: HTMLElement; onScroll: () => void; onResize: () => void } | null>(null)

  const removeCite = (id: string): void => {
    setCites((prev) => {
      const next = prev.filter((c) => c.id !== id)
      saveCites(next)
      return next
    })
  }

  const toggleCiteExpand = (id: string): void => {
    setCites((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, _expanded: !c._expanded } : c))
      saveCites(next)
      return next
    })
  }

  const editCiteInstruction = (id: string, instruction: string): void => {
    setCites((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, instruction } : c))
      saveCites(next)
      return next
    })
  }

  /** 「发送」:主消息+引用块,走官方 session/prompt 正式接口(消息照常进官方对话流)。
   *  背景:官方输入框的 Lexical 不认外部注入文字(DOM 进了、state 不吸收、发送即丢,
   *  实测证伪注入路线)——改走官方公开 RPC,机制上可靠。
   *  v4 行号引用在发送一刻以磁盘文件为准:摘要锚在行号附近 ±40 行内核对,
   *  找到→按差量平移修正;找不到(文件改动过大)→该条降级为附带原文,绝不改错位置。 */
  const [sending, setSending] = useState(false)
  const sendCites = async (): Promise<void> => {
    const main = citeMain.trim()
    if (!cites.length || !main || sending) return
    setSending(true)
    try {
      // 当前会话 id(官方持久化位置,旧路线实证)
      let sessionId = ''
      try { sessionId = String(JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId || '') } catch {}
      if (!sessionId) { flash('发送失败：找不到当前会话（请先在对话区选中会话）', true); return }
      // 行号校验/修正/降级(同一文件只读一次磁盘)
      let degraded = 0
      const cache = new Map<string, string>()
      const effective: CiteItem[] = []
      for (const c0 of cites) {
        let c = c0
        if (c.lines && c.lines.length) {
          let src = ''
          if (cache.has(c.path)) src = cache.get(c.path) || ''
          else {
            try { const d = await api('/api/woody/files/read?path=' + encodeURIComponent(c.path)); src = String(d.content ?? '') } catch { src = '' }
            cache.set(c.path, src)
          }
          if (src) {
            const srcLines = src.split('\n')
            const found = locateAnchorLine(srcLines, c.anchor || '', c.lines[0].s)
            if (found > 0) {
              const delta = found - c.lines[0].s
              if (delta !== 0) c = { ...c, lines: shiftRanges(c.lines, delta, srcLines.length) }
            } else {
              const t = (c.linesText || c.anchor || '').trim()
              c = { ...c, lines: undefined, text: t, snippet: t.length > 42 ? t.slice(0, 42) + '…' : t }
              degraded++
            }
          } else {
            const t = (c.linesText || c.anchor || '').trim()
            c = { ...c, lines: undefined, text: t, snippet: t.length > 42 ? t.slice(0, 42) + '…' : t }
            degraded++
          }
        }
        effective.push(c)
      }
      const text = main + '\n\n' + buildCiteBlocks(effective)
      const uuid = (): string => (globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const r = await fetch('/api/session/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: uuid(),
          method: 'session/prompt',
          payload: { args: { request: {
            requestId: uuid(), sessionId, mode: 'queue',
            content: [{ type: 'text', text }],
          } } },
        }),
      })
      const d: any = await r.json().catch(() => null)
      const okSend = r.ok && d?.type === 'server-response' && d?.result?.ok !== false
      if (!okSend) {
        const err = d?.result?.error || d?.error || ('HTTP ' + r.status)
        flash('发送失败：' + JSON.stringify(err).slice(0, 160), true)
        return
      }
      // 成功:清卡片+主消息;消息流卡片由常驻 observer 渲染。
      // 「引用已消耗」只在这里广播(多编辑器实例联动清空);旧消息重画不再触发
      try { window.dispatchEvent(new CustomEvent('woody-cites-consumed')) } catch {}
      saveCites([]); setCites([])
      setCiteMain(''); localStorage.removeItem('woody-cites-main')
      flash(degraded > 0
        ? `✓ 已发送（${cites.length} 条引用；其中 ${degraded} 条因文件改动较大改为附带原文）`
        : `✓ 已发送（${cites.length} 条引用）`)
    } catch (e: any) {
      flash('发送失败：' + String(e?.message ?? e), true)
    } finally { setSending(false) }
  }

  // ── 统计(原版 statsData 口径逐字移植) ──
  const openStats = (): void => {
    try {
      const vd = vdRef.current
      const t = (vd ? vd.getValue() : lastSetMdRef.current) || ''
      const han = (t.match(/[一-鿿]/g) || []).length
      const punct = (t.match(/[　-〿＀-￯]/g) || []).length
      const digit = (t.match(/[0-9]/g) || []).length
      const alpha = (t.match(/[a-zA-Z]/g) || []).length
      const total = t.length
      const other = total - han - punct - digit - alpha
      const lines = t.split('\n').length
      const paras = t.split('\n').filter((l) => l.trim()).length
      const pct = (v: number): string => (total > 0 ? (v / total * 100).toFixed(1) : '0.0')
      const fmt = (v: number): string => v.toLocaleString()
      setStatsRows([
        { label: '汉字', value: fmt(han), pct: pct(han) + '%' },
        { label: '中文标点', value: fmt(punct), pct: pct(punct) + '%' },
        { label: '数字', value: fmt(digit), pct: pct(digit) + '%' },
        { label: '英文字母', value: fmt(alpha), pct: pct(alpha) + '%' },
        { label: '其他字符', value: fmt(other), pct: pct(other) + '%' },
        { label: '─', value: '' },
        { label: '总字符', value: fmt(total) },
        { label: '总行数', value: fmt(lines) },
        { label: '段落数', value: fmt(paras) },
      ])
      setShowStats(true)
    } catch {}
  }

  // ── 加入对照(原版 doCompare 语义;DSH 限制:不能同标签换文件,创建后提示手动打开) ──
  const canCompare = /\/细纲\/|\/剧本\//.test(filePath)
  const doCompareFinalize = async (): Promise<void> => {
    const vd = vdRef.current
    if (!vd) return
    const lastDot = filePath.lastIndexOf('.')
    const lastSlash = filePath.lastIndexOf('/')
    const base = lastDot > lastSlash ? filePath.slice(0, lastDot) : filePath
    const ext = lastDot > lastSlash ? filePath.slice(lastDot) : ''
    if (base.endsWith('-定稿')) { flash('已是定稿文件，无法再次定稿', true); return }
    const copyPath = base + '-定稿' + ext
    const copyName = fileNameOf(copyPath)
    try {
      await apiPost('/api/woody/files/write', { dir: fileDirOf(copyPath), name: copyName, content: vd.getValue() })
      flash(`✓ 已创建定稿文件 ${copyName}，请在文件面板打开`)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg.includes('已存在') || msg.includes('409')) flash('定稿文件已存在', true)
      else flash('创建失败：' + msg, true)
    }
  }

  /** 版本列表 */
  const openVersions = async (): Promise<void> => {
    setShowVersions(true)
    try { setVersions(await api('/api/woody/files/versions?path=' + encodeURIComponent(filePath))) }
    catch (e: any) { setVersions([]); flash('版本列表加载失败：' + String(e?.message ?? e), true) }
  }

  /** 只读查看某个历史版本 */
  const previewVersion = async (v: { ts: string; file: string }): Promise<void> => {
    setShowVersions(false)
    try {
      const dir = fileDirOf(filePath)
      const name = fileNameOf(filePath).replace(/\.md$/i, '')
      const d = await api('/api/woody/files/read?path=' + encodeURIComponent(`${dir}/.versions/${name}.${v.ts}.md`))
      loadingRef.current = true
      lastSetMdRef.current = d.content || ''
      vdRef.current?.setValue(lastSetMdRef.current)
      setViewingTS(v.ts)
      setDirty(false)
      setHan(hanCount(d.content || ''))
      setEditable(false)
      window.setTimeout(() => { loadingRef.current = false }, 0)
    } catch (e: any) { flash('版本内容读取失败：' + String(e?.message ?? e), true) }
  }

  /** 返回当前版本(重新从磁盘读) */
  const backToCurrent = async (): Promise<void> => {
    try {
      const d = await api('/api/woody/files/read?path=' + encodeURIComponent(filePath))
      setViewingTS('')
      setEditable(true)
      loadContent(String(d.content ?? ''))
    } catch (e: any) { flash('读取失败：' + String(e?.message ?? e), true) }
  }

  /** 恢复所选版本(服务端会先把当前内容备份成快照) */
  const doRestore = async (ts: string): Promise<void> => {
    try {
      const d = await apiPost('/api/woody/files/restore-version', { path: filePath, ts })
      setViewingTS('')
      setEditable(true)
      loadContent(String(d.content ?? ''))
      baseContentRef.current = String(d.content ?? '')
      setVersionCount(Number(d.versionCount) || 0)
      clearDraft(filePath)
      setDraft(null)
      flash('✓ 已恢复')
    } catch (e: any) { flash('恢复失败：' + String(e?.message ?? e), true) }
  }

  /** 应用草稿 */
  const useDraft = (): void => {
    if (!draft) return
    const conflict = baseContentRef.current !== draft.baseContent
    setViewingTS('')
    setEditable(true)
    loadingRef.current = true
    lastSetMdRef.current = draft.content
    vdRef.current?.setValue(draft.content)
    setDirty(true)
    clearTicks()   // 载入草稿 = 离开「已保存」态,旧勾选作废
    setHan(hanCount(draft.content))
    window.setTimeout(() => { loadingRef.current = false }, 0)
    scheduleReapply()
    if (conflict) flash('已载入草稿（注意：文件在草稿之后被修改过，保存将以草稿为准）')
    else flash('已载入草稿')
  }

  const discardDraft = (): void => { clearDraft(filePath); setDraft(null) }

  // ── 引用变化 / 文件切换 → 重应用高亮 ──
  useEffect(() => { scheduleReapply() }, [cites, filePath])

  // ── 行号栏生命周期:就绪且非版本查看时建栏;版本查看/未就绪时拆除;dirty 变化重建对齐 ──
  useEffect(() => {
    if (phase === 'ready' && !viewingTS) scheduleGutterRebuild()
    else teardownGutter()
  }, [phase, viewingTS, dirty, filePath])
  // dirty 灰显实时反映(重建是防抖的,这里的类切换是即时的)
  useEffect(() => {
    try { gutterRef.current?.classList.toggle('disabled', dirty) } catch {}
  }, [dirty])
  // 最新实现注册(每轮渲染刷新;行号栏 DOM 事件经 gutterApiRef 转发)
  gutterApiRef.current = {
    rebuild: rebuildGutter, schedule: scheduleGutterRebuild, teardown: teardownGutter,
    mdown: onGutterMouseDown, ssync: syncGutterScroll, wheel: onGutterWheel,
  }

  // ── 引用条停靠官方输入卡上方(有引用时;矩形跟随=已验证的定位模式) ──
  // dock 同时记录官方输入卡的完整矩形:浮层用 left/bottom/width,引导遮罩用 top/height
  useEffect(() => {
    if (cites.length === 0 || viewingTS) { setDock(null); return }
    let raf = 0
    let ro: ResizeObserver | null = null
    let target: Element | null = null
    const update = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const card = document.querySelector('[data-composer-card]')
        if (!(card instanceof HTMLElement)) { setDock(null); return }
        const r = card.getBoundingClientRect()
        if (r.width < 50) { setDock(null); return }
        setDock({ left: r.left, top: r.top, width: r.width, height: r.height, bottom: window.innerHeight - r.top + 8 })
      })
    }
    update()
    target = document.querySelector('[data-composer-card]')
    if (target) { ro = new ResizeObserver(update); ro.observe(target) }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [cites.length > 0, viewingTS])

  // ── 消息流渲染到引用卡片 = 引用已随消息发出 → 清空引用条(原版"发送后清空") ──
  useEffect(() => {
    const onConsumed = (): void => {
      setCites((prev) => { if (prev.length) { saveCites([]) }; return [] })
    }
    window.addEventListener('woody-cites-consumed', onConsumed)
    return () => { window.removeEventListener('woody-cites-consumed', onConsumed) }
  }, [])

  // ── 初始化:加载 Vditor 库 → 建实例 → 读文件 → 查草稿 ──
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        setDark(detectDark()); darkRef.current = detectDark()
        const Vditor = await ensureVditorLib()
        const base = await apiBase()
        if (disposed || !boxRef.current) return
        const vd = new Vditor(boxRef.current, {
          mode: 'wysiwyg',
          cdn: `${base}/vditor`,
          value: '',
          placeholder: '开始写作…',
          lang: 'zh_CN',
          cache: { enable: false },
          counter: { enable: false },
          height: '100%',
          preview: { theme: { path: `${base}/vditor/dist/css/content-theme` } },
          outline: { enable: true, position: 'left' },
          toolbar: [
            'undo', 'redo', '|',
            'headings', 'bold', 'italic', 'strike', '|',
            'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
            'quote', 'line', 'code', 'inline-code', 'insert-before', 'insert-after', '|',
            'table', 'link', '|',
            // 全屏按钮已移除:DSH 内嵌环境下全屏编辑有重 bug(2026-10-03 用户拍板,
            // 易出 bug 的交互入口直接去掉;用户很少用到全屏)
          ],
          input: (v: string) => onInputValue(v),
          after: () => {
            if (disposed) return
            try { vd.setTheme(darkRef.current ? 'dark' : 'classic', darkRef.current ? 'dark' : 'light', undefined, `${base}/vditor/dist/css/content-theme`) } catch {}
            bindFullscreenWatcher()
            applyOutlineDisplay(false)   // 大纲默认隐藏(用户拍板:通过左缘把手呼出)
            // 调试留痕:编辑器每次初始化都记一条——用来实证「保存后页面刷新」是否为重建
            void fetch(base + '/api/woody/debug/log?msg=' + encodeURIComponent('editor-init ' + filePath)).catch(() => {})
            // 读文件 → 装载 → 查草稿
            void (async () => {
              try {
                const d = await api('/api/woody/files/read?path=' + encodeURIComponent(filePath))
                if (disposed) return
                baseContentRef.current = String(d.content ?? '')
                loadContent(baseContentRef.current)
                setPhase('ready')
                // 打开即拉版本数(工具栏徽标,原版行为)
                void api('/api/woody/files/versions?path=' + encodeURIComponent(filePath))
                  .then((v) => { setVersions(v); setVersionCount(Array.isArray(v) ? v.length : 0) }).catch(() => {})
                const dr = readDraft(filePath)
                if (dr && dr.content !== baseContentRef.current) setDraft(dr)
              } catch (e: any) { setErrMsg(String(e?.message ?? e)); setPhase('error') }
            })()
          },
          esc: () => {},
        })
        vdRef.current = vd
      } catch (e: any) { setErrMsg(String(e?.message ?? e)); setPhase('error') }
    })()

    return () => {
      disposed = true
      window.clearTimeout(draftTimerRef.current)
      window.clearTimeout(fbTimerRef.current)
      window.clearTimeout(reapplyTimerRef.current)
      window.clearTimeout(gutterTimerRef.current)
      try { fsObserverRef.current?.disconnect() } catch {}
      fsObserverRef.current = null
      try { gutterApiRef.current?.teardown() } catch {}
      // 记住阅读位置:若外部(如文件监听)触发编辑器重建,重挂载后原地恢复
      try {
        const el = vdRef.current?.vditor?.wysiwyg?.element
        if (el && el.scrollTop > 0) lastScrollByPath.set(filePath, el.scrollTop)
      } catch {}
      try { vdRef.current?.destroy() } catch {}
      vdRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  // ── 双通道输入监听:原生 input 事件(即时)补 Vditor 回调防抖 ──
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onInput = (ev: Event): void => {
      const t = ev.target as HTMLElement | null
      if (t && t.closest && t.closest('.vditor-wysiwyg')) {
        const vd = vdRef.current
        if (vd) onInputValue(vd.getValue())
      }
    }
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault()
        void doSave()
      }
    }
    box.addEventListener('input', onInput)
    box.addEventListener('keydown', onKey)
    return () => { box.removeEventListener('input', onInput); box.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, viewingTS, dirty])

  // ── 富文本复制 v2:Vditor 所见即所得的复制默认只给 Markdown 源码,
  //    粘到 Word 得到的是代码;首版「补写 text/html」会被 Vditor 的复制处理器
  //    覆盖(2026-10-11 实测无效)。v2 完全接管:preventDefault + 阻断 Vditor
  //    处理器,同时写入 富文本 HTML + Markdown 纯文本——Word 拿排版,
  //    编辑器内再粘贴拿 Markdown 源码,两边都不丢。 ──
  useEffect(() => {
    const handler = (ev: ClipboardEvent): void => {
      try {
        const root: HTMLElement | null = vdRef.current?.vditor?.wysiwyg?.element ?? null
        const node = ev.target as Node | null
        if (!root || !node || !root.contains(node)) return
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
        const holder = document.createElement('div')
        for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents())
        const html = holder.innerHTML
        if (!html.trim()) return
        let plain = sel.toString()
        try {
          // Markdown 源码优先(用 Vditor 自带的 Lute 引擎把选区 HTML 转 MD)
          const lute = (vdRef.current as any)?.vditor?.lute?.Lute
          if (lute && typeof lute.HTML2Md === 'function') {
            const md = lute.HTML2Md(html)
            if (md && String(md).trim()) plain = String(md)
          }
        } catch {}
        ev.preventDefault()
        ev.stopImmediatePropagation()
        const dt = ev.clipboardData
        dt?.setData('text/html', html)
        dt?.setData('text/plain', plain)
      } catch {}
    }
    // 捕获阶段注册:先于 Vditor 的复制处理;完全接管剪贴板
    document.addEventListener('copy', handler, true)
    return () => document.removeEventListener('copy', handler, true)
  }, [])

  // ── 明暗主题跟随(DSW 变量变化 → Vditor 主题切换) ──
  useEffect(() => {
    let timer = 0
    const apply = (): void => {
      const d = detectDark()
      if (d !== darkRef.current) {
        darkRef.current = d
        setDark(d)
        try {
          void apiBase().then((base) => {
            vdRef.current?.setTheme(d ? 'dark' : 'classic', d ? 'dark' : 'light', undefined, `${base}/vditor/dist/css/content-theme`)
          })
        } catch {}
      }
    }
    const obs = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(apply, 300) })
    // 深色标记在 body[data-ds-dark-theme];html/body 都盯,防官方改挂载点
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
    if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
    return () => { obs.disconnect(); window.clearTimeout(timer) }
  }, [])

  // ── 渲染 ──
  if (phase === 'error') {
    return createElement('div', { className: 'wed-fill' },
      createElement('style', null, CSS),
      createElement('div', { className: 'wed-empty' },
        createElement('div', { className: 'big' }, '✎ 编辑模式加载失败'),
        createElement('div', null, errMsg)))
  }

  return createElement('div', { className: 'wed-fill ' + (dark ? 'dark' : 'light') },
    createElement('style', null, CSS),

    // ── 第一排:自定义工具栏(原版 editor-toolbar 结构) ──
    createElement('div', { className: 'wed-toolbar' },
      createElement('img', { className: 'bird', alt: '', src: dark ? BIRD_PLAIN : BIRD_DENSE }),
      createElement('span', { className: 'file-path' }, fileNameOf(filePath)),
      dirty ? createElement('span', { className: 'dirty-dot', title: '有未保存的修改（草稿每 2 秒自动暂存）' }) : null,
      feedback ? createElement('span', { className: 'save-feedback' + (feedback.err ? ' err' : '') }, feedback.msg) : null,
      createElement('span', { className: 'char-count' }, `${han.toLocaleString()} 字`),
      // v4:引用按钮回到工具栏原位(2026-10-10 用户要求);入口=先勾选左侧行号,再点此生成
      !viewingTS && phase === 'ready'
        ? createElement('button', {
            title: tickCount > 0
              ? `把勾选的 ${tickCount} 行生成一条引用`
              : '先在左侧勾选行号，再点此生成引用',
            disabled: tickCount === 0 || dirty,
            onClick: citeFromTicks,
          }, tickCount > 0 ? `引用（${tickCount} 行）` : '引用')
        : null,
      createElement('button', { title: '字数统计', disabled: phase !== 'ready', onClick: openStats }, '统计'),
      canCompare && !viewingTS
        ? createElement('button', { title: '在同目录创建「-定稿」副本（加入对照）', onClick: () => void doCompareFinalize() }, '加入对照')
        : null,
      viewingTS
        ? createElement('button', { title: '回到当前文件内容', onClick: () => void backToCurrent() }, '← 返回当前版本')
        : createElement('button', {
            title: '历史版本（保留最新 20 份）', disabled: versionCount === 0, onClick: () => void openVersions(),
          }, ICON_HISTORY, '历史', createElement('span', { className: 'badge' }, String(versionCount))),
      viewingTS ? null : createElement('button', { title: '从磁盘重新加载', onClick: () => void doReload() }, ICON_REFRESH),
      createElement('button', {
        className: viewingTS ? 'danger-btn' : 'save-btn',
        disabled: phase !== 'ready' || (!viewingTS && !dirty),
        title: viewingTS ? '用此版本覆盖当前文件（当前内容会自动备份）' : '保存（Ctrl+S，生成版本快照）',
        onClick: () => void doSave(),
      }, viewingTS ? '恢复此版本' : '保存'),
    ),

    // 草稿恢复横幅
    draft && !viewingTS ? createElement('div', { className: 'wed-banner warn' },
      createElement('span', null,
        `检测到未保存的草稿（${new Date(draft.savedAt).toLocaleString()}）`,
        baseContentRef.current !== draft.baseContent ? '，注意：文件在草稿之后被修改过' : ''),
      createElement('span', { className: 'grow' }),
      createElement('button', { onClick: discardDraft }, '丢弃'),
      createElement('button', { onClick: useDraft }, '使用草稿'),
    ) : null,

    // ── 官方输入框引导遮罩(引用期间盖住官方输入卡,消除"该在哪输入"歧义;
    //     点击遮罩聚焦浮层主消息框;只盖视觉,官方输入框本身不动) ──
    cites.length > 0 && !viewingTS && dock ? createElement('div', {
      className: 'wed-composer-cover',
      style: { left: dock.left + 'px', top: dock.top + 'px', width: dock.width + 'px', height: dock.height + 'px' },
      title: '引用模式：请在上方的引用发送框输入并发送',
      onClick: () => { try { mainInputRef.current?.focus() } catch {} },
    }, '⬆ 引用模式：主消息请写在上方的引用发送框') : null,

    // ── 引用条(照原版 cited-bar:卡片 = 编号圆标+短文件名+摘要展开+意见输入框+移除;
    //     颜色与编辑器高亮同源 --cite-c)。
    //     停靠形态:钉在官方输入卡正上方(用户要求,原版同位);找不到输入卡回落面板内 ──
    cites.length > 0 && !viewingTS ? createElement('div', {
      className: 'wed-cites' + (dock ? ' wed-cites-dock' : ''),
      style: dock ? { left: dock.left + 'px', bottom: dock.bottom + 'px', width: dock.width + 'px' } : undefined,
    },
      // 醒目标题条:新用户一眼知道引用期间主消息写这里
      createElement('div', { className: 'wed-cites-title' },
        createElement('span', null, '引用发送'),
        createElement('span', { className: 'sub' }, `已附 ${cites.length} 段引用 · 主消息写在这里,点「发送」一并发出`),
        createElement('span', { className: 'grow', style: { flex: 1 } }),
        feedback ? createElement('span', { className: 'save-feedback' + (feedback.err ? ' err' : '') }, feedback.msg) : null),
      cites.map((c, ci) => createElement('div', {
        key: c.id, className: 'wed-chip', style: { '--cite-c': c.color } as React.CSSProperties,
      },
        createElement('div', { className: 'body' },
          createElement('div', { className: 'head' },
            createElement('span', { className: 'no' }, String(ci + 1)),
            createElement('span', { className: 'fileicon' }, '📄'),
            createElement('span', { className: 'fname', title: c.path }, c.name),
            c.lines && c.lines.length
              ? createElement('span', { className: 'lines-badge' }, '第 ' + formatLineRanges(c.lines) + ' 行')
              : null,
            createElement('button', {
              className: 'close', title: '移除引用',
              onClick: () => removeCite(c.id),
            }, '✕')),
          createElement('div', {
            className: 'snippet' + (c._expanded ? ' expanded' : ''),
            title: c.lines && c.lines.length ? '点击展开勾选的原文' : '点击展开全文',
            onClick: () => toggleCiteExpand(c.id),
          }, c._expanded ? (c.linesText || c.text) : c.snippet),
          createElement('input', {
            className: 'opinion-input', value: c.instruction, placeholder: '对此段的修改要求...',
            onChange: (ev: any) => editCiteInstruction(c.id, ev.target.value),
          })))),
      // 主消息输入 + 发送(原版输入区形态;发送走官方 session/prompt 接口)
      createElement('div', { className: 'wed-cites-send' },
        createElement('textarea', {
          className: 'wed-main-input', value: citeMain, rows: 2, ref: mainInputRef,
          placeholder: '✎ 主消息在这里输入（Enter 发送，Shift+Enter 换行）',
          onChange: (ev: any) => {
            setCiteMain(ev.target.value)
            try { localStorage.setItem('woody-cites-main', ev.target.value) } catch {}
          },
          onKeyDown: (ev: any) => {
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void sendCites() }
          },
        }),
        createElement('button', {
          className: 'wed-send-btn', disabled: sending || !citeMain.trim(),
          title: '发送（主消息 + 全部引用）', onClick: () => void sendCites(),
        }, sending ? '发送中…' : '发送')),
    ) : null,

    // 查看历史版本横幅
    viewingTS ? createElement('div', { className: 'wed-banner' },
      createElement('span', null, `正在查看 ${viewingTS} 的历史版本（只读）。点「恢复此版本」用其覆盖当前文件（当前内容会自动备份）。`),
    ) : null,

    // ── 编辑区(原版 editor-vditor:常驻容器 + 左缘大纲把手) ──
    createElement('div', { className: 'wed-vditor', onClick: onEditorAreaClick },
      isFullscreen ? null : createElement('button', {
        className: 'wed-outline-tab' + (outlineShow ? ' active' : ''),
        title: '大纲导航', onClick: (ev: any) => { ev.stopPropagation(); toggleOutline() },
      }, ICON_LIST),
      createElement('div', { ref: boxRef, style: { height: '100%' } }),
      // 勾选浮动条:状态显示 + 清空;「生成引用」按钮在上方工具栏(2026-10-10 用户要求放回原位)
      phase === 'ready' && !viewingTS && tickCount > 0 ? createElement('div', { className: 'wed-tickbar' + (dirty ? ' disabled' : '') },
        createElement('span', null, dirty ? '有未保存修改，保存后可引用勾选的行' : `已勾 ${tickCount} 行`),
        createElement('button', { className: 'ghost', disabled: dirty, onClick: clearTicks }, '清空'),
      ) : null,
    ),

    // 版本列表弹窗（纯 DOM，无原生对话框）
    showVersions ? createElement('div', {
      className: 'wed-mask',
      onClick: (ev: any) => { if (ev.target === ev.currentTarget) setShowVersions(false) },
      onKeyDown: (ev: any) => { if (ev.key === 'Escape') setShowVersions(false) },
    },
      createElement('div', { className: 'wed-box' },
        createElement('h3', null, '历史版本（保留最新 20 份）'),
        versions.length === 0
          ? createElement('div', { className: 'wed-vitem none' }, '（还没有历史版本）')
          : createElement('div', { className: 'wed-vlist' },
              versions.map((v) => createElement('div', {
                key: v.ts + v.file, className: 'wed-vitem', onClick: () => void previewVersion(v),
              }, v.formatted))),
        createElement('div', { className: 'wed-acts' },
          createElement('button', { onClick: () => setShowVersions(false) }, '关闭'))),
    ) : null,

    // 统计弹窗(照原版 stats-table;点遮罩关闭)
    showStats ? createElement('div', {
      className: 'wed-mask',
      onClick: (ev: any) => { if (ev.target === ev.currentTarget) setShowStats(false) },
      onKeyDown: (ev: any) => { if (ev.key === 'Escape') setShowStats(false) },
    },
      createElement('div', { className: 'wed-box', style: { width: 320 } },
        createElement('h3', null, '字数统计'),
        createElement('table', { className: 'wed-stats' },
          statsRows.map((r, i) => createElement('tr', { key: i },
            createElement('td', { className: 'lbl' }, r.label),
            createElement('td', { className: 'val' }, r.value),
            r.pct !== undefined ? createElement('td', { className: 'pct' }, r.pct) : createElement('td', null)))),
        createElement('div', { className: 'wed-acts' },
          createElement('button', { onClick: () => setShowStats(false) }, '关闭'))),
    ) : null,
  )
}

// ============================================================
// 正文组件:官方选中「编辑」模式时渲染
// ============================================================
function EditorBody(props: any): React.ReactElement {
  const resourceAddress = String(props?.resourceAddress ?? '')
  const [verdict, setVerdict] = useState<'loading' | 'yes' | 'no' | 'nopath' | 'error'>('loading')
  const [absPath, setAbsPath] = useState('')

  useEffect(() => {
    let alive = true
    if (!parseResourceAddress(resourceAddress)) { setVerdict('nopath'); return }
    // 一次 resolve 拿两样:绝对路径(session 虚拟地址换算)+ 是否剧本工作区
    void (async () => {
      try {
        const d = await api('/api/woody/files/resolve?addr=' + encodeURIComponent(resourceAddress))
        if (!alive) return
        if (d.isScriptWorkspace && d.absolutePath) { setAbsPath(String(d.absolutePath)); setVerdict('yes') }
        else setVerdict('no')
      } catch { if (alive) setVerdict('error') }
    })()
    return () => { alive = false }
  }, [resourceAddress])

  if (verdict === 'yes') return createElement(WoodyEditor, { filePath: absPath })
  if (verdict === 'loading') {
    return createElement('div', { className: 'wed-fill' },
      createElement('style', null, CSS),
      createElement('div', { className: 'wed-empty' }, '正在检查文件位置…'))
  }
  if (verdict === 'no') {
    return createElement('div', { className: 'wed-fill' },
      createElement('style', null, CSS),
      createElement('div', { className: 'wed-empty' },
        createElement('div', { className: 'big' }, '✎ 编辑模式仅在作品目录中可用'),
        createElement('div', null, '这个文件不在剧本作品的工作区里；要看内容请点上方模式菜单选「Markdown」。'),
        createElement('div', { className: 'path' }, resourceAddress)))
  }
  const reason = verdict === 'nopath' ? '无法识别文件地址' : 'WooDy 本地服务不可用（请确认 dsh-woody-studio 插件已启用并重启）'
  return createElement('div', { className: 'wed-fill' },
    createElement('style', null, CSS),
    createElement('div', { className: 'wed-empty' },
      createElement('div', { className: 'big' }, '✎ 编辑模式不可用'),
      createElement('div', null, reason),
      verdict === 'error' ? null : createElement('div', { className: 'path' }, resourceAddress)))
}

/** 注册「编辑」预览模式(documentPreviews 正规机制)+ 消息流引用卡片渲染 */
export function applyEditor(ctx: any): void {
  // 认领 sidebarRight(消息卡片文件名点击打开文件;官方 ui-chat 同款服务,取不到则退化为纯展示)
  try { sidebarRightSvc = (ctx.sidebarRight as { openResource: (addr: string) => void } | undefined) ?? null } catch { sidebarRightSvc = null }
  // 防御:客户端初始化异常不得影响整个界面加载
  try {
    // 消息卡片样式表:全局挂载,不随编辑器组件卸载而消失(编辑器没开时
    // 旧消息卡片也要有样式、原文也要藏住);ctx.effect 负责插件卸载时清理
    ctx.effect(() => {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const st = document.createElement('style')
      st.id = 'woody-msg-cites-css'
      st.textContent = MSG_CSS
      document.head.appendChild(st)
      return () => { try { st.remove() } catch {} }
    })
    installChatCiteRenderer()
  } catch (e: any) {
    ctx.logger?.error?.('[woody-studio] 消息流引用卡片渲染启动失败：' + String(e?.message ?? e))
  }
  // ── 「编辑」候选的动态注册(2026-10-11 用户要求):
  //    编辑模式只在「作品管理」的工作区里出现,其他工作区的 .md 回落到
  //    官方 Markdown 查看器。官方匹配按扩展名全局生效(无按路径条件注册),
  //    所以用「巡检当前会话 → 启停注册」实现:会话属于作品工作区才挂载候选。 ──
  let regDisposers: Array<() => void> | null = null
  let lastSessionKey = ''
  let lastInside: boolean | null = null
  const doRegister = (): void => {
    if (regDisposers) return
    try {
      // title 必须是函数(官方 candidate.title() 调用);priority:'plugin' → .md 默认进入
      const d1 = ctx.documentPreviews.register({
        id: VIEWER_ID,
        extensions: ['md'],
        priority: 'plugin',
        title: () => '编辑',
        loading: 'text-pages',
        wrap: false,
      })
      // 正文挂 keyed 槽位(key 必须等于模式 id——keyed 槽位铁律)
      const d2 = ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
        name: 'sidebar.right.tab.document',
        key: VIEWER_ID,
      }, EditorBody))
      regDisposers = [d1, d2].filter((x) => typeof x === 'function')
      ctx.logger?.info?.('[woody-studio] 「编辑」模式已注册（当前会话属于作品工作区）')
    } catch { regDisposers = null }
  }
  const doUnregister = (): void => {
    const ds = regDisposers
    regDisposers = null
    for (const d of ds ?? []) { try { d() } catch {} }
    if (ds) ctx.logger?.info?.('[woody-studio] 「编辑」模式已注销（当前会话不属于作品工作区）')
  }
  const refreshEditorReg = async (): Promise<void> => {
    let sid = ''
    let haveLs = true
    try { sid = String(JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId || '') } catch { haveLs = false }
    if (!haveLs) return                       // 无 localStorage(如自检环境):保持现状
    if (sid === lastSessionKey && lastInside !== null) return
    if (!sid) {
      lastSessionKey = sid
      if (lastInside !== false) { lastInside = false; doUnregister() }
      return
    }
    let inside: boolean
    try {
      const base = await apiBase()
      const d: any = await fetch(base + '/api/woody/files/context?sessionId=' + encodeURIComponent(sid)).then((x) => x.json())
      inside = d?.isScriptWorkspace === true
    } catch { return }                        // 服务不可达:保持现状,下轮再试
    lastSessionKey = sid
    if (inside === lastInside) return
    lastInside = inside
    if (inside) doRegister(); else doUnregister()
  }
  try {
    // 初始先注册(与既有行为一致),随后巡检按会话归属启停(1.5s)
    doRegister()
    const poll = globalThis.setInterval(() => { try { void refreshEditorReg() } catch {} }, 1500)
    ctx.effect(() => () => {
      try { globalThis.clearInterval(poll) } catch {}
      doUnregister()
    })
    ctx.logger?.info?.('[woody-studio] 编辑器组件就绪：「编辑」模式按会话动态注册（仅作品工作区出现）')
  } catch (e: any) {
    ctx.logger?.error?.('[woody-studio] 编辑器组件初始化失败：' + String(e?.message ?? e))
  }
}
