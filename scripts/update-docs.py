#!/usr/bin/env python3
"""
Unfiltered — Claude Code Stop Hook
Auto-updates docs/projectstatus.md and docs/changelog.md after each session.
Fires after every Claude turn; skips silently if no git changes are detected.

Requirements:
  - ANTHROPIC_API_KEY in environment
  - git available on PATH
  - Python 3.8+
"""

import sys
import json
import os
import subprocess
import urllib.request
import re
from datetime import datetime
from pathlib import Path


def read_hook_input() -> dict:
    """Read JSON payload from stdin (Claude Code hook protocol)."""
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def run_git(args: list, cwd: Path) -> str:
    """Run git command, return stdout or empty string on failure."""
    try:
        return subprocess.check_output(
            ["git"] + args, cwd=cwd, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return ""


def find_repo_root() -> Path | None:
    """Find the git repository root from CWD."""
    try:
        root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return Path(root)
    except Exception:
        return None


def read_transcript(path: str, max_chars: int = 6000) -> str:
    """Read the tail of the session transcript file for context."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        return content[-max_chars:] if len(content) > max_chars else content
    except Exception:
        return ""


def call_claude(api_key: str, system: str, prompt: str, max_tokens: int = 2048) -> str:
    """Call claude-haiku-4-5-20251001 synchronously via urllib (no dependencies)."""
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.load(resp)
            return data["content"][0]["text"]
    except Exception:
        return ""


def main():
    hook_data = read_hook_input()

    repo_root = find_repo_root()
    if not repo_root:
        return

    # --- Gate: only proceed if something changed ---
    git_status = run_git(["status", "--short"], repo_root)
    git_diff_stat = run_git(["diff", "--stat", "HEAD"], repo_root)
    if not git_status and not git_diff_stat:
        return  # nothing to document

    # --- Gather git context ---
    git_log = run_git(["log", "--oneline", "-5"], repo_root)
    latest_commit = run_git(["log", "--format=%h %s", "-1"], repo_root)
    commit_hash = run_git(["log", "--format=%h", "-1"], repo_root) or "uncommitted"

    # --- Read API key ---
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return  # can't generate docs without key

    # --- Read session transcript ---
    transcript_path = hook_data.get("transcript_path", "")
    transcript = read_transcript(transcript_path) if transcript_path else ""

    # --- Load existing changelog ---
    docs_dir = repo_root / "docs"
    docs_dir.mkdir(exist_ok=True)
    changelog_path = docs_dir / "changelog.md"
    status_path = docs_dir / "projectstatus.md"

    existing_changelog = (
        changelog_path.read_text(encoding="utf-8")
        if changelog_path.exists()
        else "# Changelog\n"
    )

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    # --- Build prompt ---
    system_prompt = (
        'You are a technical documentation assistant for "Unfiltered" — an AI UX interview tool '
        "built with Next.js, Convex, Claude, Speechmatics, and MiniMax Vision.\n"
        "Generate concise, factual documentation updates. Be specific. No fluff. Use markdown."
    )

    user_prompt = f"""Update project documentation for this work session.

TIMESTAMP: {timestamp}
COMMIT: {commit_hash} — {latest_commit}

GIT STATUS (changed files):
{git_status or "(no uncommitted changes)"}

GIT DIFF STAT:
{git_diff_stat or "(no diff against HEAD)"}

RECENT COMMITS:
{git_log or "(no commits yet)"}

SESSION TRANSCRIPT (last portion for context):
{transcript or "(not available)"}

---
Generate exactly two delimited sections:

[PROJECTSTATUS]
Full content for docs/projectstatus.md. This file is OVERWRITTEN every session.

# Project Status
**Last updated:** {timestamp}

## What Happened This Session
[Bullet list — specific files created/modified, features built, decisions made. Be concrete.]

## Issues / Watch Out For
[Problems encountered, edge cases, gotchas. "None" if clean.]

## Where We Left Off
[Exact state — what's complete, what's in progress, what's next.]

## How to Continue
[Concrete next step with file references. One sentence.]

(Max 350 words total.)
[/PROJECTSTATUS]

[CHANGELOG]
ONE new entry to prepend to the existing changelog. Use this exact format:

## {timestamp} — [3-6 word title describing what changed]
**Commit:** {commit_hash}
- [specific change 1]
- [specific change 2]
- [up to 6 bullets, each specific and factual]

Only the new entry — do not include the rest of the changelog.
[/CHANGELOG]"""

    # --- Call Claude ---
    response = call_claude(api_key, system_prompt, user_prompt)
    if not response:
        return

    # --- Parse and write ---
    status_match = re.search(r"\[PROJECTSTATUS\](.*?)\[/PROJECTSTATUS\]", response, re.DOTALL)
    changelog_match = re.search(r"\[CHANGELOG\](.*?)\[/CHANGELOG\]", response, re.DOTALL)

    if status_match:
        status_path.write_text(status_match.group(1).strip() + "\n", encoding="utf-8")

    if changelog_match:
        new_entry = changelog_match.group(1).strip()
        if existing_changelog.startswith("# Changelog"):
            rest = existing_changelog[len("# Changelog"):].lstrip("\n")
            updated = f"# Changelog\n\n{new_entry}\n\n{rest}" if rest else f"# Changelog\n\n{new_entry}\n"
        else:
            updated = f"{new_entry}\n\n{existing_changelog}"
        changelog_path.write_text(updated, encoding="utf-8")


if __name__ == "__main__":
    main()
