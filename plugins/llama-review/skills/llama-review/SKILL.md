---
name: llama-review
description: Use when the user invokes /llama-review or asks to run a multi-model code review with Ollama
---

# Llama Review — Multi-Model Review Conductor

## Overview

You orchestrate parallel specialist reviewers through Ollama, each running on a model chosen for that domain, then merge, deduplicate, rank, and validate their findings into a prioritized report.

Different models have different strengths. Qwen 3.5 has vision, thinking, and tools — best for frontend review where you need to see UI state. GLM-5.1 is the strongest for backend code reasoning and agentic engineering. Kimi K2.6 has 262K context for spotting attack surfaces across large diffs. DeepSeek V4-Flash is fast and good for structured test analysis. MiniMax M2.7 is cheap and fast for spotting unnecessary complexity.

Ollama models run as parallel specialist reviewers.

## Execution Workflow

**Argument parsing rules:**
- `key=value` pairs: split on the first `=` sign. Values containing spaces must not contain shell metacharacters.
- `--flag` booleans: detected by presence alone. `--local`, `--jira`, `--effort` are valid flags.
- `lanes=` values: split on commas, no spaces. `lanes=frontend,security` is valid; `lanes=frontend, security` (with space) is not.
- `--effort` values: one of `quick`, `normal`, `deep`.
- Empty or missing values: fall back to defaults (target=`origin/main`, effort=`normal`, lanes=all).

Execute these steps in order. Do not skip steps.

### Step 1: Pre-Flight Checks

Before anything else, verify the environment:

```bash
which ollama || echo "MISSING"
```

If ollama is missing, stop and report: "ollama CLI not found on PATH. Install it first: https://ollama.com"

Then detect the diff target. Parse `$ARGUMENTS` for `target=<ref>`. Default: `origin/main`.

**Validate the target ref** before using it in git commands. The target must match `^[a-zA-Z0-9._/\-]+$`. If it contains any other characters (spaces, semicolons, pipes, backticks, dollar signs), report: "Invalid target ref: contains disallowed characters" and stop. This prevents command injection through user input.

```bash
git diff "<target>"...HEAD --name-only
```

If the command fails (not a git repo, bad ref), report the error and stop.

If no changed files: report "No changed files to review" and stop.

Get the full diff:
```bash
git diff "<target>"...HEAD
```

Note the total diff line count. If it exceeds 3,000 lines, warn the user that some lane models may lack full context. Continue anyway — truncation is handled per lane in Step 4 based on character count, not line count.

### Step 2: Load Configuration

Check for `.llama-review.yml` in the project root (the directory where `/llama-review` was invoked). If found, parse it. If parsing fails (invalid YAML, wrong types, bad indentation), report the parse error with the file path and line number, then fall back to built-in defaults. Do not abort the entire review for a config error.

If not found, use built-in defaults:

**Default models:**
- frontend: `qwen3.5:cloud`
- backend: `glm-5.1:cloud`
- security: `kimi-k2.6:cloud`
- tests: `deepseek-v4-flash:cloud`
- simplify: `minimax-m2.7:cloud`

**Default effort:** normal (32000 tokens)

**Default local:** false

Note: The `:cloud` suffix on default models requires the Ollama cloud provider plugin. Running `ollama pull qwen3.5:cloud` will fail on a standard Ollama installation. Use `--local` to run with locally available models, or configure `.llama-review.yml` with model names that exist in your `ollama list`.

If the user passed `--local` in `$ARGUMENTS`, override config: strip all `:cloud` suffixes from model names. Run `ollama list` to verify each model is available. If a model is missing, skip that lane, print a warning with the missing model name, and suggest running `ollama pull <model>` to enable that lane. Continue with the remaining lanes.

### Step 3: Group Files by Lane

Apply built-in lane file patterns to the changed file list:

```
frontend: *.tsx, *.jsx, *.vue, *.svelte, *.astro, *.css, *.scss, *.less, *.html, *.mdx, *.d.ts, *.j2, *.twig, *.blade.php, templates/
backend:  *.php, *.py, *.rb, *.go, *.java, *.rs, *.kt, *.ts, *.js, *.cs, *.scala, *.c, *.cpp, *.h, *.hpp, *.sql, *.graphql, *.proto, *.tf (excluding test files and frontend matches)
security: all changed files (always)
tests:    *.test.*, *_test.*, *.spec.*, *_spec.*, *.phpunit.*, *.cy.*, *.e2e.*, *.integration.*, *.stories.*, tests/, __tests__/, spec/
simplify: all changed files (always)
```

Routing logic:
- Match each changed file against lane patterns
- A file can match multiple lanes
- Security always gets the full file list
- Simplify always gets the full file list
- Tests gets test files plus the source files those tests cover (same stem name minus .test/.spec suffix). This is a best-effort heuristic — it matches `OrderService.test.ts` to `OrderService.ts` but may miss indirect imports or tests in `__tests__/` directories with different naming. When in doubt, include more source files rather than fewer.
- If a lane matches zero files, mark it skipped

Also apply any custom lanes from `.llama-review.yml` (under `lanes:` key). Custom lanes extend defaults.

If the user passed `lanes=<list>` in `$ARGUMENTS`, only run those lanes.

**If all active lanes have zero matching files**, report "No files matched any review lane" and stop. Do not dispatch empty reviews.

### Step 4: Build the Dispatch Payloads

For each active lane:

1. **Read the prompt template:** Check in order: `~/.claude/skills/llama-review/prompts/<lane>.md`, then `<project-root>/.llama-review/prompts/<lane>.md`. Use the first file found.

2. **Replace `<EFFORT>`** with the behavioral description:
   - quick → "QUICK SCAN: Flag only the most obvious issues. Skip deep analysis. Aim for 0-3 findings max."
   - normal → "THOROUGH REVIEW: Examine every changed line. Check for edge cases, regressions, and correctness."
   - deep → "EXHAUSTIVE ANALYSIS: Trace every code path. Consider interactions with unchanged code. Flag anything suspicious, even at low confidence."

3. **Append the filtered diff.** Include only the files matching this lane. If the diff exceeds 20,000 characters, truncate at hunk boundaries — never split a `@@ ... @@` hunk or a file header mid-line. If truncating would split a file, drop that entire file rather than including a partial hunk. After truncation, add: "(Note: diff truncated. Dropped files: <list of dropped file names>)". The 20,000-character limit is per lane, not global — each lane truncates independently.

4. **Resolve the model** from config or defaults. If `--local`, use the non-`:cloud` variant.

### Step 5: Dispatch Parallel Reviewers

For EACH active lane, dispatch a background Bash call. Issue ALL calls in a SINGLE message — do not dispatch them one at a time.

For cloud models (default):

```
Bash({
  command: "PROMPT_FILE=$(mktemp) && trap 'rm -f \"$PROMPT_FILE\"' EXIT && cat > \"$PROMPT_FILE\" <<'LLAMA_EOF'\n<prompt content with diff appended>\nLLAMA_EOF\nollama launch claude --model <model> < \"$PROMPT_FILE\"; rm \"$PROMPT_FILE\"",
  run_in_background: true,
  timeout: 600000,
  description: "<Lane> review (<model>)"
})
```

For local models (`--local`):

```
Bash({
  command: "PROMPT_FILE=$(mktemp) && trap 'rm -f \"$PROMPT_FILE\"' EXIT && cat > \"$PROMPT_FILE\" <<'LLAMA_EOF'\n<prompt content with diff appended>\nLLAMA_EOF\nollama run <model> < \"$PROMPT_FILE\"; rm \"$PROMPT_FILE\"",
  run_in_background: true,
  timeout: 600000,
  description: "<Lane> review (<model>, local)"
})
```

Map each task_id to its lane name for result collection.

### Step 6: Collect Results

For each background task:

```
TaskOutput({ task_id: "<id>", block: true, timeout: 600000 })
```

If a task times out after 10 minutes, mark that lane as "Timed out" and continue.
If a task exits with an error, mark it as "Failed: <error>" and continue.

Error detection for collected output:
- If the task exit code is non-zero, mark the lane as "Failed" with the stderr output as the reason. Do not attempt to parse the output as review findings.
- If the exit code is 0, first strip any thinking/reasoning blocks (text between `<think>...</think>` tags or similar model-specific reasoning markers) and leading whitespace/BOM characters. Then check if the cleaned output starts with `FILE:` or `NO_ISSUES`. If it does not, treat the entire output as a parsing error. Mark the lane as "Failed: unexpected output format" and include the first 500 characters of the raw output for debugging.

### Step 7: Merge, Deduplicate, Rank

**Merge:** Combine all lane outputs into one list.

**Deduplicate by root cause:** Group findings that point to the same underlying issue, even if they describe different symptoms. For example:
- Frontend flags "missing error state in UI" and Backend flags "unhandled exception in handler" — these are the same root cause (the exception is unhandled, and the UI doesn't account for it). Merge into one finding with the more detailed description.
- Security flags "no auth check on endpoint" and Simplify flags "unnecessary middleware wrapper around endpoint" — different symptoms, but if the auth check is the middleware that Simplify wants removed, these are related. Keep both but note the connection.

Dedup rules:
- Same file:line with same failure mode → keep the more detailed version, discard the duplicate.
- Same root cause, different symptoms → merge into one finding that describes both symptoms and the shared root cause. Note which lanes flagged it.
- Unrelated findings at the same file → keep both.

**Rank:**

- **Critical:** High confidence AND any of: security vulnerability, data loss, data corruption, crash, auth bypass, incorrect production behavior. Blocks merge.
- **Needs Attention:** Medium-high confidence AND: bug, regression, missing test coverage, performance regression, race condition, unnecessary complexity that obscures real bugs. Should be addressed before merge.
- **Noted:** Low-confidence findings worth tracking. Lanes that returned NO_ISSUES. Things the models flagged but verified as intentional.

### Step 8: Validate Against Finding Contract

For each finding, verify all 6 required fields are present and concrete:
- FILE: exact path (not a directory or module name)
- LINE: a number
- CODE: actual snippet from the diff
- FAILURE: specific breakage description
- CONFIDENCE: high, medium, or low
- FIX: actionable code change

**Discard any finding that:**
- Is generic advice: "consider adding error handling," "improve readability," "add tests," "this could be refactored"
- References code not in the diff
- Has no specific file location
- Has no concrete failure mode
- Is a duplicate (same file, line, and failure mode as another, less detailed finding)

**Trust NO_ISSUES.** If a lane returned NO_ISSUES, report it honestly. Do not second-guess it or add your own commentary.

### Step 9: Output the Final Report

```
## Critical
- [file:line] concrete failure mode → suggested fix (confidence: high)

(If no critical findings: "No critical findings.")

## Needs Attention
- [file:line] risk description → fix suggestion (confidence: medium)

(If none: "No issues needing attention.")

## Models Used
| Lane | Model | Effort | Result |
|------|-------|--------|--------|
| <lane> | <model> | <effort level> | <findings count or NO_ISSUES or Failed> |

(One row per lane that ran, including lanes that failed or timed out.)

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

After the report, output a **Next Steps** block with concrete actions. Map each finding to a specific subagent or skill command the user can run to fix it. Format:

```
## Next Steps

### Critical — fix before merge
- [ ] `security-reviewer` on <files with security findings> → <specific files>
- [ ] `code-reviewer` on <files with bug findings> → <specific files>
- [ ] Manual fix needed: <one-line description of the most urgent fix>

### Needs Attention — address before merge
- [ ] `tdd` — write tests for <uncovered paths> → <specific test files>
- [ ] `refactor-cleaner` on <files with dead code> → <specific files>
- [ ] `performance-optimizer` on <files with N+1 or resource leaks> → <specific files>

### Noted — optional follow-up
- [ ] `code-simplifier` on <files with low-confidence complexity findings> → <specific files>
```

Rules for Next Steps:
- Only suggest subagents that map to real findings. Do not pad the list with generic suggestions.
- Every action must reference specific files from the findings. No vague "review your code" suggestions.
- Map findings to subagents by type:
  - Security findings → `security-reviewer`
  - Bug/correctness findings → `code-reviewer`
  - Test coverage gaps → `tdd`
  - Dead code / over-engineering → `refactor-cleaner` or `code-simplifier`
  - Performance findings → `performance-optimizer`
  - Frontend findings → `frontend-design` or `code-reviewer`
- If there are no findings in a tier, write "None" instead of leaving it empty.
- Always include at least one actionable checkbox in Critical or Needs Attention if those tiers have findings.

If `$ARGUMENTS` contains `--jira`, also append:

```
## Jira Comment
<3-5 sentence summary. Key findings only. Ready to paste.>
```

## Key Rules

1. You orchestrate, not review. Do not add your own review commentary.
2. Trust the models on their lane. Never second-guess a NO_ISSUES response.
3. Discard generic feedback. No file + line + failure + fix = noise.
4. Report failures honestly. If a model times out or errors, tell the user which lane and why.
5. Zero wasted calls. If a lane has no matching files, skip it.
6. One batch dispatch. All lanes fire in a single message, running in parallel.
7. Honor the effort level. Pass the correct behavioral description and token budget.
8. Check pre-flight. Missing ollama or no changed files → clear error, not cryptic failure.
9. Merge by root cause, not just by file:line. Different symptoms from the same bug should become one finding.