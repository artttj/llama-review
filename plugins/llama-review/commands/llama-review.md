---
description: Run parallel specialist code reviews through Ollama models, merged into one prioritized report
argument-hint: "[last N commits | target=ref] [lanes=list] [--local] [--effort quick|normal|deep] [--strict] [--jira]"
---

# Llama Review — Multi-Model Review Swarm

Dispatch parallel specialist reviewers through Ollama models, then merge findings into one report. Each lane uses a model chosen for that domain's strengths.

$ARGUMENTS

---

## Usage

```
/llama-review                                        # defaults: all lanes, origin/main, normal effort
/llama-review target=origin/staging                  # diff against a specific branch
/llama-review lanes=frontend,security               # only run specific lanes
/llama-review --local                               # use local ollama models (ollama list)
/llama-review --effort deep                         # deep review (64k tokens per lane)
/llama-review --jira                                # append Jira-ready comment block
/llama-review --effort quick --local --jira       # combine flags
```

## Flags

| Flag | Description |
|------|-------------|
| `target=<ref>` | Git ref to diff against (default: `origin/main`) |
| `last N commits` | Shorthand: review last N commits (e.g. `last 3 commits` → `HEAD~3`) |
| `lanes=<list>` | Comma-separated lanes to run (default: all) |
| `--local` | Use local Ollama models instead of cloud |
| `--effort <level>` | Review depth: `quick`, `normal`, `deep` (default: `normal`) |
| `--jira` | Append a Jira-ready comment block to output |
| `--init` | Save default config to .llama-review.yml |
| `--json` | Write structured findings (incl. `verdict`) to llama-review-results.json |
| `--strict` | Block on needs-attention items too (REVIEW → BLOCK, exit 2). For CI gates. |

Every run ends with a verdict — **BLOCK** (any critical, exit 2), **REVIEW** (attention items only, exit 0), or **CLEAN** (exit 0). `--strict` makes REVIEW block as well.

## Default Models

| Lane | Model | Type | Strength |
|------|-------|------|----------|
| frontend | qwen3.5:cloud | cloud | Vision + thinking + tools for UI review |
| backend | glm-5.1:cloud | cloud | Strongest code reasoning, 9.5/10 |
| security | kimi-k2.6:cloud | cloud | 262K context, long reasoning for attack surfaces |
| tests | deepseek-v4-flash:cloud | cloud | Fast structured analysis |
| simplify | minimax-m2.7:cloud | cloud | Cheap pattern matching for dead code and over-engineering |

Cloud and local models both dispatch via the Ollama HTTP API. Cloud models (with `:cloud` suffix) do NOT appear in `ollama list` — that command only shows locally pulled models. **Do not run `ollama list` to check for cloud models.** Use `--local` to switch to local models.

Override with `.llama-review.yml` in your project root. If no config file exists, llama-review offers to create one from defaults on first run.

## Behavior

1. Runs `git diff <target>...HEAD` to get changed files (respects `exclude` patterns from config)
2. Auto-assigns files to review lanes by pattern matching
3. Loads `.llama-review.yml` config if present, falls back to defaults
4. Scales `num_predict` based on diff size (thinking models get higher budgets)
5. Dispatches parallel Ollama HTTP API calls per lane with per-lane timeout and retry
6. Handles thinking models (reads `message.content`, falls back to `message.thinking`)
7. Parses structured JSON output, falls back to text extraction
8. Merges, deduplicates, and ranks findings by severity
9. Outputs a report with Models Used table, Critical / Needs Attention / Noted tiers
10. Offers interactive fix actions: fix inline, run specialist subagents, or review only

## Requirements

- `node` (18+) — bundled with Claude Code
- `ollama` CLI installed and on PATH
- Git repository
- Optional: `.llama-review.yml` in project root for custom config

**Invoke the llama-review skill now and execute the full review workflow.**