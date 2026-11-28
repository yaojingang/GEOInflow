/** Only these read endpoints run inside a publication-pinned warehouse report.
 * Mutations, metadata, links and pixels retain their existing revision semantics. */
export function isWarehouseReportRequest(request?: Request) {
  if (!request || request.method !== 'GET') return false;
  const path = new URL(request.url).pathname;
  return (
    /\/api\/liekan\/websites\/[^/]+\/(?:page-report|log-entries|log-count|log-summary|analytics|journeys|overview-jobs\/[^/]+(?:\/result)?)$/.test(
      path,
    ) ||
    /\/api\/websites\/[^/]+\/(?:stats|pageviews|metrics|active|sessions(?:\/[^/]+(?:\/activity)?)?|retention|events(?:\/(?:stats|series))?|goals\/(?:stats|[^/]+\/stats)|funnels\/(?:stats|[^/]+\/stats)|utm\/metrics|breakdown|attribution|journeys|values|realtime)$/.test(
      path,
    )
  );
}
