import { ImageUploaderPlugin } from "./ImageUploaderPlugin";
import { PlantumlEmbedResolverPlugin } from "./PlantumlEmbedResolverPlugin";

export * from "./types";
export * from "./MermaidRendererPlugin";
export * from "./PlantumlRendererPlugin";
export * from "./PlantumlEmbedResolverPlugin";

export const AlwaysADFProcessingPlugins = [ImageUploaderPlugin];

// Preprocessors run before the main pipeline. They can do async I/O
// (e.g. read referenced files) before extract() begins.
export const AlwaysADFPreprocessors = [PlantumlEmbedResolverPlugin];
