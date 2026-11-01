import { getApiUrl } from '@/lib/api-url';

export function robotsAgentUrl(origin: string) {
  return new URL(getApiUrl('/liekan/robots-agent'), origin).href;
}
