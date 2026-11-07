// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const methodOverride = require('method-override');
const path = require('path');

const store = require('./services/store');
const sheets = require('./services/sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// Passport
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
  accessType: 'offline',
  prompt: 'consent',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : '';
    const name = profile.displayName || email;
    const avatar = profile.photos && profile.photos[0] ? profile.photos[0].value : null;
    let user = store.findUserByGoogleId(profile.id);
    if (!user && email) {
      // vincular con usuario pendiente creado por el admin (por email)
      user = store.findUserByEmail(email);
      if (user) {
        store.updateUser(user.id, { googleId: profile.id, name, avatar, refreshToken: refreshToken || user.refreshToken });
        user = store.findUserById(user.id);
      }
    }
    if (!user) {
      // crear tenant + usuario admin
      const tenant = store.createTenant({ name: name || email, slug: email.split('@')[0] });
      user = store.createUser({
        googleId: profile.id,
        email,
        name,
        avatar,
        tenantId: tenant.id,
        role: 'admin',
        refreshToken: refreshToken || null,
      });
    } else {
      if (refreshToken) store.updateUser(user.id, { refreshToken });
      else store.updateUser(user.id, { name, avatar });
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, store.findUserById(id)));

app.use(passport.initialize());
app.use(passport.session());

// Middleware: usuario + tenant + hoja
async function requireAuth(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');
  const user = store.findUserById(req.user.id || req.user);
  if (!user) return res.redirect('/login');
  req.user = user;
  req.tenant = store.findTenantById(user.tenantId);
  // auto-crear hoja si falta
  if (req.tenant && !req.tenant.spreadsheetId) {
    try {
      const { spreadsheetId, url } = await sheets.createSpreadsheet(user.refreshToken, `CashFlow - ${req.tenant.name}`);
      store.updateTenant(req.tenant.id, { spreadsheetId, spreadsheetUrl: url });
      req.tenant = store.findTenantById(req.tenant.id);
    } catch (e) {
      console.error('Error creando spreadsheet:', e.message);
    }
  }
  if (req.tenant && req.tenant.spreadsheetId) {
    try { await sheets.ensureSheets(user.refreshToken, req.tenant.spreadsheetId); } catch (e) { console.error('ensureSheets:', e.message); }
  }
  next();
}

// Helpers para vistas
app.locals.money = (n) => {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
};

// Roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).send('Sin permisos para esta acción.');
    }
    next();
  };
}

// Routes
app.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req, res) => res.render('login', { title: 'Iniciar sesión' }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'], accessType: 'offline', prompt: 'consent' }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/dashboard'));

app.get('/logout', (req, res, next) => req.logout(err => { if (err) return next(err); res.redirect('/login'); }));

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const ingresos = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'ingreso');
    const egresos = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso');
    const pedidos = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido');
    const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');

    const totalIngresos = ingresos.reduce((s, i) => s + (parseFloat(i.Monto) || 0), 0);
    const totalEgresos = egresos.reduce((s, e) => s + (parseFloat(e.Monto) || 0), 0);
    const saldo = totalIngresos - totalEgresos;
    const pedidosPendientes = pedidos.filter(p => (p.Estado || '').toLowerCase() !== 'completado').length;

    // serie mensual
    const months = {};
    ingresos.forEach(i => {
      const m = (i.Fecha || '').slice(0, 7);
      if (!m) return;
      months[m] = months[m] || { ingresos: 0, egresos: 0 };
      months[m].ingresos += parseFloat(i.Monto) || 0;
    });
    egresos.forEach(e => {
      const m = (e.Fecha || '').slice(0, 7);
      if (!m) return;
      months[m] = months[m] || { ingresos: 0, egresos: 0 };
      months[m].egresos += parseFloat(e.Monto) || 0;
    });
    const series = Object.keys(months).sort().map(m => ({ mes: m, ...months[m] }));

    res.render('dashboard', {
      title: 'Dashboard',
      tenant: req.tenant,
      user: req.user,
      totalIngresos, totalEgresos, saldo, pedidosPendientes,
      numProveedores: proveedores.length,
      series: JSON.stringify(series),
      ultimosIngresos: ingresos.slice(-5).reverse(),
      ultimosEgresos: egresos.slice(-5).reverse(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error cargando dashboard: ' + e.message);
  }
});

// Proveedores
app.get('/proveedores', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  res.render('proveedores/index', { title: 'Proveedores', tenant: req.tenant, user: req.user, proveedores: list.map(sheets.rowToProveedor) });
});

app.get('/proveedores/nuevo', requireAuth, (req, res) => {
  res.render('proveedores/form', { title: 'Nuevo proveedor', tenant: req.tenant, user: req.user, proveedor: null, action: '/proveedores' });
});

app.post('/proveedores', requireAuth, async (req, res) => {
  const p = {
    id: sheets.uuidv4(),
    nombre: req.body.nombre,
    contacto: req.body.contacto,
    telefono: req.body.telefono,
    email: req.body.email,
    direccion: req.body.direccion,
    notas: req.body.notas,
    creado: new Date().toISOString().slice(0, 10),
  };
  await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor', sheets.proveedorToRow(p));
  res.redirect('/proveedores');
});

app.get('/proveedores/:row/edit', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  const proveedor = list.map(sheets.rowToProveedor).find(p => String(p._row) === String(req.params.row));
  res.render('proveedores/form', { title: 'Editar proveedor', tenant: req.tenant, user: req.user, proveedor, action: `/proveedores/${req.params.row}` });
});

app.put('/proveedores/:row', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  const existing = list.map(sheets.rowToProveedor).find(p => String(p._row) === String(req.params.row));
  const p = {
    id: existing.id,
    nombre: req.body.nombre,
    contacto: req.body.contacto,
    telefono: req.body.telefono,
    email: req.body.email,
    direccion: req.body.direccion,
    notas: req.body.notas,
    creado: existing.creado,
  };
  await sheets.updateRow(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor', req.params.row, sheets.proveedorToRow(p));
  res.redirect('/proveedores');
});

app.delete('/proveedores/:row', requireAuth, requireRole('admin'), async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor', req.params.row);
  res.redirect('/proveedores');
});

// Pedidos
app.get('/pedidos', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido');
  const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  res.render('pedidos/index', { title: 'Pedidos', tenant: req.tenant, user: req.user, pedidos: list.map(sheets.rowToPedido), proveedores: proveedores.map(sheets.rowToProveedor) });
});

app.get('/pedidos/nuevo', requireAuth, async (req, res) => {
  const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  res.render('pedidos/form', { title: 'Nuevo pedido', tenant: req.tenant, user: req.user, pedido: null, proveedores: proveedores.map(sheets.rowToProveedor), action: '/pedidos' });
});

app.post('/pedidos', requireAuth, async (req, res) => {
  const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  const prov = proveedores.map(sheets.rowToProveedor).find(p => p.id === req.body.proveedorId);
  const cantidad = parseFloat(req.body.cantidad) || 0;
  const precio = parseFloat(req.body.precioUnit) || 0;
  const p = {
    id: sheets.uuidv4(),
    fecha: req.body.fecha || new Date().toISOString().slice(0, 10),
    proveedorId: req.body.proveedorId,
    proveedor: prov ? prov.nombre : req.body.proveedor,
    descripcion: req.body.descripcion,
    cantidad,
    precioUnit: precio,
    total: cantidad * precio,
    estado: req.body.estado || 'Pendiente',
    notas: req.body.notas,
  };
  await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido', sheets.pedidoToRow(p));
  res.redirect('/pedidos');
});

app.post('/pedidos/:row/estado', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido');
  const existing = list.map(sheets.rowToPedido).find(p => String(p._row) === String(req.params.row));
  if (existing) {
    existing.estado = req.body.estado;
    await sheets.updateRow(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido', req.params.row, sheets.pedidoToRow(existing));
  }
  res.redirect('/pedidos');
});

app.delete('/pedidos/:row', requireAuth, requireRole('admin'), async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'pedido', req.params.row);
  res.redirect('/pedidos');
});

// Ingresos
app.get('/ingresos', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'ingreso');
  res.render('ingresos/index', { title: 'Ingresos', tenant: req.tenant, user: req.user, ingresos: list.map(sheets.rowToIngreso) });
});

app.get('/ingresos/nuevo', requireAuth, (req, res) => {
  res.render('ingresos/form', { title: 'Nuevo ingreso', tenant: req.tenant, user: req.user, ingreso: null, action: '/ingresos' });
});

app.post('/ingresos', requireAuth, async (req, res) => {
  const i = {
    id: sheets.uuidv4(),
    fecha: req.body.fecha || new Date().toISOString().slice(0, 10),
    concepto: req.body.concepto,
    categoria: req.body.categoria,
    monto: parseFloat(req.body.monto) || 0,
    fuente: req.body.fuente,
    notas: req.body.notas,
  };
  await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'ingreso', sheets.ingresoToRow(i));
  res.redirect('/ingresos');
});

app.delete('/ingresos/:row', requireAuth, requireRole('admin'), async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'ingreso', req.params.row);
  res.redirect('/ingresos');
});

// Egresos
app.get('/egresos', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso');
  const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  res.render('egresos/index', { title: 'Egresos', tenant: req.tenant, user: req.user, egresos: list.map(sheets.rowToEgreso), proveedores: proveedores.map(sheets.rowToProveedor) });
});

app.get('/egresos/nuevo', requireAuth, async (req, res) => {
  const proveedores = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'proveedor');
  res.render('egresos/form', { title: 'Nuevo egreso', tenant: req.tenant, user: req.user, egreso: null, proveedores: proveedores.map(sheets.rowToProveedor), action: '/egresos' });
});

app.post('/egresos', requireAuth, async (req, res) => {
  const e = {
    id: sheets.uuidv4(),
    fecha: req.body.fecha || new Date().toISOString().slice(0, 10),
    concepto: req.body.concepto,
    categoria: req.body.categoria,
    monto: parseFloat(req.body.monto) || 0,
    proveedor: req.body.proveedor,
    notas: req.body.notas,
  };
  await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso', sheets.egresoToRow(e));
  res.redirect('/egresos');
});

app.delete('/egresos/:row', requireAuth, requireRole('admin'), async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso', req.params.row);
  res.redirect('/egresos');
});

// Inventario
app.get('/inventario', requireAuth, async (req, res) => {
  await sheets.ensureSheets(req.user.refreshToken, req.tenant.spreadsheetId);
  const items = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario');
  const movs = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'movimiento');
  res.render('inventario/index', { title: 'Inventario', tenant: req.tenant, user: req.user, items: items.map(sheets.rowToInventario), movimientos: movs.map(sheets.rowToMovimiento).reverse().slice(0, 20) });
});

app.get('/inventario/nuevo', requireAuth, (req, res) => {
  res.render('inventario/form', { title: 'Nuevo producto', tenant: req.tenant, user: req.user, item: null, action: '/inventario' });
});

app.post('/inventario', requireAuth, async (req, res) => {
  const i = {
    id: sheets.uuidv4(),
    producto: req.body.producto,
    categoria: req.body.categoria,
    cantidad: parseFloat(req.body.cantidad) || 0,
    unidad: req.body.unidad,
    precioCosto: parseFloat(req.body.precioCosto) || 0,
    precioVenta: parseFloat(req.body.precioVenta) || 0,
    proveedor: req.body.proveedor,
    stockMinimo: parseFloat(req.body.stockMinimo) || 0,
    notas: req.body.notas,
    actualizado: new Date().toISOString().slice(0, 10),
  };
  await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario', sheets.inventarioToRow(i));
  res.redirect('/inventario');
});

app.get('/inventario/:row/edit', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario');
  const item = list.map(sheets.rowToInventario).find(x => String(x._row) === String(req.params.row));
  res.render('inventario/form', { title: 'Editar producto', tenant: req.tenant, user: req.user, item, action: `/inventario/${req.params.row}` });
});

app.post('/inventario/:row/edit', requireAuth, async (req, res) => {
  // method-override not used here; handle update via hidden _method? We'll accept POST with ?_method=PUT too.
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario');
  const existing = list.map(sheets.rowToInventario).find(x => String(x._row) === String(req.params.row));
  if (existing) {
    const i = {
      id: existing.id,
      producto: req.body.producto,
      categoria: req.body.categoria,
      cantidad: parseFloat(req.body.cantidad) || 0,
      unidad: req.body.unidad,
      precioCosto: parseFloat(req.body.precioCosto) || 0,
      precioVenta: parseFloat(req.body.precioVenta) || 0,
      proveedor: req.body.proveedor,
      stockMinimo: parseFloat(req.body.stockMinimo) || 0,
      notas: req.body.notas,
      actualizado: new Date().toISOString().slice(0, 10),
    };
    await sheets.updateRow(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario', req.params.row, sheets.inventarioToRow(i));
  }
  res.redirect('/inventario');
});

app.post('/inventario/:row/movimiento', requireAuth, async (req, res) => {
  const list = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario');
  const item = list.map(sheets.rowToInventario).find(x => String(x._row) === String(req.params.row));
  if (item) {
    const cantidad = parseFloat(req.body.cantidad) || 0;
    const tipo = req.body.tipo; // Entrada | Salida
    const nuevoStock = tipo === 'Salida' ? (parseFloat(item.cantidad) || 0) - cantidad : (parseFloat(item.cantidad) || 0) + cantidad;
    // registrar movimiento
    const m = {
      id: sheets.uuidv4(),
      fecha: new Date().toISOString().slice(0, 10),
      productoId: item.id,
      producto: item.producto,
      tipo,
      cantidad,
      motivo: req.body.motivo,
      notas: req.body.notas,
    };
    await sheets.appendRow(req.user.refreshToken, req.tenant.spreadsheetId, 'movimiento', sheets.movimientoToRow(m));
    // actualizar stock
    item.cantidad = nuevoStock;
    item.actualizado = new Date().toISOString().slice(0, 10);
    await sheets.updateRow(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario', req.params.row, sheets.inventarioToRow(item));
  }
  res.redirect('/inventario');
});

app.delete('/inventario/:row', requireAuth, requireRole('admin'), async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'inventario', req.params.row);
  res.redirect('/inventario');
});

// Flujo de caja
app.get('/flujo', requireAuth, async (req, res) => {
  const ingresos = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'ingreso');
  const egresos = await sheets.getAll(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso');
  const movs = [];
  ingresos.map(sheets.rowToIngreso).forEach(i => movs.push({ fecha: i.fecha, tipo: 'Ingreso', concepto: i.concepto, monto: parseFloat(i.monto) || 0 }));
  egresos.map(sheets.rowToEgreso).forEach(e => movs.push({ fecha: e.fecha, tipo: 'Egreso', concepto: e.concepto, monto: -(parseFloat(e.monto) || 0) }));
  movs.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  let saldo = 0;
  movs.forEach(m => { saldo += m.monto; m.saldo = saldo; });
  res.render('flujo', { title: 'Flujo de caja', tenant: req.tenant, user: req.user, movs });
});

// Exportación CSV
function toCSV(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  rows.forEach(r => lines.push(r.map(esc).join(',')));
  return lines.join('\\n');
}

app.get('/export/:entity', requireAuth, async (req, res) => {
  const entity = req.params.entity;
  const rt = req.user.refreshToken;
  const sid = req.tenant.spreadsheetId;
  let headers = [], rows = [], filename = entity + '.csv';
  try {
    if (entity === 'proveedores') {
      const list = (await sheets.getAll(rt, sid, 'proveedor')).map(sheets.rowToProveedor);
      headers = ['ID','Nombre','Contacto','Teléfono','Email','Dirección','Notas','Creado'];
      rows = list.map(p => [p.id,p.nombre,p.contacto,p.telefono,p.email,p.direccion,p.notas,p.creado]);
    } else if (entity === 'pedidos') {
      const list = (await sheets.getAll(rt, sid, 'pedido')).map(sheets.rowToPedido);
      headers = ['ID','Fecha','Proveedor','Descripción','Cantidad','PrecioUnit','Total','Estado','Notas'];
      rows = list.map(p => [p.id,p.fecha,p.proveedor,p.descripcion,p.cantidad,p.precioUnit,p.total,p.estado,p.notas]);
    } else if (entity === 'ingresos') {
      const list = (await sheets.getAll(rt, sid, 'ingreso')).map(sheets.rowToIngreso);
      headers = ['ID','Fecha','Concepto','Categoría','Monto','Fuente','Notas'];
      rows = list.map(i => [i.id,i.fecha,i.concepto,i.categoria,i.monto,i.fuente,i.notas]);
    } else if (entity === 'egresos') {
      const list = (await sheets.getAll(rt, sid, 'egreso')).map(sheets.rowToEgreso);
      headers = ['ID','Fecha','Concepto','Categoría','Monto','Proveedor','Notas'];
      rows = list.map(e => [e.id,e.fecha,e.concepto,e.categoria,e.monto,e.proveedor,e.notas]);
    } else if (entity === 'inventario') {
      const list = (await sheets.getAll(rt, sid, 'inventario')).map(sheets.rowToInventario);
      headers = ['ID','Producto','Categoría','Cantidad','Unidad','PrecioCosto','PrecioVenta','Proveedor','StockMinimo','Notas','Actualizado'];
      rows = list.map(i => [i.id,i.producto,i.categoria,i.cantidad,i.unidad,i.precioCosto,i.precioVenta,i.proveedor,i.stockMinimo,i.notas,i.actualizado]);
    } else if (entity === 'flujo') {
      const ingresos = (await sheets.getAll(rt, sid, 'ingreso')).map(sheets.rowToIngreso);
      const egresos = (await sheets.getAll(rt, sid, 'egreso')).map(sheets.rowToEgreso);
      const movs = [];
      ingresos.forEach(i => movs.push([i.fecha,'Ingreso',i.concepto, i.monto]));
      egresos.forEach(e => movs.push([e.fecha,'Egreso',e.concepto, -(parseFloat(e.monto)||0)]));
      movs.sort((a,b) => (a[0]||'').localeCompare(b[0]||''));
      let saldo = 0;
      const withSaldo = movs.map(m => { saldo += parseFloat(m[3])||0; return [...m, saldo]; });
      headers = ['Fecha','Tipo','Concepto','Monto','Saldo'];
      rows = withSaldo;
    } else {
      return res.status(404).send('Entidad no soportada');
    }
    const csv = toCSV(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\\ufeff' + csv);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error exportando: ' + e.message);
  }
});

// Usuarios (solo admin)
app.get('/usuarios', requireAuth, requireRole('admin'), async (req, res) => {
  const data = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'db.json'), 'utf8'));
  const users = data.users.filter(u => u.tenantId === req.tenant.id);
  res.render('usuarios/index', { title: 'Usuarios', tenant: req.tenant, user: req.user, usuarios: users });
});

app.post('/usuarios', requireAuth, requireRole('admin'), (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.redirect('/usuarios');
  const storeMod = require('./services/store');
  const existing = storeMod.findUserByEmail(email);
  if (existing) {
    if (existing.tenantId !== req.tenant.id) return res.status(400).send('El usuario ya pertenece a otro negocio.');
    storeMod.updateUser(existing.id, { role: req.body.role || existing.role, name: req.body.name || existing.name });
  } else {
    storeMod.createUser({
      googleId: null,
      email,
      name: req.body.name || email.split('@')[0],
      tenantId: req.tenant.id,
      role: req.body.role || 'operador',
      refreshToken: null,
    });
  }
  res.redirect('/usuarios');
});

app.post('/usuarios/:id/editar', requireAuth, requireRole('admin'), (req, res) => {
  const storeMod = require('./services/store');
  storeMod.updateUser(req.params.id, {
    name: req.body.name,
    email: req.body.email,
    role: req.body.role,
  });
  res.redirect('/usuarios');
});

app.post('/usuarios/:id/rol', requireAuth, requireRole('admin'), (req, res) => {
  const storeMod = require('./services/store');
  storeMod.updateUser(req.params.id, { role: req.body.role });
  res.redirect('/usuarios');
});

app.post('/usuarios/:id/eliminar', requireAuth, requireRole('admin'), (req, res) => {
  const storeMod = require('./services/store');
  const u = storeMod.findUserById(req.params.id);
  if (u && u.id !== req.user.id && u.tenantId === req.tenant.id) {
    storeMod.deleteUser(req.params.id);
  }
  res.redirect('/usuarios');
});

// Settings
app.get('/settings', requireAuth, (req, res) => {
  res.render('settings', { title: 'Configuración', tenant: req.tenant, user: req.user });
});

app.listen(PORT, () => {
  console.log(`CashFlow app corriendo en http://localhost:${PORT}`);
});
