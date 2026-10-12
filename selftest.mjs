// WooDy 剧本工作室(三合一)· 端到端自检(提交前强制运行)
// 断言合并自三个原插件(作品管理/文件管理/编辑器),一处不缩水:
//   宿主端:单服务真实 HTTP——作品全链路 + 文件/版本全链路 + 静态资源 + 地址解析
//   浏览器端:DSH 模块契约——三组件注册 + documentPreviews(优先级 plugin)+ 地址解析
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
let failed = 0
const ok = (m) => console.log('  ✔ ' + m)
const bad = (m) => { failed++; console.log('  ✖ ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TEST_PORT = 43999
const SCRIPT_DIRS = ['大纲', '记忆', '剧本', '细纲', '作品资料']

// 测试环境:作品管理数据根 + 一个剧本工作区 + 一个普通工作区
const testRoot = mkdtempSync(join(tmpdir(), 'woody-studio-selftest-'))
const scriptWork = join(testRoot, '剧本作品')
const plainWork = join(testRoot, '普通目录')
mkdirSync(scriptWork, { recursive: true })
// 迁移场景预置:数据根下一个未注册、无 AGENTS.md 的旧作品目录(开机巡检应纳管)
const legacyDir = join(testRoot, '作品根', '旧作品')
for (const d of SCRIPT_DIRS) mkdirSync(join(legacyDir, d), { recursive: true })
writeFileSync(join(legacyDir, '待定.md'), '# 旧作品\n', 'utf-8')
mkdirSync(plainWork, { recursive: true })
for (const d of SCRIPT_DIRS) mkdirSync(join(scriptWork, d), { recursive: true })
writeFileSync(join(scriptWork, '剧本', '第10集.md'), '# 第10集\n', 'utf-8')
writeFileSync(join(scriptWork, '剧本', '第2集.md'), '# 第2集\n', 'utf-8')
writeFileSync(join(scriptWork, '剧本', '忽略.txt'), 'x', 'utf-8')
writeFileSync(join(plainWork, '普通.md'), '# 普通\n', 'utf-8')

const TEST_NAME = '自检作品'
const RENAME_TO = '自检作品改'

// ── 宿主端 + HTTP 端到端 ──
console.log('宿主端 lib/index.js(三合一,含真实 HTTP 请求):')
let dispose = null
try {
  const m = await import(pathToFileURL('./lib/index.js').href)
  if (typeof m.apply !== 'function') bad('apply 不是函数')
  else ok('apply 导出正常(name=' + m.name + ')')

  const logs = []
  const registryCalls = []
  // 统一注册表 mock:预置剧本/普通两个工作区(文件组件判定用),
  // create/delete/setTitle 反映真实状态(作品组件全链路用)
  const records = [
    { id: 'ws-1', path: scriptWork, title: '剧本作品', sessionIds: ['s-script'] },
    { id: 'ws-2', path: plainWork, title: '普通目录', sessionIds: ['s-plain'] },
  ]
  const baseCtx = {
    logger: { info: (s) => logs.push('info: ' + s), error: (s) => logs.push('error: ' + s) },
    get: (key) => (key === 'workspaceRegistry' ? {
      list: () => records.map((r) => ({ ...r })),
      resolveByPath: async (p) => {
        if (!existsSync(p)) return undefined
        const rec = records.find((r) => r.path.toLowerCase() === String(p).toLowerCase())
        if (!rec) return undefined
        return {
          id: rec.id, path: rec.path, sessionIds: rec.sessionIds,
          get title() { return rec.title },
          setTitle: async (t) => { registryCalls.push('setTitle:' + t); rec.title = t },
        }
      },
      create: async (p, t) => {
        registryCalls.push('create:' + p)
        const rec = { id: 'ws-' + records.length, path: p, title: t ?? p.split('\\').pop() ?? '', sessionIds: [] }
        records.push(rec)
        return rec
      },
      delete: async (id) => {
        registryCalls.push('delete:' + id)
        const i = records.findIndex((r) => r.id === id)
        if (i >= 0) records.splice(i, 1)
      },
      archiveSession: async () => {},
    } : undefined),
    effect: (fn) => { dispose = fn() },
  }
  const ctx = new Proxy(baseCtx, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'then' || prop === 'toJSON' || typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  const BOOT_INPUT = { dataRoot: join(testRoot, '作品根'), port: TEST_PORT, userName: '测试用户' }
  m.apply(ctx, BOOT_INPUT)

  const base = `http://127.0.0.1:${TEST_PORT}`
  let ready = false
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(base + '/api/woody/ping'); if (r.ok) { ready = true; break } } catch {}
    await sleep(100)
  }
  if (!ready) { bad('本地服务未就绪。日志：' + logs.join(' | ')); throw new Error('未就绪') }
  let d0 = await (await fetch(base + '/api/woody/ping')).json()
  if (d0.service === 'woody-studio') ok('ping 返回 woody-studio(单服务三合一)')
  else bad('ping 服务名异常:' + JSON.stringify(d0))

  // ══ 组件①:作品管理 ══
  console.log('── 组件① 作品管理 ──')
  let r = await fetch(base + '/api/woody/workspace/list')
  let d = await r.json()
  if (r.status === 200 && Array.isArray(d.items)) ok('list 返回 200(注册表形状异常也不崩)')
  else bad('list 异常:' + r.status + ' ' + JSON.stringify(d))

  r = await fetch(base + '/api/woody/workspace/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME }),
  })
  d = await r.json()
  if (r.status === 200) ok('create 返回 200(path=' + d.path + ')')
  else bad('create 失败:' + r.status + ' ' + JSON.stringify(d))
  const wdir = join(testRoot, '作品根', TEST_NAME)
  const missing = SCRIPT_DIRS.filter((x) => !existsSync(join(wdir, x)))
  if (missing.length === 0) ok('磁盘骨架齐全:' + SCRIPT_DIRS.join('/'))
  else bad('缺少骨架目录:' + missing.join(','))
  if (existsSync(join(wdir, '待定.md'))) ok('待定.md 已生成')
  else bad('待定.md 缺失')

  // AGENTS.md 系统提示词:随新建作品自动生成,占位符按配置填充,无模板记号残留
  const agentsPath = join(wdir, 'AGENTS.md')
  if (existsSync(agentsPath)) {
    const ag = readFileSync(agentsPath, 'utf-8')
    const uname = String(BOOT_INPUT.userName || '')
    const userOk = uname ? ag.includes('当前服务用户：**' + uname + '**') : !ag.includes('当前服务用户：')
    if (ag.includes('行号引用规则') && ag.includes('woody-writing-index') && userOk && !ag.includes('{{')) {
      ok('新建作品自带 AGENTS.md(引用规则+skill 索引在,占位符已按配置填充,无记号残留)')
    } else bad('AGENTS.md 内容异常:' + JSON.stringify({ 有引用规则: ag.includes('行号引用规则'), 用户名正确: userOk, 有残留记号: ag.includes('{{') }))
  } else bad('新建作品未生成 AGENTS.md')

  // 开机巡检:迁移场景(数据根下未注册、无 AGENTS.md 的旧目录)自动登记并补提示词
  const legacyAgents = join(legacyDir, 'AGENTS.md')
  let legacyReady = existsSync(legacyAgents)
  for (let i = 0; i < 30 && !legacyReady; i++) { await sleep(100); legacyReady = existsSync(legacyAgents) }
  if (legacyReady) {
    const la = readFileSync(legacyAgents, 'utf-8')
    r = await fetch(base + '/api/woody/workspace/list')
    d = await r.json()
    const li = (d.items || []).find((x) => x.dirName === '旧作品')
    if (la.includes('当前服务作品：**旧作品**') && la.includes('当前服务用户：**测试用户**') && li && li.workspaceId) {
      ok('开机巡检:旧目录自动登记 + 补生成 AGENTS.md(作品名/用户名占位符已填)')
    } else bad('开机巡检异常:' + JSON.stringify({ 作品名: la.includes('当前服务作品：**旧作品**'), 用户名: la.includes('当前服务用户：**测试用户**'), 已注册: !!(li && li.workspaceId) }))
  } else bad('开机巡检未给旧目录补 AGENTS.md')

  // 作品资料天生 3 个 MD(照原版模板)
  const info = join(wdir, '作品资料', '作品信息.md')
  const world = join(wdir, '作品资料', '世界观.md')
  const roles = join(wdir, '作品资料', '角色.md')
  if (existsSync(info) && existsSync(world) && existsSync(roles)) {
    const infoText = readFileSync(info, 'utf-8')
    if (infoText.includes(`**书名**：${TEST_NAME}`) && infoText.includes('市场定位') && infoText.includes('最后修改')) {
      ok('作品资料 3 个 MD 已生成(作品信息含书名与模板字段)')
    } else bad('作品信息模板内容异常:' + infoText.slice(0, 80))
  } else bad('作品资料 3 个 MD 缺失')

  r = await fetch(base + '/api/woody/workspace/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME }),
  })
  if (r.status === 409) ok('重名创建被拒(409)')
  else bad('重名创建未拒:' + r.status)
  r = await fetch(base + '/api/woody/workspace/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '../evil' }),
  })
  if (r.status === 400) ok('非法作品名被拒(400,防路径逃逸)')
  else bad('非法名未拒:' + r.status)

  // 重命名:官方语义 = 只改标题(目录不动 → 历史会话完整保留)
  r = await fetch(base + '/api/woody/workspace/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: wdir, newName: RENAME_TO }),
  })
  d = await r.json()
  if (r.status === 200 && d.mode === 'title') ok('rename 走官方语义(mode=title,只改标题)')
  else bad('rename 异常:' + r.status + ' ' + JSON.stringify(d))
  if (existsSync(wdir) && !existsSync(join(testRoot, '作品根', RENAME_TO))) ok('重命名后目录未变(历史会话保留)')
  else bad('重命名改了目录(会丢会话归属)')
  if (registryCalls.some((c) => c === 'setTitle:' + RENAME_TO)) ok('注册表收到 setTitle(新标题) 调用')
  else bad('注册表未收到 setTitle 调用')

  r = await fetch(base + '/api/woody/workspace/list')
  d = await r.json()
  const renamedItem = (d.items || []).find((x) => x.path === wdir)
  if (renamedItem && renamedItem.name === RENAME_TO && renamedItem.dirName === TEST_NAME) ok('列表显示新标题、目录名保持不变')
  else bad('列表显示异常:' + JSON.stringify(renamedItem))

  r = await fetch(base + '/api/woody/workspace/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME }),
  })
  d = await r.json()
  if (r.status === 200 && !existsSync(wdir)) ok('delete 生效(目录已删除)')
  else bad('delete 异常:' + r.status + ' ' + JSON.stringify(d))

  // 数据存放位置
  r = await fetch(base + '/api/woody/config')
  d = await r.json()
  if (r.status === 200 && String(d.dataRoot || '').includes('作品根')) ok('config 读取当前数据根')
  else bad('config 异常:' + JSON.stringify(d))

  // ══ 组件②:文件 + 版本数据 ══
  console.log('── 组件② 文件+版本数据 ──')
  r = await fetch(base + '/api/woody/files/context?sessionId=s-script')
  d = await r.json()
  if (d.isScriptWorkspace === true && d.workName === '剧本作品') ok('context:剧本工作区会话 → true')
  else bad('context 异常(剧本):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/context?sessionId=s-plain')
  d = await r.json()
  if (d.isScriptWorkspace === false) ok('context:普通工作区会话 → false')
  else bad('context 异常(普通):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/context?sessionId=unknown')
  d = await r.json()
  if (d.isScriptWorkspace === false) ok('context:未知会话 → false')
  else bad('context 异常(未知):' + JSON.stringify(d))

  r = await fetch(base + '/api/woody/files/is-script?dir=' + encodeURIComponent(scriptWork))
  d = await r.json()
  if (d.isScriptWorkspace === true) ok('is-script:剧本工作区目录 → true')
  else bad('is-script 异常(剧本):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/is-script?dir=' + encodeURIComponent(join(scriptWork, '剧本')))
  d = await r.json()
  if (d.isScriptWorkspace === true) ok('is-script:工作区内子目录 → true')
  else bad('is-script 异常(子目录):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/is-script?dir=' + encodeURIComponent(plainWork))
  d = await r.json()
  if (d.isScriptWorkspace === false) ok('is-script:普通目录 → false')
  else bad('is-script 异常(普通):' + JSON.stringify(d))

  r = await fetch(base + '/api/woody/files/list?dir=' + encodeURIComponent(join(scriptWork, '剧本')))
  d = await r.json()
  const names = (d.items || []).map((i) => i.name)
  if (names.length === 2 && names[0] === '第2集.md' && names[1] === '第10集.md') ok('文件树:自然排序正确 + 过滤 .txt')
  else bad('文件树异常:' + JSON.stringify(names))

  r = await fetch(base + '/api/woody/files/list?dir=' + encodeURIComponent(plainWork))
  if (r.status === 403) ok('路径安全:剧本工作区之外被拒(403)')
  else bad('路径安全失效:' + r.status)

  r = await fetch(base + '/api/woody/files/mkdir', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: join(scriptWork, '剧本'), name: '新文件夹' }),
  })
  if (r.status === 200 && existsSync(join(scriptWork, '剧本', '新文件夹'))) ok('新建文件夹生效')
  else bad('新建文件夹失败:' + r.status)

  r = await fetch(base + '/api/woody/files/write', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: join(scriptWork, '细纲'), name: '分集细纲.md', content: '# 细纲\n' }),
  })
  if (r.status === 200 && readFileSync(join(scriptWork, '细纲', '分集细纲.md'), 'utf-8').includes('细纲')) ok('新建文件生效')
  else bad('新建文件失败:' + r.status)

  r = await fetch(base + '/api/woody/files/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(scriptWork, '细纲', '分集细纲.md'), newName: '细纲.md' }),
  })
  if (r.status === 200 && existsSync(join(scriptWork, '细纲', '细纲.md'))) ok('重命名生效')
  else bad('重命名失败:' + r.status)

  r = await fetch(base + '/api/woody/files/read?path=' + encodeURIComponent(join(scriptWork, '剧本', '第2集.md')))
  d = await r.json()
  if (r.status === 200 && String(d.content).includes('第2集')) ok('读取文件生效')
  else bad('读取文件失败:' + r.status + ' ' + JSON.stringify(d))

  const payload = Buffer.from('# 上传的参考\n', 'utf-8').toString('base64')
  r = await fetch(base + '/api/woody/files/upload', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: join(scriptWork, '作品资料'), name: '参考.md', contentBase64: payload }),
  })
  if (r.status === 200 && readFileSync(join(scriptWork, '作品资料', '参考.md'), 'utf-8').includes('上传的参考')) ok('上传生效')
  else bad('上传失败:' + r.status)

  // 正式保存 + 快照
  const xlPath = join(scriptWork, '细纲', '细纲.md')
  r = await fetch(base + '/api/woody/files/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: xlPath, content: '# 细纲 v1\n' }),
  })
  d = await r.json()
  if (r.status === 200 && d.versionSaved === true && d.versionCount === 1) ok('保存:首次覆盖写入并生成 1 份快照')
  else bad('保存异常:' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: xlPath, content: '# 细纲 v1\n' }),
  })
  d = await r.json()
  if (d.versionSaved === false && d.versionCount === 1) ok('保存:内容未变不重复存快照')
  else bad('重复快照异常:' + JSON.stringify(d))

  await fetch(base + '/api/woody/files/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: xlPath, content: '# 细纲 v2\n' }),
  })
  r = await fetch(base + '/api/woody/files/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: xlPath, content: '# 细纲 v3\n' }),
  })
  d = await r.json()
  if (d.versionCount === 3) ok('同秒连存:两份快照都在,无覆盖(现共 3 份)')
  else bad('同秒防撞异常:count=' + d.versionCount)

  r = await fetch(base + '/api/woody/files/versions?path=' + encodeURIComponent(xlPath))
  d = await r.json()
  if (Array.isArray(d) && d.length === 3 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d[0].formatted)) ok('版本列表:3 份、新→旧、时间已格式化')
  else bad('版本列表异常:' + JSON.stringify(d))

  // 恢复:模拟外部修改(不走 save 直接改磁盘)→ 恢复时当前内容被自动备份
  writeFileSync(xlPath, '# 细纲 被外部改过\n', 'utf-8')
  r = await fetch(base + '/api/woody/files/versions?path=' + encodeURIComponent(xlPath))
  d = await r.json()
  const oldestTS = d[d.length - 1].ts
  r = await fetch(base + '/api/woody/files/restore-version', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: xlPath, ts: oldestTS }),
  })
  d = await r.json()
  if (r.status === 200 && String(d.content).includes('v1') && d.versionCount === 4) ok('恢复:内容回到所选版本 + 外部修改已自动备份(共 4 份)')
  else bad('恢复异常:' + JSON.stringify(d))

  for (let i = 4; i <= 25; i++) {
    await fetch(base + '/api/woody/files/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: xlPath, content: `# 细纲 v${i}\n` }),
    })
  }
  r = await fetch(base + '/api/woody/files/versions?path=' + encodeURIComponent(xlPath))
  d = await r.json()
  if (d.length === 20) ok('修剪:始终只保留 20 份(现 20 份)')
  else bad('修剪异常:' + d.length + ' 份')

  r = await fetch(base + '/api/woody/files/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(plainWork, '普通.md'), content: 'x' }),
  })
  if (r.status === 403) ok('保存越界被拒(403,非剧本工作区)')
  else bad('保存越界未拒:' + r.status)

  // 地址解析(编辑组件的生命线)
  const enc = (s) => encodeURIComponent(s)
  r = await fetch(base + '/api/woody/files/resolve?addr=' + encodeURIComponent(
    `dsh-resource://file/session/s-script/${enc('大纲')}/${enc('待定.md')}`))
  d = await r.json()
  const expectAbs = join(scriptWork, '大纲', '待定.md').replaceAll('\\', '/').toLowerCase()
  const gotAbs = String(d.absolutePath || '').replaceAll('\\', '/').toLowerCase()
  if (r.status === 200 && d.isScriptWorkspace === true && gotAbs === expectAbs) ok('resolve:会话虚拟地址 → 正确绝对路径(剧本工作区)')
  else bad('resolve 异常(session/剧本):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/resolve?addr=' + encodeURIComponent(
    `dsh-resource://file/session/s-plain/${enc('普通.md')}`))
  d = await r.json()
  if (d.isScriptWorkspace === false && !d.absolutePath) ok('resolve:普通工作区会话 → 不可编辑')
  else bad('resolve 异常(session/普通):' + JSON.stringify(d))
  const absAddr = 'dsh-resource://file/absolute/' + join(scriptWork, '细纲')
    .replaceAll('\\', '/').split('/').map(enc).join('/') + '/' + enc('细纲.md')
  r = await fetch(base + '/api/woody/files/resolve?addr=' + encodeURIComponent(absAddr))
  d = await r.json()
  if (d.isScriptWorkspace === true && String(d.absolutePath || '').replaceAll('\\', '/').toLowerCase().endsWith('细纲/细纲.md')) ok('resolve:absolute 地址 → 剧本工作区 + 绝对路径')
  else bad('resolve 异常(absolute):' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/resolve?addr=' + encodeURIComponent('http://别的地址'))
  d = await r.json()
  if (d.isScriptWorkspace === false) ok('resolve:非法地址 → 不可编辑')
  else bad('resolve 未拒非法地址')

  // 删除 .md 时快照一并清理
  r = await fetch(base + '/api/woody/files/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [xlPath] }),
  })
  const vd = join(scriptWork, '细纲', '.versions')
  const leftover = existsSync(vd) ? readdirSync(vd).filter((f) => f.startsWith('细纲.')) : []
  if (leftover.length === 0 && !existsSync(xlPath)) ok('删除文件:快照一并清理干净')
  else bad('删除后快照残留:' + leftover.join(', '))

  r = await fetch(base + '/api/woody/files/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [join(scriptWork, '剧本', '新文件夹'), join(scriptWork, '作品资料', '参考.md')] }),
  })
  d = await r.json()
  if ((d.deleted || []).length === 2) ok('批量删除生效(2 项)')
  else bad('批量删除异常:' + JSON.stringify(d))
  r = await fetch(base + '/api/woody/files/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [join(plainWork, '普通.md')] }),
  })
  d = await r.json()
  if ((d.failed || []).length === 1 && existsSync(join(plainWork, '普通.md'))) ok('越界删除被拒(文件未受影响)')
  else bad('越界删除未拒:' + JSON.stringify(d))

  // ══ 组件③:静态资源 ══
  console.log('── 组件③ 编辑器静态资源 ──')
  const tmpAsset = join('.', 'assets', 'vditor', 'test-asset.css')
  writeFileSync(tmpAsset, 'body{}', 'utf-8')
  r = await fetch(base + '/vditor/test-asset.css')
  if (r.status === 200 && (await r.text()) === 'body{}') ok('静态资源可下发(/vditor/*)')
  else bad('静态资源异常:HTTP ' + r.status)
  rmSync(tmpAsset, { force: true })
  r = await fetch(base + '/vditor/dist/index.min.js')
  const vdJs = await r.text()
  if (r.status === 200 && vdJs.length > 100000) ok('Vditor 主脚本可下发(' + Math.round(vdJs.length / 1024) + 'KB)')
  else bad('Vditor 主脚本异常:HTTP ' + r.status + ' len=' + vdJs.length)
  r = await fetch(base + '/vditor/dist/css/content-theme/dark.css')
  if (r.status === 200) ok('深色内容主题可下发(setTheme 依赖,防黑字黑底)')
  else bad('深色内容主题 404')
  r = await fetch(base + '/vditor/' + encodeURIComponent('..') + '/package.json')
  if (r.status === 404) ok('越界路径被拒(.. 不可逃出资源目录)')
  else bad('越界路径未拒:' + r.status)

  // ══ 通用 ══
  r = await fetch(base + '/api/woody/nope')
  const ct = r.headers.get('content-type') || ''
  if (r.status === 404 && ct.includes('json')) ok('未知路径返回 JSON 404')
  else bad('未知路径响应异常:' + r.status + ' ' + ct)

  const errs = logs.filter((x) => x.startsWith('error:'))
  if (errs.length === 0) ok('宿主端无错误日志')
  else bad('宿主端错误日志:' + errs.join(' | '))

  if (typeof dispose === 'function') { try { dispose() } catch {} }
  await sleep(150)
} catch (e) {
  bad('宿主端端到端失败:' + e.message)
}

// ── 模块④:写作 skill 同步(随插件分发,防覆盖规则) ──
console.log('── 模块④ 写作 skill 同步 ──')
try {
  const m2 = await import(pathToFileURL('./lib/index.js').href)
  const sync = m2.syncBundledSkills
  if (typeof sync !== 'function') {
    bad('未导出 syncBundledSkills')
  } else {
    const srcDir = join('.', 'skills')
    const countFiles = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, x) => n + (x.isDirectory() ? countFiles(join(dir, x.name)) : 1), 0)
    const coreFiles = countFiles(srcDir)
    const t1 = join(testRoot, 'skills-同步')
    const man1 = join(testRoot, 'skills-manifest.json')
    // 场景1:全新安装
    const r1 = sync({ sourceDir: srcDir, targetRoot: t1, manifestPath: man1 })
    const skm = join(t1, 'screenplay-format-spec', 'SKILL.md')
    if (r1.installed.length === coreFiles && r1.updated.length === 0 && r1.skipped.length === 0 && existsSync(skm)) ok('skill 同步:全新安装(5 个 skill 共 ' + coreFiles + ' 个文件全部就位)')
    else bad('skill 同步新装异常:' + JSON.stringify({ installed: r1.installed.length, expect: coreFiles, updated: r1.updated.length, skipped: r1.skipped.length }))
    // 场景2:内容一致 → 不做无谓动作
    const r2 = sync({ sourceDir: srcDir, targetRoot: t1, manifestPath: man1 })
    if (r2.installed.length === 0 && r2.updated.length === 0 && r2.skipped.length === 0) ok('skill 同步:内容一致时不做无谓动作')
    else bad('skill 同步重复执行异常:' + JSON.stringify(r2))
    // 场景3:插件更新(目标==上次发布版) → 覆盖为新版
    const probeRel = 'de-ai-flavor/SKILL.md'
    const probe = join(t1, ...probeRel.split('/'))
    const realContent = readFileSync(probe, 'utf-8')
    writeFileSync(probe, '# 旧版内容\n', 'utf-8')
    const crypto = await import('node:crypto')
    const oldHash = crypto.createHash('sha256').update(Buffer.from('# 旧版内容\n', 'utf-8')).digest('hex')
    const manOld = JSON.parse(readFileSync(man1, 'utf-8'))
    manOld[probeRel] = oldHash
    writeFileSync(man1, JSON.stringify(manOld), 'utf-8')
    const r3 = sync({ sourceDir: srcDir, targetRoot: t1, manifestPath: man1 })
    if (r3.updated.includes(probeRel) && readFileSync(probe, 'utf-8') === realContent) ok('skill 同步:插件更新覆盖旧版(目标==上次发布版)')
    else bad('skill 同步更新异常:' + JSON.stringify(r3))
    // 场景4:用户改过(目标 ≠ 上次发布版) → 保护跳过
    writeFileSync(probe, '# 用户手改版本\n', 'utf-8')
    const r4 = sync({ sourceDir: srcDir, targetRoot: t1, manifestPath: man1 })
    if (r4.skipped.includes(probeRel) && readFileSync(probe, 'utf-8') === '# 用户手改版本\n') ok('skill 同步:用户修改被保护(绝不覆盖)')
    else bad('skill 同步保护异常:' + JSON.stringify(r4))
    // 场景5:随包目录缺失 → 安全空转
    const r5 = sync({ sourceDir: join(testRoot, '不存在的skill目录'), targetRoot: t1, manifestPath: man1 })
    if (r5.installed.length === 0 && r5.updated.length === 0 && r5.skipped.length === 0 && r5.errors.length === 0) ok('skill 同步:随包目录缺失时安全跳过')
    else bad('skill 同步缺目录异常:' + JSON.stringify(r5))
  }
} catch (e) {
  bad('skill 同步测试失败:' + e.message)
}

// ── 浏览器端(DSH 模块契约)──
console.log('浏览器端 lib/client.js(三组件注册):')
try {
  const code = readFileSync('./lib/client.js', 'utf-8')
  if (!code.includes('__ModuleLoader__.load(')) { bad('缺少 __ModuleLoader__ 包装'); throw new Error('包装缺失') }
  ok('产物含 __ModuleLoader__.load 包装')

  // 产物完整性:浏览器端关键链路必须真的在包里(2026-10-07 事故教训:
  // doUpload 少写一对调用括号,打包器把上传函数体整体按死代码删除——
  // 自检全绿但上传静默失效且 busy 永久卡死。字符串断言=最便宜的防回归闸门)
  for (const [marker, name] of [
    ['files/upload', '上传接口调用'],
    ['readAsDataURL', '文件读取编码'],
    ['已上传', '上传完成反馈'],
    ['woody-msg-cites-css', '消息卡片全局样式表'],
    ['data-ds-dark-theme', '明暗探测标记(官方深色 body 属性)'],
    ['dsw-static-deepseek-450', '主题不变品牌蓝(配白字的底色)'],
    ['wed-gutter', '行号栏 DOM(勾选引用 v4)'],
    ['生成引用', '勾选生成引用按钮'],
    ['位置[', '载荷 v4 行号格式标记'],
  ]) {
    if (code.includes(marker)) ok('产物含 ' + name + '("' + marker + '")')
    else bad('产物缺失 ' + name + '("' + marker + '")——疑似被死代码删除,查调用括号')
  }

  let captured = null
  const fakeWindow = {
    __ModuleLoader__: { load: (x) => { captured = x } },
    addEventListener: () => {},
  }
  const fakeRequire = (id) => {
    if (id === 'react') return require('react')
    throw new Error('产物请求了未预期的模块:' + id)
  }
  new Function('window', 'localStorage', 'fetch', code)(fakeWindow, fakeWindow.localStorage, async () => { throw new Error('不应发请求') })
  if (!captured) { bad('未调用 __ModuleLoader__.load'); throw new Error('未注册') }
  ok('注册 id=' + captured.id)
  const exportsObj = captured.factory(fakeRequire)
  ok('factory 执行无异常(导出键:' + Object.keys(exportsObj).join(', ') + ')')

  const declared = Array.isArray(exportsObj.inject) ? exportsObj.inject : []
  if (declared.includes('slots') && declared.includes('documentPreviews')) ok('inject 已声明 slots + documentPreviews')
  else bad('inject 声明缺失:' + JSON.stringify(declared))

  // 严格 mock:访问未声明的服务属性会抛错(漏声明 inject 在此暴露)
  const previewDefs = []
  const slotRegs = []
  const disposers = []
  const registered = []
  const baseCtx2 = {
    logger: { info: () => {}, error: (e) => { throw new Error('客户端错误:' + e) } },
    effect: (fn) => { disposers.push(fn()) },
    documentPreviews: {
      register: (def) => { previewDefs.push(def); return () => { previewDefs.splice(previewDefs.indexOf(def), 1) } },
    },
    slots: {
      inject: (name, fn) => { registered.push(name); fn() },
      register: (opts) => { slotRegs.push(opts); registered.push('register:' + (opts.key || opts.id || opts.name)) },
    },
  }
  const ctx2 = new Proxy(baseCtx2, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'then' || prop === 'toJSON' || typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  exportsObj.apply(ctx2)

  // 组件①:侧栏 + 主面板
  if (registered.includes('sidebar.panellist')) ok('① 注册了侧栏项(作品管理)')
  else bad('① 未注册侧栏项')
  if (registered.includes('main')) ok('① 注册了主面板')
  else bad('① 未注册主面板')

  // 组件②:文件面板工具栏
  if (registered.includes('sidebar.right.tab.files.actions')) ok('② 注册进原生「工作区文件」工具栏')
  else bad('② 未注册 sidebar.right.tab.files.actions')
  const actionsReg = slotRegs.find((o) => o.name === 'sidebar.right.tab.files.actions')
  if (actionsReg && typeof actionsReg.inject === 'function') {
    const injected = actionsReg.inject({ absolutePath: 'D:\\demo\\作品' })
    if (injected && injected.absolutePath === 'D:\\demo\\作品') ok('② 注入契约正确:absolutePath 透传')
    else bad('② 注入契约异常:' + JSON.stringify(injected))
  } else bad('② 缺少 inject 声明')

  // 组件③:编辑模式
  const def = previewDefs[0]
  if (def && def.id === 'woody-editor' && Array.isArray(def.extensions) && def.extensions.includes('md')) ok('③ documentPreviews 注册:id=woody-editor、适用 .md')
  else bad('③ 注册异常:' + JSON.stringify(def))
  if (def && typeof def.title === 'function' && def.title() === '编辑') ok('③ title 是函数且返回「编辑」')
  else bad('③ title 异常')
  if (def && def.priority === 'plugin') ok('③ priority=plugin → .md 默认进入编辑模式(官方排序:非 builtin 优先)')
  else bad('③ priority 异常:' + (def ? def.priority : '无定义'))
  if (disposers.length === 2) ok('③ 注销函数就位(消息卡片全局样式 + 「编辑」动态注册清理)')
  else bad('③ effect 注销函数数量异常:' + disposers.length + '(预期 2)')
  const bodyReg = slotRegs.find((o) => o.name === 'sidebar.right.tab.document')
  if (bodyReg && bodyReg.key === 'woody-editor') ok('③ 槽位 key = 模式 id(keyed 槽位铁律)')
  else bad('③ 槽位 key 异常:' + JSON.stringify(bodyReg))

  // 官方文件地址解析
  const parse = exportsObj.parseResourceAddress
  if (typeof parse !== 'function') bad('未导出 parseResourceAddress')
  else {
    const norm = (v) => JSON.stringify(v)
    const cases = [
      ['dsh-resource://file/session/s-1/%E7%BB%86%E7%BA%B2.md', norm({ scope: 'session', sessionId: 's-1', path: '细纲.md' })],
      ['dsh-resource://file/absolute/D:/WooDy/%E4%BD%9C%E5%93%81.md', norm({ scope: 'absolute', path: 'D:/WooDy/作品.md' })],
      ['', 'null'], ['http://other/thing', 'null'],
    ]
    let pass = 0
    for (const [input, expect] of cases) if (norm(parse(input) ?? null) === expect) pass++
    if (pass === cases.length) ok('地址解析:session/absolute/中文/非法输入 全部正确')
    else bad('解析断言 ' + pass + '/' + cases.length)
  }

  // 引用功能:djb2 去重哈希 + 载荷格式 v4(2026-10-10 勾行引用:行号+摘要锚,不贴原文;
  // 历史 v3 内容格式与更早 @ 格式仍兼容)。任何版本载荷中都不得出现 @(官方 projectUserText
  // 会把 @记号劫持成可点击文件引用块,点出"文件不存在"坏路径)
  const djb2 = exportsObj.djb2
  const buildCiteBlocks = exportsObj.buildCiteBlocks
  const mergeLineTicks = exportsObj.mergeLineTicks
  const formatLineRanges = exportsObj.formatLineRanges
  const locateAnchorLine = exportsObj.locateAnchorLine
  const shiftRanges = exportsObj.shiftRanges
  if (typeof djb2 === 'function' && typeof buildCiteBlocks === 'function'
    && typeof mergeLineTicks === 'function' && typeof formatLineRanges === 'function'
    && typeof locateAnchorLine === 'function' && typeof shiftRanges === 'function') {
    if (djb2('你好世界') === djb2('你好世界') && djb2('甲') !== djb2('乙')) ok('djb2:同文本同哈希、异文本异哈希')
    else bad('djb2 异常')
    // 行段纯函数
    const merged = mergeLineTicks([40, 41, 12, 13, 14, 25, 52])
    const mergedOk = JSON.stringify(merged) === JSON.stringify([{ s: 12, e: 14 }, { s: 25, e: 25 }, { s: 40, e: 41 }, { s: 52, e: 52 }])
    if (mergedOk && formatLineRanges(merged) === '12–14、25、40–41、52') ok('行段合并与格式化:连续行并区间、标签正确')
    else bad('行段合并/格式化异常:' + JSON.stringify(merged) + ' / ' + formatLineRanges(merged))
    const shifted = shiftRanges([{ s: 10, e: 12 }], 3, 100)
    const shiftedEmpty = shiftRanges([{ s: 99, e: 102 }], 5, 100)
    if (JSON.stringify(shifted) === JSON.stringify([{ s: 13, e: 15 }]) && shiftedEmpty.length === 0) ok('行号平移:差量修正正确、越界夹回')
    else bad('行号平移异常:' + JSON.stringify(shifted) + ' / ' + JSON.stringify(shiftedEmpty))
    const sl = Array.from({ length: 30 }, (_, i) => '第' + (i + 1) + '行')
    sl[14] = '第三场 夜 内 医院走廊'
    sl[19] = '# 第四场 晨 内 天台'
    // 2026-10-10 实测回归:截断摘要末尾的「…」不剥掉,所有被截断的锚都匹配失败
    // → 发送时全部降级附带原文(位置字段消失)。标题行同理(# 前缀)。此三条锁死该回归。
    const anchorHit = locateAnchorLine(sl, '第三场 夜 内', 12) === 15
    const ellipsisHit = locateAnchorLine(sl, '第三场 夜 内 医' + '…', 12) === 15
    const headingHit = locateAnchorLine(sl, '# 第四场 晨 内 天台', 20) === 20
    const anchorMiss = locateAnchorLine(sl, '不存在的锚', 12) === 0
    if (anchorHit && ellipsisHit && headingHit && anchorMiss) ok('行号校验:附近命中/截断锚带省略号命中/标题行命中/找不到返回 0')
    else bad('行号校验异常:' + JSON.stringify({ anchorHit, ellipsisHit, headingHit, anchorMiss }))
    // 载荷:v4 行号引用 + 历史文字引用混排
    const mk = (over) => Object.assign({ id: 'x', path: 'D:/w/细纲.md', name: '细纲.md', text: '引用的原文', snippet: '引用的原…', head: '', tail: '', color: '#2563EB', instruction: '' }, over)
    const lineCite = mk({
      instruction: '改得更有张力', lines: [{ s: 12, e: 18 }, { s: 25, e: 25 }],
      anchor: '第三场 夜 内', linesText: '第三场 夜 内 医院走廊……', text: '第三场 夜 内',
      snippet: '第 12–18、25 行 · 第三场 夜 内',
    })
    const textCite = mk({ path: 'D:/w/剧本.md', name: '剧本.md' })
    const blocks = buildCiteBlocks([lineCite, textCite])
    const expect = '引用[1] 要求：改得更有张力\n文件[1]：D:/w/细纲.md\n位置[1]：第 12–18、25 行（「第三场 夜 内」）\n\n引用[2] 要求：（未填写）\n文件[2]：D:/w/剧本.md\n内容[2]：引用的原文'
    if (blocks === expect) ok('引用载荷格式正确(v4 行号不贴原文 + 历史文字引用兼容)')
    else bad('载荷格式异常:' + JSON.stringify(blocks))
    if (!blocks.includes('@')) ok('载荷不含任何 @ 记号(官方 projectUserText 无从劫持)')
    else bad('载荷仍含 @:' + JSON.stringify(blocks.match(/@\S{0,12}/g)))
    // 反解析(消息流卡片渲染的解析器;四兼容 v4 / v3 / @文件: / @file:)
    const parse = exportsObj.parseCiteBlocks
    if (typeof parse === 'function') {
      const back = parse('请改这一段\n\n' + expect)
      const legacy = parse('旧格式\n\n@[1] 要求：老意见\n@file:D:/w/旧.md\n@内容：旧文本')
      const legacy2 = parse('旧格式2\n\n@[1] 要求：老意见二\n@文件:D:/w/旧二.md\n@内容：旧文本二')
      const v3only = parse('老消息\n\n引用[1] 要求：老意见三\n文件[1]：D:/w/旧三.md\n内容[1]：旧文本三')
      const pass = back.mainText === '请改这一段'
        && back.cites.length === 2
        && back.cites[0].name === '细纲.md' && back.cites[0].instruction === '改得更有张力'
        && back.cites[0].location === '第 12–18、25 行' && back.cites[0].text === '第三场 夜 内'
        && back.cites[1].instruction === '' && back.cites[1].text === '引用的原文' && !back.cites[1].location
        && legacy.cites.length === 1 && legacy.cites[0].path === 'D:/w/旧.md' && legacy.cites[0].instruction === '老意见'
        && legacy2.cites.length === 1 && legacy2.cites[0].path === 'D:/w/旧二.md'
        && v3only.cites.length === 1 && v3only.cites[0].path === 'D:/w/旧三.md' && v3only.cites[0].text === '旧文本三'
      if (pass) ok('消息反解析:v4行号/v3无@/@文件:/@file: 四种格式全部还原')
      else bad('反解析异常:' + JSON.stringify(back) + ' / ' + JSON.stringify(legacy) + ' / ' + JSON.stringify(legacy2) + ' / ' + JSON.stringify(v3only))
      const none = parse('没有引用的普通消息')
      if (none.mainText === '没有引用的普通消息' && none.cites.length === 0) ok('反解析:普通消息不受影响')
      else bad('反解析误伤普通消息')
    } else bad('未导出 parseCiteBlocks')
  } else bad('未导出 djb2/buildCiteBlocks/行段纯函数')

  // 定稿副本(加入对照)与统计口径的宿主侧依赖:write 拒绝同名(已在组件②断言)
} catch (e) {
  bad('浏览器端执行失败:' + e.message)
}

try { rmSync(testRoot, { recursive: true, force: true }) } catch {}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
