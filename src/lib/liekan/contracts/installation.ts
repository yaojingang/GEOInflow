import { z } from 'zod';

export const logMethodSchema = z.enum(['cloudflare', 'server', 'manual']);
export type LogMethod = z.infer<typeof logMethodSchema>;
export const installationSteps = ['js', 'logs', 'finish', 'check', 'complete', 'overview'] as const;
export type InstallationStep = (typeof installationSteps)[number];
export const installationActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('select-method'), method: logMethodSchema }),
  z.strictObject({
    action: z.literal('continue'),
    step: z.enum(['logs', 'finish']),
    method: logMethodSchema,
  }),
  z.strictObject({ action: z.literal('skip-browser') }),
  z.strictObject({ action: z.literal('skip-logs'), method: logMethodSchema }),
  z.strictObject({ action: z.literal('skip-checks'), method: logMethodSchema }),
  z.strictObject({ action: z.literal('finish'), method: logMethodSchema }),
]);
export type InstallationAction = z.infer<typeof installationActionSchema>;
export type LogSetupCheckId =
  | 'public-url'
  | 'queue'
  | 'worker'
  | 'agent-package'
  | 'cloudflare-oauth'
  | 'credentials-key';
export interface LogSetupCheck {
  id: LogSetupCheckId;
  state: 'ready' | 'missing' | 'unverified';
}
export interface LogCapability {
  available: boolean;
  reason: string | null;
  version: string;
  publicUrl?: string | null;
  checks?: LogSetupCheck[];
  runtimes?: { docker: boolean; systemd: boolean };
}
export const serverRuntimeSchema = z.enum(['docker', 'systemd']);
export const serverPairingSchema = z.strictObject({ runtime: serverRuntimeSchema.optional() });
export function logPublicOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export interface InstallationProgress {
  method: LogMethod;
  lastStep: 'js' | 'logs' | 'finish';
  browserCheckDeferred: boolean;
  logCheckDeferred: boolean;
  completedAt: string | null;
}
export interface IdentityIngressDiagnostic {
  configured: boolean;
  state: 'missing_configuration' | 'needs_ingress_verification';
  observation?: InstallationIdentityObservation;
}
export interface InstallationIdentityObservation {
  version: 'received-browser-identity-v1';
  timeBasis: 'received_at';
  population: 'raw_public_pv';
  range: { startAt: number; endAt: number; timezone: 'UTC'; endExclusive: true };
  status:
    | 'empty'
    | 'complete'
    | 'partial'
    | 'unavailable'
    | 'unknown'
    | 'demo'
    | 'unsupported'
    | 'temporarily_unavailable';
  sampleCount: number | null;
  availableIdentityCount: number | null;
  unknownIdentityCount: number | null;
  coverage: number | null;
  lastReceivedAt: string | null;
  smallSample: boolean | null;
  reasons: (
    | 'no_received_samples'
    | 'small_sample'
    | 'identity_input_unavailable'
    | 'identity_evidence_missing'
    | 'partial_identity'
    | 'reception_fallback'
    | 'demo_data'
    | 'unsupported_database'
    | 'diagnostic_timeout'
    | 'diagnostic_unavailable'
  )[];
}
export interface InstallationStatus {
  identityIngress?: IdentityIngressDiagnostic;
  progress: InstallationProgress;
  canManage: boolean;
  browser?: { pageviews: number; firstAt: string | null; lastAt: string | null };
  logs: {
    total: number;
    ai: number;
    latestAt: string | null;
    latestImportAt: string | null;
    demo: boolean;
  };
  capabilities: { cloudflare: boolean; server: boolean };
  availability?: Record<'server' | 'cloudflare', LogCapability>;
  sources?: {
    id: string;
    kind: 'server' | 'cloudflare';
    domain: string;
    state: string;
    primary: boolean;
    lastHeartbeatAt: string | null;
    lastReceivedAt: string | null;
    lastProcessedAt: string | null;
    backlog: number;
    failed?: number;
    errorCode: string | null;
    cleanupPending?: boolean;
    health: Record<string, unknown>;
  }[];
}
export const logMethodLabels: Record<LogMethod, string> = {
  cloudflare: 'Cloudflare 授权连接',
  server: '服务器一次安装',
  manual: '手动导入日志',
};
export function initialInstallationProgress(): InstallationProgress {
  return {
    method: 'cloudflare',
    lastStep: 'js',
    browserCheckDeferred: false,
    logCheckDeferred: false,
    completedAt: null,
  };
}
export function installationStep(value?: string): InstallationStep | undefined {
  return installationSteps.find(step => step === value);
}
export function installationParams(websiteId: string, step: InstallationStep, method?: LogMethod) {
  return { websiteId, section: 'install', step, ...(method ? { method } : {}) };
}
