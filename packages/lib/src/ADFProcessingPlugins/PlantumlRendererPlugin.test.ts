/* eslint-disable @typescript-eslint/naming-convention */
import { expect, test } from "vite-plus/test";
import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { UploadedImageData } from "../Attachments";
import { ChartData, PublisherFunctions } from "./types";
import {
	PlantumlRenderer,
	PlantumlRendererPlugin,
	getPlantumlFileName,
} from "./PlantumlRendererPlugin";

class StubPlantumlRenderer implements PlantumlRenderer {
	captured: ChartData[] = [];

	constructor(private readonly result: Map<string, Buffer> = new Map()) {}

	async capturePlantumlCharts(charts: ChartData[]): Promise<Map<string, Buffer>> {
		this.captured = charts;
		return this.result;
	}
}

const noopSupportFunctions: PublisherFunctions = {
	uploadBuffer: async (filename: string): Promise<UploadedImageData | null> => ({
		filename,
		id: `id-${filename}`,
		collection: "test",
		width: 100,
		height: 100,
		status: "uploaded",
	}),
	uploadFile: async () => null,
};

function makeDoc(
	blocks: { language: string; text: string }[],
	extras: unknown[] = [],
): JSONDocNode {
	return {
		version: 1,
		type: "doc",
		content: [
			...blocks.map((block) => ({
				type: "codeBlock",
				attrs: { language: block.language },
				content: [{ type: "text", text: block.text }],
			})),
			...(extras as []),
		],
	} as unknown as JSONDocNode;
}

test("extract picks up plantuml/puml/uml language tags case-insensitively", () => {
	const renderer = new StubPlantumlRenderer();
	const plugin = new PlantumlRendererPlugin(renderer);
	const doc = makeDoc([
		{ language: "plantuml", text: "@startuml\nA -> B\n@enduml" },
		{ language: "PUML", text: "@startuml\nC -> D\n@enduml" },
		{ language: "Uml", text: "@startuml\nE -> F\n@enduml" },
		{ language: "mermaid", text: "flowchart LR\nA --> B" },
		{ language: "javascript", text: "console.log(1)" },
	]);

	const charts = plugin.extract(doc);

	expect(charts).toHaveLength(3);
	const sources = charts.map((c) => c.data);
	expect(sources).toContain("@startuml\nA -> B\n@enduml");
	expect(sources).toContain("@startuml\nC -> D\n@enduml");
	expect(sources).toContain("@startuml\nE -> F\n@enduml");
});

test("extract dedupes identical plantuml sources", () => {
	const renderer = new StubPlantumlRenderer();
	const plugin = new PlantumlRendererPlugin(renderer);
	const doc = makeDoc([
		{ language: "plantuml", text: "@startuml\nA -> B\n@enduml" },
		{ language: "puml", text: "@startuml\nA -> B\n@enduml" },
	]);

	const charts = plugin.extract(doc);
	expect(charts).toHaveLength(1);
});

test("extract wraps bare snippets (e.g. .iuml-style) in @startuml/@enduml for hashing", () => {
	const renderer = new StubPlantumlRenderer();
	const plugin = new PlantumlRendererPlugin(renderer);
	const bare = "skinparam monochrome true\nAlice -> Bob";
	const doc = makeDoc([{ language: "plantuml", text: bare }]);

	const charts = plugin.extract(doc);

	expect(charts).toHaveLength(1);
	expect(charts[0]?.data).toBe(`@startuml\n${bare}\n@enduml`);
});

test("getPlantumlFileName produces a deterministic filename and falls back on empty", () => {
	const a = getPlantumlFileName("@startuml\nA -> B\n@enduml");
	const b = getPlantumlFileName("@startuml\nA -> B\n@enduml");
	expect(a.uploadFilename).toBe(b.uploadFilename);
	expect(a.uploadFilename).toMatch(/^RenderedPlantumlChart-[0-9a-f]+\.png$/);

	const fallback = getPlantumlFileName(undefined);
	expect(fallback.plantumlText).toBe("@startuml\nAlice -> Bob\n@enduml");
});

test("transform returns empty map when nothing to render and skips the renderer", async () => {
	const renderer = new StubPlantumlRenderer();
	const plugin = new PlantumlRendererPlugin(renderer);
	const result = await plugin.transform([], noopSupportFunctions);
	expect(result).toEqual({});
	expect(renderer.captured).toHaveLength(0);
});

test("load replaces matched codeBlocks with mediaSingle and leaves other code blocks untouched", async () => {
	const sample = "@startuml\nA -> B\n@enduml";
	const { uploadFilename } = getPlantumlFileName(sample);

	const renderer = new StubPlantumlRenderer(
		new Map<string, Buffer>([[uploadFilename, Buffer.from("png")]]),
	);
	const plugin = new PlantumlRendererPlugin(renderer);

	const doc = makeDoc([
		{ language: "plantuml", text: sample },
		{ language: "javascript", text: "console.log(1)" },
	]);

	const charts = plugin.extract(doc);
	const imageMap = await plugin.transform(charts, noopSupportFunctions);
	const finalAdf = plugin.load(doc, imageMap);

	const content = (finalAdf as unknown as { content: { type: string }[] }).content;
	expect(content[0]?.type).toBe("mediaSingle");
	expect(content[1]?.type).toBe("codeBlock");
});

test("load leaves codeBlock alone when imageMap entry missing (e.g. renderer returned nothing)", async () => {
	const renderer = new StubPlantumlRenderer(new Map());
	const plugin = new PlantumlRendererPlugin(renderer);
	const doc = makeDoc([{ language: "plantuml", text: "@startuml\nA -> B\n@enduml" }]);

	const charts = plugin.extract(doc);
	const imageMap = await plugin.transform(charts, noopSupportFunctions);
	const finalAdf = plugin.load(doc, imageMap);
	const content = (finalAdf as unknown as { content: { type: string }[] }).content;
	expect(content[0]?.type).toBe("codeBlock");
});
