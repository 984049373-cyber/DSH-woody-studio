// ============================================================
// 模块④:写作 skill 同步(2026-10-10 新增)
// 把插件自带的 skills/ 目录(核心 5 个写作 skill)同步到用户级
// DSH skill 目录(~/.dsh/skills/),让所有 DSH 会话开箱可用。
//
// 【三条防覆盖规则】(绝不冲掉用户修改):
//   1. 目标缺失                → 安装
//   2. 目标 == 上次随插件发布的版本 → 覆盖(插件更新正常流转)
//   3. 目标被用户改过           → 跳过并记日志(用户改动是主人的)
// 「上次发布的版本」记录在插件数据目录的 skills-manifest.json
// (每文件 SHA-256)。同步完成后清单更新为本次发布版。
//
// 【为什么是 ~/.dsh/skills】DSH 源码实证(dsh-skill-filesystem):
// FileSystemSkillProvider 默认扫描 <dshHome>/skills,dshHome 默认 ~/.dsh;
// 目录式 <skill名>/SKILL.md 与单文件 <skill名>.md 均可;skill 名必须是
// 小写 kebab-case(^[a-z0-9]+(-[a-z0-9]+)*$),中文名会被拒绝——
// 因此随包的 5 个 skill 目录用英文名(原 frontmatter name 本就是英文)。
// ============================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DATA_DIR } from './shared'

// 构建后此模块内联进 lib/index.js,import.meta.url 即 lib/index.js,
// skill 资产根 = 插件根/skills/(lib 的上一级),与 assets/ 同款定位方式
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const MANIFEST_PATH = join(PLUGIN_DATA_DIR, 'skills-manifest.json')

/** 用户级 skill 目录。与 DSH 自身的解析规则对齐(dsh-home-paths 源码实证):
 *  显式配置 > $DSH_HOME 环境变量(空白视为未设) > 默认 ~/.dsh。
 *  开源场景:其他用户的 DSH 数据根若被 DSH_HOME 挪过位置,这里必须跟过去,
 *  否则同步进 ~/.dsh/skills 的技能 DSH 根本不扫。 */
function resolveUserSkillsRoot(): string {
  const envHome = process.env.DSH_HOME
  const dshHome = envHome && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return join(dshHome, 'skills')
}

export interface SkillSyncResult {
  installed: string[]   // 新安装的文件(相对路径)
  updated: string[]     // 随插件更新被覆盖的文件
  skipped: string[]     // 用户改过、被保护跳过的文件
  errors: string[]      // 单文件失败(不影响其余)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

type Manifest = Record<string, string>

function loadManifest(path: string): Manifest {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Manifest : {}
  } catch { return {} }
}

function walkFiles(dir: string, baseDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, baseDir, out)
    else if (entry.isFile()) {
      // 相对路径必须干净(baseDir 可能不带尾分隔符,切片会多出前导 /)
      const rel = full.slice(baseDir.length).replaceAll('\\', '/').replace(/^\//, '')
      out.push(rel)
    }
  }
  return out
}

/**
 * 把随包 skills/ 同步到用户级目录。任何异常都不外抛(不得影响 DSH 启动)。
 * 允许通过参数覆盖各路径(自检用,与生产实例隔离)。
 */
export function syncBundledSkills(opts: {
  sourceDir?: string
  targetRoot?: string
  manifestPath?: string
  log?: (msg: string) => void
} = {}): SkillSyncResult {
  const result: SkillSyncResult = { installed: [], updated: [], skipped: [], errors: [] }
  try {
    const sourceDir = opts.sourceDir ?? BUNDLED_SKILLS_DIR
    const targetRoot = opts.targetRoot ?? resolveUserSkillsRoot()
    const manifestPath = opts.manifestPath ?? MANIFEST_PATH
    const log = opts.log ?? (() => {})
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      log('skill 同步:随包目录不存在,跳过(' + sourceDir + ')')
      return result
    }
    const manifest = loadManifest(manifestPath)
    const nextManifest: Manifest = {}
    const files = walkFiles(sourceDir, sourceDir)
    for (const rel of files) {
      const src = join(sourceDir, ...rel.split('/'))
      const dst = join(targetRoot, ...rel.split('/'))
      try {
        const srcHash = sha256File(src)
        nextManifest[rel] = srcHash
        if (!existsSync(dst)) {
          mkdirSync(dirname(dst), { recursive: true })
          copyFileSync(src, dst)
          result.installed.push(rel)
          continue
        }
        const dstHash = sha256File(dst)
        if (dstHash === srcHash) continue                       // 已是最新,无事
        if (manifest[rel] !== undefined && dstHash === manifest[rel]) {
          copyFileSync(src, dst)                                // 与上次发布版一致 → 插件更新
          result.updated.push(rel)
          continue
        }
        result.skipped.push(rel)                                // 用户改过 → 保护
      } catch (e: any) {
        result.errors.push(rel + ': ' + String(e?.message ?? e))
      }
    }
    try {
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf-8')
    } catch (e: any) {
      result.errors.push('manifest: ' + String(e?.message ?? e))
    }
    const parts: string[] = []
    if (result.installed.length) parts.push('新装 ' + result.installed.length)
    if (result.updated.length) parts.push('更新 ' + result.updated.length)
    if (result.skipped.length) parts.push('保护跳过 ' + result.skipped.length)
    if (result.errors.length) parts.push('失败 ' + result.errors.length)
    if (parts.length) log('skill 同步:' + parts.join(','))
  } catch (e: any) {
    result.errors.push('sync: ' + String(e?.message ?? e))
    try { opts.log?.('skill 同步失败:' + String(e?.message ?? e)) } catch {}
  }
  return result
}
