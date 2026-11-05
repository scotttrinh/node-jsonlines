import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  parse,
  stringify,
  parseValues,
  stringifyValues,
} from '@scotttrinh/jsonlines'

test('exposes the ESM entry point and blocks CommonJS resolution', () => {
  for (const factory of [parse, stringify, parseValues, stringifyValues]) {
    assert.equal(typeof factory, 'function')
  }
  const require = createRequire(import.meta.url)
  assert.throws(() => require('@scotttrinh/jsonlines'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  })
})
