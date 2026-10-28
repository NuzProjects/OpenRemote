// The account's device list is the last collection in the console without an
// answered flag, and the two views that read it said "no phones yet" and
// "0 devices" before the first answer arrived. Unknown is not empty: a list
// that has not answered is silence, not a claim, and this file pins that the
// flag exists in one place, that the three consumers wait for it, and that the
// remove-a-device hint says what actually happens tonight (the chats stay on
// that machine until they are deleted there) with the count the modal already
// shows two rows above.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
const console_ = source('state/console.jsx')
const machines = source('MachinesView.jsx')
const mobile = source('MobileView.jsx')
const modal = source('MachineModal.jsx')
const cloud = source('cloud.js')

test('the console answers the device list the way it answers every other list', () => {
  assert.match(console_, /const \[devicesAnswered, setDevicesAnswered\] = useState\(false\)/)
  // Set by the boot read, a beat, and the refresh the sign-in and kind calls use.
  assert.equal(
    (console_.match(/setDevicesAnswered\(true\)/g) ?? []).length,
    3,
    'boot, beat and refreshCloud all set the flag',
  )
  // Cleared with the other flags when the console points at another daemon, and
  // on sign-out, where the list is unknown again rather than empty.
  assert.match(console_, /setProjectsAnswered\(false\)\s*setDevicesAnswered\(false\)/)
  assert.match(console_, /setDevices\(\[\]\)[\s\S]{0,400}?setDevicesAnswered\(false\)/)
  // Exposed to every consumer, and in the memo dependency list so a flip reaches
  // the views rather than being memoised away.
  assert.equal((console_.match(/^\s+devicesAnswered,$/gm) ?? []).length, 2)
})

test('a remote chat is unknown until the device list has answered', () => {
  // The rule itself is unit tested in cloud.test.js; this pins that the list is
  // read through shape.js and that absence from an empty list is not "gone".
  assert.match(cloud, /Unknown is not empty/)
  assert.match(cloud, /rows\.length === 0 \? 'unknown' : 'gone'/)
  assert.match(cloud, /- 'unknown': the account is signed in but the device list has not answered/)
})

test('Machines does not count zero devices, or hide its own row, before an answer', () => {
  assert.match(machines, /const \{ devices, devicesAnswered, thisDevice, cloud, setDeviceKind \} = useConsole\(\)/)
  assert.match(machines, /devicesAnswered\s*\n\s*\? `\$\{list\.length\}/)
  assert.match(machines, /'Checking your devices…'/)
  // The self row survives an unanswered list through the account view's device.
  assert.match(machines, /const me = list\.find\(\(d\) => d\.id === thisDevice\) \?\? cloud\?\.device \?\? null/)
  assert.doesNotMatch(
    machines,
    /\{list\.length\} \{list\.length === 1 \? 'device' : 'devices'\} · \{onlineCount\} online/,
    'the unguarded count is gone',
  )
})

test('Mobile asks the empty question only after an answer', () => {
  assert.match(mobile, /const \{ devices, devicesAnswered, thisDevice, cloud, connection \} = useConsole\(\)/)
  assert.match(mobile, /devicesAnswered\s*\n\s*\? `\$\{phones\.length\}/)
  // The checking row comes before the empty row and is not the empty row.
  const checking = mobile.indexOf('<CheckingPhones />')
  const empty = mobile.indexOf('<NoPhonesYet />')
  assert.ok(checking > 0 && empty > checking, 'the reading state renders before the empty claim')
  assert.match(mobile, /function CheckingPhones\(\)/)
  assert.match(mobile, /!devicesAnswered \?/)
  assert.match(mobile, /<CheckingPhones \/>/)
  // A read that failed is not a read still coming: the branch that would say "checking"
  // for ever now asks the console's connection state first.
  assert.match(mobile, /const stalled = !devicesAnswered && connection\?\.state === 'error'/)
  assert.ok(
    mobile.indexOf('stalled ?') > 0 && mobile.indexOf('stalled ?') < checking,
    'the failure row is decided before the reading row',
  )
  assert.doesNotMatch(mobile, /'No phones in your Cloud yet\.'\s*\n\s*\)\}/, 'the empty row is not the fallback')
})

test('removing a device says the chats stay on it, and how many are at stake', () => {
  // The truth tonight: the device leaves the account and its copies stay on it
  // until they are deleted there. Nothing is "deleted on every device" here.
  assert.match(modal, /leaves your Cloud\. Its copies of synced chats stay on it until they are deleted there\./)
  assert.match(modal, /const chatCount = \(n\) => `\$\{n\} synced \$\{n === 1 \? 'chat' : 'chats'\}`/)
  // The rows a device runs carry the local's own name, `sessionRows`, and not a
  // `chats`: a local named like one of the console's own lists is how the palette
  // lost its Rules group on 2026-10-28, by shadowing the list a predicate read.
  assert.match(modal, /chatCount\(sessionRows\.length\)/)
  assert.doesNotMatch(modal, /const chats = /, 'no local named like a console list')
  assert.match(modal, /const syncedCopies = \(sessions \?\? \[\]\)\.filter\(\(s\) => s\.executor\)\.length/)
  // Leaving Cloud deletes the copies here, and the hint names how many.
  assert.match(modal, /deletes its \$\{chatCount\(syncedCopies\)\} here/)
  assert.doesNotMatch(
    modal,
    /deletes its copies of synced chats the next time it connects/,
    'the promise it cannot keep is gone',
  )
  assert.doesNotMatch(modal, /it deletes the synced chats it kept/, 'and so is the title that said it')
})
