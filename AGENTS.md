# pivot-parlor Agent Notes

## Automatic Graphite Consult

For any non-trivial code change, run Graphite before broad file reads or edits:

```bash
python -m graphite check .
python -m graphite context <likely-changed-file>
python -m graphite impact <likely-changed-file>
python -m graphite query "stats"
```

Use `python -m graphite context` first when the likely target file is known. Treat its output as a dependency map, not as proof of correctness: still read the relevant source files and tests before editing. If `python -m graphite check .` reports stale output, rebuild before relying on context or impact data.

If the graph is missing or stale, rebuild it from the repository root with:

```bash
python -m graphite -v build .
```

During active multi-file development, keep the graph current with:

```bash
python -m graphite watch . --impact
```

Graphite lives in its own git repo at `F:\Projects\graphite` and is pip-installed editable from there; it runs locally by default and should not use LLM or network calls unless explicitly configured. The bare `graphite` command works in PowerShell/cmd (via the `C:/Users/fbmac/.local/bin/graphite.cmd` shim) but not in Git Bash; `python -m graphite` works in every shell, so prefer that form.

For TypeScript, Graphite uses the local TypeScript compiler resolver automatically when available. If a project has a broken TypeScript setup, fall back with `python -m graphite --typescript-resolver disabled build .`.
