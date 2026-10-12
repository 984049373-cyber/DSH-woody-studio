// ============================================================
// WooDy 剧本工作室 · 浏览器端入口(三合一)
// 一个插件、三个组件(2026-10-03 用户拍板合并):
//   ① workspace 作品管理(侧栏「作品管理」+ 主面板)
//   ② files    文件管理(原生「工作区文件」工具栏 新建/上传/删除)
//   ③ editor   剧本编辑器(官方文件预览的「编辑」模式,.md 默认进入)
// 数据统一走宿主端单服务(:43199 起)。
// ============================================================
import { applyWorkspace } from './client/workspace'
import { applyFiles } from './client/files'
import { applyEditor } from './client/editor'

export const name = 'woody-studio'

/** 依赖的客户端服务:slots(槽位注册)+ documentPreviews(预览模式注册)
 *  + sidebarRight(消息引用卡片文件名点击 → 右侧栏打开文件) */
export const inject = ['slots', 'documentPreviews', 'sidebarRight']

export function apply(ctx: any): void {
  applyWorkspace(ctx)
  applyFiles(ctx)
  applyEditor(ctx)
}

// 官方文件地址解析(自检与正文组件共用)
export { parseResourceAddress } from './client/editor'
// 引用功能(自检用:djb2 去重哈希 / 载荷格式 v4 / 消息反解析 / 行段合并与行号校验)
export {
  djb2, buildCiteBlocks, parseCiteBlocks,
  mergeLineTicks, formatLineRanges, locateAnchorLine, shiftRanges,
  type CiteItem, type CiteRange,
} from './client/editor'
