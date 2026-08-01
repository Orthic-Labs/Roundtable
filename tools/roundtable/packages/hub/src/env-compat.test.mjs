import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnv } from './env-compat.mjs';

test('resolveEnv prefers CITADEL_ over deprecated ROUNDTABLE_ when both set', () => {
  const env = { CITADEL_LOG_LEVEL: 'debug', ROUNDTABLE_LOG_LEVEL: 'warn' };
  assert.equal(resolveEnv('CITADEL_LOG_LEVEL', 'ROUNDTABLE_LOG_LEVEL', env), 'debug');
});

test('resolveEnv falls back to deprecated ROUNDTABLE_ when CITADEL_ unset', () => {
  const env = { ROUNDTABLE_LOG_LEVEL: 'warn' };
  assert.equal(resolveEnv('CITADEL_LOG_LEVEL', 'ROUNDTABLE_LOG_LEVEL', env), 'warn');
});

test('resolveEnv returns undefined when neither is set', () => {
  assert.equal(resolveEnv('CITADEL_LOG_LEVEL', 'ROUNDTABLE_LOG_LEVEL', {}), undefined);
});

test('resolveEnv treats an empty CITADEL_ value as unset', () => {
  const env = { CITADEL_LOG_LEVEL: '', ROUNDTABLE_LOG_LEVEL: 'warn' };
  assert.equal(resolveEnv('CITADEL_LOG_LEVEL', 'ROUNDTABLE_LOG_LEVEL', env), 'warn');
});
