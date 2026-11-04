#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyte>=0.8"]
# ///
"""Run pi with the working copy of pi-tps-meter in a pseudo-terminal and print the screen.

A development aid for what the unit tests cannot see: where the meter lands in pi's real TUI,
how it lines up with pi's own footer, and how it behaves while a real model streams. See
CONTRIBUTING.md, "Manual verification in pi".

pi runs as `pi --no-session -ne -e <repo> [-e <extra> ...]`: no session file is written and
every other extension is off, so a run never loads a second (installed) copy of this package
and never fires notification extensions. Your models, settings and pi-tps-meter config.json are
used as they are (set PI_CODING_AGENT_DIR to use another agent directory); a config.json changed
by --command "/tps ..." is restored on exit.

Examples:
  uv run scripts/tui-snapshot.py
  uv run scripts/tui-snapshot.py --cols 70 --cwd /tmp
  uv run scripts/tui-snapshot.py --with ~/.pi/agent/npm/node_modules/pi-lens
  uv run scripts/tui-snapshot.py --command "/tps right"
  uv run scripts/tui-snapshot.py --prompt "Write two sentences about West Lake. Do not use tools."
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time
from pathlib import Path

# pyte comes from the inline script metadata above: `uv run` installs it into an ephemeral
# environment, which an editor's type checker does not see.
import pyte  # pyright: ignore[reportMissingImports]

REPO = Path(__file__).resolve().parent.parent
LIVE = re.compile(r"TPS \d")  # a live rate is on screen
SUMMARY = re.compile(r"TPS --.*AVG \d")  # a message has completed: no live rate, AVG known
PARTICLES = re.compile("[\u2801-\u28ff]")  # particle-stream glyphs (U+2800, the gap, excluded)


class Pi:
    """pi in a pseudo-terminal, its output fed into a pyte screen."""

    def __init__(self, argv: list[str], cwd: str, cols: int, rows: int, env: dict[str, str]):
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child: become pi
            os.chdir(cwd)
            # Exec without a shell is the point here: the child must become pi on the pty. argv is
            # "pi" plus extension paths from this script's own command line, never outside input.
            os.execvpe(argv[0], argv, env)  # noqa: S606
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds: float) -> None:
        """Feed pi's output into the screen for `seconds`."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.02)
            if ready:
                try:
                    self.stream.feed(os.read(self.fd, 65536))
                except OSError:  # pi exited
                    return

    def submit(self, text: str) -> None:
        # One character at a time, the way a person types.
        for ch in text:
            os.write(self.fd, ch.encode())
            self.pump(0.01)
        self.pump(0.3)
        os.write(self.fd, b"\r")

    def lines(self) -> list[str]:
        return [line.rstrip() for line in self.screen.display]

    def bottom(self, n: int) -> list[str]:
        """The last `n` non-blank-terminated lines: pi's footer and whatever sits above it."""
        rows = self.lines()
        filled = [i for i, line in enumerate(rows) if line.strip()]
        if not filled:
            return []
        return rows[max(0, filled[-1] - n + 1) : filled[-1] + 1]

    def exited(self) -> bool:
        try:
            return os.waitpid(self.pid, os.WNOHANG) != (0, 0)
        except ChildProcessError:  # already reaped
            return True

    def close(self) -> None:
        """Quit pi (Ctrl+D on an empty editor); signal it if it does not exit within a second."""
        with contextlib.suppress(OSError):
            os.write(self.fd, b"\x04")
        for sig in (None, signal.SIGTERM, signal.SIGKILL):
            if sig is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(self.pid, sig)
            end = time.monotonic() + 1.0
            while time.monotonic() < end:
                if self.exited():
                    return
                self.pump(0.05)  # keep draining output so pi never blocks on a full pty


def config_file(env: dict[str, str]) -> Path:
    # Same resolution as src/config.ts agentDir().
    agent_dir = env.get("PI_CODING_AGENT_DIR") or "~/.pi/agent"
    return Path(os.path.expanduser(agent_dir)) / "pi-tps-meter" / "config.json"


def show(title: str, lines: list[str]) -> None:
    print(f"--- {title}")
    for line in lines:
        print(f"  |{line}")


def run_prompt(pi: Pi, args: argparse.Namespace) -> None:
    pi.submit(args.prompt)
    thinking: list[str] | None = None
    streaming: list[str] | None = None
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        pi.pump(0.1)
        meter = "\n".join(line for line in pi.lines() if "TTFT" in line)
        if LIVE.search(meter):
            if PARTICLES.search(meter):
                thinking = thinking or pi.bottom(args.lines)
            else:
                streaming = streaming or pi.bottom(args.lines)
        if (thinking or streaming) and SUMMARY.search(meter):
            break
    else:
        print(f"(timed out after {args.timeout:.0f}s)")
    pi.pump(1.0)
    if thinking:
        show("thinking (live reading with the particle stream)", thinking)
    if streaming:
        show("streaming (live reading)", streaming)
    if not (thinking or streaming):
        print("--- no live reading seen: the meter is off, or the request failed (see below)")
    show("after the message", pi.bottom(args.lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cols", type=int, default=120, help="terminal width (default 120)")
    parser.add_argument("--rows", type=int, default=32, help="terminal height (default 32)")
    parser.add_argument("--lines", type=int, default=4, help="bottom screen lines to print (default 4)")
    parser.add_argument("--cwd", default=str(REPO), help="directory pi starts in; the footer shows it")
    parser.add_argument("--with", dest="extra", action="append", default=[], metavar="PATH",
                        help="also load this extension or package (repeatable)")
    parser.add_argument("--command", action="append", default=[], metavar="TEXT",
                        help='submit this before the prompt, e.g. "/tps right" (repeatable)')
    parser.add_argument("--prompt", help="send this prompt (a real request to your default model)")
    parser.add_argument("--startup", type=float, default=6.0, help="seconds to let pi start (default 6)")
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to wait for the reply")
    args = parser.parse_args()

    if not shutil.which("pi"):
        sys.exit("pi is not on PATH")
    argv = ["pi", "--no-session", "-ne", "-e", str(REPO)]
    for extra in args.extra:
        argv += ["-e", os.path.expanduser(extra)]
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    config = config_file(env)
    saved = config.read_bytes() if config.exists() else None

    print("$ " + " ".join(argv))
    pi = Pi(argv, args.cwd, args.cols, args.rows, env)
    try:
        pi.pump(args.startup)
        show(f"idle ({args.cols}x{args.rows})", pi.bottom(args.lines))
        for command in args.command:
            pi.submit(command)
            pi.pump(1.5)
            show(f"after {command}", pi.bottom(args.lines))
        if args.prompt:
            run_prompt(pi, args)
    finally:
        pi.close()
        # /tps persists the mode; put the user's file back as it was.
        if saved is None and config.exists():
            config.unlink()
        elif saved is not None and config.read_bytes() != saved:
            config.write_bytes(saved)


if __name__ == "__main__":
    main()
