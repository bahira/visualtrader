# Polymarket BTC Up/Down · Quant Skew paper

Ce worker Node.js indépendant collecte les API publiques. Il ne possède aucune clé, portefeuille ou fonction de placement d’ordre. L’onglet **Poly BTC** lit son rapport local. Le moteur Binance et sa campagne paper restent des processus distincts.

```powershell
node polymarket_paper.mjs
Get-Content data/polymarket/status.json
node --test test/polymarket_paper.test.mjs
```

## Hypothèses figées

- Un seul point de décision par marché BTC 5 min, autour de la deuxième minute. Une position simulée maximum par variante et par marché, 10 parts. Le protocole peut donc générer au plus 12 entrées par heure et par variante.
- Momentum logarithmique sur 30 secondes clôturées. La semivariance sépare les retours positifs et négatifs au carré. Le déséquilibre est leur différence divisée par leur somme.
- Trois variantes imbriquées : distance du BTC à l’ouverture normalisée par la volatilité et le temps restant, ajout du momentum, puis ajout du skew si les deux signes concordent. Les probabilités sont heuristiques et leurs coefficients sont figés. Le BTC Binance est un proxy pour le signal, puisque le contrat se règle d’après le TWAP Chainlink.
- Le P&L à règlement est le paiement de la part gagnante, moins le coût d’achat et les frais. La décision nécessite 4 cents d’avantage estimé par part. Le moteur balaye les asks et observe un second carnet après au moins 500 ms. Le prix doit encore satisfaire le seuil et la taille totale doit être disponible. L’exécution simulée reste hypothétique.
- La formule par niveau est parts × taux × prix × (1 − prix). Le taux est lu sur le marché, qui doit annoncer l’exposant 1 lorsque les frais sont activés. À 0,50 et au taux 0,07, les frais sont de 0,0175 par part. La résolution exige un marché fermé, marqué comme résolu et des valeurs finales 1/0 dans les métadonnées officielles.
- Le carnet fournit une référence de calibration via les deux asks normalisés. Le score de Brier est calculé sur les marchés résolus. Les variantes sont des portefeuilles contrefactuels distincts, donc leurs P&L ne s’additionnent pas. La référence cash vaut zéro et n’oublie pas les abstentions.
- On garde SQLite et les snapshots exécutables normalisés localement. Le remplissage réel, le basis Binance/Chainlink et la calibration hors échantillon restent à vérifier. Une décision Ratée par indisponibilité du flux peut être exclue. Les performances citées dans la demande ne sont pas des résultats vérifiés de ce modèle.

[Montant des frais](https://docs.polymarket.com/trading/fees) · [Carnet public](https://docs.polymarket.com/api-reference/market-data/get-order-book) · [Exemple de règles de règlement BTC 5 min](https://polymarket.com/event/btc-updown-5m-1789375800)

## Fenêtre Windows en direct

Lancer Polymarket.cmd pour afficher la fenêtre native dédiée. Le worker actualise les cotations publiques toutes les quelques secondes. Le compte à rebours est local et se met à jour chaque seconde. Les prix d'achat par part incluent les frais estimés pour 10 parts. Le journal distingue les positions avant échéance, le règlement en attente et le P&L officiel du portefeuille simulé. La courbe conserve les observations du marché courant depuis l'ouverture de la fenêtre.
## Traçabilité et replay v2

La v2 utilise `data/polymarket-v2` et combine en parts égales les logits du carnet et du proxy BTC. Les variantes ajoutent le momentum puis le skew sur cette référence. La v1 reste séparée. Les fills utilisent le premier état source admissible après le délai simulé et refusent le fill si l’avantage a disparu. Les marchés manqués, abstentions, refus et coûts sont journalisés.

Sur le graphique Polymarket, survoler un marqueur révèle sa décision. Un double-clic sur un trade ouvre le marché historique, avec les points réellement enregistrés et ses marqueurs. **Revenir au direct** rétablit le marché courant. Les graphiques Binance 1 s et Time signalent les fills des portefeuilles Actif, Rapide et Phoenix.

```powershell
node poly_replay.mjs data/polymarket-v2/paper.sqlite
python -B polymarket_audit.py --db data/polymarket-v2/paper.sqlite
```

Le replay recalcule les features, probabilités, motifs et fills depuis les chandelles et snapshots REST archivés. Les lignes dépourvues de l’heure exacte du calcul sont recensées à part. Le journal de décision est écrit dans la même transaction que ses entrées brutes. Les snapshots REST ne reproduisent ni le flux CLOB exhaustif ni une exécution réelle. Le TWAP Chainlink exact via PolyBolt demande une authentification. Binance reste le proxy, et le règlement officiel reste la source des paiements.

Le [rapport CLOB, l'exploitation et les 20 priorités](POLYMARKET_REPORT.md) documentent le collecteur parallèle et le comparatif REST/WebSocket.
