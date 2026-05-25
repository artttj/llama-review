---
description: Run parallel specialist code reviews through Ollama models, merged into one prioritized report
argument-hint: "[last N commits | target=ref] [lanes=list] [--local] [--effort quick|normal|deep] [--jira]"
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

## Default Models

| Lane | Model | Type | Strength |
|------|-------|------|----------|
| frontend | qwen3.5:cloud | cloud | Vision + thinking + tools for UI review |
| backend | glm-5.1:cloud | cloud | Strongest code reasoning, 9.5/10 |
| security | kimi-k2.6:cloud | cloud | 262K context, long reasoning for attack surfaces |
| tests | deepseek-v4-flash:cloud | cloud | Fast structured analysis |
| simplify | minimax-m2.7:cloud | cloud | Cheap pattern matching for dead code and over-engineering |

Cloud models (with `:cloud` suffix) are dispatched via `ollama launch`. They do NOT appear in `ollama list` — that command only shows locally pulled models. **Do not run `ollama list` to check for cloud models.** Use `--local` to switch to local models.

Override with `.llama-review.yml` in your project root. If no config file exists, llama-review offers to create one from defaults on first run.

## Behavior

1. Runs `git diff <target>...HEAD` to get changed files
2. Loads `.llama-review.yml` config if present, falls back to defaults
3. Auto-creates `.llama-review.yml` from defaults if missing (asks first)
4. Prints a dispatch plan showing which model runs which lane
5. Groups files into review lanes by file pattern
6. Dispatches parallel `ollama launch claude --model <model>` calls per lane
7. Collects, merges, deduplicates, and ranks findings
8. Outputs a report with Models Used table, Critical / Needs Attention / Noted tiers
9. Suggests concrete next steps with subagent commands to fix findings

## Requirements

- `ollama` CLI installed and on PATH
- Git repository
- Optional: `.llama-review.yml` in project root for custom config

**Invoke the llama-review skill now and execute the full review workflow.**