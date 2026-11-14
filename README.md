# VisualTrader

VisualTrader simule une stratégie BTC/USDT Spot autour du graphique Binance à **1 seconde**. Le runtime utilise des flux publics et un portefeuille virtuel en USDT. Il ne contient aucun client d’ordres ni configuration de clés d’échange.

## Démarrage

Prérequis : Node.js 24.x pour le moteur, Python 3.10+ avec Tk pour le client, et accès HTTPS et WSS publics à Binance. Aucun paquet à installer.

Dans un terminal :

```powershell
npm.cmd start
```

Puis lancer [VisualTrader.cmd](VisualTrader.cmd), ou exécuter `python desktop.py` dans un autre terminal. Le client utilise les contrôles natifs Tk et un tracé Canvas Tk. La connexion au moteur reste locale. À la fermeture du client, le moteur continue la capture et le paper trading.

**Time** affiche jusqu’à environ 16 heures de clôtures à la minute, avec volumes et prolongation live. **1 s** affiche les bougies OHLCV. Survolez le tracé pour inspecter un point et utilisez la molette ou le menu de durée pour changer l’échelle. Les raccourcis Ctrl+1, Ctrl+2 et Ctrl+3 changent de vue. **Capital** montre le capital liquidable simulé en USDT. Les onglets donnent le carnet, les transactions, les exécutions, l’optimiseur, les statistiques et les décisions. Lancer `VisualTrader.cmd --port 8788` pour voir la démo de l’exemple ci-dessous.

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

## Poche de cadence et test du levier

**Cadence** et **Fills rapides** suivent un portefeuille de simulation distinct. Il tente un achat long spot par créneau de 5 s, engage jusqu’à 250 USDT, et cherche à sortir au-dessus des coûts après 1 s ou sur échéance après 2,6 s. L’objectif est de 10 allers-retours sur 60 s. Le carnet, le spread, la latence, les coupures et les refus peuvent réduire le débit. La pause couvre les deux portefeuilles. Le journal identifie les événements de la poche par `wallet: "Rapide"`.

```powershell
node leverage-study.mjs --session 3 --end-seq 335859 --interest-bps-hour 1
```

Le scénario hors ligne rejoue le carnet spot aux tailles 250, 500, 750, 1 250 et 2 500 USDT. Il calcule aussi le rendement moyen par cycle si l’exposition restait à 250 USDT et que seule la marge initiale baissait. Les hypothèses sont 10 pb taker et 1 pb de slippage par côté, avec un taux d’intérêt d’emprunt proratisé hypothétique. Le replay utilise le carnet spot et ne simule pas les règles de liquidation, appels de marge, ou contrats perpétuels. Voir [résultats et périmètre](docs/LEVERAGE.md).

## Exploitation

- `GET /health` donne l’état du flux et les compteurs. `marketReady=true` exige un carnet et des clôtures frais.
- `GET /api/state` fournit l’état complet. Le client charge `/api/client` environ une fois par seconde et `/api/time` uniquement lorsque le dernier timestamp de l’historique change. Les horodatages API sont en Unix millisecondes. Le client affiche l’heure locale Windows.
- Le lien d’export télécharge les 10 000 derniers événements d’audit de la session courante en NDJSON. La base conserve les données brutes et l’audit complet.
- En premier plan, arrêter avec Ctrl+C pour vider les tampons et fermer la base. Au redémarrage, le journal conserve le portefeuille actif et son historique récent. Les ordres virtuels en attente et les candidats repartent à zéro.
- Superviser l’espace disque. La capture est intégrale pour les flux souscrits. La croissance varie avec le débit des transactions. La rotation est manuelle par changement de fichier `--db`. Pour sauvegarder un fichier actif, utiliser l’API de sauvegarde SQLite ou copier la base après arrêt propre.
- Garder l’écoute sur loopback. Les commandes de pause vérifient l’origine HTTP locale.

Voir [l’architecture et le modèle](docs/ARCHITECTURE.md) pour les équations, le protocole d’optimisation et les limites du simulateur.
