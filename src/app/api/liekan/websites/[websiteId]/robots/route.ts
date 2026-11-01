import { crawlerApi, crawlerBody } from '@/lib/liekan/crawler-control/http';
import { robotsManagementInput } from '@/lib/liekan/contracts/robots-management';
import {
  getRobotsManagement,
  changeRobotsManagement,
} from '@/lib/liekan/upstream/robots-management';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return crawlerApi(request, async actor => getRobotsManagement(actor, (await params).websiteId));
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  return crawlerApi(request, async actor =>
    changeRobotsManagement(
      actor,
      (await params).websiteId,
      await crawlerBody(request, robotsManagementInput, 1600000),
    ),
  );
}
