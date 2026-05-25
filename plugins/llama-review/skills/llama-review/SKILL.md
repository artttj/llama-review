---
name: llama-review
description: Use when the user invokes /llama-review or asks to run a multi-model code review with Ollama
---

# Llama Review — Multi-Model Review Conductor

You orchestrate parallel specialist reviewers through Ollama, each running on a model chosen for that domain, then merge, deduplicate, rank, and validate their findings into a prioritized report.

## STOP — READ BEFORE PROCEEDING

**You MUST use Ollama models via `ollama launch` (cloud) or `ollama run` (local). NEVER substitute built-in Agent specialist types (typescript-reviewer, code-reviewer, security-reviewer, etc.). The entire value of this skill comes from different models with different strengths.**

**DO NOT run `ollama list` to check for cloud models.** The `ollama list` command only shows locally pulled models. Cloud models (those with `:cloud` suffix) do NOT appear in `ollama list`. Running `ollama list` and concluding "only gemma3:4b available, I'll use Agent specialists instead" is the #1 failure mode. Do not do this.

**Default mode is cloud.** Unless `--local` was passed, all models have `:cloud` suffix and are dispatched via `ollama launch claude --model <model>`. Trust the `:cloud` suffix and dispatch directly. If a cloud model is unavailable, the `ollama launch` call itself will fail — handle that in Step 8. Do NOT pre-check with `ollama list`.

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

**CRITICAL: Do NOT run `ollama list` in cloud mode.** Only run `ollama list` when `--local` was explicitly passed. In cloud mode, verify `ollama launch` works instead:

```bash
ollama launch --help >/dev/null 2>&1 && echo "LAUNCH_OK" || echo "LAUNCH_MISSING"
```

If `LAUNCH_MISSING`, report: "ollama launch is not available. Update ollama to a version that supports cloud models."

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

**Cloud model dispatch (default):** Models with `:cloud` suffix are dispatched via `ollama launch claude --model <model>`. They do NOT appear in `ollama list`. Do NOT run `ollama list` to check for them. Trust the `:cloud` suffix and dispatch directly. If a cloud model is unavailable, the `ollama launch` call will fail — handle that in Step 8. Do NOT fall back to built-in Agent specialists on failure.

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

Print a dispatch plan before launching:

```
Review dispatch plan:

  Lane       Model                  Type    Effort   Files
  ─────────  ──────────────────────  ──────  ───────  ─────
  frontend   qwen3.5:cloud          cloud   normal   12
  backend    glm-5.1:cloud           cloud   normal   8
  security   kimi-k2.6:cloud         cloud   normal   20
  tests      deepseek-v4-flash:cloud  cloud   normal   5
  simplify   minimax-m2.7:cloud      cloud   normal   20
```

For `--local` mode, show local model names with type "local". Show skipped lanes with the reason.

### Step 5: Group Files by Lane

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

Also apply custom lanes from `.llama-review.yml` (under `lanes:` key). If `lanes=<list>` was passed, only run those lanes.

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

**REMINDER: You MUST dispatch via `ollama launch` (cloud) or `ollama run` (local). Do NOT use the Agent tool. Do NOT use built-in specialist types like typescript-reviewer, code-reviewer, etc. Every lane is an `ollama launch` Bash call. No exceptions.**

For EACH active lane, dispatch a background Bash call. Issue ALL calls in a SINGLE message.

**For cloud models (default):**

```
Bash({
  command: "PROMPT_FILE=$(mktemp) && trap 'rm -f \"$PROMPT_FILE\"' EXIT && cat > \"$PROMPT_FILE\" <<'LLAMA_EOF'\n<prompt content with diff appended>\nLLAMA_EOF\nollama launch claude --model <model> < \"$PROMPT_FILE\"",
  run_in_background: true,
  timeout: 600000,
  description: "<Lane> review via <model>"
})
```

**For local models (`--local`):**

```
Bash({
  command: "PROMPT_FILE=$(mktemp) && trap 'rm -f \"$PROMPT_FILE\"' EXIT && cat > \"$PROMPT_FILE\" <<'LLAMA_EOF'\n<prompt content with diff appended>\nLLAMA_EOF\nollama run <model> < \"$PROMPT_FILE\"",
  run_in_background: true,
  timeout: 600000,
  description: "<Lane> review via <model> (local)"
})
```

Map each task_id to its lane name for result collection.

**Fallback behavior:** If `ollama launch` fails for a cloud model, mark that lane as failed in Step 8. Do NOT substitute a different model. Do NOT fall back to built-in Agent specialists. Do NOT use the Agent tool. Report the failure honestly with the error output. A failed lane is better than a lane that ran on the wrong model.

### Step 8: Collect Results

For each background task:

```
TaskOutput({ task_id: "<id>", block: true, timeout: 600000 })
```

If a task times out after 10 minutes, mark that lane as "Timed out" and continue.

Error handling:
- **Non-zero exit code:** Mark as "Failed" with stderr as the reason. Classify: `model not found` vs `network error` vs `other`.
- **Exit code 0 but unexpected format:** Strip thinking/reasoning blocks first, then check format.

Strip thinking/reasoning blocks from all models before parsing. Known formats:
- Claude: angle-bracket thinking tags (anthropic thinking blocks)
- Qwen, DeepSeek: angle-bracket think tags (standard reasoning format)
- GLM: `<<reasoning>>...<</reasoning>>`
- Kimi: `<thought>...</thought>`
- MiniMax: Chinese bracket thinking markers
- Strip any leading whitespace and BOM characters after removing thinking blocks.

After stripping, check if output starts with `FILE:` or `NO_ISSUES`. If not, mark as "Failed: unexpected output format" and include the first 500 characters for debugging.

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

```
## Models Used

| Lane | Model | Type | Effort | Result |
|------|-------|------|--------|--------|
| <lane> | <model> | <cloud/local> | <effort level> | <findings count or NO_ISSUES or Failed> |

(One row per lane that ran, including lanes that failed or timed out.)

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
10. Use Ollama models. Always dispatch via `ollama launch` (cloud) or `ollama run` (local). Never substitute built-in Agent specialist types. A failed lane is honest. A lane that ran on the wrong model is worse than no lane at all.
11. Strip all thinking/reasoning blocks before parsing output (Claude, Qwen, DeepSeek, GLM, Kimi, MiniMax formats).
12. Classify failures: timeout, model-not-found, network, unexpected-output.
13. Do NOT run `ollama list` in cloud mode. Cloud models do not appear in `ollama list`. Running `ollama list` and then substituting Agent specialists is the #1 failure mode. Only use `ollama list` when `--local` was passed.