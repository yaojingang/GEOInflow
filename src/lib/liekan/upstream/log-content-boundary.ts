// This boundary only applies to the today content-request card. Raw logs remain complete.
// Keep the same case-insensitive PostgreSQL and JavaScript suffix/query/fragment semantics.
export const staticRequestExtensionPattern =
  '[.](js|mjs|cjs|css|map|avif|webp|png|jpg|jpeg|gif|svg|ico|bmp|tif|tiff|woff|woff2|ttf|otf|eot|mp3|m4a|wav|ogg|mp4|webm|mov|avi)([?#]|$)';
export const isStaticRequestPath = (path: string) =>
  new RegExp(staticRequestExtensionPattern, 'i').test(path);
