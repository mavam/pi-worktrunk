# 🚦 pi-worktrunk

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
extension that updates Worktrunk branch markers via `wt` so `wt list` shows
whether pi is currently working or waiting for input.

## 📦 Install

Just one command:

```bash
pi install npm:pi-worktrunk
```

## ✨ What it does

- Sets the current branch marker to `💬` when pi starts and whenever pi becomes
  idle again
- Switches the marker to `🤖` while pi is actively working on a prompt
- Clears the marker on shutdown so `wt list` does not accumulate stale status
- Fails quietly when `wt` is unavailable or the current directory is not managed
  by Worktrunk

## 👀 Preview

A tiny status badge with disproportionate emotional value:

```text
wt list
+ feature-auth      ↑ 🤖              ↑1               ../repo.feature-auth
+ review-copy     ? ↑ 💬              ↑1               ../repo.review-copy
```

## ✅ Requirements

- [`wt`](https://worktrunk.dev/) must be installed and available on your `PATH`
- The current repository should be managed by Worktrunk for markers to appear
  in `wt list`

## 🧠 How it works

The extension maps pi lifecycle events to Worktrunk markers:

- `session_start` → `💬`
- `agent_start` → `🤖`
- `agent_end` → `💬`
- `session_shutdown` → clear marker

## 📄 License

[MIT](LICENSE)
