import { describe, expect, it } from "vitest";
import { normalizeMarkdownPartialClosingFence } from "./markdown-normalize";

const PartialFenceCases = (["`", "~"] as const).flatMap((marker) =>
    [3, 4, 5].flatMap((openerLength) =>
        Array.from({ length: openerLength - 1 }, (_, index) => [marker, openerLength, index + 1] as const)
    )
);

const CompleteFenceCases = (["`", "~"] as const).flatMap((marker) =>
    [3, 4, 5].map((length) => [marker, length] as const)
);

describe("normalizeMarkdownPartialClosingFence", () => {
    it.each(PartialFenceCases)(
        "trims marker %s opener N=%i with partial closing run %i",
        (marker, openerLength, closingLength) => {
            const opener = marker.repeat(openerLength);
            const closing = marker.repeat(closingLength);

            expect(normalizeMarkdownPartialClosingFence(`${opener}ts\nconst value = 1;\n${closing}`)).toBe(
                `${opener}ts\nconst value = 1;`
            );
        }
    );

    it.each(CompleteFenceCases)("preserves a complete marker %s closing run for opener N=%i", (marker, length) => {
        const fence = marker.repeat(length);
        const source = `${fence}ts\nconst value = 1;\n${fence}`;

        expect(normalizeMarkdownPartialClosingFence(source)).toBe(source);
    });

    it("normalizes only the unclosed final fence after complete earlier fences", () => {
        expect(
            normalizeMarkdownPartialClosingFence(
                "```js\nfirst()\n```\n\n~~~~ts\nsecond()\n~~~~\n\n`````tsx\nthird()\n````"
            )
        ).toBe("```js\nfirst()\n```\n\n~~~~ts\nsecond()\n~~~~\n\n`````tsx\nthird()");
    });

    it.each([3, 4, 5])("does not open an N=%i backtick fence whose info contains a backtick", (length) => {
        const opener = "`".repeat(length);
        const partial = "`".repeat(length - 1);
        const source = `${opener}ts\`invalid\nconst value = 1;\n${partial}`;

        expect(normalizeMarkdownPartialClosingFence(source)).toBe(source);
    });

    it("allows a backtick in tilde fence info and trims its partial closing run", () => {
        expect(normalizeMarkdownPartialClosingFence("~~~~ts`valid\nconst value = 1;\n~~~")).toBe(
            "~~~~ts`valid\nconst value = 1;"
        );
    });

    it.each([
        "````ts meta\nconst value = 1;\n````",
        "`````tsx\nconst view = <div>{`content`}</div>;\n`````",
        "```ts\nconst ticks = ``inside``;\n```",
        "~~~ts\nconst tick = `inside`;\n~~~",
        "text `ts` and ``code``",
        "````ts\nconst value = 1;\n``` trailing",
    ])("preserves complete fences, content backticks, and non-empty final lines", (source) => {
        expect(normalizeMarkdownPartialClosingFence(source)).toBe(source);
    });
});
