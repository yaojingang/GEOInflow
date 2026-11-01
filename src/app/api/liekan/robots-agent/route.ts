import { requestApi, readBody } from '@/lib/liekan/http';
import { robotsAgentInput } from '@/lib/liekan/contracts/robots-management';
import { robotsAgentRequest } from '@/lib/liekan/upstream/robots-management';
import { LiekanError } from '@/lib/liekan/upstream/errors';
export async function POST(request: Request) {
  return requestApi(request, async () => {
    const parsed = robotsAgentInput.safeParse(await readBody(request, 1600000));
    if (!parsed.success) throw new LiekanError('robots 服务器参数无效', 400);
    return robotsAgentRequest(
      parsed.data,
      request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1],
    );
  });
}
