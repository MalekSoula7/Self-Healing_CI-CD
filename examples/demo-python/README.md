# pipeheal-demo-python

A small invoicing module (line totals, tax, formatting) with the usual checks, used to try
PipeHeal on real CI failures.

```sh
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\pip
ruff check .
mypy
pytest
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull request, and uploads
the pytest results as JUnit XML (`reports/junit.xml`).
