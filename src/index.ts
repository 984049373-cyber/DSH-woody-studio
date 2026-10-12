// ============================================================
// WooDy 剧本工作室 · 宿主端入口(三合一)
// 一个插件、一个本地服务(:43199 起,占用递增)、一个数据目录
// (~/.dsh/profiles/desktop/woody-studio/)。三个组件:
//   ① workspace 作品管理(/api/woody/config、/api/woody/workspace/*)
//   ② files    文件+版本数据(/api/woody/files/*)
//   ③ assets   Vditor 静态资源(/vditor/*)
//
// 【为什么自起 HTTP 服务而不是用 ctx.webServer】
// DSH Desktop(Electron)模式下,渲染进程的 fetch 走 IPC 桥,
// 插件注册的 WebRoute 在桌面窗口内不可达(实测 404)——
// 自起仅监听回环的服务是项目已验证的通路。
// ============================================================

import { createServer } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PLUGIN_DATA_DIR, BOOT_LOG } from './host/shared'
import { bootLog, rotateLogIfNeeded, makeHttpHelpers } from './host/shared'
import { createWorkspaceModule } from './host/workspace'
import { createFilesModule } from './host/files'
import { createAssetsModule } from './host/assets'
import { syncBundledSkills } from './host/skills'

// 自检用:写作 skill 同步(防覆盖规则的场景断言直接调它)
export { syncBundledSkills } from './host/skills'

export const name = 'woody-studio'

export function apply(ctx: any, input: any = {}): void {
  rotateLogIfNeeded()
  bootLog('apply() 被调用 —— 宿主端已加载(三合一)')
  // 防御:插件初始化中的任何异常都不得外抛(否则会阻断 DSH 启动)
  try {
    setup(ctx, input)
    bootLog('setup() 完成')
  } catch (e: any) {
    bootLog('setup() 抛错：' + String(e?.message ?? e))
    try { ctx.logger?.error?.('[woody-studio] 初始化失败（插件已禁用自身功能，不影响 DSH）：' + String(e?.message ?? e)) } catch {}
  }
}

function setup(ctx: any, input: any): void {
  const { json, readBody } = makeHttpHelpers()
  const workspace = createWorkspaceModule({ ctx, input, json, readBody })
  const files = createFilesModule({ ctx, input, json, readBody })
  const assets = createAssetsModule()
  // 写作 skill 随插件分发:核心 5 个同步到用户级 ~/.dsh/skills,
  // 防覆盖用户修改(规则见 host/skills.ts);失败只记日志,不影响启动
  syncBundledSkills({ log: (m) => { bootLog(m); try { ctx.logger?.info?.('[woody-studio] ' + m) } catch {} } })
  // 开机巡检:数据根下未登记的作品自动注册、缺 AGENTS.md 的自动补(幂等,异步)
  void workspace.ensureWorks()

  const handler = async (req: any, res: any): Promise<void> => {
    // CORS:界面运行在 file:// / dsh-app:// 源下,访问本机回环服务属跨源
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    let pathname = '/'
    let query: URLSearchParams = new URLSearchParams()
    try {
      const u = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      pathname = u.pathname
      query = u.searchParams
    } catch {}

    try {
      if (pathname === '/api/woody/ping') { json(res, 200, { ok: true, service: 'woody-studio' }); return }
      // 调试日志:客户端把关键生命周期事件(如编辑器初始化)落到宿主日志,
      // 用于排查「保存后页面刷新」这类只在真实环境出现的问题
      if (pathname === '/api/woody/debug/log') {
        bootLog('DEBUG ' + String(query.get('msg') ?? '').slice(0, 200))
        json(res, 200, { ok: true })
        return
      }
      if (await workspace.handle(pathname, req, res, currentPort)) return
      if (await files.handle(pathname, req, res, query)) return
      if (assets.handle(pathname, res)) return
      json(res, 404, { error: 'not found: ' + pathname })
    } catch (e: any) {
      bootLog('请求处理失败：' + String(e?.message ?? e))
      ctx.logger?.error?.('[woody-studio] 请求处理失败：' + String(e?.message ?? e))
      try { json(res, 500, { error: String(e?.message ?? e) }) } catch {}
    }
  }

  const server = createServer((req, res) => { void handler(req, res) })

  // 端口从 BASE_PORT 起尝试(占用则递增),客户端按同区间扫描;
  // input.port 可覆盖(自检用,与生产实例隔离)
  const basePort = Number(input?.port) || 43199
  let currentPort = basePort
  bootLog('准备监听 127.0.0.1:' + basePort + '（数据目录=' + PLUGIN_DATA_DIR + '，静态资源根=' + assets.assetsRoot + '）')
  const tryListen = (): void => {
    server.once('error', (err: any) => {
      bootLog('监听 ' + currentPort + ' 出错：' + String(err?.code ?? '') + ' ' + String(err?.message ?? err))
      if (err?.code === 'EADDRINUSE' && currentPort < basePort + 10 - 1) {
        currentPort += 1
        tryListen()
      } else {
        ctx.logger?.error?.('[woody-studio] 本地服务启动失败：' + String(err?.message ?? err))
      }
    })
    server.listen(currentPort, '127.0.0.1', () => {
      bootLog('监听成功：http://127.0.0.1:' + currentPort + '/api/woody/')
      ctx.logger?.info?.(`[woody-studio] 本地服务已就绪：http://127.0.0.1:${currentPort}/api/woody/`)
    })
  }
  tryListen()

  // 插件卸载时关闭服务
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { try { server.close() } catch {} })
    }
  } catch {}
}

// 避免未使用导入告警(homedir/join 供未来扩展;BOOT_LOG 已在 shared 内部使用)
void homedir; void join; void BOOT_LOG
