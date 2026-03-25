---
type: project-note
title: "TinyClaw (Pepe)"
status: "active"
priority: "Medium"
business: "Internal"
repo: "tjp2021/tinyclaw"
updated: 2026-02-26
created: 2026-01-01
tags:
  - project
  - telegram
  - ai-agent
---

# TinyClaw (Pepe)

## Overview
AI agent framework running on tinyclaw server (165.22.11.9). Pepe is the Telegram-facing agent using Anthropic Opus 4.6.

## Current Status
Running on tinyclaw. Telegram interface active. WhatsApp scraping moved to Mac-only standalone read-only server.

## Key Decisions
- WhatsApp scraping ONLY on Mac, NEVER on server
- Telegram is the primary agent channel
- Agent runs as non-root dedicated user

## Links
- TinyClaw: 165.22.11.9
