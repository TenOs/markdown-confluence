import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { AlwaysADFPreprocessors, AlwaysADFProcessingPlugins } from "./ADFProcessingPlugins";
import {
	ADFProcessingPlugin,
	createPublisherFunctions,
	executeADFPreprocessors,
	executeADFProcessingPipeline,
} from "./ADFProcessingPlugins/types";
import { adfEqual } from "./AdfEqual";
import { CurrentAttachments } from "./Attachments";
import { PageContentType } from "./ConniePageConfig";
import { createMissingSpaceKeyError } from "./ConfluenceErrors";
import { SettingsLoader } from "./SettingsLoader";
import { ensureAllFilesExistInConfluence } from "./TreeConfluence";
import { createFolderStructure as createLocalAdfTree } from "./TreeLocal";
import { LoaderAdaptor, RequiredConfluenceClient } from "./adaptors";
import { isEqual } from "./isEqual";

export interface LocalAdfFileTreeNode {
	name: string;
	children: LocalAdfFileTreeNode[];
	file?: LocalAdfFile;
}

interface FilePublishResult {
	successfulUploadResult?: UploadAdfFileResult;
	node: ConfluenceNode;
	reason?: string;
}

export interface LocalAdfFile {
	folderName: string;
	absoluteFilePath: string;
	fileName: string;
	contents: JSONDocNode;
	pageTitle: string;
	frontmatter: {
		[key: string]: unknown;
	};
	tags: string[];
	pageId: string | undefined;
	dontChangeParentPageId: boolean;
	contentType: PageContentType;
	blogPostDate: string | undefined;
}

export interface ConfluenceAdfFile {
	folderName: string;
	absoluteFilePath: string;
	fileName: string;
	contents: JSONDocNode;
	pageTitle: string;
	frontmatter: {
		[key: string]: unknown;
	};
	tags: string[];
	dontChangeParentPageId: boolean;

	pageId: string;
	spaceKey: string;
	pageUrl: string;

	contentType: PageContentType;
	blogPostDate: string | undefined;
}

interface ConfluencePageExistingData {
	adfContent: JSONDocNode;
	pageTitle: string;
	ancestors: { id: string }[];
	contentType: string;
}

export interface ConfluenceNode {
	file: ConfluenceAdfFile;
	version: number;
	lastUpdatedBy: string;
	existingPageData: ConfluencePageExistingData;
	ancestors: string[];
}

export interface ConfluenceTreeNode {
	file: ConfluenceAdfFile;
	version: number;
	lastUpdatedBy: string;
	existingPageData: ConfluencePageExistingData;
	children: ConfluenceTreeNode[];
}

export interface UploadAdfFileResult {
	adfFile: ConfluenceAdfFile;
	contentResult: "same" | "updated";
	imageResult: "same" | "updated";
	labelResult: "same" | "updated";
}

export class Publisher {
	private confluenceClient: RequiredConfluenceClient;
	private adaptor: LoaderAdaptor;
	private myAccountId: string | undefined;
	private settingsLoader: SettingsLoader;
	private adfProcessingPlugins: ADFProcessingPlugin<unknown, unknown>[];

	constructor(
		adaptor: LoaderAdaptor,
		settingsLoader: SettingsLoader,
		confluenceClient: RequiredConfluenceClient,
		adfProcessingPlugins: ADFProcessingPlugin<unknown, unknown>[],
	) {
		this.adaptor = adaptor;
		this.settingsLoader = settingsLoader;

		this.confluenceClient = confluenceClient;
		this.adfProcessingPlugins = adfProcessingPlugins.concat(AlwaysADFProcessingPlugins);
	}

	async publish(publishFilter?: string) {
		const settings = this.settingsLoader.load();

		if (!this.myAccountId) {
			const currentUser = await this.confluenceClient.users.getCurrentUser();
			this.myAccountId = currentUser.accountId;
		}

		const parentPage = await this.confluenceClient.content.getContentById({
			id: settings.confluenceParentId,
			expand: ["body.atlas_doc_format", "space"],
		});
		if (!parentPage.space?.key) {
			throw createMissingSpaceKeyError(
				settings.confluenceParentId,
				settings.confluenceBaseUrl,
			);
		}

		const spaceToPublishTo = parentPage.space;

		const files = await this.adaptor.getMarkdownFilesToUpload();
		const folderTree = createLocalAdfTree(files, settings);
		let confluencePagesToPublish = await ensureAllFilesExistInConfluence(
			this.confluenceClient,
			this.adaptor,
			folderTree,
			spaceToPublishTo.key,
			parentPage.id,
			parentPage.id,
			settings,
		);

		if (publishFilter) {
			confluencePagesToPublish = confluencePagesToPublish.filter(
				(file) => file.file.absoluteFilePath === publishFilter,
			);
		}

		const adrFileTasks = confluencePagesToPublish.map((file) => {
			return this.publishFile(file);
		});

		const adrFiles = await Promise.all(adrFileTasks);
		return adrFiles;
	}

	private async publishFile(node: ConfluenceNode): Promise<FilePublishResult> {
		try {
			const successfulUploadResult = await this.updatePageContent(
				node.ancestors,
				node.version,
				node.existingPageData,
				node.file,
				node.lastUpdatedBy,
			);

			return {
				node,
				successfulUploadResult,
			};
		} catch (e: unknown) {
			if (e instanceof Error) {
				return {
					node,
					reason: e.message,
				};
			}

			return {
				node,
				reason: JSON.stringify(e), // TODO: Understand why this doesn't show error message properly
			};
		}
	}

	private async updatePageContent(
		ancestors: string[],
		pageVersionNumber: number,
		existingPageData: ConfluencePageExistingData,
		adfFile: ConfluenceAdfFile,
		lastUpdatedBy: string,
	): Promise<UploadAdfFileResult> {
		if (lastUpdatedBy !== this.myAccountId) {
			throw new Error(
				`Page last updated by another user. Won't publish over their changes. MyAccountId: ${this.myAccountId}, Last Updated By: ${lastUpdatedBy}`,
			);
		}
		if (existingPageData.contentType !== adfFile.contentType) {
			throw new Error(
				`Cannot convert between content types. From ${existingPageData.contentType} to ${adfFile.contentType}`,
			);
		}

		const result: UploadAdfFileResult = {
			adfFile,
			contentResult: "same",
			imageResult: "same",
			labelResult: "same",
		};

		const currentUploadedAttachments =
			await this.confluenceClient.contentAttachments.getAttachments({
				id: adfFile.pageId,
			});

		const currentAttachments: CurrentAttachments = currentUploadedAttachments.results.reduce(
			(prev, curr) => {
				return {
					...prev,
					[`${curr.title}`]: {
						filehash: curr.metadata.comment,
						attachmentId: curr.extensions.fileId,
						collectionName: curr.extensions.collectionName,
					},
				};
			},
			{},
		);

		const supportFunctions = createPublisherFunctions(
			this.confluenceClient,
			this.adaptor,
			adfFile.pageId,
			adfFile.absoluteFilePath,
			currentAttachments,
		);

		const preprocessedAdf = await executeADFPreprocessors(
			AlwaysADFPreprocessors,
			adfFile.contents,
			{ adaptor: this.adaptor, pageFilePath: adfFile.absoluteFilePath },
		);

		const adfToUpload = await executeADFProcessingPipeline(
			this.adfProcessingPlugins,
			preprocessedAdf,
			supportFunctions,
		);

		/*
		const imageResult = Object.keys(imageUploadResult.imageMap).reduce(
			(prev, curr) => {
				const value = imageUploadResult.imageMap[curr];
				if (!value) {
					return prev;
				}
				const status = value.status;
				return {
					...prev,
					[status]: (prev[status] ?? 0) + 1,
				};
			},
			{
				existing: 0,
				uploaded: 0,
			} as Record<string, number>
		);
		*/

		/*
		if (!adfEqual(adfFile.contents, imageUploadResult.adf)) {
			result.imageResult =
				(imageResult["uploaded"] ?? 0) > 0 ? "updated" : "same";
		}
		*/

		result.imageResult = "updated";

		const existingPageDetails = {
			title: existingPageData.pageTitle,
			type: existingPageData.contentType,
			...(adfFile.contentType === "blogpost" || adfFile.dontChangeParentPageId
				? {}
				: { ancestors: existingPageData.ancestors }),
		};

		const newPageDetails = {
			title: adfFile.pageTitle,
			type: adfFile.contentType,
			...(adfFile.contentType === "blogpost" || adfFile.dontChangeParentPageId
				? {}
				: {
						ancestors: ancestors.map((ancestor) => ({
							id: ancestor,
						})),
					}),
		};

		if (
			!adfEqual(existingPageData.adfContent, adfToUpload) ||
			!isEqual(existingPageDetails, newPageDetails)
		) {
			result.contentResult = "updated";
			console.log(`TESTING DIFF - ${adfFile.absoluteFilePath}`);

			const replacer = (_key: unknown, value: unknown) =>
				typeof value === "undefined" ? null : value;

			console.log(JSON.stringify(existingPageData.adfContent, replacer));
			console.log(JSON.stringify(adfToUpload, replacer));

			// Each attachment upload bumps the page version on the server, so
			// pageVersionNumber (captured before attachment uploads) is stale
			// by the time we get here. Re-fetch the current version, but
			// because Confluence's read-after-write can lag (CDN/replica),
			// the GET sometimes returns a version that's still behind
			// master — in which case the update fails with "version more
			// than the previous version". Retry on that error by
			// re-fetching and bumping again.
			const buildUpdateDetails = (versionNumber: number) => ({
				...newPageDetails,
				id: adfFile.pageId,
				version: { number: versionNumber + 1 },
				body: {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					atlas_doc_format: {
						value: JSON.stringify(adfToUpload),
						representation: "atlas_doc_format",
					},
				},
			});

			const fetchCurrentVersion = async (): Promise<number> => {
				const currentPage = await this.confluenceClient.content.getContentById({
					id: adfFile.pageId,
					expand: ["version"],
				});
				return currentPage.version?.number ?? pageVersionNumber;
			};

			let attempt = 0;
			let nextVersion = await fetchCurrentVersion();
			while (true) {
				try {
					await this.confluenceClient.content.updateContent(
						buildUpdateDetails(nextVersion),
					);
					break;
				} catch (e: unknown) {
					// Different clients surface the version-conflict error
					// differently: confluence.js (CLI) wraps Confluence's
					// JSON in `e.message`, while the Obsidian custom HTTP
					// client throws `{ message: "Received a 500", response:
					// { status, data } }` where `data` is the JSON string.
					// Check both.
					const messageBlobs: string[] = [];
					if (e instanceof Error) {
						messageBlobs.push(e.message);
					}
					const maybeResponse = (e as { response?: { data?: unknown; status?: number } })
						.response;
					if (maybeResponse?.data && typeof maybeResponse.data === "string") {
						messageBlobs.push(maybeResponse.data);
					}
					const blob = messageBlobs.join(" ");
					const isVersionConflict =
						blob.includes("more than the previous version") ||
						blob.includes("optimistic lock");
					if (!isVersionConflict || attempt >= 3) {
						throw e;
					}
					attempt++;
					console.log(
						`Confluence version conflict on ${adfFile.absoluteFilePath}, retrying with version ${nextVersion + 2} (attempt ${attempt})`,
					);
					// Bump past whatever we just tried — Confluence's GET may
					// still be behind, so jumping ahead is more reliable than
					// re-fetching the same stale value.
					nextVersion += 1;
				}
			}
		}

		const getLabelsForContent = {
			id: adfFile.pageId,
		};
		const currentLabels =
			await this.confluenceClient.contentLabels.getLabelsForContent(getLabelsForContent);

		for (const existingLabel of currentLabels.results) {
			if (!adfFile.tags.includes(existingLabel.label)) {
				result.labelResult = "updated";
				await this.confluenceClient.contentLabels.removeLabelFromContentUsingQueryParameter(
					{
						id: adfFile.pageId,
						name: existingLabel.name,
					},
				);
			}
		}

		const labelsToAdd = [];
		for (const newLabel of adfFile.tags) {
			if (currentLabels.results.findIndex((item) => item.label === newLabel) === -1) {
				labelsToAdd.push({
					prefix: "global",
					name: newLabel,
				});
			}
		}

		if (labelsToAdd.length > 0) {
			result.labelResult = "updated";
			await this.confluenceClient.contentLabels.addLabelsToContent({
				id: adfFile.pageId,
				body: labelsToAdd,
			});
		}

		return result;
	}
}
