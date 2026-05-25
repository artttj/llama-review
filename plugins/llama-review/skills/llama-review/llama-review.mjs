#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const SCRIPT_DIR = dirname(resolve(process.argv[1]))

const LANE_PATTERNS = {
  frontend: [
    '*.tsx', '*.jsx', '*.vue', '*.svelte', '*.astro',
    '*.css', '*.scss', '*.less', '*.html', '*.mdx',
    '*.d.ts', '*.j2', '*.twig', '*.blade.php', 'templates/**'
  ],
  backend: [
    '*.php', '*.py', '*.rb', '*.go', '*.java', '*.rs', '*.kt',
    '*.ts', '*.js', '*.cs', '*.scala', '*.c', '*.cpp', '*.h', '*.hpp',
    '*.sql', '*.graphql', '*.proto', '*.tf'
  ],
  security: ['*'],
  tests: [
    '*.test.*', '*_test.*', '*.spec.*', '*_spec.*', '*.phpunit.*',
    '*.cy.*', '*.e2e.*', '*.integration.*', '*.stories.*',
    'tests/**', '__tests__/**', 'spec/**'
  ],
  simplify: ['*']
}

const EXCLUDE_FROM_BACKEND = [
  '*.test.*', '*_test.*', '*.spec.*', '*_spec.*',
  '*.tsx', '*.jsx', '*.vue', '*.svelte', '*.astro',
  '*.css', '*.scss', '*.less', '*.html', '*.mdx'
]

const EFFORT_TOKENS = { quick: 8000, normal: 32000, deep: 64000 }

const EFFORT_BEHAVIOR = {
  quick: 'QUICK SCAN: Flag only the most obvious issues. Skip deep analysis. Aim for 0-3 findings max.',
  normal: 'THOROUGH REVIEW: Examine every changed line. Check for edge cases, regressions, and correctness.',
  deep: 'EXHAUSTIVE ANALYSIS: Trace every code path. Consider interactions with unchanged code. Flag anything suspicious, even at low confidence.'
}

const DEFAULT_MODELS = {
  frontend: 'qwen3.5:cloud',
  backend: 'glm-5.1:cloud',
  security: 'kimi-k2.6:cloud',
  tests: 'deepseek-v4-flash:cloud',
  simplify: 'minimax-m2.7:cloud'
}

const DEFAULT_LANE_CONFIG = {
  frontend: { timeout: 180, retries: 1 },
  backend: { timeout: 240, retries: 1, thinking: true },
  security: { timeout: 180, retries: 1, thinking: true },
  tests: { timeout: 120, retries: 1 },
  simplify: { timeout: 120, retries: 0 }
}

function parseArgs(argv) {
  const args = { target: 'origin/main', effort: 'normal', lanes: [], local: false, jira: false, init: false, json: false }
  let i = 2
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--local') { args.local = true; i++ }
    else if (arg === '--jira') { args.jira = true; i++ }
    else if (arg === '--init') { args.init = true; i++ }
    else if (arg === '--json') { args.json = true; i++ }
    else if (arg === '--effort' && i + 1 < argv.length) { args.effort = argv[++i]; i++ }
    else if (arg === '--target' && i + 1 < argv.length) { args.target = argv[++i]; i++ }
    else if (arg === '--lanes' && i + 1 < argv.length) { args.lanes = argv[++i].split(',').map(s => s.trim()); i++ }
    else if (arg === '--config' && i + 1 < argv.length) { args.configPath = argv[++i]; i++ }
    else if (arg.startsWith('target=')) { args.target = arg.slice(7); i++ }
    else if (arg.startsWith('lanes=')) { args.lanes = arg.slice(6).split(',').map(s => s.trim()); i++ }
    else if (arg.startsWith('last ')) {
      const n = parseInt(arg.split(' ')[1], 10)
      if (n > 0) args.target = `HEAD~${n}`
      i++
    }
    else { i++ }
  }
  if (!['quick', 'normal', 'deep'].includes(args.effort)) {
    console.error(`Invalid effort level: ${args.effort}. Use quick, normal, or deep.`)
    process.exit(1)
  }
  if (!/^[a-zA-Z0-9._/\-]+$/.test(args.target)) {
    console.error(`Invalid target ref: ${args.target}`)
    process.exit(1)
  }
  return args
}

function parseYaml(text) {
  const lines = text.split('\n')
  const root = {}
  const stack = [{ obj: root, indent: -1 }]
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    i++
    const trimmed = raw.trimStart()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = raw.length - trimmed.length
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const current = stack[stack.length - 1].obj
    if (trimmed.startsWith('- ')) {
      const key = stack[stack.length - 1].key
      if (key && !Array.isArray(current[key])) current[key] = []
      const val = parseValue(trimmed.slice(2).trim())
      if (key) current[key].push(val)
      continue
    }
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let val = trimmed.slice(colonIdx + 1).trim()
    if (!val) {
      current[key] = {}
      stack.push({ obj: current[key], indent, key })
    } else {
      current[key] = parseValue(val)
    }
  }
  return root
}

function parseValue(val) {
  if (val === 'true') return true
  if (val === 'false') return false
  if (val === 'null' || val === '~') return null
  if (/^-?\d+$/.test(val)) return parseInt(val, 10)
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val)
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    return val.slice(1, -1)
  return val
}

function loadConfig(configPath, args) {
  const paths = [
    configPath,
    join(process.cwd(), '.llama-review.yml'),
    join(SCRIPT_DIR, '.llama-review.yml')
  ].filter(Boolean)

  let config = null
  for (const p of paths) {
    if (p && existsSync(p)) {
      try {
        config = parseYaml(readFileSync(p, 'utf8'))
        break
      } catch (e) {
        console.error(`Config parse error (${p}): ${e.message}`)
      }
    }
  }

  if (!config) config = {}
  const models = { ...DEFAULT_MODELS, ...(config.models || {}) }
  if (args.local) {
    for (const k of Object.keys(models)) {
      if (typeof models[k] === 'string') models[k] = models[k].replace(/:cloud$/, '')
    }
  }
  for (const k of Object.keys(models)) {
    if (models[k] === false) delete models[k]
  }
  return {
    models,
    effort: { ...EFFORT_TOKENS, ...(config.effort || {}) },
    local: args.local || config.local || false,
    exclude: config.exclude || [],
    laneConfig: { ...DEFAULT_LANE_CONFIG, ...(config.lane_config || {}) },
    customLanes: config.lanes || {}
  }
}

function saveDefaultConfig() {
  const yaml = `# Llama Review — Multi-Model Review Swarm Configuration
# https://github.com/artttj/llama-review

exclude:
  # - "packages/exercises/src/data/exercises/**"
  # - "**/seed.sql"
  # - "**/messages.js"
  # - "**/messages.po"

models:
  frontend: "qwen3.5:cloud"
  backend: "glm-5.1:cloud"
  security: "kimi-k2.6:cloud"
  tests: "deepseek-v4-flash:cloud"
  simplify: "minimax-m2.7:cloud"

effort:
  quick: 8000
  normal: 32000
  deep: 64000

local: false

lane_config:
  frontend:
    timeout: 180
    retries: 1
  backend:
    timeout: 240
    retries: 1
    thinking: true
  security:
    timeout: 180
    retries: 1
    thinking: true
  tests:
    timeout: 120
    retries: 1
  simplify:
    timeout: 120
    retries: 0

# Custom review lanes (extend built-in defaults):
# lanes:
#   magento:
#     files: "app/code/**, etc/**/*.xml, Plugin/**, Observer/**"
#     focus: "DI mistakes, plugin sort order, cache scope config, setup patches"
#     model: "kimi-k2.6:cloud"
#     timeout: 180
#     retries: 1
`
  const path = join(process.cwd(), '.llama-review.yml')
  writeFileSync(path, yaml)
  console.log(`Config saved to ${path}`)
}

function globToRegex(pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  if (!re.startsWith('.*')) re = '(.*/)?' + re
  return new RegExp(re + '$')
}

function matchesPattern(file, patterns) {
  for (const p of patterns) {
    if (p.startsWith('*') && !p.includes('/')) {
      if (file.endsWith(p.slice(1))) return true
    } else if (p.endsWith('/')) {
      if (file.startsWith(p) || file.includes('/' + p)) return true
    } else {
      try {
        if (globToRegex(p).test(file)) return true
      } catch { /* skip invalid patterns */ }
    }
  }
  return false
}

function getChangedFiles(target) {
  const out = execSync(`git diff "${target}"...HEAD --name-only`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  return out ? out.split('\n').filter(Boolean) : []
}

function getDiff(target, excludes) {
  let cmd = `git diff "${target}"...HEAD`
  if (excludes.length > 0) {
    for (const p of excludes) {
      cmd += ` -- ':!${p}'`
    }
  }
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }).trim()
  } catch (e) {
    if (e.stderr && e.stderr.includes('not found')) return ''
    throw e
  }
}

function filterDiffForLane(fullDiff, files) {
  const hunks = fullDiff.split(/(?=^diff --git )/m)
  return hunks.filter(hunk => {
    const match = hunk.match(/^diff --git a\/(.+?) b\/|^diff --git a\/"(.+?)"/m)
    if (!match) return false
    const file = match[1] || match[2]
    return files.includes(file)
  }).join('')
}

function truncateDiff(diff, limit = 20000) {
  if (diff.length <= limit) return { diff, dropped: [] }
  const files = diff.split(/(?=^diff --git )/m)
  let result = ''
  const dropped = []
  for (const file of files) {
    if ((result + file).length > limit) {
      const name = file.match(/^diff --git a\/(\S+)/)?.[1] || 'unknown'
      dropped.push(name)
      continue
    }
    result += file
  }
  return { diff: result, dropped }
}

function assignFilesToLanes(changedFiles, customLanes) {
  const assignments = {}
  const allLanes = { ...LANE_PATTERNS }
  for (const [name, cfg] of Object.entries(customLanes)) {
    if (cfg.files) {
      allLanes[name] = cfg.files.split(',').map(s => s.trim())
    } else {
      allLanes[name] = ['*']
    }
  }

  for (const file of changedFiles) {
    for (const [lane, patterns] of Object.entries(allLanes)) {
      if (!assignments[lane]) assignments[lane] = []
      let matches = matchesPattern(file, patterns)
      if (lane === 'backend' && matches) {
        matches = !matchesPattern(file, EXCLUDE_FROM_BACKEND)
      }
      if (matches && !assignments[lane].includes(file)) {
        assignments[lane].push(file)
      }
    }
  }
  return assignments
}

function applyConsolidation(assignments, totalFiles) {
  const active = Object.entries(assignments).filter(([, files]) => files.length > 0).sort((a, b) => b[1].length - a[1].length)

  if (totalFiles <= 3 && active.length > 1) {
    const primary = active[0]
    const folded = active.slice(1)
    return {
      lanes: { [primary[0]]: { files: primary[1], folded: folded.map(f => f[0]) } },
      skipped: folded.map(f => f[0]),
      consolidated: true
    }
  }

  if (totalFiles >= 4 && totalFiles <= 10 && active.length > 2) {
    const primary = active.slice(0, 2)
    const folded = active.slice(2)
    const result = {}
    for (const [name, files] of primary) {
      result[name] = { files, folded: [] }
    }
    const secIdx = primary.findIndex(p => p[0] === 'security')
    if (secIdx >= 0 && primary.length > 1) {
      const other = primary.find(p => p[0] !== 'security')
      if (other) result[other[0]].folded.push('security')
    }
    return { lanes: result, skipped: folded.map(f => f[0]), consolidated: true }
  }

  const result = {}
  for (const [name, files] of active) {
    result[name] = { files, folded: [] }
  }
  return { lanes: result, skipped: [], consolidated: false }
}

function loadPromptTemplate(lane, skillDir) {
  const paths = [
    join(homedir(), '.claude', 'skills', 'llama-review', 'prompts', `${lane}.md`),
    join(process.cwd(), '.llama-review', 'prompts', `${lane}.md`),
    join(skillDir, 'prompts', `${lane}.md`)
  ]
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  return null
}

function buildPrompt(lane, effort, laneDiff, template, foldedConcerns, customFocus) {
  let prompt = template || `You are a ${lane} specialist reviewing a unified diff.\n\n`
  if (!template) {
    prompt += 'Focus areas: code correctness, edge cases, regressions.\n\n'
  }
  prompt = prompt.replace(/<EFFORT>/g, EFFORT_BEHAVIOR[effort])
  if (customFocus) {
    prompt += `\nAdditional focus: ${customFocus}\n`
  }
  if (foldedConcerns.length > 0) {
    prompt += `\nAlso check for: ${foldedConcerns.join(', ')}.\n`
  }
  if (lane === 'security' && !customFocus) {
    prompt += '\nThe backend lane is also reviewing this diff. Focus exclusively on security vulnerabilities — injection, auth bypass, data exposure, path traversal, unsafe deserialization, missing CSRF, and cryptographic weaknesses. Skip bugs, performance issues, code style, and general code quality concerns that the backend lane will catch. If no security-specific issues exist, return empty findings even if you see non-security problems.\n'
  }
  prompt += '\n---\nDIFF:\n' + laneDiff
  return prompt
}

function scaleNumPredict(diffLength, baseTokens, isThinkingModel) {
  const diffTokens = Math.ceil(diffLength / 4)
  let numPredict = Math.min(Math.max(diffTokens * 2, baseTokens), 65536)
  if (isThinkingModel) numPredict = Math.max(numPredict, 32768)
  return numPredict
}

function ollamaRequest(model, prompt, numPredict, timeout) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { num_predict: numPredict }
    })

    const url = new URL('/api/chat', OLLAMA_HOST)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeout * 1000
    }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.error) {
            reject(new Error(data.error))
            return
          }
          const content = data.message?.content || ''
          const thinking = data.message?.thinking || ''
          resolve({ content, thinking, model: data.model, totalDuration: data.total_duration })
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(payload)
    req.end()
  })
}

async function dispatchWithRetry(model, prompt, numPredict, laneConfig) {
  const timeout = laneConfig.timeout || 180
  const retries = laneConfig.retries ?? 1
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await ollamaRequest(model, prompt, numPredict, timeout)
      return { ...result, success: true, attempts: attempt + 1 }
    } catch (e) {
      lastError = e
      if (attempt < retries && e.message !== 'model not found') {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
  }
  return { success: false, error: lastError?.message || 'unknown', attempts: retries + 1 }
}

function stripThinkingBlocks(text) {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<<reasoning>>[\s\S]*?<<\/reasoning>>/g, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^\s*﻿?/, '')
    .trim()
}

function parseFindings(rawOutput, lane) {
  if (!rawOutput || !rawOutput.trim()) return { findings: [], format: 'empty' }

  const cleaned = stripThinkingBlocks(rawOutput)
  if (cleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleaned)
      if (parsed.findings && Array.isArray(parsed.findings)) {
        return { findings: parsed.findings.map(f => normalizeJsonFinding(f, lane)), format: 'json' }
      }
    } catch {
      const jsonMatch = cleaned.match(/\{[\s\S]*"findings"[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed.findings) return { findings: parsed.findings.map(f => normalizeJsonFinding(f, lane)), format: 'json-extracted' }
        } catch { /* fall through */ }
      }
    }
  }

  if (cleaned === 'NO_ISSUES' || cleaned.includes('"findings": []')) {
    return { findings: [], format: 'no-issues' }
  }

  return parseTextFindings(cleaned, lane)
}

function normalizeJsonFinding(f, lane) {
  return {
    severity: (f.severity || 'MEDIUM').toUpperCase(),
    file: f.file || '',
    line: f.line || 0,
    code: f.code || '',
    issue: f.issue || f.failure || '',
    confidence: (f.confidence || 'medium').toLowerCase(),
    fix: f.fix || '',
    lane
  }
}

function parseTextFindings(text, lane) {
  const findings = []
  const blocks = text.split(/(?=^FILE:)/m).filter(Boolean)
  for (const block of blocks) {
    if (!block.startsWith('FILE:')) continue
    const file = block.match(/^FILE:\s*(.+)/m)?.[1]?.trim() || ''
    const line = parseInt(block.match(/^LINE:\s*(\d+)/m)?.[1] || '0', 10)
    const code = block.match(/^CODE:\s*([\s\S]*?)(?=^FAILURE:)/m)?.[1]?.trim() || ''
    const issue = block.match(/^FAILURE:\s*([\s\S]*?)(?=^CONFIDENCE:)/m)?.[1]?.trim() || ''
    const confidence = block.match(/^CONFIDENCE:\s*(\w+)/m)?.[1]?.toLowerCase() || 'low'
    const fix = block.match(/^FIX:\s*([\s\S]*?)(?=^FILE:|$)/m)?.[1]?.trim() || ''
    if (file && issue) {
      findings.push({ severity: 'MEDIUM', file, line, code, issue, confidence, fix, lane })
    }
  }
  if (findings.length === 0) {
    const lines = text.split('\n')
    for (const line of lines) {
      const m = line.match(/^[-*]\s+`?([a-zA-Z0-9_/.-]+\.[a-zA-Z]+)`?\s*:(\d+)/)
      if (m) {
        findings.push({ severity: 'MEDIUM', file: m[1], line: parseInt(m[2], 10), code: '', issue: line.trim(), confidence: 'low', fix: '', lane })
      }
    }
  }
  return { findings, format: findings.length > 0 ? 'text' : 'unstructured' }
}

function mergeFindings(allFindings) {
  const map = new Map()
  for (const f of allFindings) {
    const key = `${f.file}:${f.line}:${f.issue.slice(0, 60)}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, f)
    } else if (f.confidence === 'high' && existing.confidence !== 'high') {
      map.set(key, f)
    } else if (f.issue.length > existing.issue.length) {
      map.set(key, f)
    }
  }
  return Array.from(map.values())
}

function rankFindings(findings) {
  const critical = [], needsAttention = [], noted = []
  for (const f of findings) {
    const sev = f.severity.toUpperCase()
    const conf = f.confidence
    if (
      (sev === 'CRITICAL') ||
      (conf === 'high' && ['security vulnerability', 'data loss', 'data corruption', 'crash', 'auth bypass', 'injection'].some(k => f.issue.toLowerCase().includes(k)))
    ) {
      critical.push(f)
    } else if (conf === 'high' || (conf === 'medium' && sev !== 'LOW')) {
      needsAttention.push(f)
    } else {
      noted.push(f)
    }
  }
  return { critical, needsAttention, noted }
}

function validateFinding(f) {
  return f.file && f.line > 0 && f.issue && f.issue.length > 10 &&
    !f.issue.match(/^(consider|could|might|should|maybe|perhaps)/i)
}

function detectTestCommands(files) {
  const cmds = []
  const has = ext => files.some(f => f.endsWith(ext))
  if (has('.php')) cmds.push('php vendor/bin/phpunit --filter=' + files.filter(f => f.includes('test') || f.includes('Test')).join(','))
  if (has('.ts') || has('.tsx') || has('.js') || has('.jsx')) cmds.push('npx jest --findRelatedTests ' + files.filter(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js')).join(' '))
  if (has('.py')) cmds.push('python -m pytest ' + files.filter(f => f.includes('test') || f.includes('spec')).join(' ') + ' -v')
  if (has('.go')) cmds.push('go test ./... -run ' + files.filter(f => f.includes('test')).map(f => dirname(f)).join('|'))
  if (has('.rs')) cmds.push('cargo test -p ' + [...new Set(files.filter(f => f.endsWith('.rs')).map(f => dirname(f).split('/')[0]))].join(','))
  return cmds.filter(c => !c.endsWith('=') && c.trim().length > 5)
}

function formatDuration(ns) {
  if (!ns) return 'N/A'
  const s = ns / 1e9
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function generateReport(results, rankedFindings, config, assignments, skipped, consolidated, diffSize, totalFiles) {
  const { critical, needsAttention, noted } = rankedFindings
  const allFindings = [...critical, ...needsAttention, ...noted]
  const lines = []

  lines.push('## Models Used')
  lines.push('')
  lines.push('| Lane | Model | Dispatch | Effort | Result | Duration |')
  lines.push('|------|-------|----------|--------|--------|---------|')
  for (const r of results) {
    const result = r.success
      ? (r.findingCount === 0 ? 'NO_ISSUES' : `${r.findingCount} finding${r.findingCount > 1 ? 's' : ''}`)
      : `Failed: ${r.error}`
    lines.push(`| ${r.lane} | ${r.model} | ollama API | ${r.effort} | ${result} | ${formatDuration(r.duration)} |`)
  }
  lines.push('')

  if (consolidated || skipped.length > 0) {
    lines.push('## Consolidated')
    for (const [lane, info] of Object.entries(assignments)) {
      if (info.folded && info.folded.length > 0) {
        lines.push(`- ${info.folded.join(', ')} folded into ${lane}`)
      }
    }
    for (const s of skipped) {
      lines.push(`- Skipped: ${s} (no matching files)`)
    }
    lines.push('')
  }

  lines.push('## Critical')
  if (critical.length === 0) {
    lines.push('No critical findings.')
  } else {
    for (const f of critical) {
      lines.push(`- [${f.file}:${f.line}] ${f.issue} → ${f.fix} (${f.confidence})`)
    }
  }
  lines.push('')

  lines.push('## Needs Attention')
  if (needsAttention.length === 0) {
    lines.push('No issues needing attention.')
  } else {
    for (const f of needsAttention) {
      lines.push(`- [${f.file}:${f.line}] ${f.issue} → ${f.fix} (${f.confidence})`)
    }
  }
  lines.push('')

  lines.push('## Noted')
  if (noted.length === 0) {
    lines.push('No low-confidence findings.')
  } else {
    for (const f of noted) {
      lines.push(`- [${f.file}:${f.line}] ${f.issue} (${f.confidence})`)
    }
  }
  const noIssuesLanes = results.filter(r => r.success && r.findingCount === 0).map(r => r.lane)
  if (noIssuesLanes.length > 0) {
    lines.push(`- Lanes with NO_ISSUES: ${noIssuesLanes.join(', ')}`)
  }
  const failedLanes = results.filter(r => !r.success).map(r => `${r.lane} (${r.error})`)
  if (failedLanes.length > 0) {
    lines.push(`- Failed lanes: ${failedLanes.join(', ')}`)
  }
  lines.push('')

  const changedFiles = Object.values(assignments).flatMap(a => a.files)
  const uniqueFiles = [...new Set(changedFiles)]
  const testCmds = detectTestCommands(uniqueFiles)
  if (testCmds.length > 0) {
    lines.push('## Suggested Test Commands')
    for (const cmd of testCmds) lines.push(`- \`${cmd}\``)
    lines.push('')
  }

  const summaryParts = []
  if (critical.length > 0) summaryParts.push(`${critical.length} critical issue${critical.length > 1 ? 's' : ''}`)
  if (needsAttention.length > 0) summaryParts.push(`${needsAttention.length} issue${needsAttention.length > 1 ? 's' : ''} needing attention`)
  if (summaryParts.length === 0) {
    lines.push('## PR Summary')
    lines.push(`Review of ${totalFiles} files across ${results.length} lanes found no actionable issues. All models returned NO_ISSUES or low-confidence findings only.`)
  } else {
    lines.push('## PR Summary')
    const critFiles = [...new Set(critical.map(f => f.file))]
    const attFiles = [...new Set(needsAttention.map(f => f.file))]
    lines.push(`Review found ${summaryParts.join(' and ')} across ${results.length} lanes. Critical findings in ${critFiles.join(', ')}. Attention items in ${attFiles.join(', ')}. Address critical items before merge.`)
  }
  lines.push('')

  lines.push('## Next Steps')
  lines.push('')
  if (critical.length > 0) {
    lines.push('### Critical — fix before merge')
    for (const f of critical) {
      const agent = f.issue.toLowerCase().includes('security') ? 'security-reviewer' : 'code-reviewer'
      lines.push(`- [ ] \`${agent}\` on ${f.file} → ${f.issue.slice(0, 60)}`)
    }
    lines.push('')
  }
  if (needsAttention.length > 0) {
    lines.push('### Needs Attention — address before merge')
    for (const f of needsAttention.slice(0, 8)) {
      let agent = 'code-reviewer'
      if (f.issue.toLowerCase().includes('test') || f.issue.toLowerCase().includes('coverage')) agent = 'tdd-guide'
      else if (f.issue.toLowerCase().includes('dead code') || f.issue.toLowerCase().includes('duplicate')) agent = 'refactor-cleaner'
      else if (f.issue.toLowerCase().includes('performance') || f.issue.toLowerCase().includes('n+1')) agent = 'performance-optimizer'
      lines.push(`- [ ] \`${agent}\` on ${f.file} → ${f.issue.slice(0, 60)}`)
    }
    lines.push('')
  }
  if (noted.length > 0) {
    lines.push('### Noted — optional follow-up')
    for (const f of noted.slice(0, 5)) {
      lines.push(`- [ ] \`code-simplifier\` on ${f.file} → ${f.issue.slice(0, 50)}`)
    }
  }

  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.init) {
    saveDefaultConfig()
    if (!process.argv.slice(2).some(a => a !== '--init')) return
  }

  try {
    execSync('which ollama', { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    console.error('ollama CLI not found on PATH. Install it first: https://ollama.com')
    process.exit(1)
  }

  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    console.error('Not in a git repository.')
    process.exit(1)
  }

  const config = loadConfig(args.configPath, args)

  const changedFiles = getChangedFiles(args.target)
  if (changedFiles.length === 0) {
    console.log('No changed files to review.')
    process.exit(0)
  }

  let fullDiff = getDiff(args.target, config.exclude)
  if (!fullDiff) {
    console.log('Empty diff.')
    process.exit(0)
  }

  const diffSize = Buffer.byteLength(fullDiff, 'utf8')
  if (diffSize > 1024 * 1024) {
    console.error(`Diff exceeds 1MB (${(diffSize / 1024).toFixed(0)}KB) — model context would be overwhelmed. Use target=<ref> to narrow scope or add exclude patterns to .llama-review.yml.`)
    process.exit(1)
  }
  if (diffSize > 100 * 1024) {
    console.error(`Warning: Diff is ${(diffSize / 1024).toFixed(0)}KB. Some models may lose context. Per-lane truncation will cap at 20K chars.`)
  }

  const rawAssignments = assignFilesToLanes(changedFiles, config.customLanes)
  const { lanes: assignments, skipped, consolidated } = applyConsolidation(rawAssignments, changedFiles.length)

  let activeLanes = Object.keys(assignments)
  if (args.lanes.length > 0) {
    activeLanes = activeLanes.filter(l => args.lanes.includes(l))
    for (const l of args.lanes) {
      if (!assignments[l]) {
        assignments[l] = { files: changedFiles, folded: [] }
        activeLanes.push(l)
      }
    }
  }

  if (activeLanes.length === 0) {
    console.log('No files matched any review lane.')
    process.exit(0)
  }

  console.log(`\nDispatch plan (${activeLanes.length} lanes):`)
  console.log('')
  console.log('  Lane       Model                  Type    Effort   Files')
  console.log('  ─────────  ──────────────────────  ──────  ───────  ─────')
  for (const lane of activeLanes) {
    const model = config.models[lane] || config.customLanes[lane]?.model || 'unknown'
    const type = args.local ? 'local' : (model.includes(':cloud') ? 'cloud' : 'local')
    const fileCount = assignments[lane]?.files?.length || changedFiles.length
    console.log(`  ${lane.padEnd(10)} ${model.padEnd(22)} ${type.padEnd(6)}  ${args.effort.padEnd(7)} ${fileCount}`)
  }
  if (skipped.length > 0) {
    console.log(`\n  Skipped: ${skipped.join(', ')} (no matching files)`)
  }
  if (consolidated) {
    console.log('  Consolidated: small diff — reduced lane count')
  }
  console.log('')

  const dispatches = []
  for (const lane of activeLanes) {
    const model = config.models[lane] || config.customLanes[lane]?.model || 'unknown'
    const laneFiles = assignments[lane]?.files || changedFiles
    const laneDiff = filterDiffForLane(fullDiff, laneFiles)
    const { diff: truncatedDiff, dropped } = truncateDiff(laneDiff, 20000)
    const template = loadPromptTemplate(lane, SCRIPT_DIR)

    let foldedConcerns = []
    const folded = assignments[lane]?.folded || []
    if (folded.includes('security')) foldedConcerns.push('security vulnerabilities (injection, auth gaps, data exposure)')
    if (folded.includes('simplify')) foldedConcerns.push('dead code, unnecessary complexity')
    if (folded.includes('tests')) foldedConcerns.push('missing test coverage')

    const customFocus = config.customLanes[lane]?.focus
    const prompt = buildPrompt(lane, args.effort, truncatedDiff, template, foldedConcerns, customFocus)

    const laneCfg = config.laneConfig[lane] || {}
    const isThinking = laneCfg.thinking || model.includes('kimi') || model.includes('glm') || model.includes('deepseek')
    const baseTokens = config.effort[args.effort] || EFFORT_TOKENS[args.effort]
    const numPredict = scaleNumPredict(truncatedDiff.length, baseTokens, isThinking)

    dispatches.push({ lane, model, prompt, numPredict, laneConfig: { ...laneCfg, ...config.customLanes[lane] }, dropped, diffLen: truncatedDiff.length })
  }

  console.log('Dispatching lanes...')
  const dispatchPromises = dispatches.map(d =>
    dispatchWithRetry(d.model, d.prompt, d.numPredict, d.laneConfig)
      .then(result => ({ ...result, lane: d.lane, model: d.model, dropped: d.dropped, diffLen: d.diffLen, effort: args.effort }))
  )

  const rawResults = await Promise.allSettled(dispatchPromises)

  const results = []
  const allFindings = []

  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i]
    const d = dispatches[i]

    if (r.status === 'fulfilled' && r.value.success) {
      const content = r.value.content || r.value.thinking || ''
      const { findings, format } = parseFindings(content, d.lane)
      results.push({
        lane: d.lane,
        model: d.model || d.lane,
        success: true,
        findingCount: findings.length,
        format,
        effort: d.effort,
        duration: r.value.totalDuration
      })
      allFindings.push(...findings)
    } else {
      const error = r.status === 'rejected' ? r.reason?.message : r.value?.error
      results.push({
        lane: d.lane,
        model: d.model || d.lane,
        success: false,
        error: error || 'unknown',
        effort: d.effort,
        duration: null
      })
    }
  }

  const validFindings = allFindings.filter(validateFinding)
  const merged = mergeFindings(validFindings)
  const ranked = rankFindings(merged)

  const report = generateReport(results, ranked, config, assignments, skipped, consolidated, diffSize, changedFiles.length)

  if (args.json) {
    const jsonOutput = {
      findings: { critical: ranked.critical, needsAttention: ranked.needsAttention, noted: ranked.noted },
      results: results.map(r => ({ lane: r.lane, model: r.model, success: r.success, findingCount: r.findingCount, error: r.error, duration: r.duration })),
      meta: { totalFiles: changedFiles.length, diffSize, effort: args.effort, lanes: activeLanes }
    }
    const jsonPath = join(process.cwd(), 'llama-review-results.json')
    writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2))
    console.error(`Results written to ${jsonPath}`)
  }

  console.log('\n' + report)

  if (args.jira) {
    const total = ranked.critical.length + ranked.needsAttention.length
    console.log('\n## Jira Comment')
    if (total === 0) {
      console.log('Multi-model review found no actionable issues. All lanes returned NO_ISSUES or low-confidence findings only.')
    } else {
      const critSummary = ranked.critical.slice(0, 3).map(f => `${f.file}:${f.line} — ${f.issue.slice(0, 80)}`)
      const attSummary = ranked.needsAttention.slice(0, 5).map(f => `${f.file}:${f.line} — ${f.issue.slice(0, 80)}`)
      console.log(`Review found ${ranked.critical.length} critical and ${ranked.needsAttention.length} attention items. Critical: ${critSummary.join('; ')}. Attention: ${attSummary.join('; ')}. Address critical items before merge.`)
    }
  }

  process.exit(ranked.critical.length > 0 ? 2 : 0)
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`)
  process.exit(1)
})