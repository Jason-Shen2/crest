#!/usr/bin/env python3
"""Generate the three word lists crest's tier-1 heuristic word-score
needs, equivalent to warp's `natural_language_detection/*.txt` files
but rebuilt from public domain sources (no AGPL inheritance).

Outputs:
  frontend/app/term/nld/word-lists/english-stems.txt
  frontend/app/term/nld/word-lists/known-commands.txt

Sources:
  - english-stems.txt: top 10K most-common English words from
    https://github.com/first20hours/google-10000-english (MIT) →
    stemmed with Snowball English (same algorithm warp uses).  Yields
    ~3-4K unique stems after dedup.
  - known-commands.txt: hand-curated list of common Unix / dev tool
    commands.  These get the "first-token-is-a-command" treatment in
    natural_language_words_score (skip from NL scoring) plus the
    "if-seen-in-query-counts-as-NL" treatment when not in first slot.

A third list (Stack Overflow tags) that warp uses is intentionally
skipped here.  Its purpose in warp is to catch tech-vocabulary-only
inputs ("javascript array regex").  Crest's tier-2 ONNX classifier
handles those cases already and the list adds ~3K entries without
proportional accuracy benefit for our use.  Easy to add later if
needed.
"""

import shutil
from io import BytesIO
from pathlib import Path

import requests
from snowballstemmer import EnglishStemmer

ROOT = Path(__file__).parent.parent
OUT_DIR = ROOT / "frontend" / "app" / "term" / "nld" / "word-lists"

GOOGLE_10K_URL = (
    "https://raw.githubusercontent.com/first20hours/google-10000-english/master/"
    "google-10000-english-no-swears.txt"
)

# Hand-curated commands.  Mirrors warp's stack_overflow_overlap_command.txt
# in purpose: it identifies tokens that LOOK like commands so the
# scorer can skip them when they appear at position 0 (the user is
# referring to a command, not asking a NL question).
KNOWN_COMMANDS = """
ls cd pwd mkdir rmdir rm cp mv ln touch chmod chown
cat tac head tail less more echo printf
grep egrep fgrep rg ag ack find fd locate which whereis
sort uniq cut sed awk tr wc xargs tee paste join split
ps top htop kill killall pkill lsof df du free fuser
git svn hg bzr
make cmake meson ninja bazel buck
gcc g++ clang cc rustc go cargo node deno bun yarn npm pnpm pip pip3 uv
python python2 python3 ruby gem java javac mvn gradle
docker podman compose buildah kubectl helm minikube kind
ssh scp sftp rsync curl wget aria2c ping traceroute nc netcat telnet dig nslookup host
tar gzip gunzip zip unzip 7z bzip2 xz
vim vi nvim emacs nano code subl
brew apt yum dnf pacman zypper apk
zsh bash sh fish ksh tcsh
history alias unalias export source set unset
mount umount fdisk parted lsblk
systemctl service launchctl supervisorctl crontab
sudo doas su
clear reset man info help tldr
exit logout
git
""".split()


def fetch_top_words() -> list[str]:
    """Download the 10K most-common English words.  Idempotent —
    cached after the first run."""
    cache = OUT_DIR / ".google-10k-cache.txt"
    if cache.exists():
        return cache.read_text().strip().split()
    print(f"fetching {GOOGLE_10K_URL}")
    r = requests.get(GOOGLE_10K_URL, timeout=30)
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(r.text)
    return r.text.strip().split()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ----- english-stems.txt -----
    words = fetch_top_words()
    print(f"loaded {len(words)} most-common words")

    stemmer = EnglishStemmer()
    stems = {stemmer.stemWord(w.lower()) for w in words if w.isalpha()}
    # Drop single-letter "stems" — too noisy as NL signals.
    stems = {s for s in stems if len(s) >= 2}
    stems_list = sorted(stems)
    print(f"after stemming + dedup + length filter: {len(stems_list)} stems")

    (OUT_DIR / "english-stems.txt").write_text("\n".join(stems_list) + "\n")
    print(f"wrote {OUT_DIR / 'english-stems.txt'}")

    # ----- known-commands.txt -----
    commands_sorted = sorted(set(KNOWN_COMMANDS))
    (OUT_DIR / "known-commands.txt").write_text("\n".join(commands_sorted) + "\n")
    print(f"wrote {OUT_DIR / 'known-commands.txt'} ({len(commands_sorted)} entries)")

    # Cleanup cache (optional — keep around if you'll rebuild often).
    # We DO keep it so subsequent runs are fast offline.


if __name__ == "__main__":
    main()
