# Site perso (React + Vite + Node API)

## Scripts

- `npm run dev`: frontend Vite (proxy API vers `http://localhost:3001`)
- `npm run dev:server`: backend Node (watch mode)
- `npm run build`: build frontend dans `dist`
- `npm run start`: serveur Node production (API + fichiers statiques `dist`)

## API disponible

- `GET /api/reviews`
- `POST /api/reviews`
- `PATCH /api/reviews/:id` (admin)
- `DELETE /api/reviews/:id` (admin)
- `POST /api/contact` (envoi email)

Corps attendu pour `POST`:

```json
{
  "name": "Dupont",
  "role": "Jean",
  "rating": 5,
  "text": "Super site"
}
```

Pour `PATCH /api/reviews/:id` (admin), envoie un JSON partiel ou complet:

```json
{
  "rating": 4,
  "text": "Avis mis à jour"
}
```

Authentification admin (`PATCH`/`DELETE`): header `X-Admin-Token: <token>`  
ou `Authorization: Bearer <token>`.

Corps attendu pour `POST /api/contact`:

```json
{
  "name": "Dupont",
  "email": "jean.dupont@email.com",
  "projectType": "site-vitrine",
  "budget": "3000-7000",
  "message": "Je veux un nouveau site."
}
```

## Variables d'environnement

- `PORT`: port HTTP du backend (Render le fournit automatiquement)
- `REVIEWS_DB_PATH`: chemin du fichier SQLite (ex: `/var/data/reviews.sqlite`)
- `VITE_API_BASE_URL`: optionnel, utile si le frontend et l'API sont sur 2 domaines différents
- `API_PROXY_TARGET`: optionnel en dev Vite (par défaut `http://localhost:3001`)
- `CORS_ORIGIN`: liste d'origines autorisées pour l'API (ex: `https://site.fr,https://www.site.fr`). Par défaut: aucun CORS cross-origin.
- `ADMIN_API_TOKEN`: token admin requis pour `PATCH /api/reviews/:id` et `DELETE /api/reviews/:id`
- `MAX_BODY_SIZE`: taille max du body JSON en octets (défaut `100000`)
- `REQUEST_TIMEOUT_MS`: timeout requête HTTP en ms (défaut `10000`)
- `RATE_LIMIT_WINDOW_MS`: fenêtre de rate-limit pour `POST /api/reviews` en ms (défaut `600000`)
- `RATE_LIMIT_MAX_POSTS`: nombre max de `POST /api/reviews` par IP et par fenêtre (défaut `20`)
- `CONTACT_TO_EMAIL`: email de destination (défaut `mathis.lallemmand2@gmail.com`)
- `CONTACT_FROM_EMAIL`: email expéditeur SMTP
- `SMTP_HOST`: serveur SMTP (ex: `smtp.gmail.com`)
- `SMTP_PORT`: port SMTP (ex: `465`)
- `SMTP_SECURE`: `true`/`false` (souvent `true` pour 465)
- `CONTACT_SMTP_TIMEOUT_MS`: timeout SMTP en ms (plafonné automatiquement pour rester sous le timeout global API)
- `CONTACT_HANDLER_TIMEOUT_MS`: timeout dur du traitement `/api/contact` pour éviter les réponses bloquées
- `SMTP_FALLBACK_ENABLED`: active une tentative fallback SMTP automatique (défaut `true`)
- `SMTP_FALLBACK_PORT`: port fallback SMTP (défaut `587` si port principal `465`)
- `SMTP_FALLBACK_SECURE`: mode TLS fallback (`false` pour `587`)
- `SMTP_USER`: utilisateur SMTP
- `SMTP_PASS`: mot de passe SMTP (pour Gmail: mot de passe d'application)

## Déploiement Render

Le fichier `render.yaml` est prêt pour un service Web Node.js.

1. Push le repo sur GitHub.
2. Sur Render: `New +` -> `Blueprint`.
3. Sélectionne ce repo, Render lira `render.yaml`.
4. Le backend servira le frontend buildé et l'API sur le même domaine.
