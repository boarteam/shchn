#!/usr/bin/env python3
"""Runs a command in a pseudo-terminal and presses keys at given times.

    python3 tools/pty-keys.py "2:<enter>,10:<enter>,14:<ctrl-c>" ./shchn live --pause-after 4

Interactive behavior (the Enter prompt, the silence pause, Ctrl+C finishing a
session cleanly) only shows up in a real terminal: a pipe isn't a TTY and a
signal sent with `kill` doesn't go to the whole foreground process group the
way Ctrl+C does. This tool gives the command a 120x40 terminal, types the keys,
and prints everything it showed (with escape codes stripped) plus the exit status.

It's how `npm run` and `tsx` were caught exiting on Ctrl+C before the session
could finish (hence the ./shchn launcher). Standard library only; macOS/Linux.
"""
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

KEYS = {"<enter>": "\n", "<ctrl-c>": "\x03", "<ctrl-d>": "\x04"}


def parse_plan(spec):
    plan = []
    for part in spec.split(","):
        at, keys = part.split(":", 1)
        for name, value in KEYS.items():
            keys = keys.replace(name, value)
        plan.append((float(at), keys))
    return sorted(plan)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    plan = parse_plan(sys.argv[1])
    timeout = (plan[-1][0] if plan else 0) + 30
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[2], sys.argv[2:])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    output = b""
    start = time.time()
    while True:
        now = time.time() - start
        while plan and now >= plan[0][0]:
            keys = plan.pop(0)[1]
            os.write(fd, keys.encode())
            output += f"\n[{now:.1f}s: pressed {keys!r}]\n".encode()
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            output += data
        if now > timeout:
            os.kill(pid, 9)
            output += b"\n[timed out]\n"
            break
    _, status = os.waitpid(pid, 0)
    print(re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", output).decode(errors="replace"))
    print(f"exit status: {os.waitstatus_to_exitcode(status)}")


if __name__ == "__main__":
    main()
