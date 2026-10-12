// ============================================================
// 模块三:静态资源服务(原 dsh-woody-editor 宿主逻辑)
// 路由:/vditor/<相对路径> → assets/vditor/<相对路径>
// ============================================================

import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 构建后此模块内联进 lib/index.js,import.meta.url 即 lib/index.js,
// 静态资源根 = 插件根/assets/(lib 的上一级)
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/** 静态资源路径钳制:/vditor/<rel> → assets/vditor/<rel>(拒绝 .. 与盘符;越界 404) */
function safeAssetPath(rel: string): string | null {
  const parts = rel.replaceAll('\\', '/').split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.includes('..') || parts.some((p) => /^[a-zA-Z]:$/.test(p))) return null
  const base = resolve(join(ASSETS_DIR, 'vditor'))
  const target = resolve(join(base, ...parts))
  if (!target.startsWith(base + sep)) return null
  return target
}

export function createAssetsModule() {
  /** 处理本模块路由;未匹配返回 false */
  function handle(pathname: string, res: any): boolean {
    if (!pathname.startsWith('/vditor/')) return false
    const target = safeAssetPath(pathname.slice('/vditor/'.length))
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404); res.end('not found')
      return true
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    createReadStream(target).pipe(res)
    return true
  }

  return { handle, assetsRoot: ASSETS_DIR }
}
