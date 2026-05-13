#!/usr/bin/env python3
"""v0 training data generator for crest's NLD tier-2 classifier.

Produces a balanced ~2K-sample dataset of shell-command vs natural-
language inputs.  Two design constraints drive the templates here:

1.  Multilingual coverage — crest's embedder is the paraphrase-
    multilingual MiniLM, so the head should see Chinese, English, and
    a smattering of European languages during training.  Otherwise the
    head learns the language signal alongside the intent signal and
    refuses to fire on non-English queries.

2.  Lexical-bias counterexamples — the embedder happily pulls any
    sentence containing "ls -la" toward shell-space.  To teach the
    head to override that bias we have to explicitly include
    questions-about-commands ("ls -la 是什么意思", "what does ls do",
    etc.) as NL examples.

Output: training/data.jsonl with one {text, label} per line, where
label is "shell" or "ai".
"""

import json
import random
from pathlib import Path

random.seed(42)

# ---------------------------------------------------------------------------
# Shell command vocabulary — chosen for coverage, not exhaustive realism.
# Combinations get expanded by SHELL_TEMPLATES below.
# ---------------------------------------------------------------------------

COMMANDS = [
    "ls", "cd", "pwd", "mkdir", "rmdir", "rm", "cp", "mv", "cat", "tac",
    "head", "tail", "less", "more", "grep", "find", "fd", "rg", "sed",
    "awk", "cut", "sort", "uniq", "wc", "tr", "echo", "printf",
    "ps", "top", "htop", "kill", "lsof", "df", "du", "free",
    "git", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv",
    "docker", "kubectl", "helm", "podman", "compose",
    "ssh", "scp", "rsync", "curl", "wget", "ping", "telnet", "nc",
    "tar", "gzip", "unzip", "zip", "7z",
    "make", "cargo", "go", "rustc", "node", "deno",
    "python", "python3", "ruby", "java", "javac", "mvn", "gradle",
    "vim", "nvim", "emacs", "nano", "code",
    "brew", "apt", "yum", "dnf", "pacman",
    "chmod", "chown", "ln", "touch", "which", "whereis",
    "history", "alias", "export", "source", "exit",
    "jq", "yq", "tldr", "man", "info",
]

GIT_SUBCOMMANDS = [
    "status", "add .", "add -A", "commit -m 'fix'", "commit --amend",
    "push", "push origin main", "push -f", "pull", "pull --rebase",
    "fetch", "fetch --all", "merge main", "rebase main",
    "rebase -i HEAD~3", "checkout main", "checkout -b feature/foo",
    "switch main", "branch -d old", "log --oneline -10",
    "log --graph --all", "diff", "diff HEAD~1", "diff --cached",
    "stash", "stash pop", "stash list", "reset --hard HEAD~1",
    "reset --soft HEAD~1", "cherry-pick abc123", "tag v1.0",
    "remote -v", "show HEAD", "blame foo.ts", "bisect start",
    "clone https://github.com/foo/bar", "init",
]

NPM_SUBCOMMANDS = [
    "install", "install react", "install -D vitest", "install -g pnpm",
    "run dev", "run build", "run test", "test", "audit", "audit fix",
    "ls", "outdated", "update", "ci", "publish", "init -y",
    "pack", "version patch", "version minor",
]

DOCKER_SUBCOMMANDS = [
    "ps", "ps -a", "images", "build .", "build -t app .",
    "run -it ubuntu", "run -d --rm nginx", "run -p 8080:80 nginx",
    "exec -it web bash", "logs -f web", "stop web", "rm web",
    "rmi nginx", "compose up", "compose up -d", "compose down",
    "compose logs -f", "compose build", "system prune -af",
    "volume ls", "network ls", "inspect web",
]

KUBECTL_SUBCOMMANDS = [
    "get pods", "get pods -n prod", "get svc", "get deploy",
    "describe pod web-abc123", "logs -f deploy/api", "logs web-abc",
    "apply -f deploy.yaml", "delete pod web-abc",
    "exec -it web-abc -- bash", "port-forward svc/api 8080:80",
    "config get-contexts", "config use-context prod", "rollout restart deploy/api",
    "scale deploy/api --replicas=3", "top pods",
]

PATHS = [
    ".", "..", "~", "~/projects", "~/Documents", "/tmp", "/etc/hosts",
    "/var/log", "./src", "./dist", "node_modules", "package.json",
    "README.md", "*.ts", "*.tsx", "**/*.py", "Cargo.toml", "go.mod",
]

FILES_TO_EDIT = [
    "README.md", "package.json", "Cargo.toml", "go.mod", ".gitignore",
    "src/main.ts", "src/index.tsx", "Makefile", "Dockerfile",
    ".github/workflows/ci.yml", "tsconfig.json", "vite.config.ts",
]


# ---------------------------------------------------------------------------
# Shell-command generators.  Each produces a list of plain-string commands
# that an actual user might run.
# ---------------------------------------------------------------------------

def gen_simple_commands():
    out = []
    for c in COMMANDS:
        out.append(c)
    # Common standalone usage.
    out += ["clear", ":q", ":wq", ":w", "q", "exit", "logout"]
    return out


def gen_command_with_args():
    out = []
    # ls variants
    for flags in ["", "-l", "-la", "-lah", "-1", "-lt", "-S"]:
        for path in ["", " .", " ~", " /tmp", " src"]:
            out.append(f"ls{(' ' + flags) if flags else ''}{path}")
    # cd variants
    for p in PATHS:
        out.append(f"cd {p}")
    # rm / cp / mv
    for p in PATHS:
        out.append(f"rm -rf {p}")
        out.append(f"rm {p}")
    for src in ["foo.txt", "src/", "dist/"]:
        for dst in ["bar.txt", "backup/", "/tmp/"]:
            out.append(f"cp -r {src} {dst}")
            out.append(f"mv {src} {dst}")
    # mkdir / touch
    for p in ["src/lib", "dist/cache", "tmp", "logs", "./.bin"]:
        out.append(f"mkdir -p {p}")
        out.append(f"touch {p}/file.txt")
    # cat / head / tail
    for f in ["README.md", "package.json", "/etc/hosts", "logs/app.log"]:
        out.append(f"cat {f}")
        out.append(f"head -20 {f}")
        out.append(f"tail -f {f}")
        out.append(f"less {f}")
    return out


def gen_git():
    return [f"git {sub}" for sub in GIT_SUBCOMMANDS]


def gen_npm_family():
    out = []
    for mgr in ["npm", "pnpm", "yarn", "bun"]:
        for sub in NPM_SUBCOMMANDS:
            out.append(f"{mgr} {sub}")
    # pip / uv
    for sub in ["install pandas", "install -r requirements.txt", "list",
                "show numpy", "uninstall pytest", "freeze",
                "install --upgrade pip"]:
        out.append(f"pip {sub}")
        out.append(f"pip3 {sub}")
        out.append(f"uv {sub}")
    return out


def gen_docker_kube():
    out = []
    for sub in DOCKER_SUBCOMMANDS:
        out.append(f"docker {sub}")
    for sub in KUBECTL_SUBCOMMANDS:
        out.append(f"kubectl {sub}")
    out += [
        "docker compose up -d",
        "docker compose down -v",
        "podman ps",
        "helm install app ./chart",
    ]
    return out


def gen_search_and_pipes():
    out = [
        "grep -r 'TODO' src/",
        "grep -rE 'TODO|FIXME|HACK' .",
        "rg --type rust unsafe",
        "fd -e py main",
        "find . -name '*.ts' -not -path '*/node_modules/*'",
        "find . -mtime -1 -type f",
        "cat README.md | grep TODO",
        "cat logs/app.log | grep ERROR | wc -l",
        "ps aux | grep node",
        "lsof -i :3000",
        "ls -la | grep '.json'",
        "git log --oneline | head -20",
        "cat /etc/hosts | grep localhost",
        "du -sh * | sort -h",
        "history | grep git",
        "echo $PATH | tr ':' '\\n'",
        "curl -sSL https://example.com | jq .",
        "find . -name node_modules -type d -prune -exec rm -rf {} +",
    ]
    return out


def gen_build_test():
    return [
        "make", "make test", "make clean", "make install",
        "cargo build", "cargo build --release", "cargo test",
        "cargo test -- --nocapture", "cargo run", "cargo check",
        "cargo fmt", "cargo clippy", "cargo doc --open",
        "go build", "go run ./cmd/server", "go test ./...",
        "go mod tidy", "go vet ./...",
        "rustc main.rs", "rustc -O main.rs",
        "vitest run", "vitest watch", "vitest --coverage",
        "jest", "jest --watch", "jest --coverage",
        "pytest", "pytest -v", "pytest tests/",
        "npm run dev", "npm run build", "npm test", "npm run lint",
    ]


def gen_net_and_misc():
    return [
        "ssh user@server.example.com",
        "ssh -p 2222 user@host",
        "scp file.tar.gz remote:/tmp/",
        "rsync -avz src/ remote:dst/",
        "curl -sSL https://example.com",
        "curl -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:3000/api",
        "wget https://example.com/file.tar.gz",
        "ping google.com",
        "ping -c 4 1.1.1.1",
        "nc -lv 8080",
        "tar -xzf archive.tar.gz",
        "tar -czf backup.tar.gz src/",
        "unzip dist.zip",
        "zip -r backup.zip src/",
        "chmod +x script.sh",
        "chmod 755 script.sh",
        "chown user:group file",
        "which node",
        "whereis python",
        "history",
        "export FOO=bar",
        "source ~/.zshrc",
        "echo $HOME",
        "echo $?",
    ]


def gen_editor():
    out = []
    for ed in ["vim", "nvim", "code"]:
        for f in FILES_TO_EDIT:
            out.append(f"{ed} {f}")
    return out


def gen_process():
    return [
        "ps aux", "ps -ef", "top", "htop", "kill -9 1234",
        "kill 5678", "killall node", "pkill chrome",
        "df -h", "du -sh ~", "free -h",
        "uname -a", "uname -m", "uptime",
        "whoami", "id", "groups",
    ]


def collect_shell():
    sources = [
        gen_simple_commands,
        gen_command_with_args,
        gen_git,
        gen_npm_family,
        gen_docker_kube,
        gen_search_and_pipes,
        gen_build_test,
        gen_net_and_misc,
        gen_editor,
        gen_process,
    ]
    out = []
    for fn in sources:
        out.extend(fn())
    # Dedupe while preserving order so debugging diffs stay stable.
    seen = set()
    deduped = []
    for s in out:
        if s not in seen:
            seen.add(s)
            deduped.append(s)
    return deduped


# ---------------------------------------------------------------------------
# Natural-language generators.  Templates plus curated standalone questions
# in multiple languages.
# ---------------------------------------------------------------------------

CMD_FOR_QUESTIONS = [
    "ls", "ls -la", "cd", "pwd", "rm -rf", "git status", "git push",
    "git rebase", "git pull", "git stash", "git fetch", "git log",
    "npm install", "npm run dev", "yarn add", "docker compose up",
    "docker ps", "kubectl get pods", "find", "grep", "sed", "awk",
    "curl", "ssh", "scp", "rsync", "chmod", "chown", "make",
    "cargo build", "go test", "pytest", "vim", "vimrc", "tmux",
    "screen", "history", "alias", "export", "source", ".zshrc", ".bashrc",
]

EN_QUESTION_TEMPLATES = [
    # wh-prefix (canonical English question form)
    "what does {x} do",
    "what does {x} mean",
    "what is the meaning of {x}",
    "what's the purpose of {x}",
    "how do I use {x}",
    "how does {x} work",
    "how to use {x}",
    "can you explain {x}",
    "explain {x}",
    "explain the {x} command",
    "explain {x} for me",
    "explain the {x} flag",
    "explain what {x} does",
    "why is my {x} failing",
    "why does {x} return an error",
    "why is {x} so slow",
    "is there a way to {x}",
    "where does {x} store its config",
    "show me how to {x}",
    "give me an example of {x}",
    "what's the difference between {x} and something similar",
    "tell me about {x}",
    # Reverse / head-final order — the "X means what?" pattern that
    # tripped the v1 model.  MiniLM treats word order with some
    # sensitivity even though it's a sentence embedder, so we have to
    # teach the head this phrasing explicitly.
    "{x} means what",
    "{x} means what?",
    "{x} is what",
    "{x} does what exactly",
    "{x} stands for what",
    "what means {x}",
    "what is {x}",
    "what {x} does",
    "{x} how do I use it",
    "{x} what is it",
    # Command embedded mid-sentence — proves to the head that the
    # presence of a command anywhere is NOT itself a shell signal.
    "can you explain {x} for me",
    "tell me what {x} does",
    "the {x} command does what",
    "the {x} command means what",
    "I don't understand the {x} command",
    "help me with {x}",
    "help me figure out {x}",
    "I'm trying to understand {x}",
    "I want to know what {x} does",
    "what should I expect from {x}",
]

EN_GENERAL_QUESTIONS = [
    "what does this error mean",
    "what is the time complexity of quicksort",
    "explain this stack trace",
    "explain how async/await works",
    "explain the event loop",
    "how do I list all files in the current directory",
    "how do I find which process is using port 3000",
    "how can I undo my last commit",
    "how do I revert a file to the previous commit",
    "how can I split a string in python",
    "how can I read a json file in go",
    "write a python function that sorts a list",
    "write a typescript hook that debounces",
    "write a script that backs up my home folder nightly",
    "refactor this code to use async/await",
    "convert this bash script to python",
    "generate unit tests for the user service",
    "summarize the changes in this pr",
    "review this code and tell me what could break",
    "design a schema for a todo app",
    "implement binary search in rust",
    "fix the bug in this function",
    "draft a commit message for these changes",
    "translate this comment to chinese",
    "what package should i use to parse yaml in go",
    "help me debug a memory leak in node",
    "show me an example of using fetch with retry",
    "please refactor this function for me",
    "please write a regex that matches email addresses",
    "can you check this code for security issues",
    "is there a built-in way to flatten an array in javascript",
    "should I use let or const here",
    "thanks for the help",
    "thank you",
    "hello",
    "hi there",
    "hey",
    "good morning",
    "nice work",
    "looks good",
    "yes",
    "no",
    "continue",
    "do it",
    "go ahead",
    "stop",
    "wait",
    "what",
    "explain",
    "ok",
]

ZH_QUESTION_TEMPLATES = [
    # 标准疑问句
    "{x} 是什么意思",
    "{x} 怎么用",
    "怎么用 {x}",
    "{x} 怎么用法",
    "{x} 怎么操作",
    "怎么理解 {x}",
    "{x} 是干什么的",
    "{x} 是干嘛的",
    "解释一下 {x}",
    "解释下 {x}",
    "{x} 的作用是什么",
    "{x} 的意思是什么",
    "{x} 是什么",
    "为什么我的 {x} 出错",
    "为什么 {x} 一直失败",
    "{x} 出错了",
    "{x} 怎么回滚",
    "{x} 报错怎么办",
    "帮我看看 {x}",
    "帮我解释 {x}",
    "讲一下 {x}",
    "能不能讲讲 {x}",
    # 命令出现在句子中间或后部
    "{x} 这条命令的作用",
    "{x} 这个命令是干什么的",
    "{x} 这条指令怎么理解",
    "我想知道 {x} 是干什么的",
    "我不太理解 {x}",
    "帮我搞懂 {x}",
    "麻烦解释一下 {x} 的用法",
    "你能不能告诉我 {x} 是干什么的",
    "{x} 是不是用来 ...",
    # 缩短 / 口语化
    "{x} 啥意思",
    "{x} 啥用",
    "{x} 干嘛",
]

ZH_GENERAL_QUESTIONS = [
    "怎么列出当前目录下的所有文件",
    "怎么查看当前进程",
    "怎么 kill 一个进程",
    "怎么看磁盘占用",
    "怎么找端口被谁占用",
    "如何撤销上一次的 git commit",
    "如何把这段代码改成 async",
    "如何在 react 里实现一个防抖 hook",
    "如何在 typescript 里写一个范型",
    "帮我写一个读取 csv 的 python 脚本",
    "帮我写一个 debounce 函数",
    "帮我重构这个函数",
    "帮我看看这段代码有什么问题",
    "帮我把这段 bash 改成 python",
    "总结一下这个 pr 改了什么",
    "总结一下这段日志",
    "review 一下我的代码",
    "请帮我 review 这段代码",
    "用 typescript 写一个二分查找",
    "用 rust 写一个 fibonacci",
    "解释一下这个报错",
    "解释一下这段堆栈",
    "解释下 promise 是什么",
    "解释下 hoisting",
    "为什么我的测试一直失败",
    "为什么 npm install 这么慢",
    "为什么 docker container 一启动就退出",
    "这段代码是什么意思",
    "这个错误是什么意思",
    "怎么用 vim 替换文本",
    "怎么在 vim 里删除一行",
    "git 的 rebase 和 merge 有什么区别",
    "set 和 export 有什么区别",
    "linux 怎么改密码",
    "macOS 怎么开终端",
    "我应该用什么模型来做翻译",
    "推荐一个 python 的 http 库",
    "你能帮我写代码吗",
    "你能帮我吗",
    "谢谢",
    "好的",
    "继续",
    "停",
    "可以",
    "不可以",
    "什么",
    "为什么",
    "怎么",
    "你好",
    "在吗",
    "hi",
    "hello",
]

# Short greetings / affirmatives / interjections.  Replicated below in
# `collect_nl()` because the embedding space for short inputs is otherwise
# dominated by short shell commands (`ls`, `cd`, `pwd`, ...) and the
# classifier learns a "short → shell" prior.  Oversampling these short
# NL phrases pulls the decision boundary back toward NL for the case the
# user actually types `hi` or `thanks`.
SHORT_NL_HEAVY_OVERSAMPLE = [
    # English greetings
    "hello", "hi", "hey", "yo", "hola", "howdy",
    "good morning", "good afternoon", "good evening", "good night",
    "bye", "goodbye", "see you", "see ya", "later",
    # English thanks
    "thanks", "thank you", "thx", "ty", "thanks a lot", "thanks!",
    "much appreciated", "appreciate it",
    # English affirmatives / one-word answers
    "ok", "okay", "alright", "sure", "fine", "got it", "cool",
    "nice", "great", "perfect", "awesome",
    "yes", "yeah", "yep", "yup",
    "no", "nope", "nah",
    "maybe", "idk", "i don't know",
    # English follow-up
    "continue", "go on", "do it", "proceed", "stop", "wait",
    "more", "next", "back", "skip",
    # Chinese greetings + thanks
    "你好", "嗨", "您好", "你好啊", "在吗",
    "早上好", "晚上好", "下午好",
    "谢谢", "多谢", "感谢", "谢了", "thx",
    "再见", "拜拜", "再聊", "好的再见",
    # Chinese affirmatives / one-word answers
    "好的", "好", "嗯", "嗯嗯", "可以", "行", "ok", "okay",
    "不行", "不可以", "不要", "别", "no",
    "继续", "下一步", "回退", "停", "等等",
    "明白", "懂了", "知道了",
    # Question words alone — without a clear shell context, these should
    # bias toward NL since they're typical conversation openers.
    "what", "why", "how", "where", "when", "who",
    "什么", "为什么", "怎么", "哪里", "哪个", "什么时候",
]


# Smaller but real — keeps the head from collapsing to a binary
# "language ∈ {EN, ZH}" detector.
OTHER_LANG_NL = [
    # Spanish
    "explica este error",
    "qué significa este comando",
    "cómo listo los archivos del directorio",
    "ayúdame a depurar este código",
    "hola",
    "gracias",
    "sí",
    "no",
    # French
    "que fait cette commande",
    "comment lister les fichiers",
    "explique ce script",
    "bonjour",
    "merci",
    # German
    "was bedeutet diese Fehlermeldung",
    "wie liste ich alle Dateien auf",
    "erkläre mir diesen Befehl",
    "hallo",
    "danke",
    # Japanese
    "このコマンドの意味は何ですか",
    "ファイルを一覧表示する方法",
    "このエラーを説明してください",
    "ありがとう",
    "こんにちは",
    # Russian
    "что делает эта команда",
    "как вывести список файлов",
    "объясни эту ошибку",
    "привет",
    "спасибо",
]


def collect_nl():
    out = []
    # English question templates over command vocabulary
    for tpl in EN_QUESTION_TEMPLATES:
        for cmd in CMD_FOR_QUESTIONS:
            out.append(tpl.format(x=cmd))
    # Chinese question templates over command vocabulary — the lexical-
    # bias counterexample bucket.  Every entry mixes Chinese question
    # syntax with a shell-command token, the exact case the embedder
    # would otherwise pull toward shell-space.
    for tpl in ZH_QUESTION_TEMPLATES:
        for cmd in CMD_FOR_QUESTIONS:
            out.append(tpl.format(x=cmd))
    # Standalone questions, multilingual
    out.extend(EN_GENERAL_QUESTIONS)
    out.extend(ZH_GENERAL_QUESTIONS)
    out.extend(OTHER_LANG_NL)

    seen = set()
    deduped = []
    for s in out:
        if s not in seen:
            seen.add(s)
            deduped.append(s)

    # Oversample short NL phrases.  Dedupe runs above, so the actual
    # duplicates show up AFTER the seen-set check — they bypass the
    # shell-pool dedupe path entirely.  This deliberately weights these
    # short phrases more heavily during training.
    SHORT_OVERSAMPLE = 5
    for _ in range(SHORT_OVERSAMPLE):
        deduped.extend(SHORT_NL_HEAVY_OVERSAMPLE)

    # Oversample the curated full-sentence NL.  Templates dominate
    # otherwise — we now have ~35 templated patterns each × 43 commands
    # in two languages (~3000 templated NL examples) vs ~50 hand-
    # written natural questions per language.  Without compensating
    # oversampling the head learns "NL = something containing a
    # command token", and pure-Chinese questions like 怎么列出当前目录
    # 下的文件 (no command mentioned) regress to shell.
    REAL_OVERSAMPLE = 8
    for _ in range(REAL_OVERSAMPLE):
        deduped.extend(EN_GENERAL_QUESTIONS)
        deduped.extend(ZH_GENERAL_QUESTIONS)

    return deduped


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    shell = collect_shell()
    nl = collect_nl()

    # Do NOT undersample.  Earlier v0 trimmed both classes to the smaller
    # one's size; that randomly dropped many of the standalone short NL
    # samples ("hello", "thanks", 短中文问候) and the classifier ended up
    # tagging them as shell.  Letting the training script see the full
    # imbalance and pass class_weight='balanced' to LogisticRegression
    # produces a more honest decision boundary.
    examples = (
        [{"text": t, "label": "shell"} for t in shell]
        + [{"text": t, "label": "ai"} for t in nl]
    )
    random.shuffle(examples)

    out_path = Path(__file__).parent / "data.jsonl"
    with out_path.open("w") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"shell examples: {len(shell)}")
    print(f"nl examples:    {len(nl)}")
    print(f"total written:  {len(examples)} → {out_path}")


if __name__ == "__main__":
    main()
