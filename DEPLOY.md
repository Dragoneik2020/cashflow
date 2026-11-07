# Despliegue automático con GitHub Actions + SSH

## 1. Preparar el VPS (una sola vez)

```bash
# En el VPS
sudo apt update && sudo apt install -y git docker.io docker-compose-plugin
sudo usermod -aG docker $USER
# clonar app
sudo mkdir -p /opt && sudo chown $USER:$USER /opt
git clone https://github.com/TU_USUARIO/cashflow-app.git /opt/cashflow-app
cd /opt/cashflow-app
cp .env.example .env && nano .env   # credenciales reales
docker compose up -d --build
```

## 2. Crear clave SSH para GitHub Actions

En tu PC:
```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/cashflow_deploy -N ""
```
- Copia el contenido de `~/.ssh/cashflow_deploy.pub` al VPS en `~/.ssh/authorized_keys`.
- El contenido de `~/.ssh/cashflow_deploy` (privada) va como secreto en GitHub.

## 3. Configurar secretos en GitHub

En el repo → Settings → Secrets and variables → Actions → New repository secret:

| Secreto | Valor |
|---|---|
| `VPS_HOST` | IP o dominio del VPS |
| `VPS_USER` | usuario SSH del VPS |
| `VPS_SSH_KEY` | contenido de la clave privada `cashflow_deploy` |
| `VPS_PORT` | 22 (o tu puerto SSH) |
| `APP_PATH` | /opt/cashflow-app |

## 4. Probar

Haz un push a `main`:
```bash
git commit --allow-empty -m "test deploy"
git push
```
Ve a la pestaña **Actions** del repo para ver el progreso.

## Webhook alternativo (sin GitHub Actions)

Si prefieres un webhook directo en el VPS, puedes usar un servicio como `webhook` (https://github.com/adnanh/webhook) que escuche `/hooks/deploy` y ejecute `scripts/deploy.sh`. GitHub → Settings → Webhooks → Payload URL `http://TU_VPS:9000/hooks/deploy`, Content type `application/json`, evento `push`.
