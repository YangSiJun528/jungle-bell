"""Allow lightweight CI only for labeled PRs whose complete diff is Markdown."""

import json
import os
from pathlib import Path
import subprocess


DOCS_LABEL = "ci:docs-only"


def select_mode(event_name, event, repo="."):
    if event_name != "pull_request":
        return "full"

    pr = event["pull_request"]
    if not any(label["name"] == DOCS_LABEL for label in pr["labels"]):
        return "full"

    # Disabling rename detection keeps both paths: renaming source to .md
    # must still count as a source deletion. NUL separators preserve filenames.
    changed = subprocess.check_output(
        [
            "git", "diff", "--name-only", "--no-renames", "-z",
            f'{pr["base"]["sha"]}...{pr["head"]["sha"]}', "--",
        ],
        cwd=repo,
    )
    paths = [path for path in changed.split(b"\0") if path]
    return "docs" if paths and all(path.endswith(b".md") for path in paths) else "full"


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    mode = select_mode(os.environ["GITHUB_EVENT_NAME"], event)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"mode={mode}\n")
    summary = (
        "ci:docs-only is present and every changed path is Markdown (.md). "
        "Run hygiene; skip web, server and desktop checks."
        if mode == "docs"
        else "Run full CI. Lightweight CI requires a ci:docs-only PR label "
        "and a non-empty diff containing only Markdown (.md)."
    )
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary + "\n")


if __name__ == "__main__":
    main()
