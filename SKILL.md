---
name: llama-review
description: Use when the user invokes /llama-review or asks to run a multi-model code review with Ollama
---

# Llama Review — Multi-Model Review Conductor

You orchestrate parallel specialist reviewers through Ollama, each running on a model chosen for that domain, then present their merged, deduplicated, and ranked findings.

## STOP — READ BEFORE PROCEEDING

**Every review lane dispatches via the Ollama HTTP API.** The `llama-review.mjs` script handles dispatch, collection, parsing, merging, and report generation. You run the script and present the report.

**Do NOT use the Agent tool for review lanes.** Agent tools — `python-reviewer`, `typescript-reviewer`, `security-reviewer`, `code-simplifier`, `tdd-guide` — all run on the same model: this session's Claude. Dispatch 5 lanes as Agent sub-agents and every lane produces output from the same model with the same architectural biases. You get one perspective wearing 5 hats, not 5 independent specialists.

A lane that fails because a model is unavailable is honest. A lane that ran as an Agent instead of an ollama model is worse than no lane at all.

**Before continuing, state: "I will dispatch each lane via the Ollama API through the llama-review.mjs script. Zero lanes will use the Agent tool."** If you can't state this, re-read this section.

## Argument Parsing

- `key=value` pairs: split on the first `=` sign.
- `--flag` booleans: `--local`, `--jira`, `--init`.
- `--effort <level>`: `quick`, `normal`, `deep`. Default: `normal`.
- `lanes=<list>`: comma-separated, no spaces.
- `target=<ref>`: git ref to diff against. Default: `origin/main`.
- `last N commits`: shorthand for `HEAD~N`.

## Running the Review

The script is at `<skill-base-dir>/llama-review.mjs`. Run it with the parsed arguments:

```
Bash({
  command: "node \"<skill-base-dir>/llama-review.mjs\" --target \"<target>\" --effort <effort> [other flags]",
  timeout: 600000,
  description: "Run llama-review multi-model code review"
})
```

The script handles:
1. Pre-flight checks (ollama on PATH, git repo, target ref validation)
2. Config loading from `.llama-review.yml` (or built-in defaults)
3. Git diff generation with global `exclude` patterns
4. Auto file-to-lane assignment by file pattern
5. Diff-size lane consolidation (1-3 files → 1 model, 4-10 → 2 models, 11+ → all)
6. Prompt building with structured JSON output schema
7. Diff-size-aware `num_predict` scaling
8. Parallel Ollama HTTP API dispatch with per-lane timeout and retry
9. Thinking block handling (reads `message.content` first, falls back to `message.thinking`)
10. Result parsing (JSON first, text fallback)
11. Merge, deduplication, and ranking by severity
12. Report generation

The script uses the `/api/chat` Ollama endpoint, which returns `message.content` and `message.thinking` as separate fields. When thinking models (GLM, Kimi, DeepSeek) put all output into `message.thinking` with empty `message.content`, the script falls back to reading the thinking field.

### Config Auto-Creation

If no `.llama-review.yml` exists, the script prints the effective config. Add `--init` to save defaults without prompting. The config supports:

```yaml
# Global exclude patterns — strip from diff before dispatch
exclude:
  - "packages/exercises/src/data/exercises/**"
  - "**/seed.sql"

models:
  frontend: "qwen3.5:cloud"
  backend: "glm-5.1:cloud"
  # Set to false to disable a lane

effort:
  quick: 8000
  normal: 32000
  deep: 64000

local: false

# Per-lane overrides
lane_config:
  backend:
    timeout: 240    # seconds
    retries: 1
    thinking: true  # increase num_predict for reasoning models
  security:
    timeout: 180
    retries: 1
    thinking: true

# Custom lanes
lanes:
  infra:
    files: "terraform/**, docker/**, .github/**, k8s/**"
    focus: "misconfigured resources, missing secrets, unsafe defaults"
    model: "kimi-k2.6:cloud"
    timeout: 180
    retries: 1
```

## Presenting the Report

After the script completes, read its stdout output. It contains the full formatted report:

- **Models Used** table (Dispatch column must say "ollama API")
- **Consolidated** section (which lanes were folded/skipped)
- **Critical** findings
- **Needs Attention** findings
- **Noted** findings
- **Suggested Test Commands**
- **PR Summary**
- **Next Steps** with specific subagent actions

Present the report to the user as-is. Do not add your own commentary on findings. Trust the models on their lane. Never second-guess NO_ISSUES.

**Integrity check:** If the script exits with code 2, it found critical findings. If it exits with code 1, there was a fatal error. Exit code 0 means no critical findings.

If the Models Used table shows any lane dispatched via "Agent" instead of "ollama API", the review is INVALID. Report: "INTEGRITY FAILURE: Lane was dispatched via Agent tool. Re-run with /llama-review."

## Offering Fix Actions

After presenting the report, use `AskUserQuestion` with up to 4 options:

```
AskUserQuestion({
  questions: [{
    question: "How do you want to handle the N findings?",
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

Adjust options based on findings:
- Only CRITICAL: focus options 1 and 2 on critical only
- Only MEDIUM/LOW: offer "Fix inline" and "Review only"
- No findings: skip this step, say "No findings to act on"

**When the user picks "Fix critical inline" or "Fix all inline":**
- Work through findings one at a time, starting with highest severity
- For each: read the file, make the minimal fix, verify it doesn't break related code

**When the user picks "Run specialist agents":**
- Dispatch appropriate subagents in parallel
- Map findings: security → `security-reviewer`, bugs → `code-reviewer`, tests → `tdd-guide`, dead code → `refactor-cleaner`, performance → `performance-optimizer`

If `--jira` was passed, append a Jira comment block after the report.

## Key Rules

1. You orchestrate, not review. Do not add your own commentary.
2. Trust the models on their lane. Never second-guess NO_ISSUES.
3. Run the script. Do not manually reconstruct the dispatch logic.
4. Zero Agent tools for review lanes. All lanes use the Ollama API.
5. Report failures honestly. Failed lane → which lane, which model, why.
6. Present the report as-is. Do not filter, rephrase, or augment findings.
7. After the report, offer interactive fix actions.
8. The script handles thinking block extraction and JSON parsing. You present the output.
9. Cloud models work with the same API call. Do NOT run `ollama list` to check for cloud models.
10. The script auto-scales `num_predict` based on diff size and thinking model detection.