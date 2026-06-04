import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import http from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'

const scriptPath = resolve(new URL('../llama-review.mjs', import.meta.url).pathname)

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'llama-review-test-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  writeFileSync(join(cwd, 'server.go'), 'package main\n\nfunc main() {}\n')
  git(cwd, ['add', 'server.go'])
  git(cwd, ['commit', '-m', 'base'])
  git(cwd, ['branch', 'base'])
  writeFileSync(join(cwd, 'server.go'), 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n')
  writeFileSync(join(cwd, 'server_test.go'), 'package main\n\nfunc TestMain(t *testing.T) {}\n')
  git(cwd, ['add', 'server.go', 'server_test.go'])
  git(cwd, ['commit', '-m', 'change'])
  return cwd
}

function makeModerateRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'llama-review-large-test-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  writeFileSync(join(cwd, 'base.go'), 'package main\n')
  git(cwd, ['add', 'base.go'])
  git(cwd, ['commit', '-m', 'base'])
  git(cwd, ['branch', 'base'])
  const funcs = Array.from({ length: 430 }, (_, i) => `func generated${i}() int { return ${i} }\n`).join('')
  const tests = Array.from({ length: 220 }, (_, i) => `func TestGenerated${i}(t *testing.T) {}\n`).join('')
  writeFileSync(join(cwd, 'a.go'), `package main\n\n${funcs}`)
  writeFileSync(join(cwd, 'z_test.go'), `package main\n\nimport "testing"\n\n${tests}`)
  git(cwd, ['add', 'a.go', 'z_test.go'])
  git(cwd, ['commit', '-m', 'large change'])
  return cwd
}

function makeFakePath() {
  const bin = mkdtempSync(join(tmpdir(), 'llama-review-bin-'))
  const ollama = join(bin, 'ollama')
  writeFileSync(ollama, '#!/bin/sh\nexit 0\n')
  chmodSync(ollama, 0o755)
  return `${bin}:${process.env.PATH}`
}

function withOllamaStub(handler, content = '{"findings":[]}') {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      const responseContent = typeof content === 'function' ? content(requests.at(-1)) : content
      res.end(JSON.stringify({
        model: requests.at(-1).model,
        message: { content: responseContent },
        total_duration: 1_000_000_000
      }))
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port
        resolve(await handler(`http://127.0.0.1:${port}`, requests))
      } catch (error) {
        reject(error)
      } finally {
        server.close()
      }
    })
  })
}

function runScript(cwd, args, host) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, PATH: makeFakePath(), OLLAMA_HOST: host },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('builds a structured JSON prompt for review lanes', async () => {
  const cwd = makeRepo()
  await withOllamaStub(async (host, requests) => {
    const result = await runScript(cwd, ['--target', 'base', '--effort', 'quick', '--lanes', 'backend'], host)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(requests.length, 1)
    const prompt = requests[0].messages[0].content
    assert.match(prompt, /Return ONLY valid JSON/)
    assert.match(prompt, /"findings": \[/)
    assert.match(prompt, /"severity": "CRITICAL\|HIGH\|MEDIUM\|LOW"/)
  })
})

test('reports effort and only labels truly unmatched lanes as skipped', async () => {
  const cwd = makeRepo()
  await withOllamaStub(async (host) => {
    const result = await runScript(cwd, ['--target', 'base', '--effort', 'quick'], host)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /\| backend \| glm-5\.1:cloud \| ollama API \| quick \| NO_ISSUES \|/)
    assert.doesNotMatch(result.stdout, /Skipped: security \(no matching files\)/)
    assert.doesNotMatch(result.stdout, /Skipped: simplify \(no matching files\)/)
    assert.match(result.stdout, /`go test \.\/`/)
    assert.doesNotMatch(result.stdout, /go test \.\/\.\.\. -run \./)
  })
})

test('uses lane-specific default focus', async () => {
  const cwd = makeRepo()
  await withOllamaStub(async (host, requests) => {
    const result = await runScript(cwd, ['--target', 'base', '--effort', 'quick', '--lanes', 'tests'], host)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(requests.length, 1)
    const prompt = requests[0].messages[0].content
    assert.match(prompt, /missing test coverage/)
    assert.match(prompt, /broken assertions/)
    assert.match(prompt, /edge cases/)
  })
})

test('keeps moderate test diffs in lane context', async () => {
  const cwd = makeModerateRepo()
  await withOllamaStub(async (host, requests) => {
    const result = await runScript(cwd, ['--target', 'base', '--effort', 'quick', '--lanes', 'tests'], host)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(requests.length, 1)
    assert.match(requests[0].messages[0].content, /diff --git a\/z_test\.go b\/z_test\.go/)
  })
})

test('summarizes attention-only findings without empty critical text', async () => {
  const cwd = makeRepo()
  const content = JSON.stringify({
    findings: [{
      severity: 'HIGH',
      file: 'server.go',
      line: 3,
      code: 'println("hi")',
      issue: 'The new behavior has no assertion around the changed output path.',
      confidence: 'high',
      fix: 'Add a focused test that asserts the changed output path.'
    }]
  })

  await withOllamaStub(async (host) => {
    const result = await runScript(cwd, ['--target', 'base', '--effort', 'quick', '--lanes', 'tests'], host)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Review found 1 issue needing attention across 1 lanes\./)
    assert.doesNotMatch(result.stdout, /Critical findings in \./)
    assert.doesNotMatch(result.stdout, /Address critical items before merge\./)
    assert.doesNotMatch(result.stdout, /folded into backend/)
  }, content)
})
