// ============================================================
// 客户端产物包装器：把 tsdown 的 CJS 输出包成 DSH 模块系统要求的
// window.__ModuleLoader__.load({ id, factory }) 格式。
// 官方 bundle（见 dsh-client-ui-schedule/lib/client.js）就是这个形状：
//   - id: 包名
//   - factory(require): 内部自建 module/exports，末尾 return module.exports
// 不包这一层会在浏览器里报 "exports is not defined"。
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
const file = new URL('../lib/client.js', import.meta.url)
const inner = readFileSync(file, 'utf-8')

// 幂等：已包装过就跳过
if (inner.includes('__ModuleLoader__.load(')) {
  console.log('client.js 已是包装格式，跳过')
  process.exit(0)
}

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${inner.replace(/^(?!$)/gm, '\t\t')}
\t\treturn module.exports;
\t}
});
`

writeFileSync(file, wrapped, 'utf-8')
console.log(`已包装 lib/client.js（id=${pkg.name}）`)
