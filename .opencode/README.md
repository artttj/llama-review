# llama-review for OpenCode

Multi-model code review through Ollama. Different models, different strengths, one report.

## Install

```bash
# project-local
git clone https://github.com/artttj/llama-review.git /tmp/llama-review
cp -R /tmp/llama-review/.opencode/* .opencode/

# or global
cp -R /tmp/llama-review/.opencode/* ~/.config/opencode/
```

## Usage

```
/llama-review
```

## What works out of the box

The command runs with the bundled prompt. No external skills required.

## Format differences from Claude Code

- Commands use `mode: subagent` and a `permission` block declaring `edit`, `write`, and `bash`
- OpenCode reads skills from `.opencode/skills/` or `.claude/skills/` natively
