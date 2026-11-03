import { readFile, stat } from 'node:fs/promises';
import { createHash, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
const artifact = z.strictObject({
  file: z.string().regex(/^agent-linux-(x64|arm64)\.tar\.gz$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.strictObject({
  version: z.literal('1.0.0'),
  protocol: z.literal(1),
  runtime: z.literal('22.23.4'),
  installerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  platforms: z.strictObject({ x64: artifact, arm64: artifact }),
  docker: z
    .strictObject({
      file: z.literal('agent-docker.tar.gz'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      zipFile: z.literal('agent-docker.zip'),
      zipSha256: z.string().regex(/^[a-f0-9]{64}$/),
      installerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
async function signedManifest() {
  const directory = resolve('public/liekan-agent');
  const [bytes, signature, key] = await Promise.all(
    ['manifest.json', 'manifest.sig', 'manifest.pub'].map(name =>
      readFile(resolve(directory, name)),
    ),
  );
  if (bytes.length > 16384 || !verify(null, bytes, key, signature))
    throw new Error('安装资产签名无效');
  return manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
}
export async function readAgentManifest() {
  const directory = resolve('public/liekan-agent');
  const manifest = await signedManifest();
  const installer = await readFile(resolve(directory, 'install.sh'));
  if (createHash('sha256').update(installer).digest('hex') !== manifest.installerSha256)
    throw new Error('安装引导校验失败');
  for (const asset of Object.values(manifest.platforms))
    if (!(await stat(resolve(directory, asset.file))).isFile()) throw new Error('安装资产不完整');
  return manifest;
}
export async function readDockerManifest() {
  const directory = resolve('public/liekan-agent');
  const manifest = await signedManifest();
  if (!manifest.docker) throw new Error('Docker 安装资产尚未准备完成');
  for (const [file, checksum] of [
    ['install-docker.sh', manifest.docker.installerSha256],
    [manifest.docker.file, manifest.docker.sha256],
    [manifest.docker.zipFile, manifest.docker.zipSha256],
  ]) {
    const bytes = await readFile(resolve(directory, file));
    if (createHash('sha256').update(bytes).digest('hex') !== checksum)
      throw new Error('Docker 安装资产校验失败');
  }
  return manifest;
}
