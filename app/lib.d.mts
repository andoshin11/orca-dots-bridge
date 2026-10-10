export type Step = { step: string; status: string; detail: string };
export type SetupRequest = {
  useClipboardKey: boolean;
  installTunnelClient: boolean;
  installAgent: boolean;
  statusTunnelId?: string;
  notificationTunnelId?: string;
};
export const runtimeKeyPattern: RegExp;
export const tunnelIdPattern: RegExp;
export function overallLevel(steps: Step[]): "ok" | "action" | "error";
export function trayTitle(level: "ok" | "action" | "error", tunnelReady: boolean): string;
export const stepLabels: Record<string, string>;
export function nodeCandidates(home: string): string[];
export function runtimeKeyFromClipboard(text: string | undefined): string | undefined;
export function parseSetupRequest(input: unknown): SetupRequest;
export const externalPages: string[];
