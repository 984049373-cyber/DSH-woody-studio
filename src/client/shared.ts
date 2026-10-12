// ============================================================
// WooDy 剧本工作室 · 浏览器端共享层
// 三合一后单一服务:作品/文件/版本/静态资源都在 :43199 起
// 的同一个本地服务上,客户端只扫一个区间。
// ============================================================

const BASE_PORT = 43199
const PORT_TRIES = 10

let cachedBase: string | null = null

export async function apiBase(): Promise<string> {
  if (cachedBase) return cachedBase
  for (let p = BASE_PORT; p < BASE_PORT + PORT_TRIES; p++) {
    const base = `http://127.0.0.1:${p}`
    try {
      const r = await fetch(base + '/api/woody/ping', { signal: AbortSignal.timeout(800) })
      if (!r.ok) continue
      const d = await r.json()
      if (d && d.ok) { cachedBase = base; return base }
    } catch { /* 该端口无服务,试下一个 */ }
  }
  throw new Error('WooDy 本地服务未就绪——请确认 dsh-woody-studio 插件已启用并重启 DSH')
}

export async function api(path: string, init?: RequestInit): Promise<any> {
  const base = await apiBase()
  const r = await fetch(base + path, init)
  let d: any = null
  try { d = await r.json() } catch {}
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status))
  return d
}

export const apiPost = (path: string, body: unknown): Promise<any> => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
