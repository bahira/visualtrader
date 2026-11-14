# VisualTrader

VisualTrader simule une stratégie BTC/USDT Spot autour du graphique Binance à **1 seconde**. Le runtime utilise des flux publics et un portefeuille virtuel en USDT. Il ne contient aucun client d’ordres ni configuration de clés d’échange.

## Démarrage

Prérequis : Node.js 24.x, accès HTTPS et WSS publics à Binance. Aucun paquet à installer.

```powershell
npm.cmd start
```

Ouvrir [127.0.0.1:8787](http://127.0.0.1:8787). Le bouton **Time** affiche environ 16 heures de clôtures à la minute, avec volumes et prolongation à partir des bougies live. **Bougies 1 s** affiche les OHLCV et les moyennes 7/25/99. **Capital** montre la valeur liquidable simulée en USDT.

Le bouton **Pause entrées** suspend les nouveaux achats du portefeuille actif. Les sorties continuent. Sur un flux continu, il faut 99 bougies pour les indicateurs, puis deux fenêtres de 15 min pour la première activation possible. Le portefeuille reste en cash jusqu’à validation. Même avec un flux sain, le moteur peut rester en cash indéfiniment.

```powershell
# Démo synthétique accélérée et isolée du portefeuille live
npm.cmd run demo -- --port 8788

# Replay accéléré des prix et du carnet d’une session capturée
node app.mjs --mode replay --session 1 --speed 50 --port 8789

# Replay non interactif et mesures de débit
node app.mjs --mode replay --session 1 --batch
npm.cmd run benchmark
npm.cmd test

# Isoler un autre scénario de coûts
node app.mjs --mode live --port 8790 --db data/scenario.sqlite --fee-bps 10 --slip-bps 2 --latency-ms 400
```

`--fee-bps`, `--slip-bps` et `--latency-ms` règlent les hypothèses d’exécution. Un point de base (pb) vaut 0,01 %. Le modèle applique **10 pb de frais taker par côté**, **1 pb de slippage défavorable par côté**, le prix du carnet et **250 ms** de latence minimale par défaut. Consulter le [barème Binance](https://www.binance.com/en/fee/trading) pour les taux par compte et par paire. Une modification de configuration live nécessite un fichier de données distinct.

## Exploitation

- `GET /health` donne l’état du flux et les compteurs. `marketReady=true` exige un carnet et des clôtures frais.
- `GET /api/state` fournit les données du tableau de bord. Les horodatages API sont en Unix millisecondes. Le navigateur affiche Europe/Paris.
- Le lien d’export télécharge les 10 000 derniers événements d’audit de la session courante en NDJSON. La base conserve les données brutes et l’audit complet.
- En premier plan, arrêter avec Ctrl+C pour vider les tampons et fermer la base. Au redémarrage, le journal conserve le portefeuille actif et son historique récent. Les ordres virtuels en attente et les candidats repartent à zéro.
- Superviser l’espace disque. La capture est intégrale pour les flux souscrits. La croissance varie avec le débit des transactions. La rotation est manuelle par changement de fichier `--db`. Pour sauvegarder un fichier actif, utiliser l’API de sauvegarde SQLite ou copier la base après arrêt propre.
- Garder l’écoute sur loopback. Les commandes de pause vérifient l’origine HTTP locale.

Voir [l’architecture et le modèle](docs/ARCHITECTURE.md) pour les équations, le protocole d’optimisation et les limites du simulateur.
