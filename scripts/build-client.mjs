// scripts/build-client.mjs — 生成 lib/client.js（window.__ModuleLoader__.load 闭包）。
// 零依赖：读 client/index.js（bundle-ready CJS 风格），包进 factory 模板。
// 运行：node scripts/build-client.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'client', 'index.js'), 'utf8')

// 源码以 "exports.apply = apply" 结尾（模板需要它）；构建时剥掉，由模板统一赋值
const body = source.replace(/\n\/\/ build\.mjs[\s\S]*$/, '')

const bundle = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-adaptive-context",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body.split('\n').map((line) => '\t\t' + line).join('\n'),
  '\t\texports.apply = apply;',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), bundle, 'utf8')
console.log('lib/client.js written (' + bundle.length + ' bytes)')
