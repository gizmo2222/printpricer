// File parsing: gcode (PrusaSlicer/Orca/Cura/Bambu) + .3mf (Bambu/Orca
// project files) + geometry-based estimator for model-only 3MFs.
//
// The geometry estimator handles 3MF's componentized form (real meshes
// in 3D/Objects/object_*.model files) and per-color volume splitting
// using either per-triangle paint_color/extruder/pindex attributes, or
// part-level extruder mappings from model_settings.config.

import { settings } from './state.js?v=16';
import { getActivePrinter } from './storage.js?v=16';
import { parseTimeStr } from './utils.js?v=16';

// ---------- regex literals (module-scope so they aren't re-compiled) ----------

const RE_OBJECT       = /<object\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/object>/gi;
const RE_VERTEX       = /<vertex\b[^>]*\bx\s*=\s*"([^"]+)"[^>]*\by\s*=\s*"([^"]+)"[^>]*\bz\s*=\s*"([^"]+)"/gi;
const RE_TRIANGLE_FULL = /<triangle\b([^>]*?)\/?>/gi;
const RE_FILAMENT_TAG = /<filament\b[^>]*?>/gi;
const RE_PLATE        = /<plate\b[^>]*>([\s\S]*?)<\/plate>/gi;
const RE_PART_BLOCK   = /<(part|object)\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;

// ---------- gcode ----------

export function parseGcode(text) {
  // Slicer metadata is in the first ~16KB or last ~64KB of the file.
  const head = text.slice(0, 16 * 1024);
  const tail = text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
  const search = head + '\n' + tail;
  const result = { hours: 0, filaments: [] };

  let m = search.match(/;\s*estimated printing time(?:\s*\(normal mode\))?\s*=\s*([^\r\n]+)/i)
        || search.match(/;\s*total estimated time\s*[:=]\s*([^\r\n]+)/i)
        || search.match(/;\s*Print time\s*[:=]\s*([^\r\n]+)/i);
  if (m) {
    result.hours = parseTimeStr(m[1].trim());
  } else {
    const t = search.match(/;\s*TIME\s*[:=]\s*(\d+)/i);
    if (t) result.hours = parseInt(t[1]) / 3600;
  }

  let weights = [];
  const fm = search.match(/;\s*(?:total\s+)?filament[\s_]used\s*\[g\]\s*=\s*([\d.,\s]+)/i)
          || search.match(/;\s*filament[\s_]weight\s*[:=]\s*([\d.,\s]+)/i);
  if (fm) {
    weights = fm[1].split(',').map(s => parseFloat(s.trim())).filter(n => isFinite(n) && n > 0);
  }

  let types = [];
  const tm = search.match(/;\s*filament_type\s*=\s*([^\r\n]+)/i);
  if (tm) types = tm[1].split(/[,;]/).map(s => s.trim()).filter(Boolean);

  result.filaments = weights.map((w, i) => ({
    name: types[i] || types[0] || '',
    grams: w.toFixed(2),
    costPerKg: settings.filamentCost || '',
  }));

  return result;
}

// ---------- 3mf ----------

export async function parse3mf(file) {
  if (typeof JSZip === 'undefined') throw new Error('Zip library not loaded');
  const zip = await JSZip.loadAsync(file);
  const result = { hours: 0, filaments: [] };
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);

  async function readByRegex(re) {
    const path = paths.find(p => re.test(p));
    return path ? { path, text: await zip.file(path).async('string') } : null;
  }

  // Strategy 1 — slice_info.config (Bambu / Orca sliced 3MFs)
  const sliceInfo = await readByRegex(/slice_info\.config$/i);
  if (sliceInfo) {
    const xml = sliceInfo.text;
    const plates = [];
    let pm;
    while ((pm = RE_PLATE.exec(xml))) plates.push(parsePlateBody(pm[1]));
    RE_PLATE.lastIndex = 0;
    if (plates.length === 0) {
      const flat = parsePlateBody(xml);
      if (flat.hours > 0 || flat.filaments.length > 0) plates.push(flat);
    }
    let chosen = null;
    let chosenIdx = -1;
    for (let i = 0; i < plates.length; i++) {
      if (plates[i].hours === 0 && plates[i].filaments.length === 0) continue;
      if (!chosen || plateMassG(plates[i]) > plateMassG(chosen)) {
        chosen = plates[i];
        chosenIdx = i;
      }
    }
    if (chosen) {
      result.hours = chosen.hours;
      result.filaments = chosen.filaments;
    }
  }

  // Strategy 2 — Bambu plate_*.json
  if (result.filaments.length === 0 || result.hours === 0) {
    const plateJson = await readByRegex(/plate[_-]?\d*\.json$/i);
    if (plateJson) {
      try {
        const data = JSON.parse(plateJson.text);
        if (!result.hours && data.prediction) result.hours = data.prediction / 3600;
        if (result.filaments.length === 0 && Array.isArray(data.filament_use_g)) {
          const types = Array.isArray(data.filament_types) ? data.filament_types : [];
          const colors = Array.isArray(data.filament_colors) ? data.filament_colors : [];
          data.filament_use_g.forEach((g, i) => {
            const grams = parseFloat(g);
            if (isFinite(grams) && grams > 0) {
              const name = [types[i], colors[i]].filter(Boolean).join(' ') || `Filament ${i + 1}`;
              result.filaments.push({
                name,
                grams: grams.toFixed(2),
                costPerKg: settings.filamentCost || '',
              });
            }
          });
        }
      } catch { /* not parseable JSON */ }
    }
  }

  // Strategy 3 — embedded .gcode in the zip
  if (result.filaments.length === 0 || result.hours === 0) {
    const gcodePath = paths.find(p => /\.gcode$/i.test(p));
    if (gcodePath) {
      const text = await zip.file(gcodePath).async('string');
      const g = parseGcode(text);
      if (!result.hours && g.hours) result.hours = g.hours;
      if (result.filaments.length === 0 && g.filaments.length) result.filaments = g.filaments;
    }
  }

  // Strategy 4 — PrusaSlicer config (project .3mf without slicing data)
  if (result.filaments.length === 0 || result.hours === 0) {
    const ps = await readByRegex(/(Slic3r|PrusaSlicer)[\w.\- ]*\.config$/i);
    if (ps) {
      const xml = ps.text;
      if (!result.hours) {
        const tm = xml.match(/key\s*=\s*"estimated_printing_time(?:_normal_mode)?"\s+value\s*=\s*"([^"]+)"/i);
        if (tm) result.hours = parseTimeStr(tm[1]);
      }
    }
  }

  // Strategy 5 — geometry-based estimate
  if (result.filaments.length === 0 || result.hours === 0) {
    const est = await estimateFromGeometry(zip);
    if (est) {
      if (!result.hours && est.hours) result.hours = est.hours;
      if (result.filaments.length === 0 && est.filaments.length) result.filaments = est.filaments;
      result.estimated = true;
      result.meshVolumeCm3 = est.meshVolumeCm3;
    }
  }

  if (result.filaments.length === 0 && result.hours === 0) {
    const hasOnlyPreviews = paths.every(p =>
      /\.(png|jpg|jpeg|xml)$/i.test(p) || /3dmodel\.model/i.test(p) || /_rels\//i.test(p)
    );
    if (hasOnlyPreviews) {
      throw new Error(
        'This 3MF has only the model + previews (no slicing data). ' +
        'Slice it in your slicer first, then export the sliced 3MF / G-code.'
      );
    }
    throw new Error(
      `No print data in 3MF. ${paths.length} files found. ` +
      `In Bambu/Orca, use the gear icon → "Export plate sliced file". In PrusaSlicer, use "Export plate as G-code 3MF".`
    );
  }
  return result;
}

// ---------- plate-body parsing helpers ----------

function parsePlateBody(body) {
  const plate = { hours: 0, filaments: [] };
  const pred = body.match(/<metadata\b[^>]*\bkey\s*=\s*"prediction"[^>]*\bvalue\s*=\s*"([^"]+)"/i)
            || body.match(/<metadata\b[^>]*\bvalue\s*=\s*"([^"]+)"[^>]*\bkey\s*=\s*"prediction"/i);
  if (pred) {
    const v = parseFloat(pred[1]);
    if (isFinite(v)) plate.hours = v / 3600;
  }
  const filTags = body.match(RE_FILAMENT_TAG) || [];
  filTags.forEach((tag, idx) => {
    const g = tag.match(/\bused_g\s*=\s*"([^"]+)"/i);
    const t = tag.match(/\btype\s*=\s*"([^"]+)"/i);
    const c = tag.match(/\bcolor\s*=\s*"([^"]+)"/i);
    if (g) {
      const grams = parseFloat(g[1]);
      if (isFinite(grams) && grams > 0) {
        plate.filaments.push({
          name: [t?.[1], c?.[1] && !/^#FFFFFFFF$/i.test(c[1]) ? c[1] : ''].filter(Boolean).join(' ') || `Filament ${idx + 1}`,
          grams: grams.toFixed(2),
          costPerKg: settings.filamentCost || '',
        });
      }
    }
  });
  return plate;
}
function plateMassG(p) {
  return p.filaments.reduce((s, f) => s + (+f.grams || 0), 0);
}

// ---------- geometry estimator ----------

function applyTransform3MF(p, t) {
  if (!t || t.length < 12) return p;
  return {
    x: t[0]*p.x + t[3]*p.y + t[6]*p.z + t[9],
    y: t[1]*p.x + t[4]*p.y + t[7]*p.z + t[10],
    z: t[2]*p.x + t[5]*p.y + t[8]*p.z + t[11],
  };
}

function meshVolumeMm3(verts, tris, transform) {
  let v = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const a = applyTransform3MF(verts[t.v1], transform);
    const b = applyTransform3MF(verts[t.v2], transform);
    const c = applyTransform3MF(verts[t.v3], transform);
    const cx = b.y * c.z - b.z * c.y;
    const cy = b.z * c.x - b.x * c.z;
    const cz = b.x * c.y - b.y * c.x;
    v += (a.x * cx + a.y * cy + a.z * cz) / 6;
  }
  return Math.abs(v);
}

function triArea(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

async function readPartExtruderMap(zip) {
  const map = new Map();
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
  const cfgPath = paths.find(p => /model_settings\.config$/i.test(p));
  if (!cfgPath) return map;
  let xml;
  try { xml = await zip.file(cfgPath).async('string'); }
  catch { return map; }
  let bm;
  while ((bm = RE_PART_BLOCK.exec(xml))) {
    const id = bm[2];
    const body = bm[3];
    const ex = body.match(/<metadata\b[^>]*\bkey\s*=\s*"(?:extruder|filament)"[^>]*\bvalue\s*=\s*"([^"]+)"/i);
    if (ex) map.set(id, ex[1].trim());
  }
  RE_PART_BLOCK.lastIndex = 0;
  return map;
}

async function readFilamentLabelsFromZip(zip) {
  const labels = {};
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
  for (const path of paths) {
    if (!/(model_settings|project_settings|slice_info)\.config$/i.test(path)) continue;
    let xml;
    try { xml = await zip.file(path).async('string'); }
    catch { continue; }
    const tags = xml.match(RE_FILAMENT_TAG) || [];
    tags.forEach(tag => {
      const id    = tag.match(/\bid\s*=\s*"([^"]+)"/i)?.[1];
      const type  = tag.match(/\btype\s*=\s*"([^"]+)"/i)?.[1];
      const color = tag.match(/\bcolor\s*=\s*"([^"]+)"/i)?.[1];
      if (id) {
        const label = [type, color && !/^#FFFFFFFF$/i.test(color) ? color : ''].filter(Boolean).join(' ');
        if (label && !labels[id]) labels[id] = label;
      }
    });
  }
  return labels;
}

async function estimateFromGeometry(zip) {
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
  const modelPaths = paths.filter(p => /\.model$/i.test(p));
  if (modelPaths.length === 0) return null;

  const partExtruder = await readPartExtruderMap(zip);

  function objectsWithMesh(xml) {
    const out = [];
    let om;
    while ((om = RE_OBJECT.exec(xml))) {
      const objId = om[1];
      const body = om[2];
      const verts = [];
      let vm;
      while ((vm = RE_VERTEX.exec(body))) verts.push({ x: +vm[1], y: +vm[2], z: +vm[3] });
      RE_VERTEX.lastIndex = 0;
      const tris = [];
      let tm;
      while ((tm = RE_TRIANGLE_FULL.exec(body))) {
        const attrs = tm[1];
        const v1 = attrs.match(/\bv1\s*=\s*"(\d+)"/i);
        const v2 = attrs.match(/\bv2\s*=\s*"(\d+)"/i);
        const v3 = attrs.match(/\bv3\s*=\s*"(\d+)"/i);
        if (!v1 || !v2 || !v3) continue;
        const paint    = attrs.match(/\bpaint_color\s*=\s*"([^"]+)"/i)?.[1];
        const extruder = attrs.match(/\bextruder\s*=\s*"([^"]+)"/i)?.[1];
        const pindex   = attrs.match(/\bpindex\s*=\s*"([^"]+)"/i)?.[1];
        const tPaint = paint ?? extruder ?? pindex;
        const colorKey = String(tPaint ?? partExtruder.get(objId) ?? '0');
        tris.push({ v1: +v1[1], v2: +v2[1], v3: +v3[1], color: colorKey });
      }
      RE_TRIANGLE_FULL.lastIndex = 0;
      if (verts.length && tris.length) out.push({ id: objId, verts, tris });
    }
    RE_OBJECT.lastIndex = 0;
    return out;
  }

  let totalMm3 = 0;
  let totalObjects = 0;
  const volByColor = new Map();
  function add(map, key, val) { map.set(key, (map.get(key) || 0) + val); }

  for (const mp of modelPaths) {
    let xml;
    try { xml = await zip.file(mp).async('string'); }
    catch { continue; }
    const objs = objectsWithMesh(xml);
    for (const o of objs) {
      const objVol = meshVolumeMm3(o.verts, o.tris, null);
      if (!isFinite(objVol) || objVol <= 0) continue;
      totalMm3 += objVol;
      totalObjects++;
      const objAreaByColor = new Map();
      for (const t of o.tris) {
        const a = o.verts[t.v1], b = o.verts[t.v2], c = o.verts[t.v3];
        add(objAreaByColor, t.color, triArea(a, b, c));
      }
      if (objAreaByColor.size === 1) {
        const color = [...objAreaByColor.keys()][0];
        add(volByColor, color, objVol);
      } else {
        const totalObjArea = [...objAreaByColor.values()].reduce((s, a) => s + a, 0) || 1;
        for (const [color, area] of objAreaByColor) {
          add(volByColor, color, objVol * (area / totalObjArea));
        }
      }
    }
  }

  if (!isFinite(totalMm3) || totalMm3 <= 0) return null;

  const printer = getActivePrinter();
  const density       = +settings.estDensity || 1.24;
  const fillPct       = +settings.estFillPct || 30;
  const gramsPerHour  = +(printer?.gramsPerHour) || 18;
  const swapPct       = printer && printer.swapPct !== '' && printer.swapPct != null
    ? +printer.swapPct : 25;

  const distinctColors = volByColor.size;
  const volCm3   = totalMm3 / 1000;
  const totalG   = volCm3 * density * (fillPct / 100);
  const baseHours = totalG / gramsPerHour;
  const numColors = Math.max(1, distinctColors);
  const overheadFactor = 1 + (swapPct / 100) * (numColors - 1);
  const hours = baseHours * overheadFactor;

  const filamentLabels = await readFilamentLabelsFromZip(zip);

  const filamentRows = [];
  if (distinctColors <= 1) {
    filamentRows.push({
      name: 'Estimated · adjust if needed',
      grams: totalG.toFixed(2),
      costPerKg: settings.filamentCost || '',
    });
  } else {
    const totalVol = [...volByColor.values()].reduce((s, v) => s + v, 0) || 1;
    const sorted = [...volByColor.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([color, vol], idx) => {
      const share = vol / totalVol;
      const grams = totalG * share;
      if (share < 0.001 && grams < 0.005) return;
      const label = filamentLabels[+color] || filamentLabels[color] || null;
      const name = label ? `Est. ${label}` : `Est. filament ${idx + 1} (paint ${color})`;
      filamentRows.push({
        name,
        grams: grams.toFixed(2),
        costPerKg: settings.filamentCost || '',
      });
    });
  }

  return {
    hours,
    filaments: filamentRows,
    meshVolumeCm3: volCm3,
  };
}
