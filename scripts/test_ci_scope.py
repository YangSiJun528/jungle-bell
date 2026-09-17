"""Exercise scope selection against real git diffs, including renames."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from ci_scope import DOCS_LABEL, select_mode


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "CI scope test")
        self.git("config", "user.email", "ci@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.write("README.md", "Original docs\n")
        self.write("app.py", "print('application')\n")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def write(self, path, content="Updated docs\n"):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self):
        self.git("add", "--all")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def event(self, head, labels=(DOCS_LABEL,)):
        return {"pull_request": {
            "base": {"sha": self.base},
            "head": {"sha": head},
            "labels": [{"name": label} for label in labels],
        }}

    def test_labeled_markdown_only_pr(self):
        self.write("docs/한글 문서.md")
        self.write("README.md")
        self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "docs")

    def test_no_label_and_label_removal_require_full_ci(self):
        self.write("README.md")
        head = self.commit()
        for labels in [(), ("documentation",)]:
            with self.subTest(labels=labels):
                event = self.event(head, labels)
                event["action"] = "unlabeled"
                event["label"] = {"name": DOCS_LABEL}
                self.assertEqual(select_mode("pull_request", event, self.repo), "full")

    def test_push_and_manual_run_always_require_full_ci(self):
        for name in ["push", "workflow_dispatch"]:
            with self.subTest(name=name):
                self.assertEqual(select_mode(name, {}), "full")

    def test_code_or_configuration_mixed_with_docs_requires_full_ci(self):
        for path in ["app.py", ".github/workflows/ci.yml", "docs/example.sh", "docs/image.png"]:
            with self.subTest(path=path):
                self.git("reset", "--hard", self.base)
                self.write("README.md")
                self.write(path, "changed\n")
                self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "full")

    def test_source_renamed_to_markdown_requires_full_ci(self):
        self.git("mv", "app.py", "app.md")
        self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "full")

    def test_markdown_rename_and_deletion_are_allowed(self):
        self.git("mv", "README.md", "renamed.md")
        self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "docs")
        self.git("rm", "renamed.md")
        self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "docs")

    def test_complete_pr_diff_includes_code_from_earlier_commits(self):
        self.write("app.py", "print('changed')\n")
        self.commit()
        self.write("README.md")
        self.assertEqual(select_mode("pull_request", self.event(self.commit()), self.repo), "full")

    def test_diff_uses_merge_base_when_base_branch_advances(self):
        self.git("switch", "-qc", "topic")
        self.write("README.md")
        head = self.commit()
        self.git("switch", "-q", "main")
        self.write("app.py", "print('base changed')\n")
        self.base = self.commit()
        self.assertEqual(select_mode("pull_request", self.event(head), self.repo), "docs")

    def test_empty_diff_requires_full_ci(self):
        self.assertEqual(select_mode("pull_request", self.event(self.base), self.repo), "full")

    def test_missing_revision_fails_instead_of_skipping(self):
        with self.assertRaises(subprocess.CalledProcessError):
            select_mode("pull_request", self.event("0" * 40), self.repo)


if __name__ == "__main__":
    unittest.main()
