export declare const CI_DEPLOYED: string[];

export interface WorkerFolder {
  dir: string;
  toml: string;
}

export interface HandDeployedWorker {
  dir: string;
  script: string;
}

export interface MultipartPart {
  name: string;
  filename: string | null;
  body: Uint8Array;
}

export interface BundleComparison {
  match: boolean;
  changed: string[];
  missing: string[];
  extra: string[];
}

export declare function workerScriptName(toml: string): string | null;
export declare function handDeployedWorkers(entries: WorkerFolder[], ciDeployed?: string[]): HandDeployedWorker[];
export declare function boundaryOf(contentType: string | null | undefined): string | null;
export declare function multipartParts(bytes: Uint8Array, boundary: string): MultipartPart[];
export declare function deployedModules(parts: MultipartPart[]): MultipartPart[];
export declare function compareBundles(local: Record<string, string>, live: Record<string, string>): BundleComparison;
