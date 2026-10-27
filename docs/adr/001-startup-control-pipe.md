# ADR 001 — Windows startup control

Status: accepted for implementation; Windows runtime tests pending.

Implementation Design originally selected an inherited anonymous startup pipe. Passing a raw Win32 HANDLE to a Node program does not expose an ordinary Node file descriptor automatically. We use the existing launcher-owned, current-user ACL named pipe for the startup handshake instead, avoiding an additional native Node addon.

Launcher creates the pipe before spawning Node suspended into a Job Object. A random startup nonce and pipe name are passed in the child environment (not command line, HTTP URL, or logs). Node removes these environment entries before spawning media processes. Launcher accepts backend readiness only for its own PID and nonce. Subsequent launch/stop clients use the same current-user ACL control protocol; no arbitrary command or path is accepted.

The threat boundary excludes malicious processes under the same user account. Cookies/CSRF/Origin controls separately protect localhost HTTP from unrelated websites. Native ACL, parent crash, double launch and nonce validation require Windows integration tests before release.
