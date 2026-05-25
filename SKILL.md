---
name: llama-review
description: Use when the user invokes /llama-review or asks to run a multi-model code review with Ollama
---

# Llama Review — Multi-Model Review Conductor

You orchestrate parallel specialist reviewers through Ollama, each running on a model chosen for that domain, then merge, deduplicate, rank, and validate their findings into a prioritized report.

## STOP — READ BEFORE PROCEEDING

**Every review lane MUST dispatch via the Ollama HTTP API. This is the ONLY valid dispatch method. The command is:**

```
jq -Rs --arg model "<model>" '{model: $model, prompt: ., stream: false}' <prompt-file> | curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'
```

Why the API instead of `ollama run` CLI:
1. **Clean output** — the API returns pure JSON with the response in `.response`. No braille spinner characters, no ANSI cursor control sequences, no stderr pollution. The CLI emits these even with `--nowordwrap --hidethinking`.
2. **No size limits** — the prompt is sent as a JSON body, avoiding shell ARG_MAX limits that break with large diffs (3600+ lines).
3. **No parsing fragility** — `jq -r '.response'` extracts exactly the model output. No perl regex stripping needed.

**NEVER use the Agent tool for review lanes.** Do NOT use built-in specialist types (typescript-reviewer, code-reviewer, security-reviewer, etc.). The entire value of this skill comes from different models with different strengths.

**NEVER run `ollama list` to check for cloud models.** The `ollama list` command only shows locally pulled models. Cloud models (those with `:cloud` suffix) do NOT appear in `ollama list`. Running `ollama list` and concluding "only local models available, I'll use Agent specialists instead" is the #1 failure mode. Do not do this.

**Cloud models work with the same API call.** The `:cloud` suffix is part of the model name. `{"model": "qwen3.5:cloud"}` in the API works just like `{"model": "gemma3:4b"}`. No special handling needed. Dispatch directly. If a model is unavailable, the API call will fail — handle that in Step 8.

## Argument Parsing

- `key=value` pairs: split on the first `=` sign. Values must not contain shell metacharacters.
- `--flag` booleans: detected by presence alone. Valid flags: `--local`, `--jira`, `--init`.
- `--effort <level>`: one of `quick`, `normal`, `deep`. Default: `normal`.
- `lanes=<list>`: comma-separated, no spaces. `lanes=frontend,security` is valid.
- `target=<ref>`: git ref to diff against. Default: `origin/main`.
- `last N commits`: shorthand for reviewing the last N commits. Compute the target as `HEAD~N` (e.g. "last 3 commits" → `target=HEAD~3`).
- Empty or missing values fall back to defaults.

Execute these steps in order. Do not skip steps.

### Step 1: Pre-Flight Checks

Verify the environment:

```bash
which ollama || echo "MISSING"
```

If ollama is missing, stop and report: "ollama CLI not found on PATH. Install it first: https://ollama.com"

**CRITICAL: Do NOT run `ollama list` in cloud mode.** Only run `ollama list` when `--local` was explicitly passed, to verify local model availability. In cloud mode, skip this check entirely — cloud models do not appear in `ollama list` but work fine with the API.

Parse `$ARGUMENTS` for `target=<ref>`. Default: `origin/main`.

**Validate the target ref** before using it in git commands. The target must match `^[a-zA-Z0-9._/\-]+$`. If it contains any other characters, report: "Invalid target ref: contains disallowed characters" and stop.

```bash
git diff "<target>"...HEAD --name-only
```

If the command fails, report the error and stop. If no changed files, report "No changed files to review" and stop.

Get the full diff:
```bash
git diff "<target>"...HEAD
```

If the diff exceeds 3,000 lines, warn that some models may lack full context. Continue — truncation is handled per lane in Step 6.

### Step 2: Load Configuration

Check for `.llama-review.yml` in the project root. If found, parse it. If parsing fails, report the error with file path and line number, then fall back to defaults. Do not abort the review for a config error.

If not found, use built-in defaults:

- frontend: `qwen3.5:cloud`
- backend: `glm-5.1:cloud`
- security: `kimi-k2.6:cloud`
- tests: `deepseek-v4-flash:cloud`
- simplify: `minimax-m2.7:cloud`
- effort: `normal` (32000 tokens)
- local: `false`

**All models dispatch via the Ollama HTTP API.** Cloud models (with `:cloud` suffix) and local models use the exact same `POST /api/generate` call. Cloud models do NOT appear in `ollama list` but work with the API. Do NOT run `ollama list` to verify cloud models. Trust the model name and dispatch directly. If a model is unavailable, the API call will fail — handle that in Step 8. Do NOT fall back to built-in Agent specialists on failure.

If `--local` was passed, strip `:cloud` suffixes and verify each model via `ollama list`. Skip lanes with missing models, warn with the model name, and suggest `ollama pull <model>`.

### Step 3: Auto-Create Config

If no `.llama-review.yml` was found, print the effective configuration and offer to save it:

```
No .llama-review.yml found. Using built-in defaults:

  models:
    frontend: qwen3.5:cloud
    backend: glm-5.1:cloud
    security: kimi-k2.6:cloud
    tests: deepseek-v4-flash:cloud
    simplify: minimax-m2.7:cloud

  effort: normal (32000 tokens)
  local: false

Save these defaults to .llama-review.yml? [y/N]
```

If `--init` was passed, save without prompting. If the user declines or doesn't respond, continue with defaults. Do not block the review on this step.

### Step 4: Pre-Flight Model Summary

Print a dispatch plan before launching. This plan shows which lanes will actually run after Step 5 consolidation rules are applied:

```
Review dispatch plan (N lanes, M models):

  Lane       Model                  Type    Effort   Files
  ─────────  ──────────────────────  ──────  ───────  ─────
  backend    glm-5.1:cloud           cloud   normal   3

  Folded: security → backend
  Skipped: frontend (no matching files), tests (no matching files), simplify (small diff)
```

For small diffs, show which lanes were consolidated or skipped and why. For `--local` mode, show local model names with type "local".

### Step 5: Group Files by Lane and Apply Diff-Size Heuristics

Match changed files against lane patterns:

```
frontend: *.tsx, *.jsx, *.vue, *.svelte, *.astro, *.css, *.scss, *.less, *.html, *.mdx, *.d.ts, *.j2, *.twig, *.blade.php, templates/
backend:  *.php, *.py, *.rb, *.go, *.java, *.rs, *.kt, *.ts, *.js, *.cs, *.scala, *.c, *.cpp, *.h, *.hpp, *.sql, *.graphql, *.proto, *.tf (excluding test files and frontend matches)
security: all changed files (always)
tests:    *.test.*, *_test.*, *.spec.*, *_spec.*, *.phpunit.*, *.cy.*, *.e2e.*, *.integration.*, *.stories.*, tests/, __tests__/, spec/
simplify: all changed files (always)
```

Routing rules:
- A file can match multiple lanes
- Security and simplify always get the full file list
- Tests gets test files plus their corresponding source files (same stem minus .test/.spec suffix). Best-effort heuristic — when in doubt, include more source files
- A lane with zero matching files is skipped

**Diff-size lane consolidation.** Spinning up 5 ollama models for a 1-file change wastes time and tokens. Apply these rules after initial lane assignment:

| Total changed files | Action |
|---|---|
| 1-3 files | Run **1 lane only**: pick the lane with the most matching files. Fold security + simplify concerns into that single review prompt. Skip all other lanes. |
| 4-10 files | Run **2 lanes**: pick the two lanes with the most matching files. Fold security concerns into the highest-priority lane. Skip simplify unless the diff is >500 lines. |
| 11+ files | Run **all lanes** that have matching files. No consolidation. |

When folding concerns into a consolidated lane, append to the prompt: "Also check for: <folded concerns>". For example, if security is folded into backend: "Also check for: security vulnerabilities (injection, auth gaps, data exposure)."

**Security lane scoping.** When both backend and security lanes are active, the security lane prompt gets an additional instruction to avoid redundant coverage. Append to the security prompt: "The backend lane is also reviewing this diff. Focus exclusively on security vulnerabilities — injection, auth bypass, data exposure, path traversal, unsafe deserialization, missing CSRF, and cryptographic weaknesses. Skip bugs, performance issues, code style, and general code quality concerns that the backend lane will catch. If no security-specific issues exist, return NO_ISSUES even if you see non-security problems."

Also apply custom lanes from `.llama-review.yml` (under `lanes:` key). If `lanes=<list>` was passed, only run those lanes (override consolidation).

If all lanes have zero files, report "No files matched any review lane" and stop.

### Step 6: Build Dispatch Payloads

For each active lane:

1. **Read the prompt template.** Check in order: `~/.claude/skills/llama-review/prompts/<lane>.md`, then `<project-root>/.llama-review/prompts/<lane>.md`. Use the first file found. If neither exists, use a built-in default prompt for that lane.

2. **Replace `<EFFORT>`** with the behavioral description:
   - quick → "QUICK SCAN: Flag only the most obvious issues. Skip deep analysis. Aim for 0-3 findings max."
   - normal → "THOROUGH REVIEW: Examine every changed line. Check for edge cases, regressions, and correctness."
   - deep → "EXHAUSTIVE ANALYSIS: Trace every code path. Consider interactions with unchanged code. Flag anything suspicious, even at low confidence."

3. **Append the filtered diff.** Include only the files matching this lane. If the diff exceeds 20,000 characters, truncate at hunk boundaries — never split a `@@ ... @@` hunk or a file header mid-line. If truncating would split a file, drop that entire file. After truncation, add: "(Note: diff truncated. Dropped files: <list>)". The 20,000-character limit is per lane.

4. **Resolve the model** from config or defaults. If `--local`, strip `:cloud`.

### Step 7: Dispatch Parallel Reviewers

**REMINDER: You MUST dispatch via the Ollama HTTP API. Do NOT use `ollama run` CLI. Do NOT use the Agent tool. Do NOT use built-in specialist types like typescript-reviewer, code-reviewer, etc. Every lane is a curl + jq Bash call. No exceptions.**

For EACH active lane, dispatch a background Bash call. Issue ALL calls in a SINGLE message.

**For ALL models (cloud and local use the same command):**

```
Bash({
  command: "PROMPT_FILE=$(mktemp) && trap 'rm -f \"$PROMPT_FILE\"' EXIT && cat > \"$PROMPT_FILE\" <<'LLAMA_EOF'\n<prompt content with diff appended>\nLLAMA_EOF\njq -Rs --arg model \"<model>\" '{model: $model, prompt: ., stream: false}' \"$PROMPT_FILE\" | curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'",
  run_in_background: true,
  timeout: 600000,
  description: "<Lane> review via <model> (API)"
})
```

The prompt is written to a temp file, then `jq -Rs` reads it as a raw string and builds the JSON payload (`-R` for raw input, `-s` to slurp into a single string). The `--arg model` injects the model name safely (no shell interpolation). `curl -s http://localhost:11434/api/generate -d @-` reads the JSON from stdin. `jq -r '.response'` extracts the model's response text. No ANSI codes, no spinner pollution, no ARG_MAX limits.

Map each task_id to its lane name for result collection.

**Fallback behavior:** If the API call fails for a model, mark that lane as failed in Step 8. Do NOT substitute a different model. Do NOT fall back to `ollama run` CLI. Do NOT fall back to built-in Agent specialists. Do NOT use the Agent tool. Report the failure honestly with the error output. A failed lane is better than a lane that ran on the wrong model.

### Step 8: Collect Results

For each background task:

```
TaskOutput({ task_id: "<id>", block: true, timeout: 600000 })
```

If a task times out after 10 minutes, mark that lane as "Timed out" and continue.

Error handling:
- **Non-zero exit code:** Mark as "Failed" with stderr as the reason. Classify: `model not found` vs `network error` vs `other`.
- **Exit code 0 but empty response:** Mark as "Failed: empty response from API".
- **Exit code 0 but `jq` parse error:** The API returned non-JSON (connection refused, bad gateway). Mark as "Failed: API error" with the raw output.

Strip output before parsing (apply in this order):
1. **Thinking/reasoning blocks** from all models (the API returns these in the response text):
   - Claude: angle-bracket thinking tags (anthropic thinking blocks)
   - Qwen, DeepSeek: angle-bracket think tags (standard reasoning format)
   - GLM: `<<reasoning>>...<</reasoning>>`
   - Kimi: `<thought>...</thought>`
   - MiniMax: Chinese bracket thinking markers
2. **Leading whitespace and BOM characters.**

After stripping, check if output starts with `FILE:` or `NO_ISSUES`. If so, parse findings normally.

**If output does NOT match the expected format**, apply fallback extraction before marking as failed:

1. **Structured extraction:** Scan the output for finding-like patterns using these regex heuristics (in order):
   - Lines matching `(CRITICAL|HIGH|MEDIUM|LOW).*file.*line` → extract severity, file path, line number
   - Lines matching `File:.*Line:.*` → treat as a finding block
   - Bullet points with file paths: `[-*]\s+\`?([a-zA-Z0-9_/.-]+\.[a-zA-Z]+)\`?.*:\d+` → extract file and line
   - Code blocks with file references nearby → associate code with the referenced file

2. **If extraction finds anything:** Convert extracted items into the standard format (FILE, LINE, CODE, FAILURE, CONFIDENCE, FIX). For items missing fields, mark CONFIDENCE as "low" and note "extracted from unstructured output".

3. **If extraction finds nothing:** Mark as "Failed: unexpected output format" and include the first 500 characters for debugging. Do NOT treat the raw output as findings.

This fallback ensures models that produce slightly non-compliant output still contribute findings, while models that produce completely unrecognizable output are flagged honestly.

### Step 9: Merge, Deduplicate, Rank

**Merge:** Combine all lane outputs into one list.

**Deduplicate by root cause:** Group findings pointing to the same underlying issue:
- Same file:line with same failure mode → keep the more detailed version
- Same root cause, different symptoms → merge into one finding describing both symptoms and shared root cause. Note which lanes flagged it.
- Unrelated findings at the same file → keep both

**Rank:**

- **Critical:** High confidence AND any of: security vulnerability, data loss, data corruption, crash, auth bypass, incorrect production behavior. Blocks merge.
- **Needs Attention:** Medium-high confidence AND: bug, regression, missing test coverage, performance regression, race condition, unnecessary complexity that obscures real bugs. Address before merge.
- **Noted:** Low-confidence findings worth tracking. Lanes that returned NO_ISSUES. Things verified as intentional.

### Step 10: Validate Against Finding Contract

Every finding must have all 6 fields:
- FILE: exact path (not a directory or module name)
- LINE: a number
- CODE: actual snippet from the diff
- FAILURE: specific breakage description
- CONFIDENCE: high, medium, or low
- FIX: actionable code change

Discard findings that:
- Are generic advice ("consider adding error handling")
- Reference code not in the diff
- Have no specific file location or concrete failure mode
- Are duplicates (same file, line, failure mode — keep the more detailed one)

Trust NO_ISSUES. Do not second-guess it.

### Step 11: Output the Final Report

**Integrity check BEFORE rendering the table.** Verify that every lane in the table was dispatched via the Ollama HTTP API (from Step 7 task_ids). If any lane was dispatched via the Agent tool instead, the review is INVALID. Report: "INTEGRITY FAILURE: Lane <name> was dispatched via Agent tool instead of ollama API. Review results are unreliable — all lanes ran on the same model. Re-run with /llama-review." Do NOT render the table if the integrity check fails.

```
## Models Used

| Lane | Model | Dispatch | Effort | Result |
|------|-------|----------|--------|--------|
| <lane> | <model> | ollama API | <effort level> | <findings count or NO_ISSUES or Failed or Timed out> |

(One row per lane that actually ran. The Dispatch column MUST say "ollama API" — if it says anything else, the review is invalid. Include lanes that failed or timed out with their actual result.)

## Consolidated
- <list lanes that were folded into other lanes due to small diff size, e.g. "security folded into backend">
- (If no consolidation happened, omit this section)

## Critical
- [file:line] concrete failure mode → suggested fix (confidence: high)

(If no critical findings: "No critical findings.")

## Needs Attention
- [file:line] risk description → fix suggestion (confidence: medium)

(If none: "No issues needing attention.")

## Noted
- <things checked and why they're OK>
- Lanes that returned NO_ISSUES: <list>
- Failed lanes: <list if any>

## Skipped
- <lanes with zero matching files, reason>
- (If none skipped, omit this section)

## Suggested Test Commands
- <exact commands, detected from changed file types>
  - PHP: `php vendor/bin/phpunit --filter=<changed test files>`
  - JS/TS: `npx jest --findRelatedTests <changed files>`
  - Python: `python -m pytest <changed test files> -v`
  - Go: `go test ./<changed packages>/...`
  - Rust: `cargo test -p <changed crate>`

## PR Summary
<3-5 sentence concrete summary. No generic phrasing. Ready to paste.>
```

Then output a **Next Steps** block:

```
## Next Steps

### Critical — fix before merge
- [ ] `security-reviewer` on <files> → <specific files>
- [ ] `code-reviewer` on <files> → <specific files>
- [ ] Manual fix needed: <one-line description>

### Needs Attention — address before merge
- [ ] `tdd` — write tests for <paths> → <test files>
- [ ] `refactor-cleaner` on <files> → <specific files>
- [ ] `performance-optimizer` on <files> → <specific files>

### Noted — optional follow-up
- [ ] `code-simplifier` on <files> → <specific files>
```

Next Steps rules:
- Only suggest subagents mapped to real findings. No padding.
- Every action references specific files. No vague suggestions.
- Map by type: security → `security-reviewer`, bugs → `code-reviewer`, tests → `tdd`, dead code → `refactor-cleaner`, performance → `performance-optimizer`, frontend → `frontend-design`
- If no findings in a tier, write "None"
- Always include at least one actionable checkbox in Critical or Needs Attention if those tiers have findings

### Step 12: Offer Fix Actions

After rendering the report, ask the user how they want to act on findings. Use `AskUserQuestion` with up to 4 options:

```
AskUserQuestion({
  questions: [{
    question: "How do you want to handle the <N> findings?",
    header: "Fix actions",
    multiSelect: false,
    options: [
      { label: "Fix critical inline", description: "Fix CRITICAL findings directly in the current session, one at a time" },
      { label: "Run specialist agents", description: "Dispatch subagents (security-reviewer, code-reviewer, tdd-guide) to fix findings in parallel" },
      { label: "Fix all inline", description: "Fix every finding (critical + needs attention) directly, sequentially" },
      { label: "Review only", description: "No fixes — I'll handle them separately" }
    ]
  }]
})
```

Adjust the options based on what was found:
- If only CRITICAL findings: options 1 and 2 focus on critical only
- If only MEDIUM/LOW findings: offer "Fix inline" and "Review only"
- If no findings at all: skip Step 12 entirely, just say "No findings to act on"

**When the user picks "Fix critical inline" or "Fix all inline":**
- Work through findings one at a time, starting with the highest severity
- For each finding: read the file, make the minimal fix, verify it doesn't break related code
- After each fix, ask: "Fixed <file>. Continue to next finding?" (unless there's only one)

**When the user picks "Run specialist agents":**
- Dispatch the appropriate subagent for each finding type in parallel
- Map findings to agents: security → `security-reviewer`, bugs → `code-reviewer`, tests → `tdd-guide`, dead code → `refactor-cleaner`, performance → `performance-optimizer`
- Pass each agent the specific file(s) and finding description so it knows what to fix
- After agents complete, summarize what was fixed

If `$ARGUMENTS` contains `--jira`:

```
## Jira Comment
<3-5 sentence summary. Key findings only. Ready to paste.>
```

## Key Rules

1. You orchestrate, not review. Do not add your own commentary.
2. Trust the models on their lane. Never second-guess NO_ISSUES.
3. Discard generic feedback. No FILE + LINE + CODE + FAILURE + FIX = noise.
4. Report failures honestly. Failed lane → which lane, which model, why.
5. Zero wasted calls. No matching files → skip the lane.
6. One batch dispatch. All lanes in a single message, in parallel.
7. Honor the effort level. Pass the correct behavioral description.
8. Check pre-flight. Missing ollama or no files → clear error, not cryptic failure.
9. Merge by root cause, not just file:line.
10. Dispatch via `jq -Rs --arg model "<model>" '{model: $model, prompt: ., stream: false}' <prompt-file> | curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'`. Same command for cloud and local models. Never use `ollama run` CLI. Never substitute built-in Agent specialist types. A failed lane is honest. A lane that ran on the wrong model is worse than no lane at all.
11. Integrity check: the Models Used table Dispatch column MUST say "ollama API". If any lane shows "Agent" or a specialist type name, the review is invalid. All Agent specialists run on the same model (this session's model), so using them means all lanes produce the same perspective — this defeats the multi-model purpose entirely.
12. Strip thinking/reasoning blocks, then leading whitespace before parsing output. No ANSI stripping needed — the API returns clean JSON.
13. Classify failures: timeout, model-not-found, network, unexpected-output.
14. Do NOT run `ollama list` in cloud mode. Cloud models do not appear in `ollama list`. Running `ollama list` and then substituting Agent specialists is the #1 failure mode. Only use `ollama list` when `--local` was passed.
15. Apply diff-size lane consolidation (Step 5). Small diffs get fewer model dispatches. Do not spin up 5 models for a 2-file change.
16. After the report, offer interactive fix actions (Step 12). Let the user choose between fixing inline, running specialist subagents, or skipping fixes.
17. Apply fallback output extraction (Step 8) when models don't produce the expected FILE:/NO_ISSUES format. Try regex extraction before giving up on a lane's output.