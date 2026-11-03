export async function loadEcharts() {
  const echarts = await import('echarts');
  await import('echarts/theme/v5.js');
  return echarts;
}
