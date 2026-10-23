import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { DaemonApi } from './daemon.js'

// ---- loopback URL handling ----

test('the api client accepts plain hostnames and adds http when omitted', () => {
  const api = new DaemonApi('localhost:9876', 'token')
  assert.equal(api.url, 'http://localhost:9876')
  assert.equal(api.token, 'token')

  const withScheme = new DaemonApi('http://127.0.0.1:1234', 'tok')
  assert.equal(withScheme.url, 'http://127.0.0.1:1234')

  const stripped = new DaemonApi('http://localhost:9/', 't')
  assert.equal(stripped.url, 'http://localhost:9')
})

test('the api client accepts nullish url as not ready', () => {
  assert.equal(new DaemonApi(null, 'tok').ready, false)
  assert.equal(new DaemonApi('http://localhost:9', null).ready, false)
  assert.equal(new DaemonApi('http://localhost:9', 'tok').ready, true)
})

test('device() points every call at another device through this daemon', () => {
  const api = new DaemonApi('http://localhost:9', 'tok')
  const remote = api.device('abc123')
  assert.equal(remote.url, 'http://localhost:9')
  assert.equal(remote.token, 'tok')
  assert.equal(remote.prefix, '/devices/abc123')
  assert.equal(api.device(null).prefix, '')
  assert.equal(api.device(undefined).prefix, '')
})

// ---- a real loopback handshake ----

test('a real loopback server answers healthz within the normal budget', async () => {
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull',
      )
      socket.destroy()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const api = new DaemonApi(`http://127.0.0.1:${port}`, 'token')
    assert.equal(await api.call('GET', '/healthz'), null)
  } finally {
    server.close()
  }
})

test('a socket drop during the request rejects as a network error', async () => {
  const server = createServer((socket) => {
    socket.on('data', () => socket.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const api = new DaemonApi(`http://127.0.0.1:${port}`, 'token')
    await assert.rejects(api.call('GET', '/healthz'), /fetch failed/)
  } finally {
    server.close()
  }
})

test('a non-2xx response throws the json error message', async () => {
  // The client throws on non-2xx, carrying the json error body as the
  // message so callers can show the daemon's own words. The status rides
  // on the error for retry/disambiguation (404 = dead session, 503 = busy).
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write(
        'HTTP/1.1 404 Not Found\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"error":"gone"}',
      )
      socket.destroy()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const api = new DaemonApi(`http://127.0.0.1:${port}`, 'token')
    await assert.rejects(
      api.call('GET', '/sessions/missing'),
      (err) => err.message === 'gone' && err.status === 404,
    )
  } finally {
    server.close()
  }
})

test('a 503 answer carries the status for retry decisions', async () => {
  // A 503 lets the caller tell a busy daemon from a dead connection.
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write(
        'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{"error":"busy now"}',
      )
      socket.destroy()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const api = new DaemonApi(`http://127.0.0.1:${port}`, 'token')
    await assert.rejects(
      api.call('GET', '/healthz'),
      (err) => err.message === 'busy now' && err.status === 503,
    )
  } finally {
    server.close()
  }
})
