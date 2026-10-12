import { defineConfig } from 'tsdown'

// 双入口构建：
//   src/index.ts → lib/index.js   （宿主端，ESM，Cordis 加载）
//   src/client.ts → lib/client.js （浏览器端，CJS 工厂形式，DSH 模块系统加载）
// React 全部外部化：解析到 DSH 平台基线模块表。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    external: [/^@deepseek-ai\//, 'react', 'react-dom'],
  },
  {
    entry: ['src/client.ts'],
    outDir: 'lib',
    format: 'cjs',
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    external: [/^@deepseek-ai\//, 'react', 'react-dom'],
  },
])
