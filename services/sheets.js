// services/sheets.js
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SHEET_HEADERS = {
  Proveedores: ['ID', 'Nombre', 'Contacto', 'Teléfono', 'Email', 'Dirección', 'Notas', 'Creado'],
  Pedidos: ['ID', 'Fecha', 'ProveedorID', 'Proveedor', 'Descripción', 'Cantidad', 'PrecioUnit', 'Total', 'Estado', 'Notas'],
  Ingresos: ['ID', 'Fecha', 'Concepto', 'Categoría', 'Monto', 'Fuente', 'Notas'],
  Egresos: ['ID', 'Fecha', 'Concepto', 'Categoría', 'Monto', 'Proveedor', 'Notas'],
};

function authClient(refreshToken) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

async function createSpreadsheet(refreshToken, title) {
  const auth = authClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Crear con las hojas necesarias
  const sheetTitles = Object.keys(SHEET_HEADERS);
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetTitles.map(t => ({ properties: { title: t } })),
    },
  });
  const spreadsheetId = res.data.spreadsheetId;

  // Escribir encabezados
  const data = sheetTitles.map(t => ({
    range: `${t}!A1:${String.fromCharCode(64 + SHEET_HEADERS[t].length)}1`,
    values: [SHEET_HEADERS[t]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });

  // Formato de encabezados (negrita)
  const requests = sheetTitles.map((t, i) => ({
    repeatCell: {
      range: { sheetId: res.data.sheets[i].properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  const file = await drive.files.get({ fileId: spreadsheetId, fields: 'webViewLink' });
  return { spreadsheetId, url: file.data.webViewLink };
}

function sheetName(entity) {
  const map = { proveedor: 'Proveedores', pedido: 'Pedidos', ingreso: 'Ingresos', egreso: 'Egresos' };
  return map[entity];
}

async function getAll(refreshToken, spreadsheetId, entity) {
  const auth = authClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const name = sheetName(entity);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${name}!A2:Z` });
  const rows = res.data.values || [];
  const headers = SHEET_HEADERS[name];
  return rows.map((r, idx) => {
    const obj = { _row: idx + 2 };
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

async function appendRow(refreshToken, spreadsheetId, entity, values) {
  const auth = authClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const name = sheetName(entity);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${name}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function updateRow(refreshToken, spreadsheetId, entity, rowIndex, values) {
  const auth = authClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const name = sheetName(entity);
  const headers = SHEET_HEADERS[name];
  const lastCol = String.fromCharCode(64 + headers.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${name}!A${rowIndex}:${lastCol}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

async function deleteRow(refreshToken, spreadsheetId, entity, rowIndex) {
  const auth = authClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const name = sheetName(entity);
  // obtener sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sh = meta.data.sheets.find(s => s.properties.title === name);
  const sheetId = sh.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }],
    },
  });
}

// Helpers de mapeo
function proveedorToRow(p) {
  return [p.id, p.nombre, p.contacto || '', p.telefono || '', p.email || '', p.direccion || '', p.notas || '', p.creado || new Date().toISOString()];
}
function rowToProveedor(r) {
  return {
    id: r.ID, nombre: r.Nombre, contacto: r.Contacto, telefono: r.Teléfono,
    email: r.Email, direccion: r.Dirección, notas: r.Notas, creado: r.Creado, _row: r._row,
  };
}

function pedidoToRow(p) {
  return [p.id, p.fecha, p.proveedorId || '', p.proveedor || '', p.descripcion, p.cantidad, p.precioUnit, p.total, p.estado || 'Pendiente', p.notas || ''];
}
function rowToPedido(r) {
  return {
    id: r.ID, fecha: r.Fecha, proveedorId: r.ProveedorID, proveedor: r.Proveedor,
    descripcion: r.Descripción, cantidad: r.Cantidad, precioUnit: r.PrecioUnit,
    total: r.Total, estado: r.Estado, notas: r.Notas, _row: r._row,
  };
}

function ingresoToRow(i) {
  return [i.id, i.fecha, i.concepto, i.categoria || '', i.monto, i.fuente || '', i.notas || ''];
}
function rowToIngreso(r) {
  return { id: r.ID, fecha: r.Fecha, concepto: r.Concepto, categoria: r.Categoría, monto: r.Monto, fuente: r.Fuente, notas: r.Notas, _row: r._row };
}

function egresoToRow(e) {
  return [e.id, e.fecha, e.concepto, e.categoria || '', e.monto, e.proveedor || '', e.notas || ''];
}
function rowToEgreso(r) {
  return { id: r.ID, fecha: r.Fecha, concepto: r.Concepto, categoria: r.Categoría, monto: r.Monto, proveedor: r.Proveedor, notas: r.Notas, _row: r._row };
}

module.exports = {
  SHEET_HEADERS,
  authClient,
  createSpreadsheet,
  getAll,
  appendRow,
  updateRow,
  deleteRow,
  sheetName,
  proveedorToRow, rowToProveedor,
  pedidoToRow, rowToPedido,
  ingresoToRow, rowToIngreso,
  egresoToRow, rowToEgreso,
  uuidv4,
};
