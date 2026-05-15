import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { ADFEntity } from "@atlaskit/adf-utils/types";
import { ADFPreprocessor, ADFPreprocessorContext } from "./types";

const PLANTUML_EXTENSIONS = new Set([".puml", ".iuml", ".plantuml"]);

function getExtension(url: string): string {
	const queryStripped = url.split("?")[0] ?? url;
	const lastDot = queryStripped.lastIndexOf(".");
	if (lastDot === -1) {
		return "";
	}
	return queryStripped.slice(lastDot).toLowerCase();
}

function decodeUrlSafe(url: string): string {
	try {
		return decodeURI(url);
	} catch {
		return url;
	}
}

function looksLikePlantumlEmbed(node: ADFEntity | undefined): string | null {
	if (!node || node.type !== "mediaSingle" || !Array.isArray(node.content)) {
		return null;
	}
	const media = node.content[0];
	if (!media || media.type !== "media") {
		return null;
	}
	const attrs = media.attrs ?? {};
	const type = attrs["type"];
	const rawUrl = attrs["url"];
	if (type !== "file" || typeof rawUrl !== "string") {
		return null;
	}
	const url = decodeUrlSafe(rawUrl);
	if (!url.startsWith("file://")) {
		return null;
	}
	const fileName = url.slice("file://".length);
	const ext = getExtension(fileName);
	if (!PLANTUML_EXTENSIONS.has(ext)) {
		return null;
	}
	return fileName;
}

function makePlantumlCodeBlock(text: string): ADFEntity {
	return {
		type: "codeBlock",
		attrs: { language: "plantuml" },
		content: [{ type: "text", text }],
	};
}

async function processNode(node: ADFEntity, ctx: ADFPreprocessorContext): Promise<ADFEntity> {
	const fileName = looksLikePlantumlEmbed(node);
	if (fileName) {
		const text = await ctx.adaptor.readText(fileName, ctx.pageFilePath);
		if (text === false) {
			return node;
		}
		if (text.trim().length === 0) {
			return node;
		}
		return makePlantumlCodeBlock(text);
	}

	if (Array.isArray(node.content)) {
		const newContent: (ADFEntity | undefined)[] = [];
		let mutated = false;
		for (const child of node.content) {
			if (!child) {
				newContent.push(child);
				continue;
			}
			const replaced = await processNode(child, ctx);
			if (replaced !== child) {
				mutated = true;
			}
			newContent.push(replaced);
		}
		if (mutated) {
			return { ...node, content: newContent };
		}
	}

	return node;
}

export const PlantumlEmbedResolverPlugin: ADFPreprocessor = {
	async preprocess(adf: JSONDocNode, ctx: ADFPreprocessorContext): Promise<JSONDocNode> {
		const result = await processNode(adf as ADFEntity, ctx);
		return result as JSONDocNode;
	},
};
