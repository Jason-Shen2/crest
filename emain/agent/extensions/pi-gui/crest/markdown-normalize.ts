export function normalizeMarkdownPartialClosingFence(source: string): string {
    const lines = source.split("\n");
    const lastLine = lines.at(-1);
    if (!lastLine) {
        return source;
    }

    let openFence: { marker: "`" | "~"; length: number } | undefined;
    for (const line of lines.slice(0, -1)) {
        const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (!fence) {
            continue;
        }

        const marker = fence[1][0] as "`" | "~";
        if (!openFence) {
            if (marker === "`" && fence[2].includes("`")) {
                continue;
            }
            openFence = { marker, length: fence[1].length };
        } else if (marker === openFence.marker && fence[1].length >= openFence.length && fence[2].trim() === "") {
            openFence = undefined;
        }
    }

    const closing = /^ {0,3}(`+|~+)[ \t\r]*$/.exec(lastLine);
    if (!openFence || !closing || closing[1][0] !== openFence.marker || closing[1].length >= openFence.length) {
        return source;
    }

    return lines.slice(0, -1).join("\n").replace(/\n$/, "");
}
