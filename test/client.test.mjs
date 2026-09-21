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

  const negativeCtx = new Context()
  t.after(() => negativeCtx.fiber.dispose())
  await provideClientServices(negativeCtx)
  await assert.rejects(
    async () => { await negativeCtx.plugin({ apply: plugin.apply }) },
    /cannot get property "settingsScope" without inject/,
  )

  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await provideClientServices(ctx)
  await ctx.plugin(plugin)
  assert.deepEqual([...plugin.inject], ['slots', 'settingsScope'])
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
