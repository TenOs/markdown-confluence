#!/usr/bin/env node

process.setMaxListeners(Infinity);

import chalk from "chalk";
import boxen from "boxen";
import {
	ADFProcessingPlugin,
	AutoSettingsLoader,
	FileSystemAdaptor,
	MermaidRendererPlugin,
	PlantumlRendererPlugin,
	Publisher,
} from "@markdown-confluence/lib";
import { PuppeteerMermaidRenderer } from "@markdown-confluence/mermaid-puppeteer-renderer";
import { HttpPlantumlRenderer } from "@markdown-confluence/plantuml-renderer";
import { ConfluenceClient } from "confluence.js";

// Define the main function
async function main() {
	const settingLoader = new AutoSettingsLoader();
	const settings = settingLoader.load();

	const adaptor = new FileSystemAdaptor(settings); // Make sure this is identical as possible between Obsidian and CLI
	const confluenceClient = new ConfluenceClient({
		host: settings.confluenceBaseUrl,
		authentication: {
			basic: {
				email: settings.atlassianUserName,
				apiToken: settings.atlassianApiToken,
			},
		},
		middlewares: {
			onError(e) {
				if ("response" in e && "data" in e.response) {
					e.message =
						typeof e.response.data === "string"
							? e.response.data
							: JSON.stringify(e.response.data);
				}
			},
		},
	});

	const plugins: ADFProcessingPlugin<unknown, unknown>[] = [
		new MermaidRendererPlugin(new PuppeteerMermaidRenderer()),
	];

	if (settings.plantumlEnabled) {
		if (!settings.plantumlServerUrl) {
			throw new Error(
				"PlantUML rendering is enabled but plantumlServerUrl is empty. Set CONFLUENCE_PLANTUML_SERVER_URL, --plantumlServerUrl, or plantumlServerUrl in .markdown-confluence.json — or set plantumlEnabled to false.",
			);
		}
		plugins.push(
			new PlantumlRendererPlugin(
				new HttpPlantumlRenderer({ serverUrl: settings.plantumlServerUrl }),
			),
		);
	}

	const publisher = new Publisher(adaptor, settingLoader, confluenceClient, plugins);

	const publishFilter = "";
	const results = await publisher.publish(publishFilter);
	results.forEach((file) => {
		if (file.successfulUploadResult) {
			console.log(
				chalk.green(
					`SUCCESS: ${file.node.file.absoluteFilePath} Content: ${file.successfulUploadResult.contentResult}, Images: ${file.successfulUploadResult.imageResult}, Labels: ${file.successfulUploadResult.labelResult}, Page URL: ${file.node.file.pageUrl}`,
				),
			);
			return;
		}
		console.error(
			chalk.red(
				`FAILED:  ${file.node.file.absoluteFilePath} publish failed. Error is: ${file.reason}`,
			),
		);
	});
}

// Call the main function
main().catch((error) => {
	console.error(chalk.red(boxen(`Error: ${error.message}`, { padding: 1 })));
	process.exit(1);
});
