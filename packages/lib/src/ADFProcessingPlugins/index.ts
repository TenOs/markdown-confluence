import { ImageUploaderPlugin } from "./ImageUploaderPlugin";

export * from "./types";
export * from "./MermaidRendererPlugin";
export * from "./PlantumlRendererPlugin";

export const AlwaysADFProcessingPlugins = [ImageUploaderPlugin];
