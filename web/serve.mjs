#!/usr/bin/env node
/**
 * Static file server for local development. Serves web/ plus docs/blog.
 *
 *   node web/serve.mjs
 *   # → http://127.0.0.1:8766/
 *
 * Deliberately makes no outbound requests. This tool never fetches anything
 * from teenage.engineering — not the firmware, not the factory packs, not the
 * version list. The only traffic to TE is a link a person chooses to click.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'web')
const DOCS = path.join(ROOT, 'docs')

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8766)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function send(res, status, body, type) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

function safeJoin(root, rel) {
  const target = path.resolve(root, rel)
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    return null
  }
  return target
}

async function handler(req, res) {
  let url
  try {
    url = new URL(req.url || '/', `http://${HOST}`)
  } catch {
    // A protocol-relative request target like "//" is a valid thing to receive
    // and an invalid thing to pass to new URL(). 400, not a 500 stack trace.
    return send(res, 400, 'bad request target', 'text/plain; charset=utf-8')
  }
  const p = url.pathname

  let fileRoot = WEB
  let rel = p === '/' ? 'index.html' : p.slice(1)
  if (p.startsWith('/blog/')) {
    fileRoot = path.join(DOCS, 'blog')
    rel = p.slice('/blog/'.length)
  } else if (p.startsWith('/disclosure/')) {
    fileRoot = path.join(DOCS, 'disclosure')
    rel = p.slice('/disclosure/'.length)
  }

  const target = safeJoin(fileRoot, rel)
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return send(res, 404, `missing ${p}`, 'text/plain; charset=utf-8')
  }
  const ext = path.extname(target)
  send(res, 200, fs.readFileSync(target), MIME[ext] || 'application/octet-stream')
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err)
    if (!res.headersSent) send(res, 500, 'internal error', 'text/plain; charset=utf-8')
  })
})

server.listen(PORT, HOST, () => {
  console.log(`ep-unity web → http://${HOST}:${PORT}/`)
  console.log('  /api/releases  live TE032 firmware catalog')
  console.log('  /api/factory   Sample Tool factory .pak URLs')
  console.log('  /blog/         docs/blog')
  console.log('  /disclosure/   private heads-up letter')
})
