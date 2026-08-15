# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "playwright",
# ]
# ///
"""Unit and smoke tests for the browser screenshot runner."""

from __future__ import annotations

import base64
import os
import tempfile
import unittest
from typing import Any

from runner import (
    MAX_ACTIONS,
    MAX_WAIT_MS,
    BrowserAction,
    RunnerInput,
    run_browser_session,
    validate_input,
)


class TestRunnerValidation(unittest.TestCase):
    """Test input and action validation rules."""

    def test_validate_empty_actions(self) -> None:
        """Reject empty actions list."""
        data: dict[str, Any] = {"actions": []}
        with self.assertRaises(ValueError) as ctx:
            validate_input(data)
        self.assertIn("at least one action", str(ctx.exception).lower())

    def test_validate_max_actions_exceeded(self) -> None:
        """Reject more than MAX_ACTIONS."""
        actions = [{"action": "wait", "ms": 100}] * (MAX_ACTIONS + 1)
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": actions})
        self.assertIn("max", str(ctx.exception).lower())

    def test_validate_action_goto_missing_url(self) -> None:
        """Reject goto action without url."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "goto"}]})
        self.assertIn("url", str(ctx.exception).lower())

    def test_validate_action_click_missing_selector(self) -> None:
        """Reject click action without selector."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "click"}]})
        self.assertIn("selector", str(ctx.exception).lower())

    def test_validate_action_fill_missing_fields(self) -> None:
        """Reject fill action missing selector or text."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "fill", "selector": "#input"}]})
        self.assertIn("text", str(ctx.exception).lower())

    def test_validate_action_press_missing_key(self) -> None:
        """Reject press action without key."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "press", "selector": "#input"}]})
        self.assertIn("key", str(ctx.exception).lower())

    def test_validate_action_wait_max_limit(self) -> None:
        """Reject wait exceeding MAX_WAIT_MS."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "wait", "ms": MAX_WAIT_MS + 1}]})
        self.assertIn("ms", str(ctx.exception).lower())

    def test_validate_action_click_xy_negative_coords(self) -> None:
        """Reject click_xy with negative x or y."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "click_xy", "x": -1, "y": 10}]})
        self.assertIn("non-negative", str(ctx.exception).lower())

        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "click_xy", "x": 10, "y": -5.5}]})
        self.assertIn("non-negative", str(ctx.exception).lower())

    def test_validate_action_click_xy_missing_coords(self) -> None:
        """Reject click_xy missing x or y."""
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "click_xy", "x": 10}]})
        self.assertIn("y", str(ctx.exception).lower())

    def test_validate_action_set_input_files_accepts_text_and_files(self) -> None:
        """Accept set_input_files with selector and one path in text or multiple paths in files."""
        # text with one path
        parsed_text = validate_input(
            {"actions": [{"action": "set_input_files", "selector": "#upload", "text": "/tmp/a.txt"}]}
        )
        self.assertEqual(parsed_text.actions[0].action, "set_input_files")
        self.assertEqual(parsed_text.actions[0].selector, "#upload")
        self.assertEqual(parsed_text.actions[0].files, ["/tmp/a.txt"])
        self.assertEqual(parsed_text.actions[0].text, "/tmp/a.txt")

        # files with multiple paths
        parsed_files = validate_input(
            {
                "actions": [
                    {
                        "action": "set_input_files",
                        "selector": "#upload",
                        "files": ["/tmp/a.txt", "/tmp/b.txt"],
                    }
                ]
            }
        )
        self.assertEqual(parsed_files.actions[0].action, "set_input_files")
        self.assertEqual(parsed_files.actions[0].selector, "#upload")
        self.assertEqual(parsed_files.actions[0].files, ["/tmp/a.txt", "/tmp/b.txt"])

    def test_validate_action_set_input_files_rejection(self) -> None:
        """Reject set_input_files for missing selector and invalid/empty files."""
        # missing selector
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "text": "/tmp/a.txt"}]})
        self.assertIn("selector", str(ctx.exception).lower())

        # empty selector
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "   ", "text": "/tmp/a.txt"}]})
        self.assertIn("selector", str(ctx.exception).lower())

        # missing text and files
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "#upload"}]})
        self.assertIn("text", str(ctx.exception).lower())

        # empty text
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "#upload", "text": "  "}]})
        self.assertIn("text", str(ctx.exception).lower())

        # invalid files types or empty items
        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "#upload", "files": [""]}]})
        self.assertIn("files", str(ctx.exception).lower())

        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "#upload", "files": [123]}]})
        self.assertIn("files", str(ctx.exception).lower())

        with self.assertRaises(ValueError) as ctx:
            validate_input({"actions": [{"action": "set_input_files", "selector": "#upload", "files": "not-a-list"}]})
        self.assertIn("text", str(ctx.exception).lower())

    def test_validate_valid_payload(self) -> None:
        """Accept well-formed input payload."""
        payload: dict[str, Any] = {
            "actions": [
                {"action": "goto", "url": "data:text/html,<h1>Test</h1>"},
                {"action": "wait_for", "selector": "h1"},
                {"action": "wait", "ms": 200},
            ],
            "full_page": True,
            "include_console": True,
            "ignore_https_errors": False,
        }
        parsed = validate_input(payload)
        self.assertEqual(len(parsed.actions), 3)
        self.assertTrue(parsed.full_page)
        self.assertTrue(parsed.include_console)
        self.assertFalse(parsed.ignore_https_errors)


class TestOverallTimeout(unittest.TestCase):
    """Test overall deadline enforcement in Python runner."""

    def test_overall_timeout_aborts_actions_and_captures_screenshot(self) -> None:
        """Runner aborts before finishing all actions if overall deadline is exceeded."""
        html = "<html><body><h1>Timeout Test</h1></body></html>"
        data_url = f"data:text/html;base64,{base64.b64encode(html.encode('utf-8')).decode('utf-8')}"

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = os.path.join(tmpdir, "timeout_ss.png")
            runner_input = RunnerInput(
                actions=[
                    BrowserAction(action="goto", url=data_url),
                    BrowserAction(action="wait", ms=500),
                    BrowserAction(action="wait", ms=500),
                    BrowserAction(action="wait", ms=500),
                ],
                output_path=output_path,
                action_timeout_ms=1000,
                overall_timeout_ms=400,
                full_page=False,
                include_console=False,
                ignore_https_errors=False,
            )

            result = run_browser_session(runner_input)
            self.assertFalse(result.ok)
            self.assertIsNotNone(result.failed_action_index)
            self.assertIn("timeout", str(result.error).lower())
            self.assertTrue(os.path.exists(output_path))
            self.assertGreater(os.path.getsize(output_path), 0)


class TestPlaywrightOfflineSmoke(unittest.TestCase):
    """Offline Playwright smoke scenario with data URLs."""

    def test_offline_data_url_actions_and_screenshot(self) -> None:
        """Execute click, fill, wait_for offline and verify non-empty PNG output."""
        html = """
        <html>
        <body>
            <input id="target-input" type="text" />
            <button id="target-button" onclick="document.getElementById('result').textContent = document.getElementById('target-input').value;">Submit</button>
            <div id="result"></div>
        </body>
        </html>
        """
        data_url = f"data:text/html;base64,{base64.b64encode(html.encode('utf-8')).decode('utf-8')}"

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = os.path.join(tmpdir, "screenshot.png")
            runner_input = RunnerInput(
                actions=[
                    BrowserAction(action="goto", url=data_url),
                    BrowserAction(
                        action="fill", selector="#target-input", text="Hello Pi"
                    ),
                    BrowserAction(action="click", selector="#target-button"),
                    BrowserAction(action="wait_for", selector="#result"),
                ],
                output_path=output_path,
                full_page=False,
                include_console=True,
                ignore_https_errors=False,
            )

            result = run_browser_session(runner_input)
            self.assertTrue(result.ok, f"Run failed: {result.error}")
            self.assertTrue(os.path.exists(output_path))
            self.assertGreater(os.path.getsize(output_path), 0)

    def test_offline_set_input_files_smoke(self) -> None:
        """Execute set_input_files offline and verify file attachment and screenshot output."""
        html = """
        <html>
        <body>
            <input id="file-input" type="file" onchange="document.getElementById('result').textContent = this.files[0].name;" />
            <div id="result"></div>
        </body>
        </html>
        """
        data_url = f"data:text/html;base64,{base64.b64encode(html.encode('utf-8')).decode('utf-8')}"

        with tempfile.TemporaryDirectory() as tmpdir:
            sample_file = os.path.join(tmpdir, "test_upload.txt")
            with open(sample_file, "w", encoding="utf-8") as f:
                f.write("hello file upload")

            output_path = os.path.join(tmpdir, "upload_screenshot.png")
            runner_input = RunnerInput(
                actions=[
                    BrowserAction(action="goto", url=data_url),
                    BrowserAction(
                        action="set_input_files",
                        selector="#file-input",
                        files=[sample_file],
                    ),
                    BrowserAction(action="wait_for", selector="#result:has-text('test_upload.txt')"),
                ],
                output_path=output_path,
                full_page=False,
                include_console=True,
                ignore_https_errors=False,
            )

            result = run_browser_session(runner_input)
            self.assertTrue(result.ok, f"Run failed: {result.error}")
            self.assertTrue(os.path.exists(output_path))
            self.assertGreater(os.path.getsize(output_path), 0)

    def test_action_failure_captures_screenshot(self) -> None:
        """Verify that action failure stops remaining actions and captures screenshot of state."""
        html = "<html><body><h1>Fail Page</h1></body></html>"
        data_url = f"data:text/html;base64,{base64.b64encode(html.encode('utf-8')).decode('utf-8')}"

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = os.path.join(tmpdir, "fail_screenshot.png")
            runner_input = RunnerInput(
                actions=[
                    BrowserAction(action="goto", url=data_url),
                    BrowserAction(
                        action="click", selector="#nonexistent-btn"
                    ),  # will fail on 10s or custom timeout
                ],
                output_path=output_path,
                action_timeout_ms=1000,  # speed up test
                full_page=False,
                include_console=False,
                ignore_https_errors=False,
            )

            result = run_browser_session(runner_input)
            self.assertFalse(result.ok)
            self.assertEqual(result.failed_action_index, 1)
            self.assertEqual(result.failed_action, "click")
            self.assertIsNotNone(result.error)
            self.assertTrue(os.path.exists(output_path))
            self.assertGreater(os.path.getsize(output_path), 0)


if __name__ == "__main__":
    unittest.main()
