import SparkMD5 from "spark-md5";
import FormData from "form-data";
import { Api } from "confluence.js";
import { RequiredConfluenceClient, LoaderAdaptor } from "./adaptors";
import sizeOf from "image-size";

// Confluence Cloud now rejects multipart attachment uploads with
// "Must have the same number of attachment files and minorEdits flags,
// or not have any minorEdits flags at all" when the legacy `minorEdit`
// field is present. confluence.js@2.1.0's createOrUpdateAttachments and
// createAttachments both unconditionally append `minorEdit`, so we
// override them on the prototype to omit that field.
//
// The override runs once at module load. It mirrors the upstream method
// body but without the minorEdit form field.
type AttachmentEntry = {
	file: Buffer | NodeJS.ReadableStream | string;
	filename: string;
	contentType?: string;
	comment?: string;
};

type CreateOrUpdateParams = {
	id: string;
	attachments: AttachmentEntry | AttachmentEntry[];
	status?: string;
};

type ContentAttachmentsInternal = {
	client: {
		sendRequest: (config: unknown, callback?: unknown) => Promise<unknown>;
	};
};

function buildAttachmentForm(parameters: CreateOrUpdateParams): FormData {
	const formData = new FormData();
	const attachments = Array.isArray(parameters.attachments)
		? parameters.attachments
		: [parameters.attachments];

	for (const attachment of attachments) {
		formData.append("file", attachment.file, {
			filename: attachment.filename,
			...(attachment.contentType ? { contentType: attachment.contentType } : {}),
		});
		// `comment` is intentionally NOT sent: Confluence Cloud's stricter
		// validation rejects multipart attachment uploads when the comment
		// field is present in a form that doesn't fit its expected shape
		// ("Must be same number of attachment files and comments"). We pay
		// for this by losing one signal for content-hash dedup of cross-page
		// attachments — the page-level hash check in uploadBuffer/uploadFile
		// still works for re-uploads of the same page.
	}

	return formData;
}

function patchContentAttachmentsOnce(): void {
	const proto = Api.ContentAttachments.prototype as unknown as {
		__minorEditPatched?: boolean;
		createOrUpdateAttachments: (
			this: ContentAttachmentsInternal,
			parameters: CreateOrUpdateParams,
			callback?: unknown,
		) => Promise<unknown>;
		createAttachments: (
			this: ContentAttachmentsInternal,
			parameters: CreateOrUpdateParams,
			callback?: unknown,
		) => Promise<unknown>;
	};

	if (proto.__minorEditPatched) {
		return;
	}

	proto.createOrUpdateAttachments = async function (
		this: ContentAttachmentsInternal,
		parameters: CreateOrUpdateParams,
		callback?: unknown,
	) {
		const formData = buildAttachmentForm(parameters);
		const config = {
			url: `/api/content/${parameters.id}/child/attachment`,
			method: "PUT",
			headers: {
				"X-Atlassian-Token": "no-check",
				"Content-Type": "multipart/form-data",
				...formData.getHeaders?.(),
			},
			params: { status: parameters.status },
			data: formData,
		};
		return this.client.sendRequest(config, callback);
	};

	proto.createAttachments = async function (
		this: ContentAttachmentsInternal,
		parameters: CreateOrUpdateParams,
		callback?: unknown,
	) {
		const formData = buildAttachmentForm(parameters);
		const config = {
			url: `/api/content/${parameters.id}/child/attachment`,
			method: "POST",
			headers: {
				"X-Atlassian-Token": "no-check",
				"Content-Type": "multipart/form-data",
				...formData.getHeaders?.(),
			},
			params: { status: parameters.status },
			data: formData,
		};
		return this.client.sendRequest(config, callback);
	};

	proto.__minorEditPatched = true;
}

export type ConfluenceImageStatus = "existing" | "uploaded";

export interface UploadedImageData {
	filename: string;
	id: string;
	collection: string;
	width: number;
	height: number;
	status: ConfluenceImageStatus;
}

export type CurrentAttachments = Record<
	string,
	{
		filehash: string;
		attachmentId: string;
		collectionName: string;
	}
>;

function toArrayBuffer(contents: Uint8Array): ArrayBuffer {
	return Uint8Array.from(contents).buffer;
}

export async function uploadBuffer(
	confluenceClient: RequiredConfluenceClient,
	pageId: string,
	uploadFilename: string,
	fileBuffer: Buffer,
	currentAttachments: Record<
		string,
		{ filehash: string; attachmentId: string; collectionName: string }
	>,
): Promise<UploadedImageData | null> {
	patchContentAttachmentsOnce();
	const spark = new SparkMD5.ArrayBuffer();
	const currentFileMd5 = spark.append(toArrayBuffer(fileBuffer)).end();
	const imageSize = await sizeOf(fileBuffer);

	const fileInCurrentAttachments = currentAttachments[uploadFilename];
	if (fileInCurrentAttachments?.filehash === currentFileMd5) {
		return {
			filename: uploadFilename,
			id: fileInCurrentAttachments.attachmentId,
			collection: fileInCurrentAttachments.collectionName,
			width: imageSize.width ?? 0,
			height: imageSize.height ?? 0,
			status: "existing",
		};
	}

	const attachmentDetails = {
		id: pageId,
		attachments: [
			{
				file: fileBuffer,
				filename: uploadFilename,
				comment: currentFileMd5,
				contentType: "image/png",
			},
		],
	};

	const attachmentResponse =
		await confluenceClient.contentAttachments.createOrUpdateAttachments(attachmentDetails);

	const attachmentUploadResponse = attachmentResponse.results[0];
	if (!attachmentUploadResponse) {
		throw new Error("Issue uploading buffer");
	}

	return {
		filename: uploadFilename,
		id: attachmentUploadResponse.extensions.fileId,
		collection: `contentId-${attachmentUploadResponse.container.id}`,
		width: imageSize.width ?? 0,
		height: imageSize.height ?? 0,
		status: "uploaded",
	};
}

export async function uploadFile(
	confluenceClient: RequiredConfluenceClient,
	adaptor: LoaderAdaptor,
	pageId: string,
	pageFilePath: string,
	fileNameToUpload: string,
	currentAttachments: CurrentAttachments,
): Promise<UploadedImageData | null> {
	patchContentAttachmentsOnce();
	let fileNameForUpload = fileNameToUpload;
	let testing = await adaptor.readBinary(fileNameForUpload, pageFilePath);
	if (!testing) {
		fileNameForUpload = decodeURI(fileNameForUpload);
		testing = await adaptor.readBinary(fileNameForUpload, pageFilePath);
	}
	if (testing) {
		const binaryContents =
			testing.contents instanceof ArrayBuffer
				? new Uint8Array(testing.contents)
				: testing.contents;
		const spark = new SparkMD5.ArrayBuffer();
		const currentFileMd5 = spark.append(toArrayBuffer(binaryContents)).end();
		const pathMd5 = SparkMD5.hash(testing.filePath);
		const uploadFilename = `${pathMd5}-${testing.filename}`;
		const imageBuffer = Buffer.from(binaryContents);
		const imageSize = await sizeOf(imageBuffer);

		const fileInCurrentAttachments = currentAttachments[uploadFilename];
		if (fileInCurrentAttachments?.filehash === currentFileMd5) {
			return {
				filename: fileNameForUpload,
				id: fileInCurrentAttachments.attachmentId,
				collection: fileInCurrentAttachments.collectionName,
				width: imageSize.width ?? 0,
				height: imageSize.height ?? 0,
				status: "existing",
			};
		}

		const attachmentDetails = {
			id: pageId,
			attachments: [
				{
					file: imageBuffer,
					filename: uploadFilename,
					comment: currentFileMd5,
				},
			],
		};

		const attachmentResponse =
			await confluenceClient.contentAttachments.createOrUpdateAttachments(attachmentDetails);

		const attachmentUploadResponse = attachmentResponse.results[0];
		if (!attachmentUploadResponse) {
			throw new Error("Issue uploading image");
		}

		return {
			filename: fileNameForUpload,
			id: attachmentUploadResponse.extensions.fileId,
			collection: `contentId-${attachmentUploadResponse.container.id}`,
			width: imageSize.width ?? 0,
			height: imageSize.height ?? 0,
			status: "uploaded",
		};
	}

	return null;
}
