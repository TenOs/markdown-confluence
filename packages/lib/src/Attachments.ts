import SparkMD5 from "spark-md5";
import { RequiredConfluenceClient, LoaderAdaptor } from "./adaptors";
import sizeOf from "image-size";

// We sidestep confluence.js's createOrUpdateAttachments entirely. Its built-in
// multipart serialization adds fields (`minorEdit`, third-arg filenames) that
// Confluence Cloud's stricter validation now rejects with various 4xx/5xx
// errors. Building the body ourselves and dispatching through the existing
// client transport gives one code path that works in both Node (CLI) and
// Electron (Obsidian's `requestUrl`-backed client).

type AttachmentInput = {
	file: Buffer;
	filename: string;
	contentType?: string;
};

// confluence.js's Api.ContentAttachments has a private `client` field with
// a sendRequest method. TypeScript hides it; we reach in via untyped indexing.
type InternalSendRequest = (
	config: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		params?: Record<string, unknown>;
		data?: unknown;
	},
	callback?: unknown,
) => Promise<unknown>;

type AttachmentResponse = {
	results: { extensions: { fileId: string }; container: { id: string } }[];
};

function buildMultipartBody(attachment: AttachmentInput): { body: Buffer; contentType: string } {
	// RFC 2046 boundary — random hex avoids collision with file bytes.
	const boundary = `----confluence-attachment-${SparkMD5.hash(`${attachment.filename}-${Date.now()}`).slice(0, 16)}`;
	const dashBoundary = `--${boundary}`;
	const filePartHeader = Buffer.from(
		`${dashBoundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="${attachment.filename}"\r\n` +
			`Content-Type: ${attachment.contentType ?? "application/octet-stream"}\r\n\r\n`,
	);
	const trailing = Buffer.from(`\r\n${dashBoundary}--\r\n`);
	return {
		body: Buffer.concat([filePartHeader, attachment.file, trailing]),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

async function postAttachment(
	confluenceClient: RequiredConfluenceClient,
	pageId: string,
	attachment: AttachmentInput,
): Promise<AttachmentResponse> {
	const { body, contentType } = buildMultipartBody(attachment);
	const internalClient = (
		confluenceClient.contentAttachments as unknown as {
			client?: { sendRequest: InternalSendRequest };
		}
	).client;
	if (!internalClient) {
		throw new Error(
			"ConfluenceClient.contentAttachments has no underlying transport — incompatible client",
		);
	}
	const result = await internalClient.sendRequest({
		url: `/api/content/${pageId}/child/attachment`,
		method: "PUT",
		headers: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"X-Atlassian-Token": "no-check",
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"Content-Type": contentType,
		},
		data: body,
	});
	return result as AttachmentResponse;
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

	const attachmentResponse = await uploadAttachmentWithRetry(confluenceClient, pageId, {
		file: fileBuffer,
		filename: uploadFilename,
		contentType: "image/png",
	});

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

// Confluence Cloud sometimes returns 500 StaleObjectStateException for an
// attachment upload that actually committed server-side (the post-commit
// step is what fails). When this happens, re-fetch the attachment list — if
// our file is now present, treat the original 500 as a deferred success.
async function uploadAttachmentWithRetry(
	confluenceClient: RequiredConfluenceClient,
	pageId: string,
	attachment: AttachmentInput,
): Promise<AttachmentResponse> {
	try {
		return await postAttachment(confluenceClient, pageId, attachment);
	} catch (e: unknown) {
		if (!isStaleObjectError(e)) {
			throw e;
		}
		// Wait briefly so Confluence's read replica catches up to the
		// just-committed write before we re-fetch.
		await new Promise((resolve) => setTimeout(resolve, 750));
		const refreshed = await confluenceClient.contentAttachments.getAttachments({
			id: pageId,
		});
		const found = refreshed.results.find(
			(a: { title: string }) => a.title === attachment.filename,
		) as { extensions: { fileId: string } } | undefined;
		if (!found) {
			console.log(
				"Attachment upload returned 500 StaleObjectStateException AND the attachment is not visible on re-fetch — treating as a real failure.",
			);
			throw e;
		}
		console.log(
			`Attachment upload returned 500 StaleObjectStateException but ${attachment.filename} is present server-side — treating as success.`,
		);
		return {
			results: [
				{
					extensions: { fileId: found.extensions.fileId },
					container: { id: pageId },
				},
			],
		};
	}
}

function isStaleObjectError(e: unknown): boolean {
	const blobs: string[] = [];
	if (e instanceof Error) {
		blobs.push(e.message);
	}
	const maybeResponse = (e as { response?: { data?: unknown } }).response;
	if (maybeResponse?.data && typeof maybeResponse.data === "string") {
		blobs.push(maybeResponse.data);
	}
	const blob = blobs.join(" ");
	return (
		blob.includes("StaleObjectStateException") ||
		blob.includes("more than the previous version") ||
		blob.includes("optimistic lock")
	);
}

export async function uploadFile(
	confluenceClient: RequiredConfluenceClient,
	adaptor: LoaderAdaptor,
	pageId: string,
	pageFilePath: string,
	fileNameToUpload: string,
	currentAttachments: CurrentAttachments,
): Promise<UploadedImageData | null> {
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

		const attachmentResponse = await uploadAttachmentWithRetry(confluenceClient, pageId, {
			file: imageBuffer,
			filename: uploadFilename,
		});

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
