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
    return { h() {}, useState() {}, useSyncExternalStore() {} }
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
