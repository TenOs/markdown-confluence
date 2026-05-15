/* eslint-disable @typescript-eslint/naming-convention */
import { expect, test } from "vite-plus/test";
import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { BinaryFile, FilesToUpload, LoaderAdaptor, MarkdownFile } from "../adaptors";
import { ConfluencePerPageAllValues } from "../ConniePageConfig";
import { PlantumlEmbedResolverPlugin } from "./PlantumlEmbedResolverPlugin";

class StubAdaptor implements LoaderAdaptor {
	textCalls: { path: string; from: string }[] = [];

	constructor(private readonly files: Record<string, string | false>) {}

	async updateMarkdownValues(
		_absoluteFilePath: string,
		_values: Partial<ConfluencePerPageAllValues>,
	): Promise<void> {}

	async loadMarkdownFile(_absoluteFilePath: string): Promise<MarkdownFile> {
		throw new Error("not used");
	}

	async getMarkdownFilesToUpload(): Promise<FilesToUpload> {
		throw new Error("not used");
	}

	async readBinary(_path: string, _from: string): Promise<BinaryFile | false> {
		throw new Error("not used");
	}

	async readText(searchPath: string, referencedFromFilePath: string): Promise<string | false> {
		this.textCalls.push({ path: searchPath, from: referencedFromFilePath });
		return this.files[searchPath] ?? false;
	}
}

function makeMediaSingleEmbed(url: string): unknown {
	return {
		type: "mediaSingle",
		attrs: { layout: "center" },
		content: [
			{
				type: "media",
				attrs: { type: "file", url },
			},
		],
	};
}

function docOf(...blocks: unknown[]): JSONDocNode {
	return {
		version: 1,
		type: "doc",
		content: blocks,
	} as unknown as JSONDocNode;
}

test("rewrites .puml mediaSingle embeds to plantuml codeBlocks with file contents", async () => {
	const adaptor = new StubAdaptor({
		"example.puml": "@startuml\nA -> B\n@enduml",
	});
	const adf = docOf(makeMediaSingleEmbed("file://example.puml"));

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/Notes/page.md",
	});

	const block = (
		result as unknown as {
			content: {
				type: string;
				attrs?: { language?: string };
				content?: { text?: string }[];
			}[];
		}
	).content[0];
	expect(block?.type).toBe("codeBlock");
	expect(block?.attrs?.language).toBe("plantuml");
	expect(block?.content?.[0]?.text).toBe("@startuml\nA -> B\n@enduml");
	expect(adaptor.textCalls).toEqual([{ path: "example.puml", from: "/Notes/page.md" }]);
});

test("recognizes .iuml and .plantuml extensions, case-insensitive", async () => {
	const adaptor = new StubAdaptor({
		"snippet.IUML": "skinparam monochrome true",
		"diagram.Plantuml": "@startuml\nC -> D\n@enduml",
	});
	const adf = docOf(
		makeMediaSingleEmbed("file://snippet.IUML"),
		makeMediaSingleEmbed("file://diagram.Plantuml"),
	);

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const blocks = (result as unknown as { content: { type: string }[] }).content;
	expect(blocks[0]?.type).toBe("codeBlock");
	expect(blocks[1]?.type).toBe("codeBlock");
});

test("decodes URL-encoded paths (e.g. spaces) before lookup", async () => {
	const adaptor = new StubAdaptor({
		"my diagram.puml": "@startuml\nA -> B\n@enduml",
	});
	const adf = docOf(makeMediaSingleEmbed("file://my%20diagram.puml"));

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const block = (result as unknown as { content: { type: string }[] }).content[0];
	expect(block?.type).toBe("codeBlock");
});

test("leaves non-plantuml media embeds untouched", async () => {
	const adaptor = new StubAdaptor({});
	const adf = docOf(makeMediaSingleEmbed("file://photo.png"));

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const block = (result as unknown as { content: { type: string }[] }).content[0];
	expect(block?.type).toBe("mediaSingle");
	expect(adaptor.textCalls).toHaveLength(0);
});

test("leaves non-file (external URL) media embeds untouched", async () => {
	const adaptor = new StubAdaptor({});
	const adf = docOf({
		type: "mediaSingle",
		attrs: {},
		content: [
			{ type: "media", attrs: { type: "external", url: "https://example.com/x.puml" } },
		],
	});

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const block = (result as unknown as { content: { type: string }[] }).content[0];
	expect(block?.type).toBe("mediaSingle");
});

test("leaves the embed in place when the adaptor cannot find the file", async () => {
	const adaptor = new StubAdaptor({});
	const adf = docOf(makeMediaSingleEmbed("file://missing.puml"));

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const block = (result as unknown as { content: { type: string }[] }).content[0];
	expect(block?.type).toBe("mediaSingle");
});

test("walks nested content (e.g. embeds inside callouts)", async () => {
	const adaptor = new StubAdaptor({
		"example.puml": "@startuml\nA -> B\n@enduml",
	});
	const adf = docOf({
		type: "panel",
		attrs: {},
		content: [makeMediaSingleEmbed("file://example.puml")],
	});

	const result = await PlantumlEmbedResolverPlugin.preprocess(adf, {
		adaptor,
		pageFilePath: "/p.md",
	});

	const panel = (result as unknown as { content: { content: { type: string }[] }[] }).content[0];
	expect(panel?.content[0]?.type).toBe("codeBlock");
});
