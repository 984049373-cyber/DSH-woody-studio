import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
//#region src/host/shared.ts
const PROFILE_DIR = join(homedir(), ".dsh", "profiles", "desktop");
const PLUGIN_DATA_DIR = join(PROFILE_DIR, "woody-studio");
const CONFIG_FILE = join(PLUGIN_DATA_DIR, "config.json");
const BOOT_LOG = join(PLUGIN_DATA_DIR, "host.log");
/** 剧本工作区五目录骨架(识别特征,files 模块守卫与 workspace 模块创建共用) */
const SCRIPT_DIRS = [
	"大纲",
	"记忆",
	"剧本",
	"细纲",
	"作品资料"
];
const LEGACY_CONFIGS = [join(PROFILE_DIR, "woody-workspace", "config.json")];
function ensureDataDir() {
	try {
		if (!existsSync(PLUGIN_DATA_DIR)) mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
	} catch {}
}
function rotateLogIfNeeded() {
	try {
		if (existsSync(BOOT_LOG) && statSync(BOOT_LOG).size > 262144) rmSync(BOOT_LOG, { force: true });
	} catch {}
}
function bootLog(message) {
	try {
		ensureDataDir();
		appendFileSync(BOOT_LOG, (/* @__PURE__ */ new Date()).toISOString() + " " + message + "\n");
	} catch {}
}
function loadConfig() {
	try {
		if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
	} catch {}
	for (const legacy of LEGACY_CONFIGS) try {
		if (existsSync(legacy)) {
			const parsed = JSON.parse(readFileSync(legacy, "utf-8"));
			saveConfig(parsed);
			bootLog("已迁移旧配置 " + legacy);
			return parsed;
		}
	} catch {}
	return {};
}
function saveConfig(patch) {
	const next = {
		...loadConfig(),
		...patch
	};
	try {
		ensureDataDir();
		writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
	} catch {}
}
function normPath(p) {
	return String(p || "").toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
}
/** 自然排序:让「第2集」排在「第10集」之前(原版 naturalSort 等价实现) */
function naturalCompare(a, b) {
	const re = /(\d+)|(\D+)/g;
	const pa = String(a).match(re) ?? [];
	const pb = String(b).match(re) ?? [];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === void 0) return -1;
		if (y === void 0) return 1;
		const nx = Number(x);
		const ny = Number(y);
		if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
			if (nx !== ny) return nx - ny;
		} else if (x !== y) return x.localeCompare(y, "zh-CN");
	}
	return 0;
}
/** workspaceRegistry 可选增强:任何异常都不影响核心目录读写 */
function makeSafeRegistry(ctx) {
	const safeRegistryList = async () => {
		try {
			const reg = ctx.get?.("workspaceRegistry");
			if (!reg || typeof reg.list !== "function") return [];
			const r = reg.list();
			if (Array.isArray(r)) return r;
			if (r && typeof r.then === "function") return await r;
			return [];
		} catch {
			return [];
		}
	};
	const safeRegistryCall = async (fn, ...args) => {
		try {
			const reg = ctx.get?.("workspaceRegistry");
			if (!reg || typeof reg[fn] !== "function") return void 0;
			const r = reg[fn](...args);
			if (r && typeof r.then === "function") return await r;
			return r;
		} catch {
			return;
		}
	};
	return {
		safeRegistryList,
		safeRegistryCall
	};
}
/** 目录是否具备剧本工作区的五目录骨架 */
function isScriptWorkspaceDir(dir) {
	try {
		if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
		return SCRIPT_DIRS.every((d) => {
			const sub = join(dir, d);
			return existsSync(sub) && statSync(sub).isDirectory();
		});
	} catch {
		return false;
	}
}
/**
* 官方文件地址解析(照官方 parseFileAddress 移植,源码实证):
*   dsh-resource://file/session/<会话id>/<相对路径> → 会话文件(真实路径=工作区+相对)
*   dsh-resource://file/absolute/<绝对路径>          → 绝对路径文件
*/
const FILE_ADDR_PREFIX = "dsh-resource://file/";
function parseFileAddress(addr) {
	try {
		if (!addr.startsWith(FILE_ADDR_PREFIX)) return null;
		const end = addr.search(/[?#]/);
		const [scope, ...rest] = addr.slice(20, end === -1 ? void 0 : end).split("/");
		if (scope === "session") {
			const [id, ...segments] = rest;
			if (!id || segments.length === 0) return null;
			return {
				scope,
				sessionId: decodeURIComponent(id),
				path: segments.map(decodeURIComponent).join("/")
			};
		}
		if (scope === "absolute") {
			const unc = rest[0] === "" && rest.length > 1;
			const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
			if (segments.length === 0 || segments[0] === "") return null;
			if (unc) return {
				scope,
				path: `//${segments.join("/")}`
			};
			return {
				scope,
				path: /^[a-zA-Z]:$/.test(segments[0]) ? segments.join("/") : `/${segments.join("/")}`
			};
		}
		return null;
	} catch {
		return null;
	}
}
/** HTTP 辅助:JSON 响应与请求体读取 */
function makeHttpHelpers() {
	const json = (res, code, data) => {
		res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(data));
	};
	const readBody = (req) => new Promise((resolveBody) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			try {
				resolveBody(JSON.parse(body || "{}"));
			} catch {
				resolveBody({});
			}
		});
	});
	return {
		json,
		readBody
	};
}
//#endregion
//#region src/host/workspace.ts
const DEFAULT_DATA_ROOT = "D:\\WooDy-DSH\\作品";
const AGENTS_TPL_PATH = fileURLToPath(new URL("../templates/AGENTS-模板.md", import.meta.url));
/** 当前数据根(patch/自检传入 > config.json > 默认值);可运行中切换 */
function createWorkspaceModule(env) {
	const { ctx, json, readBody } = env;
	const { safeRegistryList, safeRegistryCall } = makeSafeRegistry(ctx);
	let dataRoot = resolve(String(env.input?.dataRoot || "") || loadConfig().dataRoot || DEFAULT_DATA_ROOT);
	let userName = String(env.input?.userName ?? "").trim() || String(loadConfig().userName ?? "").trim();
	/** 渲染 AGENTS.md:用户名/作品名占位符;未设置的用户名整行移除,占位符记号不带给 AI */
	function renderAgents(workName) {
		try {
			let tpl = readFileSync(AGENTS_TPL_PATH, "utf-8");
			const uname = userName.trim();
			if (uname) tpl = tpl.replaceAll("{{用户名}}", uname);
			tpl = tpl.replaceAll("{{作品名}}", workName);
			tpl = tpl.split("\n").filter((line) => !line.includes("{{")).join("\n").replace(/\n{3,}/g, "\n\n");
			return tpl;
		} catch {
			return null;
		}
	}
	/** 生成作品的 AGENTS.md(已存在则跳过,绝不覆盖) */
	function writeAgents(dir, workName) {
		const target = join(dir, "AGENTS.md");
		if (existsSync(target)) return false;
		const tpl = renderAgents(workName);
		if (tpl === null) {
			bootLog("AGENTS.md 生成失败（模板不可读）：" + dir);
			return false;
		}
		writeFileSync(target, tpl, "utf-8");
		return true;
	}
	function validName(name) {
		return /^[\u4e00-\u9fff《》\w-]{1,50}$/.test(String(name ?? "").trim());
	}
	async function listWorks() {
		if (!existsSync(dataRoot)) return [];
		const dirs = readdirSync(dataRoot, { withFileTypes: true }).filter((ent) => ent.isDirectory() || ent.isSymbolicLink());
		const workspaces = await safeRegistryList();
		const items = dirs.map((ent) => {
			const dir = join(dataRoot, ent.name);
			const ws = workspaces.find((w) => normPath(w.path) === normPath(dir));
			return {
				name: ws?.title || ent.name,
				dirName: ent.name,
				path: dir,
				workspaceId: ws?.id ?? null,
				sessions: ws?.sessionIds?.length ?? 0,
				orphan: false
			};
		});
		const known = new Set(items.map((i) => normPath(i.path)));
		const rootNorm = normPath(dataRoot);
		for (const ws of workspaces) {
			const p = String(ws?.path ?? "");
			if (!p) continue;
			const pn = normPath(p);
			if (pn === rootNorm || !pn.startsWith(rootNorm + "\\")) continue;
			if (known.has(pn)) continue;
			items.push({
				name: p.split("\\").pop() || p,
				dirName: p.split("\\").pop() || p,
				path: p,
				workspaceId: ws?.id ?? null,
				sessions: ws?.sessionIds?.length ?? 0,
				orphan: true
			});
		}
		return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	}
	/** 处理本模块路由;未匹配返回 false */
	async function handle(pathname, req, res, port) {
		if (pathname === "/api/woody/config") {
			if (req.method === "GET") {
				json(res, 200, {
					dataRoot,
					exists: existsSync(dataRoot),
					port,
					userName
				});
				return true;
			}
			if (req.method === "POST") {
				const body = await readBody(req);
				const next = String(body.dataRoot ?? "").trim();
				if (!next) {
					json(res, 400, { error: "数据存放位置不能为空" });
					return true;
				}
				const nextResolved = resolve(next);
				try {
					if (!existsSync(nextResolved)) mkdirSync(nextResolved, { recursive: true });
				} catch (e) {
					json(res, 400, { error: "无法创建该目录：" + String(e?.message ?? e) });
					return true;
				}
				dataRoot = nextResolved;
				if (body.userName !== void 0) userName = String(body.userName).trim();
				saveConfig({
					dataRoot: nextResolved,
					userName
				});
				bootLog("数据存放位置已切换为：" + nextResolved);
				ctx.logger?.info?.(`[woody-studio] 数据存放位置切换为：${nextResolved}`);
				json(res, 200, {
					dataRoot,
					exists: true,
					userName
				});
				return true;
			}
			json(res, 405, { error: "method" });
			return true;
		}
		if (pathname === "/api/woody/workspace/list") {
			if (req.method !== "GET") {
				json(res, 405, { error: "method" });
				return true;
			}
			json(res, 200, { items: await listWorks() });
			return true;
		}
		if (pathname === "/api/woody/workspace/create") {
			if (req.method !== "POST") {
				json(res, 405, { error: "method" });
				return true;
			}
			const body = await readBody(req);
			const name = String(body.name ?? "").trim();
			if (!validName(name)) {
				json(res, 400, { error: "作品名不合法（限中文/字母/数字/书名号，1-50 字）" });
				return true;
			}
			const dir = join(dataRoot, name);
			if (existsSync(dir)) {
				json(res, 409, { error: `作品「${name}」已存在` });
				return true;
			}
			for (const d of SCRIPT_DIRS) mkdirSync(join(dir, d), { recursive: true });
			writeFileSync(join(dir, "待定.md"), `# ${name}\n\n（创作从这里开始）\n`, "utf-8");
			const now = /* @__PURE__ */ new Date();
			const p2 = (v) => String(v).padStart(2, "0");
			const tsLine = `> 最后修改：${`${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`}\n\n`;
			writeFileSync(join(dir, "作品资料", "作品信息.md"), tsLine + `# 作品基本信息\n\n## 必填\n\n- **书名**：${name}\n- **类型**：（待补充）\n- **市场定位**：（待补充）\n- **总集数规划**：（待补充）\n- **单集时长**：（待补充）\n- **细纲字数**：（待补充）字/集\n- **剧本字数**：（待补充）字/集\n\n## 选填\n\n- **目标平台**：（待补充）\n- **核心卖点**：（待补充）\n`, "utf-8");
			writeFileSync(join(dir, "作品资料", "世界观.md"), tsLine + "# 世界观设定\n\n（待补充）\n", "utf-8");
			writeFileSync(join(dir, "作品资料", "角色.md"), tsLine + "# 角色档案\n\n（待补充）\n", "utf-8");
			writeAgents(dir, name);
			const workspaceId = (await safeRegistryCall("resolveByPath", dir) ?? await safeRegistryCall("create", dir, name))?.id ?? null;
			ctx.logger?.info?.(`[woody-studio] 创建作品「${name}」：${dir}（workspaceId=${workspaceId}）`);
			json(res, 200, {
				name,
				path: dir,
				workspaceId
			});
			return true;
		}
		if (pathname === "/api/woody/workspace/delete") {
			if (req.method !== "POST") {
				json(res, 405, { error: "method" });
				return true;
			}
			const body = await readBody(req);
			const name = String(body.name ?? "").trim();
			if (!validName(name)) {
				json(res, 400, { error: "作品名不合法" });
				return true;
			}
			const dir = join(dataRoot, name);
			const existing = await safeRegistryCall("resolveByPath", dir);
			if (!existsSync(dir) && !existing) {
				json(res, 404, { error: `作品「${name}」不存在` });
				return true;
			}
			if (existing) await safeRegistryCall("delete", existing.id);
			if (existsSync(dir)) rmSync(dir, {
				recursive: true,
				force: true
			});
			ctx.logger?.info?.(`[woody-studio] 删除作品「${name}」：目录与工作区注册已移除（会话交由 DSH 原生处理）`);
			json(res, 200, { deleted: true });
			return true;
		}
		if (pathname === "/api/woody/workspace/rename") {
			if (req.method !== "POST") {
				json(res, 405, { error: "method" });
				return true;
			}
			const body = await readBody(req);
			const targetPath = String(body.path ?? "").trim();
			const newName = String(body.newName ?? "").trim();
			if (!targetPath) {
				json(res, 400, { error: "缺少作品路径" });
				return true;
			}
			if (!validName(newName)) {
				json(res, 400, { error: "作品名不合法（限中文/字母/数字/书名号，1-50 字）" });
				return true;
			}
			const dir = resolve(targetPath);
			const rootNorm = normPath(dataRoot);
			if (normPath(dir) !== rootNorm && !normPath(dir).startsWith(rootNorm + "\\")) {
				json(res, 400, { error: "该路径不在当前数据存放位置内" });
				return true;
			}
			if (!existsSync(dir)) {
				json(res, 404, { error: "作品目录不存在" });
				return true;
			}
			const existing = await safeRegistryCall("resolveByPath", dir);
			if (existing && typeof existing.setTitle === "function") {
				if ((await safeRegistryList()).some((w) => w.id !== existing.id && String(w.title ?? "") === newName)) {
					json(res, 409, { error: `已有作品叫「${newName}」` });
					return true;
				}
				try {
					await existing.setTitle(newName);
				} catch (e) {
					json(res, 500, { error: "DSH 拒绝改名：" + String(e?.message ?? e) });
					return true;
				}
				ctx.logger?.info?.(`[woody-studio] 重命名（改标题）：${dir} → 「${newName}」（目录不变，历史对话保留）`);
				json(res, 200, {
					renamed: true,
					name: newName,
					dirName: dir.split("\\").pop(),
					path: dir,
					mode: "title"
				});
				return true;
			}
			const newDir = join(dataRoot, newName);
			if (existsSync(newDir)) {
				json(res, 409, { error: `作品「${newName}」已存在` });
				return true;
			}
			renameSync(dir, newDir);
			ctx.logger?.info?.(`[woody-studio] 重命名（改目录，未注册工作区）：${dir} → ${newDir}`);
			json(res, 200, {
				renamed: true,
				name: newName,
				dirName: newName,
				path: newDir,
				mode: "directory"
			});
			return true;
		}
		return false;
	}
	/** 开机巡检(幂等):数据根下的作品目录,未注册的自动登记进注册表,
	*  缺 AGENTS.md 的按当前配置补生成(作品名=目录名)。迁入旧作品/手工拷贝的目录都靠它纳管。 */
	async function ensureWorks() {
		try {
			const items = await listWorks();
			let registered = 0, generated = 0;
			for (const it of items) {
				if (it.orphan) continue;
				if (it.workspaceId == null) {
					if (await safeRegistryCall("create", it.path, it.dirName)) registered++;
				}
				if (writeAgents(it.path, it.dirName)) generated++;
			}
			const parts = [];
			if (registered) parts.push(`登记作品 ${registered} 部`);
			if (generated) parts.push(`补生成 AGENTS.md ${generated} 份`);
			if (parts.length) {
				bootLog("开机巡检：" + parts.join(","));
				ctx.logger?.info?.("[woody-studio] 开机巡检：" + parts.join(","));
			}
		} catch (e) {
			bootLog("开机巡检失败（不影响运行）：" + String(e?.message ?? e));
		}
	}
	return {
		handle,
		getDataRoot: () => dataRoot,
		ensureWorks
	};
}
//#endregion
//#region src/host/files.ts
/** 每个文件保留的历史版本上限(超出删最旧;用户拍板 20 份,2026-10-03) */
const VERSION_KEEP = 20;
/** 快照文件名:`文件名.YYYYMMDD-HHMMSS.md`;同秒防撞时 `文件名.ts-2.md` */
const SNAP_RE = /\.(\d{8}-\d{6})(?:-\d+)?\.md$/;
/** 文件树只展示这些类型(与原版一致) */
const VISIBLE_EXTS = /* @__PURE__ */ new Set([".md", ".docx"]);
const HIDDEN_NAMES = /* @__PURE__ */ new Set([".versions", ".hermes_session"]);
/** 当前时刻 → 快照时间戳标签(本地时间 YYYYMMDD-HHMMSS,与原版一致) */
function snapTS() {
	const n = /* @__PURE__ */ new Date();
	const p = (v) => String(v).padStart(2, "0");
	return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}
/** 同秒防撞(移植原版 2026-09-17 修复):同名时自动加 -2/-3 序号,保证永不覆盖 */
function uniqueSnapshotPath(versionsDir, baseName, ts) {
	let candidate = join(versionsDir, `${baseName}.${ts}.md`);
	let n = 2;
	while (existsSync(candidate)) {
		candidate = join(versionsDir, `${baseName}.${ts}-${n}.md`);
		n += 1;
	}
	return candidate;
}
/** 快照按修改时间旧→新排序(带序号的文件名字符串序不可靠,原版教训) */
function sortByMtime(versionsDir, files) {
	return files.sort((a, b) => statSync(join(versionsDir, a)).mtimeMs - statSync(join(versionsDir, b)).mtimeMs);
}
/** 列出某文件的全部快照(旧→新;匹配规则兼容同秒序号段) */
function listSnapshots(versionsDir, baseName) {
	if (!existsSync(versionsDir)) return [];
	return sortByMtime(versionsDir, readdirSync(versionsDir).filter((f) => f.startsWith(baseName + ".") && SNAP_RE.test(f)).filter((f) => f.replace(SNAP_RE, "") === baseName));
}
function createFilesModule(env) {
	const { ctx, json, readBody } = env;
	const { safeRegistryList } = makeSafeRegistry(ctx);
	/** 按会话 id 反查它所属的工作区(用官方注册表,不碰会话存储) */
	const findWorkspaceBySession = async (sessionId) => {
		if (!sessionId) return void 0;
		return (await safeRegistryList()).find((w) => (w.sessionIds ?? []).includes(sessionId));
	};
	/** 路径安全守卫:目标路径必须位于某个「剧本工作区」目录之下。所有文件接口先过这里。 */
	const guardPath = async (target) => {
		if (!target || typeof target !== "string") return {
			ok: false,
			error: "缺少路径"
		};
		const targetNorm = normPath(resolve(target));
		const all = await safeRegistryList();
		for (const w of all) {
			const wp = String(w.path ?? "");
			if (!wp) continue;
			const wpNorm = normPath(wp);
			if (targetNorm !== wpNorm && !targetNorm.startsWith(wpNorm + "\\")) continue;
			if (!isScriptWorkspaceDir(wp)) continue;
			return {
				ok: true,
				workPath: wp
			};
		}
		return {
			ok: false,
			error: "该路径不在任何剧本工作区内（已拒绝）"
		};
	};
	/** 处理本模块路由;未匹配返回 false */
	async function handle(pathname, req, res, query) {
		if (!pathname.startsWith("/api/woody/files/")) return false;
		if (pathname === "/api/woody/files/context") {
			const sessionId = String(query.get("sessionId") ?? "");
			const ws = await findWorkspaceBySession(sessionId);
			if (!ws || !ws.path) {
				bootLog(`context 查询：sessionId=${sessionId || "(空)"} → 该会话不属于任何工作区`);
				json(res, 200, {
					isScriptWorkspace: false,
					reason: "该会话不属于任何工作区"
				});
				return true;
			}
			const ok = isScriptWorkspaceDir(ws.path);
			bootLog(`context 查询：sessionId=${sessionId} → 工作区「${ws.title ?? ""}」${ws.path} → ${ok ? "是剧本工作区 ✓" : "缺少剧本骨架 ✗"}`);
			json(res, 200, {
				isScriptWorkspace: ok,
				workPath: ok ? ws.path : void 0,
				workName: ok ? ws.title || basename(ws.path) : void 0,
				reason: ok ? void 0 : "该工作区目录缺少剧本骨架（大纲/记忆/剧本/细纲/作品资料）"
			});
			return true;
		}
		if (pathname === "/api/woody/files/list") {
			const dir = String(query.get("dir") ?? "");
			const guard = await guardPath(dir);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!existsSync(dir) || !statSync(dir).isDirectory()) {
				json(res, 200, { items: [] });
				return true;
			}
			const items = readdirSync(dir).filter((n) => !n.startsWith(".") && !HIDDEN_NAMES.has(n)).map((n) => {
				const full = join(dir, n);
				let isDir = false;
				try {
					isDir = statSync(full).isDirectory();
				} catch {
					return null;
				}
				if (!isDir && !VISIBLE_EXTS.has(extname(n).toLowerCase())) return null;
				return {
					name: n,
					path: full,
					isDir
				};
			}).filter((x) => x !== null).sort((a, b) => a.isDir !== b.isDir ? a.isDir ? -1 : 1 : naturalCompare(a.name, b.name));
			json(res, 200, {
				items,
				dir
			});
			return true;
		}
		if (pathname === "/api/woody/files/read") {
			const target = String(query.get("path") ?? "");
			const guard = await guardPath(target);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!existsSync(target)) {
				json(res, 404, { error: "文件不存在" });
				return true;
			}
			if (extname(target).toLowerCase() === ".docx") {
				json(res, 400, { error: "暂不支持预览 .docx，请下载后查看" });
				return true;
			}
			json(res, 200, {
				content: readFileSync(target, "utf-8"),
				path: target
			});
			return true;
		}
		if (pathname === "/api/woody/files/is-script") {
			const dir = String(query.get("dir") ?? "");
			if (!dir) {
				json(res, 200, { isScriptWorkspace: false });
				return true;
			}
			const dirNorm = normPath(resolve(dir));
			let hit = false;
			for (const w of await safeRegistryList()) {
				const wp = String(w.path ?? "");
				if (!wp) continue;
				const wpNorm = normPath(wp);
				if (dirNorm !== wpNorm && !dirNorm.startsWith(wpNorm + "\\")) continue;
				if (isScriptWorkspaceDir(wp)) {
					hit = true;
					break;
				}
			}
			json(res, 200, { isScriptWorkspace: hit });
			return true;
		}
		if (pathname === "/api/woody/files/mkdir") {
			const body = await readBody(req);
			const dir = String(body.dir ?? "");
			const nm = String(body.name ?? "").trim();
			const guard = await guardPath(dir);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!nm || /[\\/:*?"<>|]/.test(nm)) {
				json(res, 400, { error: "名称不合法" });
				return true;
			}
			const target = join(dir, nm);
			if (existsSync(target)) {
				json(res, 409, { error: "同名文件或文件夹已存在" });
				return true;
			}
			mkdirSync(target, { recursive: true });
			json(res, 200, { created: target });
			return true;
		}
		if (pathname === "/api/woody/files/write") {
			const body = await readBody(req);
			const dir = String(body.dir ?? "");
			const nm = String(body.name ?? "").trim();
			const content = String(body.content ?? "");
			const guard = await guardPath(dir);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!nm || /[\\/:*?"<>|]/.test(nm)) {
				json(res, 400, { error: "名称不合法" });
				return true;
			}
			const target = join(dir, nm);
			if (existsSync(target)) {
				json(res, 409, { error: "同名文件已存在" });
				return true;
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, "utf-8");
			json(res, 200, { created: target });
			return true;
		}
		if (pathname === "/api/woody/files/rename") {
			const body = await readBody(req);
			const target = String(body.path ?? "");
			const newName = String(body.newName ?? "").trim();
			const guard = await guardPath(target);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!newName || /[\\/:*?"<>|]/.test(newName)) {
				json(res, 400, { error: "名称不合法" });
				return true;
			}
			if (!existsSync(target)) {
				json(res, 404, { error: "目标不存在" });
				return true;
			}
			const dest = join(dirname(target), newName);
			if (existsSync(dest)) {
				json(res, 409, { error: "同名文件或文件夹已存在" });
				return true;
			}
			renameSync(target, dest);
			json(res, 200, { renamed: dest });
			return true;
		}
		if (pathname === "/api/woody/files/delete") {
			const body = await readBody(req);
			const paths = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
			if (paths.length === 0) {
				json(res, 400, { error: "没有指定要删除的路径" });
				return true;
			}
			const deleted = [];
			const failed = [];
			for (const p of paths) {
				const guard = await guardPath(p);
				if (!guard.ok) {
					failed.push({
						path: p,
						error: guard.error ?? "不在剧本工作区内"
					});
					continue;
				}
				try {
					if (existsSync(p) && statSync(p).isFile() && extname(p).toLowerCase() === ".md") {
						const versionsDir = join(dirname(p), ".versions");
						const baseName = basename(p).replace(/\.md$/i, "");
						for (const vf of listSnapshots(versionsDir, baseName)) try {
							unlinkSync(join(versionsDir, vf));
						} catch {}
					}
					rmSync(p, {
						recursive: true,
						force: true
					});
					deleted.push(p);
				} catch (e) {
					failed.push({
						path: p,
						error: String(e?.message ?? e)
					});
				}
			}
			json(res, 200, {
				deleted,
				failed
			});
			return true;
		}
		if (pathname === "/api/woody/files/upload") {
			const body = await readBody(req);
			const dir = String(body.dir ?? "");
			const nm = String(body.name ?? "").trim();
			const b64 = String(body.contentBase64 ?? "");
			const guard = await guardPath(dir);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!nm || /[\\/:*?"<>|]/.test(nm)) {
				json(res, 400, { error: "文件名不合法" });
				return true;
			}
			const target = join(dir, nm);
			if (existsSync(target)) {
				json(res, 409, { error: "同名文件已存在" });
				return true;
			}
			mkdirSync(dir, { recursive: true });
			writeFileSync(target, Buffer.from(b64, "base64"));
			json(res, 200, { uploaded: target });
			return true;
		}
		if (pathname === "/api/woody/files/save") {
			const body = await readBody(req);
			const target = String(body.path ?? "");
			const content = String(body.content ?? "");
			const guard = await guardPath(target);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!existsSync(target)) {
				json(res, 404, { error: "文件不存在（新建请用文件面板的＋按钮）" });
				return true;
			}
			if (extname(target).toLowerCase() !== ".md") {
				json(res, 400, { error: "仅支持保存 .md 文件" });
				return true;
			}
			writeFileSync(target, content, "utf-8");
			const dir = dirname(target);
			const versionsDir = join(dir, ".versions");
			const baseName = basename(target).replace(/\.md$/i, "");
			if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true });
			const existing = listSnapshots(versionsDir, baseName);
			let versionSaved = false;
			const latestContent = existing.length > 0 ? readFileSync(join(versionsDir, existing[existing.length - 1]), "utf-8") : null;
			if (latestContent === null || latestContent !== content) {
				writeFileSync(uniqueSnapshotPath(versionsDir, baseName, snapTS()), content, "utf-8");
				versionSaved = true;
			}
			const updated = listSnapshots(versionsDir, baseName);
			while (updated.length > VERSION_KEEP) unlinkSync(join(versionsDir, updated.shift()));
			json(res, 200, {
				ok: true,
				versionSaved,
				versionCount: updated.length
			});
			return true;
		}
		if (pathname === "/api/woody/files/versions") {
			const target = String(query.get("path") ?? "");
			const guard = await guardPath(target);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			const list = listSnapshots(join(dirname(target), ".versions"), basename(target).replace(/\.md$/i, "")).slice(-20).reverse().map((vf) => {
				const m = vf.match(SNAP_RE);
				const ts = m ? m[1] : "";
				return {
					ts,
					formatted: ts.length === 15 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}` : ts,
					file: vf
				};
			});
			json(res, 200, list);
			return true;
		}
		if (pathname === "/api/woody/files/restore-version") {
			const body = await readBody(req);
			const target = String(body.path ?? "");
			const ts = String(body.ts ?? "");
			const guard = await guardPath(target);
			if (!guard.ok) {
				json(res, 403, { error: guard.error });
				return true;
			}
			if (!existsSync(target)) {
				json(res, 404, { error: "文件不存在" });
				return true;
			}
			const versionsDir = join(dirname(target), ".versions");
			if (!existsSync(versionsDir)) {
				json(res, 404, { error: "没有版本历史" });
				return true;
			}
			const baseName = basename(target).replace(/\.md$/i, "");
			let snapshotPath = join(versionsDir, `${baseName}.${ts}.md`);
			if (!existsSync(snapshotPath)) {
				const numbered = readdirSync(versionsDir).filter((f) => f.startsWith(`${baseName}.${ts}-`) && f.endsWith(".md")).sort();
				if (numbered.length === 0) {
					json(res, 404, { error: "指定版本不存在" });
					return true;
				}
				snapshotPath = join(versionsDir, numbered[0]);
			}
			const currentContent = readFileSync(target, "utf-8");
			const snaps = listSnapshots(versionsDir, baseName);
			const latestContent = snaps.length > 0 ? readFileSync(join(versionsDir, snaps[snaps.length - 1]), "utf-8") : null;
			if (latestContent === null || latestContent !== currentContent) writeFileSync(uniqueSnapshotPath(versionsDir, baseName, snapTS()), currentContent, "utf-8");
			const snapshotContent = readFileSync(snapshotPath, "utf-8");
			writeFileSync(target, snapshotContent, "utf-8");
			const updated = listSnapshots(versionsDir, baseName);
			while (updated.length > VERSION_KEEP) unlinkSync(join(versionsDir, updated.shift()));
			json(res, 200, {
				ok: true,
				content: snapshotContent,
				versionCount: updated.length
			});
			return true;
		}
		if (pathname === "/api/woody/files/resolve") {
			const parsed = parseFileAddress(String(query.get("addr") ?? ""));
			if (!parsed) {
				json(res, 200, {
					isScriptWorkspace: false,
					reason: "无法识别的文件地址"
				});
				return true;
			}
			if (parsed.scope === "session") {
				const ws = await findWorkspaceBySession(String(parsed.sessionId ?? ""));
				if (!ws || !ws.path) {
					bootLog(`resolve：会话 ${parsed.sessionId} 不属于任何工作区（${parsed.path}）`);
					json(res, 200, {
						isScriptWorkspace: false,
						reason: "该会话不属于任何工作区"
					});
					return true;
				}
				const abs = resolve(join(ws.path, parsed.path));
				const guard = await guardPath(abs);
				if (!guard.ok) {
					bootLog(`resolve：${abs} 不在剧本工作区内（工作区「${ws.title ?? ""}」缺骨架或路径越界）`);
					json(res, 200, {
						isScriptWorkspace: false,
						reason: "该工作区不是剧本工作区"
					});
					return true;
				}
				json(res, 200, {
					isScriptWorkspace: true,
					absolutePath: abs,
					workPath: guard.workPath
				});
				return true;
			}
			const guard = await guardPath(parsed.path);
			if (!guard.ok) {
				json(res, 200, {
					isScriptWorkspace: false,
					reason: "该路径不在剧本工作区内"
				});
				return true;
			}
			json(res, 200, {
				isScriptWorkspace: true,
				absolutePath: resolve(parsed.path),
				workPath: guard.workPath
			});
			return true;
		}
		json(res, 404, { error: "not found: " + pathname });
		return true;
	}
	return { handle };
}
//#endregion
//#region src/host/assets.ts
const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
const MIME = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".eot": "application/vnd.ms-fontobject",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8"
};
/** 静态资源路径钳制:/vditor/<rel> → assets/vditor/<rel>(拒绝 .. 与盘符;越界 404) */
function safeAssetPath(rel) {
	const parts = rel.replaceAll("\\", "/").split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0 || parts.includes("..") || parts.some((p) => /^[a-zA-Z]:$/.test(p))) return null;
	const base = resolve(join(ASSETS_DIR, "vditor"));
	const target = resolve(join(base, ...parts));
	if (!target.startsWith(base + sep)) return null;
	return target;
}
function createAssetsModule() {
	/** 处理本模块路由;未匹配返回 false */
	function handle(pathname, res) {
		if (!pathname.startsWith("/vditor/")) return false;
		const target = safeAssetPath(pathname.slice(8));
		if (!target || !existsSync(target) || !statSync(target).isFile()) {
			res.writeHead(404);
			res.end("not found");
			return true;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
			"cache-control": "no-cache"
		});
		createReadStream(target).pipe(res);
		return true;
	}
	return {
		handle,
		assetsRoot: ASSETS_DIR
	};
}
//#endregion
//#region src/host/skills.ts
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));
const MANIFEST_PATH = join(PLUGIN_DATA_DIR, "skills-manifest.json");
/** 用户级 skill 目录。与 DSH 自身的解析规则对齐(dsh-home-paths 源码实证):
*  显式配置 > $DSH_HOME 环境变量(空白视为未设) > 默认 ~/.dsh。
*  开源场景:其他用户的 DSH 数据根若被 DSH_HOME 挪过位置,这里必须跟过去,
*  否则同步进 ~/.dsh/skills 的技能 DSH 根本不扫。 */
function resolveUserSkillsRoot() {
	const envHome = process.env.DSH_HOME;
	const dshHome = envHome && envHome.trim() !== "" ? envHome.trim() : join(homedir(), ".dsh");
	return join(dshHome, "skills");
}
function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function loadManifest(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}
function walkFiles(dir, baseDir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, baseDir, out);
		else if (entry.isFile()) {
			const rel = full.slice(baseDir.length).replaceAll("\\", "/").replace(/^\//, "");
			out.push(rel);
		}
	}
	return out;
}
/**
* 把随包 skills/ 同步到用户级目录。任何异常都不外抛(不得影响 DSH 启动)。
* 允许通过参数覆盖各路径(自检用,与生产实例隔离)。
*/
function syncBundledSkills(opts = {}) {
	const result = {
		installed: [],
		updated: [],
		skipped: [],
		errors: []
	};
	try {
		const sourceDir = opts.sourceDir ?? BUNDLED_SKILLS_DIR;
		const targetRoot = opts.targetRoot ?? resolveUserSkillsRoot();
		const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
		const log = opts.log ?? (() => {});
		if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
			log("skill 同步:随包目录不存在,跳过(" + sourceDir + ")");
			return result;
		}
		const manifest = loadManifest(manifestPath);
		const nextManifest = {};
		const files = walkFiles(sourceDir, sourceDir);
		for (const rel of files) {
			const src = join(sourceDir, ...rel.split("/"));
			const dst = join(targetRoot, ...rel.split("/"));
			try {
				const srcHash = sha256File(src);
				nextManifest[rel] = srcHash;
				if (!existsSync(dst)) {
					mkdirSync(dirname(dst), { recursive: true });
					copyFileSync(src, dst);
					result.installed.push(rel);
					continue;
				}
				const dstHash = sha256File(dst);
				if (dstHash === srcHash) continue;
				if (manifest[rel] !== void 0 && dstHash === manifest[rel]) {
					copyFileSync(src, dst);
					result.updated.push(rel);
					continue;
				}
				result.skipped.push(rel);
			} catch (e) {
				result.errors.push(rel + ": " + String(e?.message ?? e));
			}
		}
		try {
			mkdirSync(dirname(manifestPath), { recursive: true });
			writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2), "utf-8");
		} catch (e) {
			result.errors.push("manifest: " + String(e?.message ?? e));
		}
		const parts = [];
		if (result.installed.length) parts.push("新装 " + result.installed.length);
		if (result.updated.length) parts.push("更新 " + result.updated.length);
		if (result.skipped.length) parts.push("保护跳过 " + result.skipped.length);
		if (result.errors.length) parts.push("失败 " + result.errors.length);
		if (parts.length) log("skill 同步:" + parts.join(","));
	} catch (e) {
		result.errors.push("sync: " + String(e?.message ?? e));
		try {
			opts.log?.("skill 同步失败:" + String(e?.message ?? e));
		} catch {}
	}
	return result;
}
//#endregion
//#region src/index.ts
const name = "woody-studio";
function apply(ctx, input = {}) {
	rotateLogIfNeeded();
	bootLog("apply() 被调用 —— 宿主端已加载(三合一)");
	try {
		setup(ctx, input);
		bootLog("setup() 完成");
	} catch (e) {
		bootLog("setup() 抛错：" + String(e?.message ?? e));
		try {
			ctx.logger?.error?.("[woody-studio] 初始化失败（插件已禁用自身功能，不影响 DSH）：" + String(e?.message ?? e));
		} catch {}
	}
}
function setup(ctx, input) {
	const { json, readBody } = makeHttpHelpers();
	const workspace = createWorkspaceModule({
		ctx,
		input,
		json,
		readBody
	});
	const files = createFilesModule({
		ctx,
		input,
		json,
		readBody
	});
	const assets = createAssetsModule();
	syncBundledSkills({ log: (m) => {
		bootLog(m);
		try {
			ctx.logger?.info?.("[woody-studio] " + m);
		} catch {}
	} });
	workspace.ensureWorks();
	const handler = async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "content-type");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		let pathname = "/";
		let query = new URLSearchParams();
		try {
			const u = new URL(String(req.url ?? "/"), "http://127.0.0.1");
			pathname = u.pathname;
			query = u.searchParams;
		} catch {}
		try {
			if (pathname === "/api/woody/ping") {
				json(res, 200, {
					ok: true,
					service: "woody-studio"
				});
				return;
			}
			if (pathname === "/api/woody/debug/log") {
				bootLog("DEBUG " + String(query.get("msg") ?? "").slice(0, 200));
				json(res, 200, { ok: true });
				return;
			}
			if (await workspace.handle(pathname, req, res, currentPort)) return;
			if (await files.handle(pathname, req, res, query)) return;
			if (assets.handle(pathname, res)) return;
			json(res, 404, { error: "not found: " + pathname });
		} catch (e) {
			bootLog("请求处理失败：" + String(e?.message ?? e));
			ctx.logger?.error?.("[woody-studio] 请求处理失败：" + String(e?.message ?? e));
			try {
				json(res, 500, { error: String(e?.message ?? e) });
			} catch {}
		}
	};
	const server = createServer((req, res) => {
		handler(req, res);
	});
	const basePort = Number(input?.port) || 43199;
	let currentPort = basePort;
	bootLog("准备监听 127.0.0.1:" + basePort + "（数据目录=" + PLUGIN_DATA_DIR + "，静态资源根=" + assets.assetsRoot + "）");
	const tryListen = () => {
		server.once("error", (err) => {
			bootLog("监听 " + currentPort + " 出错：" + String(err?.code ?? "") + " " + String(err?.message ?? err));
			if (err?.code === "EADDRINUSE" && currentPort < basePort + 10 - 1) {
				currentPort += 1;
				tryListen();
			} else ctx.logger?.error?.("[woody-studio] 本地服务启动失败：" + String(err?.message ?? err));
		});
		server.listen(currentPort, "127.0.0.1", () => {
			bootLog("监听成功：http://127.0.0.1:" + currentPort + "/api/woody/");
			ctx.logger?.info?.(`[woody-studio] 本地服务已就绪：http://127.0.0.1:${currentPort}/api/woody/`);
		});
	};
	tryListen();
	try {
		if (typeof ctx.effect === "function") ctx.effect(() => () => {
			try {
				server.close();
			} catch {}
		});
	} catch {}
}
//#endregion
export { apply, name, syncBundledSkills };
