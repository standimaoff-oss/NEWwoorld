// Runtime data embedded by tools/build_china_3d.mjs. No network requests.
export const DATA = window.__CHINA3D_DATA__;
export const META = DATA.meta;
export const featureById = new Map(DATA.features.map(f => [f.id, f]));
export const CLIP = META.clipBBoxMeters; // [xmin, zmin, xmax, zmax]
export const CENTER = [(CLIP[0] + CLIP[2]) / 2, (CLIP[1] + CLIP[3]) / 2];
export const SPAN = [CLIP[2] - CLIP[0], CLIP[3] - CLIP[1]];

export const LAYERS = [
  ['buildings', 'Здания · footprints OSM'],
  ['roads', 'Улицы и хутуны · highway OSM'],
  ['barriers', 'Заборы и ворота · barrier OSM'],
  ['water', 'Вода · natural/waterway'],
  ['green', 'Парки, газоны, деревья'],
  ['monuments', 'Памятники и heritage'],
  ['pois', 'POI и вывески с именами OSM'],
  ['details', 'Окна, фонари, карнизы (стиль)'],
  ['labels', 'Подписи объектов'],
  ['other', 'Причалы и прочее'],
];

export function feature(id) {
  return featureById.get(id) || null;
}

export function centerOf(id, fallback = CENTER) {
  const f = feature(id);
  return f && f.hasGeometry ? f.center : fallback;
}

export function bboxOf(id) {
  const f = feature(id);
  return f && f.hasGeometry ? f.bbox : CLIP;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Russian aliases make the OSM search usable without Chinese input.
export const SEARCH_ALIASES = [
  ['нанлугусян', '南锣鼓巷|Nanluoguxiang|South Luogu Alley|Nan Luogu Xiang'],
  ['нанлогусян', '南锣鼓巷|Nanluoguxiang|South Luogu Alley'],
  ['южная улица луогу', '南锣鼓巷|South Luogu Alley'],
  ['барабанная башня', '鼓楼|Drum Tower|Gulou'],
  ['колокольная башня', '钟楼|Bell Tower|Zhonglou'],
  ['гулоу', '鼓楼|Gulou|Gulou East Street'],
  ['чжунлоу', '钟楼|Zhonglou'],
  ['хоухай', '什刹后海|Houhai Lake|后海'],
  ['шичахай', '什刹海|Shichahai'],
  ['бэйхай', '北海公园|Beihai Park|парк Бэйхай'],
  ['цзюйэр', "菊儿胡同|Ju'er Alley"],
  ['маоэр', "帽儿胡同|Mao'er Alley|Mao'er Hutong"],
  ['яньдай', '烟袋斜街|Yandai Byway'],
  ['баочао', '宝钞胡同|Baochao Hutong'],
];
