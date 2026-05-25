# Llama Review

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](LICENSE) ![Claude Code](https://img.shields.io/badge/Claude%20Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white) ![Ollama](https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white)

![Llama Review](llama_review.png)

Different models have different strengths. Llama Review assigns the right model to the right task.

Five review lanes, each running on a model chosen for that domain:

- **Qwen 3.5**: frontend review with vision, layout checks, state management, accessibility
- **GLM-5.1**: backend bugs, N+1 queries, race conditions, unhandled exceptions, architecture
- **Kimi K2.6**: security across large diffs using a 262K context window
- **DeepSeek V4-Flash**: test gaps, broken assertions, coverage holes
- **MiniMax M2.7**: dead code, duplicate logic, over-engineering

Results merge, deduplicate, and rank into a single report.

## What you get

- **Critical**: security holes, data loss risks, auth bypasses
- **Needs attention**: real bugs, edge cases, performance regressions, unnecessary complexity
- **Noted**: things that passed, lanes that found nothing, low-confidence flags
- **Models Used**: which model ran each lane, effort level, and result
- **Suggested test commands**: what to run to verify the changes
- **One-paragraph summary**: ready to paste into a PR or Slack
- **Next Steps**: concrete subagent commands to fix each finding

Every finding has the file, line, what's broken, and how to fix it. No generic filler.

## Install

```
/plugin marketplace add artttj/llama-review
/plugin install llama-review
/reload-plugins
```

Then run:
```
/llama-review
```

Requires the `ollama` CLI on PATH. On first run without a config file, llama-review offers to create `.llama-review.yml` from defaults.

## Usage

```
/llama-review                                        # defaults: all lanes, origin/main, normal effort
/llama-review target=origin/staging                  # diff against a branch
/llama-review lanes=frontend,security               # only specific lanes
/llama-review --local                               # use local ollama models
/llama-review --init                                # create .llama-review.yml from defaults
/llama-review --effort deep                         # 64k tokens per lane
/llama-review --jira                                # append a Jira comment block
```

The skill detects changed files with `git diff`, groups them into review lanes by file pattern, dispatches parallel Ollama HTTP API calls, then merges and ranks the findings. Before dispatching, it prints a plan showing which model runs which lane.

## Configuration

Drop a `.llama-review.yml` in your project root:

```yaml
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

local: false  # set to true to use local models (strips :cloud suffix)

lanes:
  magento:
    files: "app/code/**, etc/**/*.xml"
    focus: "DI mistakes, plugin order, cache config"
    model: "kimi-k2.6:cloud"
```

Set a lane's model to `false` to disable it. Custom lanes extend the built-in ones.

## Custom prompt templates

Override the review prompt for any lane by creating a markdown file:

- **User-level** (all projects): `~/.claude/skills/llama-review/prompts/<lane>.md`
- **Project-level**: `<project-root>/.llama-review/prompts/<lane>.md`

For example, `.llama-review/prompts/security.md` replaces the built-in security prompt. User-level files take priority over project-level. If neither exists, the built-in default is used.

## Review lanes

| Lane | Files | Default model | Type | Why this model |
|------|-------|---------------|------|----------------|
| frontend | `*.tsx, *.jsx, *.vue, *.svelte, *.astro, *.css, *.scss, *.less, *.html, *.mdx, templates/` | qwen3.5:cloud | cloud | Vision + thinking + tools for UI review |
| backend | `*.php, *.py, *.rb, *.go, *.java, *.rs, *.kt, *.ts, *.js, *.cs, *.scala, *.c, *.cpp, *.sql, *.graphql` | glm-5.1:cloud | cloud | Strongest code reasoning, 9.5/10 |
| security | all files | kimi-k2.6:cloud | cloud | 262K context for full attack surface review |
| tests | `*.test.*, *_test.*, *.spec.*, tests/, __tests__/, *.cy.*, *.e2e.*, *.stories.*` | deepseek-v4-flash:cloud | cloud | Fast structured analysis |
| simplify | all files | minimax-m2.7:cloud | cloud | Cheap pattern matching for dead code and over-engineering |

Each lane only gets files matching its patterns. Security and simplify always get the full diff. Empty lanes are skipped.

## Local models

Pass `--local` to use local Ollama models instead of cloud. The skill strips `:cloud` suffixes and verifies each local model is available via `ollama list`. Missing models are skipped with a warning.

**Note:** Cloud models (with `:cloud` suffix) are dispatched via the Ollama HTTP API and do NOT appear in `ollama list` output. `ollama list` only shows locally pulled models. Cloud model availability is validated at dispatch time — if a cloud model is unavailable, the lane fails and reports the error honestly.

Recommended local models:
- `qwen3:8b`: fits in 8GB VRAM, good for quick reviews
- `deepseek-r1:14b`: reasoning-focused, good for security lanes
- `devstral:24b`: agentic coding, good for backend lanes

## Maintaining

The three command files (`commands/llama-review.md`, `plugins/llama-review/commands/llama-review.md`, `.opencode/commands/llama-review.md`) must stay in sync. When updating one, copy changes to all three.

Version numbers live in two places: `plugins/llama-review/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Bump both together.

## License

MIT. See [LICENSE](LICENSE).