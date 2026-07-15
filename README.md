# Finwise — Simulateur de portefeuille pédagogique

Application web complète : portefeuille virtuel sur cours réels, workflow budget façon Finary, plan de versements DCA, alertes de concentration, actualités filtrées et agent IA.

## Démarrage rapide

```bash
npm install
cp .env.example .env     # puis renseignez vos clés (facultatif)
npm start                # → http://localhost:3000
```

Sans aucune clé, l'app tourne intégralement en **mode démo** (marché simulé, news simulées, agent en mode règles) — pratique pour la soutenance sans dépendre du réseau.

## Clés d'API (facultatives mais recommandées)

| Variable | Rôle | Où l'obtenir |
|---|---|---|
| `FINNHUB_API_KEY` | Cours temps réel + actualités financières réelles | https://finnhub.io (gratuit) |
| `ANTHROPIC_API_KEY` | Agent IA conversationnel (Claude) | https://console.anthropic.com |
| `JWT_SECRET` | Signature des sessions (obligatoire en prod) | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

## Architecture

```
server/
  index.js            Express + Helmet (CSP), routage, gestion d'erreurs centrale
  db.js               SQLite (better-sqlite3) : users, budgets, plans, deposits,
                      holdings, transactions — ordres exécutés en transaction atomique
  middleware/auth.js  JWT en cookie httpOnly (SameSite=Strict)
  routes/             auth (register/login/onboarding), budget (profil, dépôts,
                      plan DCA), portfolio (ordres), market (quotes/search), misc
                      (news + agent)
  services/
    market.js         Finnhub avec cache 15 s (ou marché simulé déterministe)
    news.js           Finnhub company-news filtrées sur les positions détenues
    agent.js          Analyse déterministe (concentration, risque en €) +
                      Claude avec garde-fous, fallback règles
public/
  index.html, css/app.css, js/api.js, js/app.js (SPA vanilla, CSP-safe)
```

## Base de données & comptes

Toutes les données vivent dans une base **SQL (SQLite via better-sqlite3)** : fichier `data/finwise.db`, tables `users`, `budgets`, `plans`, `deposits`, `holdings`, `transactions` avec clés étrangères et suppression en cascade. Pour l'inspecter :

```bash
sqlite3 data/finwise.db ".tables"
sqlite3 data/finwise.db "SELECT id,email,role,cash FROM users;"
```

SQLite est une vraie base relationnelle embarquée (celle de WhatsApp, Firefox, iOS…) — idéale pour ce projet : zéro serveur à installer, transactions ACID. Migrer vers PostgreSQL/MySQL ne demanderait que de réécrire `server/db.js`, le reste du code ne parle qu'à cette couche.

**Gestion des comptes** :
- Chaque utilisateur : page « Mon compte » (modifier profil, changer le mot de passe avec vérification de l'ancien, supprimer son compte — cascade sur toutes ses données).
- **Admin** : le premier compte créé est administrateur (ou l'e-mail désigné par `ADMIN_EMAIL`). Il voit l'onglet « Admin » : liste des utilisateurs avec statistiques (liquidités, total versé, positions, ordres) et suppression de comptes.

## Points clés (retours prof intégrés)

- **Workflow budget façon Finary** : diagramme de Sankey Salaire → Budget → (Investissements, Logement, Vie quotidienne, Abonnements, Reste à vivre), mis à jour en direct quand on bouge le curseur.
- **Pourcentage investi choisi par l'utilisateur** : curseur 0–40 %. Au-delà de **10 %** des revenus, avertissement + **confirmation explicite obligatoire** (case à cocher) — côté serveur (HTTP 422 `CONFIRMATION_REQUIRED`), pas seulement côté client.
- **Versements** : plan mensuel DCA *ou* versement unique, **et** possibilité d'ajouter de l'argent en cours de route ; même règle des 10 % appliquée aux dépôts ponctuels.
- **Temps réel** : cours pollés toutes les 15 s et patchés dans le DOM (pas de rechargement de page).
- **Sécurité** : mots de passe bcrypt (coût 12), JWT httpOnly, Helmet + CSP stricte, rate-limiting sur l'auth et le chat, validation systématique des entrées, prix d'exécution toujours côté serveur, aucune stack trace exposée.
- **Corrections de bugs** : la page Budget ne « saute » plus (mises à jour en place, plus de re-render complet) ; la barre de recherche fonctionne (debounce 250 ms sur l'API de recherche).
- **Garde-fous IA** : l'agent est ancré sur une analyse calculée côté serveur (il n'invente aucun chiffre), limité au pédagogique, avec disclaimer permanent dans l'interface.
