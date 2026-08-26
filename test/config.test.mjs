import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.mjs'

test('plugin config validates defaults through Standard Schema', async () => {
  const result = await Config['~standard'].validate({})

  assert.deepEqual(result, {
    value: {
      hotTokens: 300,
      recallLimit: 20,
      targetDomain: 'work',
      debug: false,
      memosBaseUrl: 'http://127.0.0.1:18801',
      memosEnabled: true,
    },
  })
})

test('plugin config rejects an unknown target domain', async () => {
  const result = await Config['~standard'].validate({ targetDomain: 'unknown-domain' })

  assert.ok(result.issues?.length)
})
