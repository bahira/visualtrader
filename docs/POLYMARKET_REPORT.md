# Rapport Polymarket BTC Up/Down

## Verdict

Le paper trading v2 continue. Le collecteur public CLOB tourne séparément et archive Up et Down en SQLite. Le replay d'exécution reconstruit un carnet à partir de ses snapshots et deltas. Les prix se calculent sur la profondeur à 10 parts, frais inclus. L'archive et les simulations restent locales.

Le premier contrôle sur un extrait de 41 535 trames réelles a produit, après une barrière de 500 ms, un ask Up de 0,82 et Down de 0,19 pour un point de contrôle choisi après le démarrage de la capture. Les coûts de 10 parts étaient respectivement 8,30332 et 2,00773 USDC. Il s'agit d'un test du pipeline de données. Le premier rapport de comparaison appariée ne contenait aucun marché dont le flux avait été capté avant la décision paper. Ces chiffres ne constituent pas un P&L.

Le TWAP exact du contrat utilise le flux authentifié PolyBolt. Le signal paper continue d'utiliser Binance comme proxy et le paiement suit le règlement officiel. Aucun compte, portefeuille ou ordre réel n'est utilisé.

## 10 indispensables réalisables maintenant

| N° | Fonction | État |
|---|---|---|
| 1 | Collecter les deux tokens par WebSocket public | En service et vérifié sur le flux |
| 2 | Archiver trames, identifiants, timestamps source et réception | En service, ordre de réception SQLite |
| 3 | Reconstruire snapshot puis deltas absolus, sans réutiliser le carnet après reconnexion | Implémenté et testé |
| 4 | Calculer le prix sur la profondeur et les frais par niveau | Vérifié sur fixtures et sur la capture réelle |
| 5 | Rejouer le premier état observé après la barrière de latence | Implémenté. Profondeur insuffisante à ce point traitée comme refus |
| 6 | Comparer les mêmes signaux REST et CLOB, avec sensibilité à 250, 500 et 1 000 ms | Commande disponible. Appariement live à observer |
| 7 | Séparer les cas inconnus des abstentions et des fills | Sorties distinctes dans l'audit. Le P&L apparié exclut les cas inconnus |
| 8 | Protéger le stockage et détecter les interruptions | Reconnexion, rétention par marché complet, seuil d'espace libre |
| 9 | Exposer la fraîcheur du CLOB dans la fenêtre native | Indicateur CLOB enregistré sur le marché courant |
| 10 | Garder les hypothèses figées et vérifier les preuves | Suite de tests, audit v2 et procédure de replay. Validation statistique en attente |

## 10 améliorations suivantes

1. **Oracle exact.** Ajouter un connecteur TWAP authentifié en lecture de données, enregistrer le prix d'ouverture et vérifier leur concordance avec les contrats effectivement suivis.
2. **Synchronisation d'horloges.** Estimer l'écart source/local et sa dispersion. Distinguer publication, réception et traitement.
3. **Contrôle de continuité.** Comparer le carnet local à des snapshots REST indépendants et mesurer chaque resynchronisation. Le canal public documenté ne fournit pas ici une séquence exploitable pour prouver l'absence de trous.
4. **Archivage sur plusieurs jours.** Compacter les trames ou enregistrer des segments compressés avec index et empreinte avant rotation. Conserver un échantillon chronologique indépendant.
5. **Fills partiels et taille.** Tester plusieurs tailles, mesurer la profondeur consommée et comparer le coût marginal.
6. **Markout.** Mesurer les prix exécutables 250 ms, 1 s, 5 s et 15 s après fill pour quantifier la sélection adverse.
7. **Modèle maker.** Encadrer les résultats par des hypothèses de file et d'annulation, avec stress de latence et liquidation de l'inventaire.
8. **Ablations et calibration.** Comparer carnet seul, oracle et temps restant, momentum, puis semivariance, avec Brier et P&L incrémental net sur les mêmes marchés.
9. **Validation multi-journées.** Règles figées, agrégation par journée, couverture, intervalles d'incertitude par blocs, stress de taille et de délai.
10. **Exploration native.** Filtres par modèle et motif, détail des trades ajoutés ou évités par Skew, comparaison REST/CLOB au marqueur et export d'une fenêtre.

## Procédure d'exploitation

```powershell
node polymarket_paper.mjs
node poly_clob.mjs
node poly_replay.mjs
node poly_clob_audit.mjs
python -B polymarket_audit.py --db data/polymarket-v2/paper.sqlite
node --test
python -B -m unittest discover -s test -p 'test_*.py'
```

Démarrer un seul worker de chaque type. Les deux ont des verrous distincts. La v2 publie `data/polymarket-v2/status.json`, le CLOB `data/polymarket-clob/status.json`. Le lanceur `Polymarket.cmd` ouvre la fenêtre native. Les marchés actifs se renouvellent par créneaux de cinq minutes.

L'archive CLOB contient une table `markets` avec les identifiants et règles, et `frames` avec les messages et bornes de reconnexion. Le writer travaille par lots et valide les transactions atomiquement. Le rapport CLOB exige une capture commencée avant le signal. Pour chaque latence, il recherche au plus quatre secondes un état du côté demandé dont l'heure source et la réception dépassent la barrière. Si cet état existe mais que la taille ou l'avantage ne suffit plus, il refuse l'exécution. L'audit utilise le résultat officiel déjà stocké dans le journal paper, quand il est disponible.

Les marchés entiers au-delà de 48 h ou du plafond logique d'environ 1 Gio sont purgés progressivement, en gardant le marché courant. La base SQLite réutilise les pages libérées. Sa taille apparente peut dépasser le plafond logique. L'acquisition s'arrête si l'espace disque disponible passe sous 2 Gio. Le plafond de taille peut donc réduire fortement la durée brute conservée aux heures chargées.

Limites actuelles : snapshots book et deltas publics, ordre local des trames, timestamp distant non synchronisé, aucune garantie de priorité de file et aucun fill réel. Une capture comparable et une validation multi-journées sont requises avant de juger la stratégie.

[Flux publics et TWAP](https://docs.polymarket.com/market-data/realtime-data) · [Frais](https://docs.polymarket.com/trading/fees) · [Protocole paper](POLYMARKET.md)
