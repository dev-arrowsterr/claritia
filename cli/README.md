# Claritia CLI

Run your Claritia tests in the cloud from a terminal or CI, and wait for the results.

```bash
export CLARITIA_API_KEY=clr_...    # Claritia → Settings → API keys
npx claritia run --project Shop --env staging
```

```
Running 3 tests of Shop on staging
PASS  Checkout  12.4s
PASS  Sign in (passed on re-run)  8.1s
FAIL  Save settings  app bug: Saving calls /api/save, which answers 500.
      Step 3: Check: It says saved
      https://app.tryclaritia.com/runs/7f1c…
2 passed, 1 failed (1 app bug) in 1m 4s
```

A test the Judge calls flaky is run once more. If the re-run passes, the test passes.

## Commands

| Command | Does |
|---|---|
| `claritia run` | Runs every test in the project that has steps, and waits |
| `claritia run --test "Checkout" --test "Sign in"` | Runs these tests (name or id) |
| `claritia run --use-case Checkout` | Runs one use case |
| `claritia run --no-wait` | Starts the runs and exits |
| `claritia run --json` | Prints the results as JSON |
| `claritia run --timeout 45` | Stops waiting after 45 minutes (default 30) |
| `claritia projects` | Lists projects and their environments |
| `claritia tests --project Shop` | Lists a project's tests |

`--project` is needed when the workspace has more than one project. `--env` defaults to the project's first environment. Up to 50 tests run at once.

## Exit codes

| Code | Means |
|---|---|
| 0 | Every test passed |
| 1 | A test failed |
| 2 | A test couldn't run (the site was unreachable, the queue was full) |
| 3 | A usage or API key problem |
| 4 | Timed out |

## GitHub Actions

Add `CLARITIA_API_KEY` as a repository secret.

```yaml
- name: End-to-end tests
  run: npx claritia run --project Shop --env staging
  env:
    CLARITIA_API_KEY: ${{ secrets.CLARITIA_API_KEY }}
```

The results also go in the job summary, with a link to each run.

## REST API

Every call sends `Authorization: Bearer clr_...` to `https://app.tryclaritia.com/api/v1`.

| Call | Does |
|---|---|
| `GET /projects` | Projects and their environments |
| `GET /tests?project=<id or name>` | A project's tests |
| `POST /runs` | Starts runs. Body: `{ "project", "environment"?, "tests"?: [id or name], "use_case"? }` |
| `GET /runs?ids=<id>,<id>` | Where runs stand. A flaky failure's result is its re-run's. `done` is true when every run finished. |

Each run in `GET /runs` has `status`, `done`, `passed`, `passed_on_retry`, `verdict` (`app_bug`, `flaky` or `setup`), `reason`, `failed_step` and `url`.

Runs started with a key count toward the plan's cloud minutes like any other run.
