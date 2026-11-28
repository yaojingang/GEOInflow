import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';
import { getAllUserTeams } from '@/queries/prisma';
import {
  clearWarehouseExportCookie,
  warehouseExportCredential,
} from '@/lib/liekan/upstream/warehouse-export-cookie';

export async function POST(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return clearWarehouseExportCookie(request, error());
  }

  const teams = await getAllUserTeams(auth.user.id);

  const response = json({ ...auth.user, teams });
  const credential = warehouseExportCredential(request);
  return credential && credential !== auth.token
    ? clearWarehouseExportCookie(request, response)
    : response;
}
