import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

async function provideClientServices(ctx) {
  await ctx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register() { return () => {} },
      })
      provider.provide('settingsScope', { bind() { return {} } })
    },
  })
}

test('built client plugin activates with its declared Cordis services', async (t) => {
  let registration
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.ok(registration)
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return { createElement() {}, useState() {}, useSyncExternalStore() {} }
  })

  // 0.1.6 路径：settingsScope 在 → 卡片照旧注册，条目激活
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await provideClientServices(ctx)
  await ctx.plugin(plugin)
  assert.deepEqual([...plugin.inject], ['slots'])

  // 0.1.7 路径：settingsScope 已被平台删除 → 条目必须照常激活、不注册卡片、绝不抛错
  const newCtx = new Context()
  t.after(() => newCtx.fiber.dispose())
  let registered = 0
  await newCtx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register() { registered += 1; return () => {} },
      })
    },
  })
  await newCtx.plugin({ apply: plugin.apply })
  assert.equal(registered, 0, '没有 settingsScope 时不应注册设置卡片')
})

test('settings section explains that blank fields fall back to plugin defaults', async (t) => {
  let registration
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const plugin = registration.factory(() => ({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }))

  let component
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register(_meta, value) { component = value; return () => {} },
      })
      provider.provide('settingsScope', {
        bind() {
          return {
            subscribe() { return () => {} },
            getSnapshot() { return { value: {}, user: {}, writable: true } },
            set() {},
            unset() {},
          }
        },
      })
    },
  })
  await ctx.plugin(plugin)
  assert.equal(typeof component, 'function')

  // 空 namespace（settings.yaml 无该键）下走一遍渲染，断言留空语义的提示确实出现在面板上
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(component())
  assert.ok(
    texts.some((text) => text.includes('未填写的项由插件采用设计默认')),
    'blank fields must be explained as falling back to plugin defaults',
  )
})
