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
  next();
}

// Helpers para vistas
app.locals.money = (n) => {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
};

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

app.delete('/proveedores/:row', requireAuth, async (req, res) => {
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

app.delete('/pedidos/:row', requireAuth, async (req, res) => {
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

app.delete('/ingresos/:row', requireAuth, async (req, res) => {
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

app.delete('/egresos/:row', requireAuth, async (req, res) => {
  await sheets.deleteRow(req.user.refreshToken, req.tenant.spreadsheetId, 'egreso', req.params.row);
  res.redirect('/egresos');
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

// Settings
app.get('/settings', requireAuth, (req, res) => {
  res.render('settings', { title: 'Configuración', tenant: req.tenant, user: req.user });
});

app.listen(PORT, () => {
  console.log(`CashFlow app corriendo en http://localhost:${PORT}`);
});
