# CRIATech — Virtual Try-On IA

## Deploy en 4 pasos

### Paso 1 — Crea tu API Key en Fal.ai
1. Ve a https://fal.ai → Sign Up
2. Dashboard → API Keys → Create Key
3. Guarda tu key: `fal_xxxxxxxxxxxxxxxx`
4. Ve a Billing → agrega tarjeta (cobran ~$0.05 por imagen)

### Paso 2 — Sube el proyecto a GitHub
```bash
cd criatech-stylist
git init
git add .
git commit -m "CRIATech v1.0 - Virtual Try-On"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/criatech-stylist.git
git push -u origin main
```

### Paso 3 — Deploy en Vercel
1. Ve a https://vercel.com → Sign up con GitHub
2. "Add New Project" → importa `criatech-stylist`
3. Settings → Environment Variables → Add:
   - Name: `FAL_API_KEY`
   - Value: `fal_xxxxxxxxxxxxxxxx` (tu key real)
4. Click "Deploy"

Tu app queda en: `criatech-stylist.vercel.app`

### Paso 4 — Verifica que funciona
- Abre la URL de Vercel
- Sube una foto
- Elige un vibe
- La IA debería generar el look en ~20-40 segundos

## Estructura del proyecto
```
criatech-stylist/
├── index.html       ← Frontend completo
├── vercel.json      ← Configuración Vercel
├── .gitignore
└── api/
    └── tryon.js     ← Backend (llama a Fal.ai IDM-VTON)
```

## Costos estimados
| Uso | Costo Fal.ai | Vercel |
|-----|-------------|--------|
| 100 usos/mes | ~$5 USD | $0 |
| 500 usos/mes | ~$25 USD | $0 |
| 2.000 usos/mes | ~$100 USD | $0 |

## Soporte
Para problemas con el deploy, revisa los logs en:
Vercel Dashboard → tu proyecto → Functions → tryon
