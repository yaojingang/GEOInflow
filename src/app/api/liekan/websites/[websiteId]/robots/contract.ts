import { crawlerOperation } from '@/lib/liekan/upstream/crawler-operation';
import { z } from 'zod';
import {
  robotsManagementInput,
  robotsManagementResponse,
} from '@/lib/liekan/contracts/robots-management';
export const operations = [
  crawlerOperation(
    'get',
    '/api/liekan/websites/{websiteId}/robots',
    'getLiekanRobotsManagement',
    undefined,
    robotsManagementResponse,
  ),
  crawlerOperation(
    'post',
    '/api/liekan/websites/{websiteId}/robots',
    'postLiekanRobotsManagement',
    robotsManagementInput,
    z.union([
      robotsManagementResponse,
      z.object({
        data: robotsManagementResponse,
        id: z.uuid().optional(),
        code: z.string().optional(),
        hostname: z.string().optional(),
      }),
    ]),
  ),
] as const;
