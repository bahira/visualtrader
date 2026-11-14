# Étude Phoenix Sentinel 4 h

Le script de recherche lit les paramètres et la commission du fichier Pine. Il reproduit le signal par noyau sech, le filtre short, les inversions long/short, le sizing à partir de l’equity, le stop et l’activation du trailing. Il calcule les signaux à la clôture de chaque 4 h puis exécute au premier open minute de la bougie suivante. Le replay est local, sans connexion d’échange.

```powershell
python -B phoenix_research.py 'C:/Users/Yuri/Documents/PineScripts/ultipine.txt' 'C:/Users/Yuri/Documents/PineScripts/freqtrade/user_data/data/binance/futures'
python -B -m unittest discover -s test -p test_phoenix_research.py
```

Dépendances de l’étude hors ligne : NumPy, pandas et PyArrow. Le client Windows lit la synthèse JSON dans l’onglet **Étude 4 h** et peut être relancé indépendamment du moteur Spot.

## Protocole

- Binance BTC/USDT futures, signaux 4 h, sorties sur les bougies de 1 minute, funding historique aux timestamps de règlement sur le mark d’ouverture correspondant. Le fichier minute ne présente aucun saut ou doublon sur le segment analysé.
- Capital initial de 1 000 USDT par période et par variante. Prix de remplissage standard ajustés de 2 pb de glissement par côté, plus 4,5 pb de commissions par côté. Stress à 5 pb de glissement par côté et hypothèse de premier extrême défavorable à la position. La comparaison de deux chemins intraminute sonde l’ambiguïté OHLC.
- Sélection limitée à 2022–2023 et 2024. Critère : maximiser le plus mauvais des deux scores « rendement net % moins drawdown % ». Grille de 36 combinaisons du levier, de l’activation et de la distance du trailing. Un score inférieur ou égal à zéro échoue face à la référence cash.
- Évaluation réservée au 1er janvier 2025–9 novembre 2026 à 08:00 UTC, avec capital réinitialisé au début et clôture forcée si une position subsiste à la fin.

| Variante | 2022–23 net | 2024 net | 2025–26 net | Drawdown 2025–26 | Stress 2025–26 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pine, 3×, activation 0,25 %, trail 0,03 % | −71,76 % | −27,86 % | +2,85 % | 35,17 % | −47,54 % |
| Plan, 3×, activation 0,25 %, trail 0,10 % | −80,49 % | −36,10 % | −9,91 % | 36,94 % | −56,34 % |
| Meilleur score de la grille, 1×, activation 0,50 %, trail 0,03 % | −19,69 % | −11,17 % | +2,48 % | 22,71 % | −20,32 % |
| Cash | 0 % | 0 % | 0 % | 0 % | 0 % |

Le Pine réalise 369 cycles sur la période réservée. Il gagne sur 88,89 % d’entre eux, mais verse 1 275,54 USDT de commissions pour un gain final de 28,51 USDT. Aucun réglage ne passe le seuil de recherche. La variante à 1× réduit le drawdown et la sensibilité aux coûts, tandis que les deux segments de sélection et le stress restent négatifs.

## Périmètre

Il s’agit d’une reproduction causale des règles numériques, avec une chronologie de fills explicitement choisie. Le script Pine active aussi les recalculs au tick et après fill. Le replay ne garantit pas la parité avec l’émulateur historique de TradingView ni avec des alertes tick par tick. Le drawdown est mesuré sur les marques minute, les ouvertures et les sorties. Le tick de prix est supposé égal à 0,1 USDT. L’étude ne simule ni liquidation d’exchange ni carnet futures historique. Les frais viennent du Pine, et les glissements sont des hypothèses. La période réservée est hors sélection dans cette étude, mais la série historique chevauche les anciens travaux du projet.

[Modèle d’exécution TradingView Pine v5](https://www.tradingview.com/pine-script-docs/v5/concepts/strategies/)
