# Site perso (React + Vite + Node API)

## Scripts

- `npm run dev`: frontend Vite (proxy API vers `http://localhost:3001`)
- `npm run dev:server`: backend Node (watch mode)
- `npm run build`: build frontend dans `dist`
- `npm run start`: serveur Node production (API + fichiers statiques `dist`)

## API disponible

- `GET /api/reviews`
- `POST /api/reviews`

Corps attendu pour `POST`:

```json
{
  "name": "Dupont",
  "role": "Jean",
  "rating": 5,
  "text": "Super site"
}
```

## Variables d'environnement

- `PORT`: port HTTP du backend (Render le fournit automatiquement)
- `REVIEWS_DB_PATH`: chemin du fichier SQLite (ex: `/var/data/reviews.sqlite`)
- `VITE_API_BASE_URL`: optionnel, utile si le frontend et l'API sont sur 2 domaines différents
- `API_PROXY_TARGET`: optionnel en dev Vite (par défaut `http://localhost:3001`)
- `CORS_ORIGIN`: optionnel, à définir uniquement si API sur domaine différent

## Déploiement Render

Le fichier `render.yaml` est prêt pour un service Web Node.js.

1. Push le repo sur GitHub.
2. Sur Render: `New +` -> `Blueprint`.
3. Sélectionne ce repo, Render lira `render.yaml`.
4. Le backend servira le frontend buildé et l'API sur le même domaine.
