---
title: Worktrunk status markers for pi sessions
type: feature
author: mavam
created: 2026-04-14T07:06:58.973361Z
---

Pi can now update Worktrunk branch markers automatically so `wt list` shows whether a session is actively working or waiting for input.

After installing the package, Worktrunk displays `🤖` while pi is processing a prompt and `💬` when pi is idle again:

```text
wt list
+ feature-auth      ↑ 🤖              ↑1               ../repo.feature-auth
+ review-copy     ? ↑ 💬              ↑1               ../repo.review-copy
```

This makes it easier to see which worktrees still need attention when you are running pi across multiple branches.
