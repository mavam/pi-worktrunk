This release adds Worktrunk status markers for pi sessions so `wt list` shows whether pi is actively working or waiting for input. It helps you manage multiple worktrees by making in-progress and idle branches visible at a glance.

## 🚀 Features

### Worktrunk status markers for pi sessions

Pi can now update Worktrunk branch markers automatically so `wt list` shows whether a session is actively working or waiting for input.

After installing the package, Worktrunk displays `🤖` while pi is processing a prompt and `💬` when pi is idle again:

```text
wt list
+ feature-auth      ↑ 🤖              ↑1               ../repo.feature-auth
+ review-copy     ? ↑ 💬              ↑1               ../repo.review-copy
```

This makes it easier to see which worktrees still need attention when you are running pi across multiple branches.

*By @mavam.*
