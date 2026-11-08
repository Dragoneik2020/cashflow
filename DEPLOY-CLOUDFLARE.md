# Despliegue con dominio en Cloudflare

## 1. DNS en Cloudflare
1. Entra a tu zona en Cloudflare → **DNS** → **Records**.
2. Crea un registro **A**:
   - Name: `app` (o `@` para raíz)
   - IPv4 address: IP de tu VPS
   - Proxy status: **Proxied (nube naranja)** recomendado (SSL + DDoS + CDN). Si usas Caddy con certificado propio, puedes usar **DNS only**.
3. Guarda. La propagación suele ser instantánea.

## 2. Google OAuth: añadir el dominio
1. Google Cloud Console → Credenciales → tu cliente OAuth.
2. **Orígenes autorizados de JavaScript**: añade `https://app.tudominio.com`
3. **URI de redirección autorizados**: añade `https://app.tudominio.com/auth/google/callback`
4. Guarda.

## 3. Variables de entorno en el VPS
En `.env` del proyecto:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=https://app.tudominio.com/auth/google/callback
SESSION_SECRET=una-cadena-larga-y-aleatoria
PORT=3000
APP_URL=https://app.tudominio.com
```

## 4. Reverse proxy con Caddy (SSL automático)
Caddy obtiene y renueva certificados Let's Encrypt automáticamente. Si usas Cloudflare en modo **DNS only (gris)**, Caddy gestiona el SSL. Si usas **Proxied (naranja)**, puedes usar el certificado de origen de Cloudflare o dejar que Caddy gestione con DNS-01 challenge.

### Opción A: Cloudflare DNS only (recomendado, más simple)
Crea `Caddyfile` en la raíz del proyecto:
```
app.tudominio.com {
    reverse_proxy cashflow:3000
}
```
Y actualiza `docker-compose.yml`:
```yaml
version: "3.9"
services:
  cashflow:
    build: .
    expose:
      - "3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```
Luego:
```bash
docker compose up -d --build
```
Caddy obtendrá el certificado automáticamente.

### Opción B: Cloudflare Proxied (nube naranja)
Cloudflare termina el SSL. El tráfico entre Cloudflare y tu VPS puede ir por HTTP (Flexible) o HTTPS con certificado de origen.

Recomendado: **Full (strict)** con certificado de origen de Cloudflare:
1. Cloudflare → SSL/TLS → Origin Server → **Create Certificate** (15 años). Descarga el cert y la key.
2. En el VPS, guárdalos como `origin.pem` y `origin.key` en `./certs/`.
3. Caddyfile:
```
app.tudominio.com {
    tls /certs/origin.pem /certs/origin.key
    reverse_proxy cashflow:3000
}
```
4. Cloudflare SSL/TLS → modo **Full (strict)**.

## 5. Firewall del VPS
Abre solo los puertos necesarios:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```
No expongas el puerto 3000 públicamente.

## 6. Verificar
- `https://app.tudominio.com` debe cargar la app.
- Inicia sesión con Google: el redirect debe funcionar.
- La hoja de cálculo se crea en tu Drive.

## 7. Auto-deploy (GitHub Actions)
Ya configurado en `.github/workflows/deploy.yml`. Añade los secretos del VPS y haz push a `main`.

## Notas
- Cloudflare cachea assets estáticos; las rutas dinámicas no se cachean por defecto si no configuras Page Rules.
- Si usas Cloudflare Proxied, el auto-refresh HTMX (polling cada 20s) funciona igual.
- Para WebSockets o SSE (si los añades), Cloudflare los soporta en planes gratuitos con límites.
