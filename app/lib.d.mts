export type Step = { step: string; status: string; detail: string };
export type SetupRequest = {
  useClipboardKey: boolean;
  replaceRuntimeKey: boolean;
  installTunnelClient: boolean;
  installAgent: boolean;
  tunnelId?: string;
};
export const runtimeKeyPattern: RegExp;
export const tunnelIdPattern: RegExp;
export function overallLevel(steps: Step[]): "ok" | "action" | "error";
export function trayTitle(level: "ok" | "action" | "error", tunnelReady: boolean): string;
export const stepLabels: Record<string, string>;
export function needsAgentRefresh(steps: Step[]): boolean;
export function nodeCandidates(home: string): string[];
export function runtimeKeyFromClipboard(text: string | undefined): string | undefined;
export function parseSetupRequest(input: unknown): SetupRequest;
export const externalPages: string[];
export type AuditEntry = {
  time: string;
  source: "chatgpt" | "stdio";
  tool: string;
  outcome: "ok" | "refused" | "error";
  errorCode: string | undefined;
  target: Record<string, string | number | boolean>;
  summary: string | undefined;
};
export const auditViewLimit: number;
export const auditToolLabels: Record<string, string>;
export const auditOutcomeLabels: Record<string, string>;
export function parseAuditLog(texts: Array<string | undefined>, limit?: number): AuditEntry[];
export function formatAuditEntry(
  entry: AuditEntry,
  locale?: string,
): {
  time: string;
  tool: string;
  source: string;
  target: string;
  outcome: string;
  outcomeClass: string;
  summary: string;
};
export type ReleaseAsset = { name: string; url: string; size: number | undefined };
export type Release = {
  version: string;
  tag: string;
  notesUrl: string;
  zip: ReleaseAsset;
  sums: ReleaseAsset;
};
export type UpdatePrefs = {
  autoCheck: boolean;
  lastCheckedAt?: string;
  skippedVersion?: string;
  pendingInstall?: { version: string; tempDir: string };
};
export const releaseRepo: string;
export const latestReleaseUrl: string;
export const appBundleName: string;
export const caskToken: string;
export const brewUpgradeArgs: string[];
export const brewCandidates: string[];
export const caskroomCandidates: string[];
export const updateCheckInterval: number;
export const firstCheckDelay: number;
export const maxAssetBytes: number;
export function parseVersion(text: unknown): number[] | undefined;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function releaseArch(arch: string): "arm64" | "x64" | undefined;
export function zipAssetName(version: string, arch: string): string;
export function parseRelease(json: unknown, arch: string): Release | undefined;
export function offeredUpdate(
  release: Release | undefined,
  currentVersion: string,
  options?: { skippedVersion?: string; manual?: boolean },
): Release | undefined;
export function expectedSha256(sums: unknown, name: string): string | undefined;
export function appBundlePath(execPath: string | undefined): string | undefined;
export function isHomebrewManaged(appPath: string | undefined, caskroomExists: boolean): boolean;
export function installTargetProblem(
  appPath: string | undefined,
): "not_an_app_bundle" | "translocated" | "unexpected_name" | undefined;
export function extractedAppPath(extractDir: string, arch: string): string;
export function bundleInfoProblem(
  info: { identifier?: string; version?: string } | undefined,
  expected: { identifier: string; version: string },
): "identifier_mismatch" | "version_mismatch" | undefined;
export function referencedRuntimes(texts: Array<string | undefined>): Set<string>;
export function runtimesToPrune(
  names: string[],
  currentVersion: string,
  referenced: Set<string>,
): string[];
export function parseUpdatePrefs(text: string | undefined): UpdatePrefs;
export function nextCheckDelay(lastCheckedAt: string | undefined, now: number): number;
export const updateTempPrefix: string;
export function isUpdateTempDir(path: unknown, tmpRoot: unknown): boolean;
export const installerScript: string;
