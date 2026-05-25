# Llama Review Agents

## llama-review

Multi-model code review conductor. Dispatches parallel specialist reviewers through Ollama, merges findings into a prioritized report.

**Dispatch rule:** Every review lane dispatches via the Ollama HTTP API. Same command for cloud and local models. Agent tools all run on the same model — using them means every lane produces the same perspective, which defeats the multi-model purpose entirely. A failed lane is honest. A lane on the wrong model is worse than no lane at all. The Models Used table Dispatch column must say "ollama API" — if it says "Agent" or a specialist type name, the review is invalid.

**Command template:**
```
RESULT=$(jq -Rs --arg model "<model>" '{model: $model, prompt: ., stream: false}' <prompt-file> | curl -s --max-time 240 http://localhost:11434/api/generate -d @- | jq -r '.response') && if [ -z "$RESULT" ]; then echo "LANE_ERROR: empty response from API" >&2; exit 1; fi && echo "$RESULT"
```

**Critical rules:**
- **No `&` in commands.** `run_in_background: true` handles parallelism. Adding `&` causes the shell to exit before curl completes — empty output on every lane.
- **Validate output is non-empty.** Capture the result in a variable and check it before treating the lane as successful. An empty response is a lane failure.
- **Timeout: 300000 (5 min) per lane.** Cloud models respond in 60-120s. 5 minutes gives headroom without hanging the review.
- **`--max-time 240` on curl.** HTTP-level timeout shorter than the harness timeout so failures surface cleanly.
- **`stream: true` for diffs >500KB per lane.** Prevents Ollama server-side timeouts on slow cloud models.
- **Cap diffs at 1MB hard limit.** Models can't handle more. Warn at 100KB+.

**Cloud model rule:** Do NOT run `ollama list` to check for cloud models. Cloud models (`:cloud` suffix) do not appear in `ollama list`. This is the #1 failure mode — running `ollama list`, seeing only local models, and falling back to Agent specialists. Trust the `:cloud` suffix and dispatch directly with the Ollama HTTP API.

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

1. Pre-flight: check `ollama` is on PATH. Validate target ref. Do NOT run `ollama list` in cloud mode.
2. Load config from `.llama-review.yml` or defaults. Offer to save if missing.
3. Print dispatch plan with model, type, effort per lane.
4. Group changed files into lanes by pattern. Apply diff-size consolidation (1-3 files → 1 model, 4-10 → 2 models, 11+ → all).
5. Build prompts from templates, append filtered diffs (20K char limit per lane).
6. Dispatch ALL lanes as parallel Ollama HTTP API calls in a single message.
7. Collect results. Strip thinking blocks (Claude, Qwen, DeepSeek, GLM, Kimi, MiniMax). Parse `FILE:` or `NO_ISSUES` format. Apply fallback regex extraction if format doesn't match.
8. Merge, deduplicate by root cause, rank into Critical / Needs Attention / Noted.
9. Validate against finding contract (FILE, LINE, CODE, FAILURE, CONFIDENCE, FIX). Discard generic advice.
10. Output report with Models Used table, findings, suggested test commands, PR summary, next steps.

### Failure handling

- API call fails → mark lane as Failed, report error honestly. Do NOT retry with a different model or Agent specialists.
- Timeout (5 min) → mark lane as "Timed out", continue.
- Unexpected output format → strip thinking blocks, apply fallback regex extraction (Step 8), then mark as "Failed: unexpected output format" if still unparseable.