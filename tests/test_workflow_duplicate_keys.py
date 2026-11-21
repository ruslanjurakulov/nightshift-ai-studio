"""Every GitHub Actions workflow parses with no key given twice in one mapping.

What would break if this failed: GitHub refuses the whole file ("Invalid workflow file"), so the deploy, the bot or the tests
stop running at all, while PyYAML (and so every other test here) silently keeps the last value. It happened: a merge of two
branches that each wired the same worker switch into deploy_web.yml left WORKERENV_NIGHTSHIFT_FILM_ASSEMBLY twice in one env:
block, and every push of that branch failed the workflow in 0 seconds."""

import unittest
from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


class _StrictLoader(yaml.SafeLoader):
    pass


def _mapping(loader, node, deep=False):
    seen = {}
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"key {key!r} is given twice (lines {seen[key] + 1} and {key_node.start_mark.line + 1})",
                key_node.start_mark)
        seen[key] = key_node.start_mark.line
    return loader.construct_mapping(node, deep=deep)


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


class WorkflowKeysTest(unittest.TestCase):
    def test_no_workflow_gives_a_key_twice(self):
        files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        self.assertTrue(files)
        for f in files:
            with self.subTest(workflow=f.name):
                yaml.load(f.read_text(encoding="utf-8"), Loader=_StrictLoader)

    def test_the_guard_catches_a_duplicate(self):
        with self.assertRaises(yaml.constructor.ConstructorError):
            yaml.load("env:\n  A: 1\n  A: 2\n", Loader=_StrictLoader)


if __name__ == "__main__":
    unittest.main()
