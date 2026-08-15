# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "playwright",
# ]
# ///
"""One-shot browser runner executing sequential actions and capturing screenshot."""

from __future__ import annotations

import json
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from playwright.sync_api import BrowserContext, ConsoleMessage, Page, sync_playwright

MAX_ACTIONS = 20
MAX_WAIT_MS = 5000
DEFAULT_ACTION_TIMEOUT_MS = 10000
DEFAULT_OVERALL_TIMEOUT_MS = 30000
DEFAULT_VIEWPORT = {"width": 1920, "height": 1080}
MAX_CONSOLE_ENTRIES = 50
MAX_CONSOLE_MSG_LENGTH = 500

ActionType = Literal["goto", "click", "fill", "press", "wait_for", "wait", "click_xy", "set_input_files"]


@dataclass(frozen=True)
class BrowserAction:
    """Structured browser action instruction."""

    action: ActionType
    url: str | None = None
    selector: str | None = None
    text: str | None = None
    files: list[str] | None = None
    key: str | None = None
    ms: int | None = None
    x: float | None = None
    y: float | None = None


@dataclass(frozen=True)
class RunnerInput:
    """Configuration and action batch for browser session."""

    actions: list[BrowserAction]
    output_path: str
    full_page: bool = False
    include_console: bool = False
    ignore_https_errors: bool = False
    action_timeout_ms: int = DEFAULT_ACTION_TIMEOUT_MS
    overall_timeout_ms: int = DEFAULT_OVERALL_TIMEOUT_MS


@dataclass
class RunnerResult:
    """Execution status and metadata returned to extension."""

    ok: bool
    output_path: str
    failed_action_index: int | None = None
    failed_action: str | None = None
    error: str | None = None
    console_logs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert result to serializable dictionary."""
        return {
            "ok": self.ok,
            "output_path": self.output_path,
            "failed_action_index": self.failed_action_index,
            "failed_action": self.failed_action,
            "error": self.error,
            "console_logs": self.console_logs,
        }


def validate_input(data: dict[str, Any]) -> RunnerInput:
    """Validate raw input dictionary against runner constraints.

    Args:
        data: Raw dictionary received from extension.

    Returns:
        Validated RunnerInput object.

    Raises:
        ValueError: If constraints or required parameters are violated.
    """
    raw_actions = data.get("actions")
    if not isinstance(raw_actions, list) or len(raw_actions) == 0:
        raise ValueError("Input must contain at least one action.")
    if len(raw_actions) > MAX_ACTIONS:
        raise ValueError(f"Number of actions exceeds maximum limit of {MAX_ACTIONS}.")

    validated_actions: list[BrowserAction] = []
    for idx, item in enumerate(raw_actions):
        if not isinstance(item, dict):
            raise ValueError(f"Action #{idx} must be an object.")
        action_name = item.get("action")
        if action_name not in {
            "goto",
            "click",
            "fill",
            "press",
            "wait_for",
            "wait",
            "click_xy",
            "set_input_files",
        }:
            raise ValueError(f"Action #{idx} has invalid action name: {action_name}")

        if action_name == "goto":
            url = item.get("url")
            if not isinstance(url, str) or not url.strip():
                raise ValueError(f"Action #{idx} (goto) requires non-empty 'url'.")
            validated_actions.append(BrowserAction(action="goto", url=url))
        elif action_name == "click":
            selector = item.get("selector")
            if not isinstance(selector, str) or not selector.strip():
                raise ValueError(
                    f"Action #{idx} (click) requires non-empty 'selector'."
                )
            validated_actions.append(BrowserAction(action="click", selector=selector))
        elif action_name == "fill":
            selector = item.get("selector")
            text = item.get("text")
            if not isinstance(selector, str) or not selector.strip():
                raise ValueError(f"Action #{idx} (fill) requires non-empty 'selector'.")
            if not isinstance(text, str):
                raise ValueError(f"Action #{idx} (fill) requires string 'text'.")
            validated_actions.append(
                BrowserAction(action="fill", selector=selector, text=text)
            )
        elif action_name == "press":
            selector = item.get("selector")
            key = item.get("key")
            if not isinstance(selector, str) or not selector.strip():
                raise ValueError(
                    f"Action #{idx} (press) requires non-empty 'selector'."
                )
            if not isinstance(key, str) or not key.strip():
                raise ValueError(f"Action #{idx} (press) requires non-empty 'key'.")
            validated_actions.append(
                BrowserAction(action="press", selector=selector, key=key)
            )
        elif action_name == "wait_for":
            selector = item.get("selector")
            if not isinstance(selector, str) or not selector.strip():
                raise ValueError(
                    f"Action #{idx} (wait_for) requires non-empty 'selector'."
                )
            validated_actions.append(
                BrowserAction(action="wait_for", selector=selector)
            )
        elif action_name == "wait":
            ms = item.get("ms")
            if not isinstance(ms, int) or ms < 0:
                raise ValueError(
                    f"Action #{idx} (wait) requires non-negative integer 'ms'."
                )
            if ms > MAX_WAIT_MS:
                raise ValueError(
                    f"Action #{idx} (wait) ms ({ms}) exceeds maximum allowed ({MAX_WAIT_MS}ms)."
                )
            validated_actions.append(BrowserAction(action="wait", ms=ms))
        elif action_name == "click_xy":
            x = item.get("x")
            y = item.get("y")
            if (
                not isinstance(x, (int, float))
                or isinstance(x, bool)
                or not isinstance(y, (int, float))
                or isinstance(y, bool)
                or x < 0
                or y < 0
            ):
                raise ValueError(
                    f"Action #{idx} (click_xy) requires non-negative numeric 'x' and 'y'."
                )
            validated_actions.append(
                BrowserAction(action="click_xy", x=float(x), y=float(y))
            )
        elif action_name == "set_input_files":
            selector = item.get("selector")
            text = item.get("text")
            raw_files = item.get("files")
            if not isinstance(selector, str) or not selector.strip():
                raise ValueError(
                    f"Action #{idx} (set_input_files) requires non-empty 'selector'."
                )
            files_list: list[str] | None = None
            if isinstance(raw_files, list):
                if not all(isinstance(f, str) and f.strip() for f in raw_files):
                    raise ValueError(
                        f"Action #{idx} (set_input_files) 'files' must be a list of non-empty strings."
                    )
                files_list = raw_files
            elif isinstance(text, str) and text.strip():
                files_list = [text]
            else:
                raise ValueError(
                    f"Action #{idx} (set_input_files) requires non-empty 'text' or 'files'."
                )
            validated_actions.append(
                BrowserAction(
                    action="set_input_files",
                    selector=selector,
                    files=files_list,
                    text=text,
                )
            )

    output_path = data.get("output_path", "screenshot.png")
    full_page = bool(data.get("full_page", False))
    include_console = bool(data.get("include_console", False))
    ignore_https_errors = bool(data.get("ignore_https_errors", False))
    action_timeout_ms = int(data.get("action_timeout_ms", DEFAULT_ACTION_TIMEOUT_MS))
    overall_timeout_ms = int(data.get("overall_timeout_ms", DEFAULT_OVERALL_TIMEOUT_MS))

    return RunnerInput(
        actions=validated_actions,
        output_path=output_path,
        full_page=full_page,
        include_console=include_console,
        ignore_https_errors=ignore_https_errors,
        action_timeout_ms=action_timeout_ms,
        overall_timeout_ms=overall_timeout_ms,
    )


def _execute_action(page: Page, action: BrowserAction, timeout_ms: int) -> None:
    """Execute a single browser action on the given page.

    Args:
        page: Playwright Page instance.
        action: BrowserAction to execute.
        timeout_ms: Timeout in milliseconds for action.
    """
    if action.action == "goto":
        assert action.url is not None
        page.goto(action.url, wait_until="domcontentloaded", timeout=float(timeout_ms))
    elif action.action == "click":
        assert action.selector is not None
        page.click(action.selector, timeout=float(timeout_ms))
    elif action.action == "fill":
        assert action.selector is not None and action.text is not None
        page.fill(action.selector, action.text, timeout=float(timeout_ms))
    elif action.action == "press":
        assert action.selector is not None and action.key is not None
        page.press(action.selector, action.key, timeout=float(timeout_ms))
    elif action.action == "wait_for":
        assert action.selector is not None
        page.wait_for_selector(
            action.selector, state="visible", timeout=float(timeout_ms)
        )
    elif action.action == "wait":
        assert action.ms is not None
        page.wait_for_timeout(float(action.ms))
    elif action.action == "click_xy":
        assert action.x is not None and action.y is not None
        page.mouse.click(action.x, action.y)
    elif action.action == "set_input_files":
        assert action.selector is not None
        files = (
            action.files
            if action.files
            else ([action.text] if action.text else [])
        )
        page.set_input_files(action.selector, files, timeout=float(timeout_ms))


def run_browser_session(runner_input: RunnerInput) -> RunnerResult:
    """Launch headless browser, execute actions, capture screenshot, and return result.

    Args:
        runner_input: Configuration and action list.

    Returns:
        RunnerResult object.
    """
    console_logs: list[str] = []

    def handle_console(msg: ConsoleMessage) -> None:
        if len(console_logs) < MAX_CONSOLE_ENTRIES:
            text = (
                msg.text[:MAX_CONSOLE_MSG_LENGTH]
                if len(msg.text) > MAX_CONSOLE_MSG_LENGTH
                else msg.text
            )
            console_logs.append(f"[{msg.type}] {text}")

    def handle_page_error(err: Exception) -> None:
        if len(console_logs) < MAX_CONSOLE_ENTRIES:
            console_logs.append(f"[pageerror] {str(err)}")

    with tempfile.TemporaryDirectory() as user_data_dir:
        with sync_playwright() as pw:
            context: BrowserContext = pw.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=True,
                viewport=DEFAULT_VIEWPORT,
                ignore_https_errors=runner_input.ignore_https_errors,
            )
            try:
                page = context.pages[0] if context.pages else context.new_page()
                if runner_input.include_console:
                    page.on("console", handle_console)
                    page.on("pageerror", handle_page_error)

                failed_idx: int | None = None
                failed_act: str | None = None
                action_err: str | None = None

                start_time = time.monotonic()
                overall_deadline = start_time + (
                    runner_input.overall_timeout_ms / 1000.0
                )

                for idx, act in enumerate(runner_input.actions):
                    remaining_sec = overall_deadline - time.monotonic()
                    if remaining_sec <= 0:
                        failed_idx = idx
                        failed_act = act.action
                        action_err = f"Overall session timeout of {runner_input.overall_timeout_ms}ms exceeded."
                        break

                    effective_timeout_ms = min(
                        runner_input.action_timeout_ms,
                        int(remaining_sec * 1000),
                    )

                    if act.action == "wait":
                        assert act.ms is not None
                        if act.ms > effective_timeout_ms:
                            page.wait_for_timeout(float(effective_timeout_ms))
                            failed_idx = idx
                            failed_act = act.action
                            action_err = f"Action timeout: wait duration ({act.ms}ms) exceeded remaining overall deadline ({effective_timeout_ms}ms)."
                            break

                    try:
                        _execute_action(page, act, effective_timeout_ms)
                    except Exception as exc:
                        failed_idx = idx
                        failed_act = act.action
                        action_err = str(exc)
                        break

                # Always attempt to capture final screenshot of current page state
                try:
                    rem_ss_sec = overall_deadline - time.monotonic()
                    ss_timeout_ms = (
                        max(1000, int(rem_ss_sec * 1000)) if rem_ss_sec > 0 else 1000
                    )
                    page.screenshot(
                        path=runner_input.output_path,
                        full_page=runner_input.full_page,
                        timeout=float(ss_timeout_ms),
                    )
                except Exception as ss_exc:
                    if action_err is None:
                        action_err = f"Screenshot capture failed: {ss_exc}"

                return RunnerResult(
                    ok=(failed_idx is None and action_err is None),
                    output_path=runner_input.output_path,
                    failed_action_index=failed_idx,
                    failed_action=failed_act,
                    error=action_err,
                    console_logs=(console_logs if runner_input.include_console else []),
                )
            finally:
                context.close()


def main() -> None:
    """Main CLI entrypoint reading JSON input from stdin and emitting JSON result to stdout."""
    try:
        raw_input = json.load(sys.stdin)
        runner_input = validate_input(raw_input)
        result = run_browser_session(runner_input)
        print(json.dumps(result.to_dict()))
    except Exception as exc:
        err_res = {
            "ok": False,
            "output_path": "",
            "failed_action_index": None,
            "failed_action": None,
            "error": str(exc),
            "console_logs": [],
        }
        print(json.dumps(err_res))
        sys.exit(1)


if __name__ == "__main__":
    main()
