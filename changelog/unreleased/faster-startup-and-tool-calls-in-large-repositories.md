---
title: Faster startup and tool calls in large repositories
type: bugfix
authors:
  - mavam
created: 2026-11-11T15:30:43.061925Z
---

Pi now starts quickly in large repositories, and Worktrunk tool calls no longer wait for a full `wt list` first. The `/wt list` and `/wt switch` pickers still show full status.
