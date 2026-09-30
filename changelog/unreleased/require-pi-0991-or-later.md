---
title: Require Pi 0.99.1 or later
type: breaking
authors:
  - mavam
prs:
  - 23
created: 2026-09-30T07:30:25.782368Z
---

`pi-worktrunk` now requires Pi 0.99.1 or later and no longer carries compatibility code for earlier versions. It also stops rendering session-transition messages written by very old releases and no longer accepts the obsolete tool-call format that put the Worktrunk command inside `args`.
