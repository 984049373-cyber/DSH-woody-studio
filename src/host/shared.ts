// ============================================================
// WooDy 剧本工作室 · 宿主端共享层
// 单一 HTTP 服务(:43199 起,被占用递增)、单一数据目录
// (~/.dsh/profiles/desktop/woody-studio/)。三模块共用:
//   workspace(作品管理) / files(文件+版本数据) / assets(Vditor 静态资源)
// ============================================================

import {
  readdirSync, mkdirSync, existsSync, readFileSync, writeFileSync,
  statSync, appendFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir as osHomedir } from 'node:os'

export const BASE_PORT = 43199
export const PORT_TRIES = 10
export const PROFILE_DIR = join(osHomedir(), '.dsh', 'profiles', 'desktop')
export const PLUGIN_DATA_DIR = join(PROFILE_DIR, 'woody-studio')
export const CONFIG_FILE = join(PLUGIN_DATA_DIR, 'config.json')
export const BOOT_LOG = join(PLUGIN_DATA_DIR, 'host.log')
export const LOG_MAX_BYTES = 256 * 1024

/** 剧本工作区五目录骨架(识别特征,files 模块守卫与 workspace 模块创建共用) */
export const SCRIPT_DIRS = ['大纲', '记忆', '剧本', '细纲', '作品资料']

// 旧三插件的数据目录(首次启动迁移 config 用)
const LEGACY_CONFIGS = [
  join(PROFILE_DIR, 'woody-workspace', 'config.json'),
]

export function ensureDataDir(): void {
  try { if (!existsSync(PLUGIN_DATA_DIR)) mkdirSync(PLUGIN_DATA_DIR, { recursive: true }) } catch {}
}

export function rotateLogIfNeeded(): void {
  try {
    if (existsSync(BOOT_LOG) && statSync(BOOT_LOG).size > LOG_MAX_BYTES) rmSync(BOOT_LOG, { force: true })
  } catch {}
}

export function bootLog(message: string): void {
  try {
    ensureDataDir()
    appendFileSync(BOOT_LOG, new Date().toISOString() + ' ' + message + '\n')
  } catch {}
}

export interface WoodyConfig { dataRoot: string; userName?: string }

export function loadConfig(): Partial<WoodyConfig> {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {}
  // 旧 woody-workspace 的 dataRoot 配置迁移(首次)
  for (const legacy of LEGACY_CONFIGS) {
    try {
      if (existsSync(legacy)) {
        const parsed = JSON.parse(readFileSync(legacy, 'utf-8'))
        saveConfig(parsed)
        bootLog('已迁移旧配置 ' + legacy)
        return parsed
      }
    } catch {}
  }
  return {}
}

export function saveConfig(patch: Partial<WoodyConfig>): void {
  const next = { ...loadConfig(), ...patch }
  try {
    ensureDataDir()
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8')
  } catch {}
}

export function normPath(p: unknown): string {
  return String(p || '').toLowerCase().replaceAll('/', '\\').replace(/\\+$/, '')
}

/** 自然排序:让「第2集」排在「第10集」之前(原版 naturalSort 等价实现) */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const pa = String(a).match(re) ?? []
  const pb = String(b).match(re) ?? []
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny
    } else if (x !== y) {
      return x.localeCompare(y, 'zh-CN')
    }
  }
  return 0
}

export interface WorkspaceLike {
  id?: string
  path?: string
  title?: string
  sessionIds?: string[]
  setTitle?: (title: string) => Promise<void>
}

/** workspaceRegistry 可选增强:任何异常都不影响核心目录读写 */
export function makeSafeRegistry(ctx: any) {
  const safeRegistryList = async (): Promise<WorkspaceLike[]> => {
    try {
      const reg: any = ctx.get?.('workspaceRegistry')
      if (!reg || typeof reg.list !== 'function') return []
      const r = reg.list()
      if (Array.isArray(r)) return r
      if (r && typeof r.then === 'function') return await r
      return []
    } catch { return [] }
  }
  const safeRegistryCall = async (fn: string, ...args: any[]): Promise<any> => {
    try {
      const reg: any = ctx.get?.('workspaceRegistry')
      if (!reg || typeof reg[fn] !== 'function') return undefined
      const r = reg[fn](...args)
      if (r && typeof r.then === 'function') return await r
      return r
    } catch { return undefined }
  }
  return { safeRegistryList, safeRegistryCall }
}

/** 目录是否具备剧本工作区的五目录骨架 */
export function isScriptWorkspaceDir(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
    return SCRIPT_DIRS.every((d) => {
      const sub = join(dir, d)
      return existsSync(sub) && statSync(sub).isDirectory()
    })
  } catch { return false }
}

/**
 * 官方文件地址解析(照官方 parseFileAddress 移植,源码实证):
 *   dsh-resource://file/session/<会话id>/<相对路径> → 会话文件(真实路径=工作区+相对)
 *   dsh-resource://file/absolute/<绝对路径>          → 绝对路径文件
 */
const FILE_ADDR_PREFIX = 'dsh-resource://file/'
export function parseFileAddress(addr: string): { scope: string; sessionId?: string; path: string } | null {
  try {
    if (!addr.startsWith(FILE_ADDR_PREFIX)) return null
    const end = addr.search(/[?#]/)
    const body = addr.slice(FILE_ADDR_PREFIX.length, end === -1 ? undefined : end)
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

/** HTTP 辅助:JSON 响应与请求体读取 */
export function makeHttpHelpers() {
  const json = (res: any, code: number, data: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  const readBody = (req: any): Promise<any> => new Promise((resolveBody) => {
    let body = ''
    req.on('data', (c: string) => { body += c })
    req.on('end', () => { try { resolveBody(JSON.parse(body || '{}')) } catch { resolveBody({}) } })
  })
  return { json, readBody }
}

/** 遗留:删除空目录辅助(files 删除场景暂不用,readdirSync 引用保底) */
export function listDir(dir: string): string[] {
  try { return existsSync(dir) ? readdirSync(dir) : [] } catch { return [] }
}
