/**
 * dsh-agentos-remote envelope tests — run with: node test/envelope.test.mjs
 *
 * Pins the encrypted-envelope contract the mobile app speaks on the device
 * channels: the signed canonical serialization, AES-GCM-256 with the pipe-
 * delimited AAD, multi-part reassembly, and the scope-based key lookup the
 * credentials use. Tampering anywhere must fail loudly.
 */
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import {
  ENVELOPE_MAX_PAYLOAD_BYTES,
  ENVELOPE_OVERHEAD,
  assembleEnvelopes,
  envelopeAAD,
  envelopeSerialize,
  envelopeSignatureValid,
  lookupScopeKey,
  packEnvelopes,
  resolveChannelKeys,
} from '../lib/envelope.js'

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
  }
}

const encKey = randomBytes(32)
const sigKey = randomBytes(32)
const CREDENTIALS = {
  keyVersion: 7,
  encryptionKeys: {
    'executor:dev-1': encKey.toString('base64'),
    'reply:#uid-1': encKey.toString('base64'),
    'user:uid-1:conversations': encKey.toString('base64'),
  },
  signingKeys: {
    'executor:dev-1': sigKey.toString('base64'),
    'reply:#uid-1': sigKey.toString('base64'),
    'user:uid-1:conversations': sigKey.toString('base64'),
  },
}

console.log('dsh-agentos-remote envelope tests\n')

await check('the signed serialization omits absent optional fields in canonical order', () => {
  const base = { v: 1, msgId: 'm', partIndex: 0, partTotal: 1, eventId: 'e', ts: 1, iv: 'i', ciphertext: 'c', tag: 't', keyVersion: 7 }
  assert.equal(
    envelopeSerialize({ ...base }).toString('utf8'),
    JSON.stringify({ v: 1, msgId: 'm', partIndex: 0, partTotal: 1, eventId: 'e', ts: 1, iv: 'i', ciphertext: 'c', tag: 't', keyVersion: 7 }),
  )
  assert.equal(
    envelopeSerialize({ ...base, seq: 3, senderDeviceId: 'd', eventType: 'x' }).toString('utf8'),
    JSON.stringify({ v: 1, msgId: 'm', partIndex: 0, partTotal: 1, eventId: 'e', seq: 3, ts: 1, iv: 'i', ciphertext: 'c', tag: 't', keyVersion: 7, senderDeviceId: 'd', eventType: 'x' }),
    'seq sits after eventId; senderDeviceId and eventType trail keyVersion',
  )
})

await check('the AAD is the pipe-delimited routing tuple', () => {
  assert.deepEqual(envelopeAAD('m', 0, 2, 7), Buffer.from('m|0|2|7', 'utf8'))
})

await check('a packed delivery reassembles to the original payload', () => {
  const payload = { type: 'prompt.submit', prompt: '查一下日志', replyChannel: 'reply:abc#uid-1' }
  const envelopes = packEnvelopes(payload, encKey, sigKey, 7, { senderDeviceId: 'dev-1' })
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0].partTotal, 1)
  assert.ok(envelopeSignatureValid(envelopes[0], sigKey))
  const roundtrip = assembleEnvelopes(envelopes, encKey, sigKey)
  assert.deepEqual(roundtrip, payload)
})

await check('a large payload splits into parts that reassemble in order', () => {
  const payload = { text: 'x'.repeat((ENVELOPE_MAX_PAYLOAD_BYTES - ENVELOPE_OVERHEAD) * 2 + 5) }
  const envelopes = packEnvelopes(payload, encKey, sigKey, 7)
  assert.equal(envelopes.length, 3)
  assert.deepEqual(assembleEnvelopes(envelopes, encKey, sigKey), payload)
  // a missing part can never silently decrypt
  assert.throws(() => assembleEnvelopes(envelopes.slice(0, 2), encKey, sigKey), /expected 3 parts/)
})

await check('tampering with any signed field fails verification', () => {
  const [envelope] = packEnvelopes({ a: 1 }, encKey, sigKey, 7)
  const tampered = { ...envelope, ciphertext: Buffer.from('evil').toString('base64') }
  assert.equal(envelopeSignatureValid(tampered, sigKey), false)
  assert.throws(() => assembleEnvelopes([tampered], encKey, sigKey), /HMAC verify failed/)
})

await check('keys resolve by exact scope, user reduction, and never fall through', () => {
  assert.ok(lookupScopeKey(CREDENTIALS.encryptionKeys, 'executor:dev-1'))
  assert.ok(lookupScopeKey(CREDENTIALS.encryptionKeys, 'reply:random-id#uid-1'), 'the reply scope reduces to the shared user key')
  assert.equal(lookupScopeKey(CREDENTIALS.encryptionKeys, 'executor:other-device'), null)
  assert.equal(lookupScopeKey(CREDENTIALS.encryptionKeys, 'unknown:x'), null)
  const keys = resolveChannelKeys(CREDENTIALS, 'reply:abc#uid-1')
  assert.equal(keys.keyVersion, 7)
  assert.equal(keys.enc.length, 32)
  assert.equal(resolveChannelKeys(CREDENTIALS, 'user:uid-9:conversations'), null, 'a scope with no grant resolves to null')
})

await check('an envelope signed under a different key set is rejected', () => {
  const otherSig = randomBytes(32)
  const [envelope] = packEnvelopes({ a: 1 }, encKey, otherSig, 7)
  assert.throws(() => assembleEnvelopes([envelope], encKey, sigKey), /HMAC verify failed/)
})

await check('hmac construction matches the canonical input directly', () => {
  // Independent construction: same bytes the verifier must compute.
  const [envelope] = packEnvelopes({ b: 2 }, encKey, sigKey, 7)
  const expected = createHmac('sha256', sigKey).update(envelopeSerialize(envelope)).digest('base64')
  assert.equal(envelope.sig, expected)
})

console.log(failed === 0 ? '\nall envelope checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
