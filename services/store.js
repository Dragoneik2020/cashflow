// services/store.js
// Almacenamiento simple en archivo JSON (sin dependencias nativas).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ tenants: [], users: [] }, null, 2));
  }
}

function read() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { tenants: [], users: [] };
  }
}

function write(data) {
  ensure();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function genId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const store = {
  // Tenants
  findTenantById(id) {
    return read().tenants.find(t => t.id === id) || null;
  },
  findTenantBySlug(slug) {
    return read().tenants.find(t => t.slug === slug) || null;
  },
  getAllTenants() {
    return read().tenants;
  },
  getAllUsers() {
    return read().users;
  },
  deleteTenant(id) {
    const db = read();
    const idx = db.tenants.findIndex(t => t.id === id);
    if (idx === -1) return false;
    db.tenants.splice(idx, 1);
    // eliminar usuarios del tenant
    db.users = db.users.filter(u => u.tenantId !== id);
    write(db);
    return true;
  },
  createTenant(data) {
    const db = read();
    const tenant = {
      id: genId(),
      name: data.name,
      slug: data.slug || genId(),
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      rut: data.rut || null,
      spreadsheetId: data.spreadsheetId || null,
      spreadsheetUrl: data.spreadsheetUrl || null,
      refreshToken: data.refreshToken || null,
      createdAt: new Date().toISOString(),
    };
    db.tenants.push(tenant);
    write(db);
    return tenant;
  },
  updateTenant(id, patch) {
    const db = read();
    const t = db.tenants.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch);
    write(db);
    return t;
  },

  // Users
  findUserByGoogleId(googleId) {
    return read().users.find(u => u.googleId === googleId) || null;
  },
  findUserByEmail(email) {
    if (!email) return null;
    return read().users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()) || null;
  },
  findUserByInviteToken(token) {
    if (!token) return null;
    return read().users.find(u => u.inviteToken === token) || null;
  },
  findUserById(id) {
    return read().users.find(u => u.id === id) || null;
  },
  createUser(data) {
    const db = read();
    const user = {
      id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      googleId: data.googleId,
      email: data.email,
      name: data.name,
      avatar: data.avatar || null,
      tenantId: data.tenantId,
      role: data.role || 'admin',
      refreshToken: data.refreshToken || null,
      inviteToken: data.inviteToken || null,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    write(db);
    return user;
  },
  updateUser(id, patch) {
    const db = read();
    const u = db.users.find(x => x.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    write(db);
    return u;
  },
  deleteUser(id) {
    const db = read();
    const idx = db.users.findIndex(x => x.id === id);
    if (idx === -1) return false;
    db.users.splice(idx, 1);
    write(db);
    return true;
  },
};

module.exports = store;
