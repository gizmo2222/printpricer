// Builds the .3mf test fixtures in this folder. The outputs are committed,
// so you only need to run this after changing it:
//   node tests\fixtures\make-3mf.js
//
// A .3mf is a zip. This writes plain zips (stored or deflated entries) with
// only the parts parser.js reads, so each fixture stays a few hundred bytes.

import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, { store = false } = {}] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const method = store ? 0 : 8;
    const body = store ? data : deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);          // time + date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- shared parts ----------

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
// Not a real image; the parser only looks at the file name.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A 10 mm cube: 1000 mm^3 = 1 cm^3. Faces wound outward.
const CUBE_VERTS = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
const CUBE_FACES = {
  bottom: [[0, 2, 1], [0, 3, 2]],
  top:    [[4, 5, 6], [4, 6, 7]],
  front:  [[0, 1, 5], [0, 5, 4]],
  back:   [[3, 7, 6], [3, 6, 2]],
  left:   [[0, 4, 7], [0, 7, 3]],
  right:  [[1, 2, 6], [1, 6, 5]],
};

// colorOf(face) returns extra triangle attributes, e.g. ' paint_color="1"'.
function cubeMesh({ colorOf = () => '', badIndex = false } = {}) {
  const verts = CUBE_VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const tris = [];
  for (const [face, list] of Object.entries(CUBE_FACES)) {
    for (const [a, b, c] of list) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${colorOf(face)}/>`);
  }
  if (badIndex) tris[tris.length - 1] = '<triangle v1="1" v2="6" v3="99"/>';
  return `<mesh><vertices>${verts}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

function model(objects, build = '') {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources>${objects}</resources><build>${build}</build></model>`;
}

const cubeObject = (opts) => `<object id="1" type="model">${cubeMesh(opts)}</object>`;
const modelOnly = (modelXml, extra = []) => [
  ['[Content_Types].xml', CONTENT_TYPES],
  ['_rels/.rels', RELS],
  ['3D/3dmodel.model', modelXml],
  ['Metadata/thumbnail.png', PNG, { store: true }],
  ...extra,
];

const gcode = readFileSync(join(here, 'prusa.gcode'), 'utf8');

// ---------- fixtures ----------

const fixtures = {
  // Two plates; the parser picks the heavier one (plate 2, 25 g).
  'sliced-multiplate.3mf': [
    ['Metadata/slice_info.config', `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3600"/>
    <filament id="1" type="PLA" color="#FF0000FF" used_m="3.3" used_g="10"/>
    <filament id="2" used_g="2.5"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="7200"/>
    <filament id="1" type="PETG" color="#FFFFFFFF" used_g="20"/>
    <filament id="2" type="PLA" color="#00FF00FF" used_g="5"/>
    <filament id="3" type="TPU" color="#0000FFFF" used_g="0"/>
  </plate>
</config>`],
    ['Metadata/plate_1.png', PNG, { store: true }],
  ],

  // No slice_info: Bambu plate_N.json with a zero-weight first filament.
  'plate-json.3mf': [
    ['Metadata/plate_1.json', JSON.stringify({
      prediction: 5400,
      filament_use_g: [0, 12.5],
      filament_types: ['PLA', 'PETG'],
      filament_colors: ['#000000', '#FFFFFF'],
    })],
  ],

  // plate_N.json that is not valid JSON, and nothing else to read.
  'plate-json-bad.3mf': [
    ['Metadata/plate_1.json', '{"prediction": 5400, "filament_use_g": [12.5'],
  ],

  // A .gcode.3mf: the sliced G-code is inside the zip (stored, not deflated).
  'embedded-gcode.3mf': [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['Metadata/plate_1.gcode', gcode, { store: true }],
  ],

  // PrusaSlicer project: time from the config, grams from the geometry.
  'prusa-project.3mf': modelOnly(model(cubeObject(), '<item objectid="1"/>'), [
    ['Metadata/Slic3r_PE.config', '<config><option key="estimated_printing_time" value="1h 30m"/></config>'],
  ]),

  // Model only: falls back to the geometry estimate.
  'cube-model-only.3mf': modelOnly(model(cubeObject(), '<item objectid="1"/>')),

  // Bambu production layout: the mesh lives in 3D/Objects/, the root model
  // only references it through a component.
  'cube-components.3mf': modelOnly(
    model('<object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object>',
      '<item objectid="2"/>'),
    [['3D/Objects/object_1.model', model(cubeObject())]],
  ),

  // Two paint colours: 4 faces colour 1, 2 faces colour 2 (2/3 vs 1/3 of
  // the surface). Only colour 1 has a label in project_settings.config.
  'two-color.3mf': modelOnly(
    model(cubeObject({ colorOf: f => ` paint_color="${['left', 'right'].includes(f) ? 2 : 1}"` }), '<item objectid="1"/>'),
    [['Metadata/project_settings.config', '<config><filament id="1" type="PLA" color="#FF0000FF"/></config>']],
  ),

  // Same cube, placed with a 2x scale transform: 8 cm^3 on the plate.
  'scaled-build.3mf': modelOnly(model(cubeObject(), '<item objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>')),

  // Same cube, placed twice: 2 cm^3 on the plate.
  'two-copies.3mf': modelOnly(model(cubeObject(),
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>')),

  // One triangle points at vertex 99, which does not exist.
  'bad-vertex-index.3mf': modelOnly(model(cubeObject({ badIndex: true }), '<item objectid="1"/>')),

  // Model file cut off in the middle of the mesh (no closing tags).
  'truncated-model.3mf': modelOnly(model(cubeObject()).slice(0, 400)),

  // Only previews and an empty model.
  'previews-only.3mf': modelOnly(model('')),

  // A project config with nothing the parser can use.
  'no-print-data.3mf': [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['Metadata/project_settings.config', '<config><option key="layer_height" value="0.2"/></config>'],
  ],
};

for (const [name, entries] of Object.entries(fixtures)) {
  writeFileSync(join(here, name), zip(entries));
}

// Not a zip at all, and a real zip cut in half (central directory lost).
writeFileSync(join(here, 'not-a-zip.3mf'), 'this is not a zip file\n');
const whole = zip(fixtures['sliced-multiplate.3mf']);
writeFileSync(join(here, 'truncated-zip.3mf'), whole.subarray(0, Math.floor(whole.length / 2)));

console.log(`wrote ${Object.keys(fixtures).length + 2} fixtures to ${here}`);
