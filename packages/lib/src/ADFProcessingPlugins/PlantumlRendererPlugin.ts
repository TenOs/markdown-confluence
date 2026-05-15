import { filter, traverse } from "@atlaskit/adf-utils/traverse";
import { UploadedImageData } from "../Attachments";
import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { ADFProcessingPlugin, ChartData, PublisherFunctions } from "./types";
import { ADFEntity } from "@atlaskit/adf-utils/types";
import SparkMD5 from "spark-md5";

const PLANTUML_LANGUAGE_TAGS = new Set(["plantuml", "puml", "uml"]);
const PLANTUML_FALLBACK = "@startuml\nAlice -> Bob\n@enduml";

function isPlantumlLanguage(language: unknown): boolean {
	if (typeof language !== "string") {
		return false;
	}
	return PLANTUML_LANGUAGE_TAGS.has(language.trim().toLowerCase());
}

// Wrap snippets that are missing the @startuml/@enduml envelope (e.g. .iuml include files).
function normalizePlantumlSource(source: string): string {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		return PLANTUML_FALLBACK;
	}
	if (/^@start[a-z]+/i.test(trimmed)) {
		return source;
	}
	return `@startuml\n${source}\n@enduml`;
}

export function getPlantumlFileName(plantumlContent: string | undefined) {
	const plantumlText = normalizePlantumlSource(plantumlContent ?? "");
	const pathMd5 = SparkMD5.hash(plantumlText);
	const uploadFilename = `RenderedPlantumlChart-${pathMd5}.png`;
	return { uploadFilename, plantumlText };
}

export interface PlantumlRenderer {
	capturePlantumlCharts(charts: ChartData[]): Promise<Map<string, Buffer>>;
}

export class PlantumlRendererPlugin implements ADFProcessingPlugin<
	ChartData[],
	Record<string, UploadedImageData | null>
> {
	constructor(private plantumlRenderer: PlantumlRenderer) {}

	extract(adf: JSONDocNode): ChartData[] {
		const plantumlNodes = filter(
			adf,
			(node) =>
				node.type == "codeBlock" && isPlantumlLanguage((node.attrs || {})?.["language"]),
		);

		// Dedup by filename (which is a hash of the normalized source) so we don't
		// hit the PlantUML server twice for the same diagram in a single page.
		const plantumlNodesToUpload = new Map<string, ChartData>();
		for (const node of plantumlNodes) {
			const plantumlDetails = getPlantumlFileName(node?.content?.at(0)?.text);
			plantumlNodesToUpload.set(plantumlDetails.uploadFilename, {
				name: plantumlDetails.uploadFilename,
				data: plantumlDetails.plantumlText,
			});
		}

		return Array.from(plantumlNodesToUpload.values());
	}

	async transform(
		plantumlNodesToUpload: ChartData[],
		supportFunctions: PublisherFunctions,
	): Promise<Record<string, UploadedImageData | null>> {
		let imageMap: Record<string, UploadedImageData | null> = {};
		if (plantumlNodesToUpload.length === 0) {
			return imageMap;
		}

		const plantumlChartsAsImages = await this.plantumlRenderer.capturePlantumlCharts([
			...plantumlNodesToUpload,
		]);

		for (const plantumlImage of plantumlChartsAsImages) {
			const uploadedContent = await supportFunctions.uploadBuffer(
				plantumlImage[0],
				plantumlImage[1],
			);

			imageMap = {
				...imageMap,
				[plantumlImage[0]]: uploadedContent,
			};
		}

		return imageMap;
	}

	load(adf: JSONDocNode, imageMap: Record<string, UploadedImageData | null>): JSONDocNode {
		let afterAdf = adf as ADFEntity;

		afterAdf =
			traverse(afterAdf, {
				codeBlock: (node, _parent) => {
					if (!isPlantumlLanguage(node?.attrs?.["language"])) {
						return;
					}
					const plantumlContent = node?.content?.at(0)?.text;
					if (!plantumlContent) {
						return;
					}
					const plantumlFilename = getPlantumlFileName(plantumlContent);

					if (!imageMap[plantumlFilename.uploadFilename]) {
						return;
					}
					const mappedImage = imageMap[plantumlFilename.uploadFilename];
					if (mappedImage) {
						node.type = "mediaSingle";
						if (node.attrs) {
							node.attrs["layout"] = "center";
							delete node.attrs["language"];
						}
						if (node.content) {
							node.content = [
								{
									type: "media",
									attrs: {
										type: "file",
										collection: mappedImage.collection,
										id: mappedImage.id,
										width: mappedImage.width,
										height: mappedImage.height,
									},
								},
							];
						}
						return node;
					}
					return;
				},
			}) || afterAdf;

		return afterAdf as JSONDocNode;
	}
}
