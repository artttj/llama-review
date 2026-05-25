# Llama Review

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](LICENSE) ![Claude Code](https://img.shields.io/badge/Claude%20Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white) ![Ollama](https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white)

![Llama Review](llama.png)

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
- **Structured JSON output**: `--json` flag writes machine-readable findings to a file
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

Requires the `ollama` CLI on PATH and Node.js 18+ (bundled with Claude Code). On first run without a config file, llama-review offers to create `.llama-review.yml` from defaults.

## Usage

```
/llama-review                                        # defaults: all lanes, origin/main, normal effort
/llama-review target=origin/staging                  # diff against a branch
/llama-review lanes=frontend,security               # only specific lanes
/llama-review --local                               # use local ollama models
/llama-review --init                                # create .llama-review.yml from defaults
/llama-review --effort deep                         # 64k tokens per lane
/llama-review --jira                                # append a Jira comment block
/llama-review --json                               # write structured findings to JSON file
```

The `llama-review.mjs` script handles the full pipeline: detects changed files with `git diff`, applies exclude patterns, auto-assigns files to lanes by pattern, scales token budgets by diff size, dispatches parallel Ollama API calls with per-lane timeout and retry, handles thinking model output (falls back to `message.thinking` when `message.content` is empty), parses structured JSON output with text fallback, then merges and ranks the findings.

## Configuration

Drop a `.llama-review.yml` in your project root:

```yaml
# Global exclude patterns — strip from diff before dispatch
exclude:
  - "packages/exercises/src/data/exercises/**"
  - "**/seed.sql"
  - "**/messages.js"
  - "**/messages.po"

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

Set a lane's model to `false` to disable it. Custom lanes extend the built-in ones.

## Custom prompt templates

Override the review prompt for any lane by creating a markdown file:

- **User-level** (all projects): `~/.claude/skills/llama-review/prompts/<lane>.md`
- **Project-level**: `<project-root>/.llama-review/prompts/<lane>.md`

For example, `.llama-review/prompts/security.md` replaces the built-in security prompt. User-level files take priority over project-level. If neither exists, the built-in default is used.

## Review lanes

| Lane | Files | Default model | Type | Why this model |
|------|-------|---------------|------|----------------|
| frontend | `*.tsx, *.jsx, *.vue, *.svelte, *.astro, *.css, *.scss, *.less, *.html, *.mdx, *.d.ts, *.j2, *.twig, *.blade.php, templates/` | qwen3.5:cloud | cloud | Vision + thinking + tools for UI review |
| backend | `*.php, *.py, *.rb, *.go, *.java, *.rs, *.kt, *.ts, *.js, *.cs, *.scala, *.c, *.cpp, *.h, *.hpp, *.sql, *.graphql, *.proto, *.tf` (excludes test and frontend files) | glm-5.1:cloud | cloud | Strongest code reasoning, 9.5/10 |
| security | all files | kimi-k2.6:cloud | cloud | 262K context for full attack surface review |
| tests | `*.test.*, *_test.*, *.spec.*, *_spec.*, *.phpunit.*, *.cy.*, *.e2e.*, *.integration.*, *.stories.*, tests/, __tests__/, spec/` | deepseek-v4-flash:cloud | cloud | Fast structured analysis |
| simplify | all files | minimax-m2.7:cloud | cloud | Cheap pattern matching for dead code and over-engineering |

Each lane only gets files matching its patterns. Security and simplify always get the full diff. Empty lanes are skipped. Files are auto-assigned by the script — no manual categorization needed.

## Local models

Pass `--local` to use local Ollama models instead of cloud. The script strips `:cloud` suffixes and dispatches directly — if a local model isn't available, the lane fails and reports the error.

**Note:** Cloud models (with `:cloud` suffix) are dispatched via the Ollama HTTP API and do NOT appear in `ollama list` output. `ollama list` only shows locally pulled models. Cloud model availability is validated at dispatch time — if a cloud model is unavailable, the lane fails and reports the error honestly.

Recommended local models:
- `qwen3:8b`: fits in 8GB VRAM, good for quick reviews
- `deepseek-r1:14b`: reasoning-focused, good for security lanes
- `devstral:24b`: agentic coding, good for backend lanes

## Maintaining

After editing the skill, sync these files in order:

1. `plugins/llama-review/skills/llama-review/SKILL.md` — canonical skill source
2. `SKILL.md` (root) — copy from plugin version
3. `AGENTS.md` — dispatch rules and failure handling (keep timeouts and command template in sync)
4. `commands/llama-review.md`, `plugins/llama-review/commands/llama-review.md`, `.opencode/commands/llama-review.md` — command files (keep all three identical)
5. `llama-review.mjs`, `plugins/llama-review/skills/llama-review/llama-review.mjs` — keep both copies identical

Version numbers live in two places: `plugins/llama-review/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Bump both together.

## License

MIT. See [LICENSE](LICENSE).