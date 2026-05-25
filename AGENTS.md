# Llama Review Agents

## llama-review

Multi-model code review conductor. Dispatches parallel specialist reviewers through Ollama, merges findings into a prioritized report.

**Dispatch rule:** Every review lane dispatches via the Ollama HTTP API through the `llama-review.mjs` script. The script handles dispatch, collection, parsing, merging, and report generation. Agent tools all run on the same model — using them means every lane produces the same perspective, which defeats the multi-model purpose entirely. A failed lane is honest. A lane on the wrong model is worse than no lane at all.

**Command:**
```
node "<skill-base-dir>/llama-review.mjs" --target "<ref>" --effort <level> [other flags]
```

**Critical rules:**
- **Run the script.** Do not manually reconstruct dispatch logic.
- **Zero Agent tools for review lanes.** All lanes use the Ollama API.
- **The script handles:** thinking block extraction (content || thinking fallback), per-lane timeout and retry, diff-size token budgeting, JSON output parsing with text fallback, auto file-to-lane assignment, global exclude patterns.
- **Cloud models:** Do NOT run `ollama list` to check for cloud models. Cloud models (`:cloud` suffix) do not appear in `ollama list`. Trust the `:cloud` suffix and dispatch directly via the script.

**Orchestration rule:** You orchestrate, not review. Do not add your own commentary on findings. Trust the models on their lane. Never second-guess NO_ISSUES.

### When to use

- User invokes `/llama-review`
- User asks for a multi-model code review
- User asks to review PR, commits, or diff with Ollama

### Arguments

- `target=<ref>` — git ref to diff against (default: `origin/main`)
- `last N commits` — shorthand (e.g. `last 3 commits` → `HEAD~3`)
- `lanes=<list>` — comma-separated lanes to run (default: all)
- `--effort <level>` — `quick`, `normal`, `deep` (default: `normal`)
- `--local` — use local Ollama models instead of cloud
- `--jira` — append Jira-ready comment block
- `--init` — save default config without prompting
- `--json` — write structured findings to llama-review-results.json

### Default cloud models

| Lane | Model | Strength |
|------|-------|----------|
| frontend | qwen3.5:cloud | Vision + thinking for UI review |
| backend | glm-5.1:cloud | Strongest code reasoning |
| security | kimi-k2.6:cloud | 262K context for attack surfaces |
| tests | deepseek-v4-flash:cloud | Fast structured analysis |
| simplify | minimax-m2.7:cloud | Cheap dead code detection |

Override with `.llama-review.yml` in project root.

### Workflow

1. Parse arguments from `$ARGUMENTS`.
2. Run `llama-review.mjs` via Bash with parsed arguments.
3. Present the report output to the user.
4. Offer interactive fix actions (AskUserQuestion).

### Failure handling

- Script exit code 2 = critical findings found
- Script exit code 1 = fatal error (report error to user)
- Script exit code 0 = no critical findings
- Failed lanes are reported in the output table — do not retry manually.