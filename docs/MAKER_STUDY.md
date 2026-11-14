# Replay maker/maker BTC/USDT

Le [test de microstructure](MICROSTRUCTURE.md) précédent utilisait une sortie taker. Ce replay ajoute une sortie passive et mesure séparément les cycles maker/maker et les liquidations taker. Il n’y a aucune interaction avec un compte ou une bourse.

## Résultats sur 31,81 minutes réservées

| Frais maker/taker par jambe | Cycles | Sorties maker | Cycles/min | P&L net USDT | P&L hors cycles traversant une lacune | Stress USDT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10/10 pb | 51 | 4 | 1,60 | −27,85 | −20,52 | −28,39 |
| 2/3 pb | 54 | 10 | 1,70 | −9,45 | −6,49 | −10,54 |
| 0/2 pb | 54 | 10 | 1,70 | −5,15 | −3,04 | −6,44 |
| 0/0 pb | 54 | 10 | 1,70 | −2,95 | −1,34 | −4,45 |
| Cash | 0 | 0 | 0 | 0 | 0 | 0 |

Le scénario 0/2 pb décompose le résultat en **+1,00 USDT** sur les 10 cycles qui se ferment en maker et **−6,15 USDT** sur les 44 autres. Mesurer uniquement les sorties passives gonflerait le résultat. Aucune des quatre conditions de frais n’a donné de candidat pouvant passer en paper live.

## Méthode

- Sélection sur les premières 14,89 minutes de la session 5, fin de séquence 519027. Évaluation sur la suite jusqu’à la séquence 823725, jamais utilisée pour la sélection. Même période de marché et même instrument.
- 54 variantes de seuil de déséquilibre, décalage du bid, plus-value cible et délai de détention. Chaque barème choisit ses paramètres sur le premier bloc, avec 20 cycles minimum et une pénalité de drawdown.
- Inventaire spot long limité à une position d’environ 250 USDT. L’entrée et la sortie sont des ordres post-only hypothétiques. Les fills exigent du volume cumulé de transactions agressives strictement au-delà de la limite après l’arrivée. Les transactions au prix limite sont ignorées, et le modèle ignore les fills partiels.
- L’entrée expire après 1 s, plus le délai d’annulation. Une sortie encore ouverte à l’échéance passe en taker après le délai d’annulation et d’envoi. Le replay évite de démarrer un cycle trop proche de la fin. Un gap est compté une seule fois par cycle. Le P&L de ces cycles est séparément contrôlé.
- Base à 250 ms par délai et 1 pb de glissement sur la liquidation forcée, stress à 500 ms et 2 pb. Les commissions varient par scénario. Le barème public général Binance affiche 10 pb maker et taker pour un compte standard. [Barème Binance Spot](https://www.binance.com/en/fee/trading)
- La couverture 100 ms et les transactions publiques ne donnent pas la file réelle. Ce modèle ne reproduit ni la priorité prix-temps ni l’impact du portefeuille sur la trajectoire observée. Il s’agit d’un test de limites à deux jambes avec inventaire borné, pas d’une implémentation de cotation simultanée. [Guéant, Lehalle et Fernandez-Tapia, risque d’inventaire](https://arxiv.org/abs/1105.3115)

## Reproduire

```powershell
python -B maker_study.py --end-seq 823725
python -B -m unittest discover -s test -p test_maker_study.py
```

Le JSON local inclut les métriques de sélection, de stress, de sorties maker et de sorties forcées. Le promoteur exige un P&L positif sur les deux blocs et en stress, au moins 10 cycles/minute en base et en stress, et aucun cycle traversant une lacune dans ces deux scénarios d’évaluation.
