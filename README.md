# CashFlow App

Gestión de flujo de caja, proveedores, pedidos, ingresos y egresos, respaldados en Google Sheets (multi-tenant).

## Requisitos

- Node.js 18+
- Cuenta de Google Cloud con OAuth 2.0 y APIs de Sheets/Drive habilitadas

## Configuración de Google Cloud

1. Crea un proyecto en https://console.cloud.google.com
2. Habilita las APIs: Google Sheets API y Google Drive API
3. Crea credenciales OAuth 2.0 (tipo Aplicación web)
4. Agrega URI de redirección: `http://localhost:3000/auth/google/callback` (y la de producción)
5. Copia Client ID y Client Secret a `.env`

## Instalación local

```bash
cp .env.example .env
# edita .env con tus credenciales
npm install
npm start
```

Abre http://localhost:3000

## Docker (VPS)

```bash
cp .env.example .env
# edita .env (GOOGLE_CALLBACK_URL con tu dominio)
docker compose up -d --build
```

## Notas

- Cada usuario que inicia sesión crea su propio "tenant" y una hoja de cálculo en su Google Drive.
- Los datos se guardan en Google Sheets; la app solo guarda config de usuarios/tenants en `data/db.json`.
- Haz backup de `data/db.json` y de las hojas de cálculo.
