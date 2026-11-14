# Sensibilité au levier sur la poche de cadence

Session 3, première réception jusqu’à la séquence 335859. Le test traite 19,54 min et 11 729 snapshots Binance BTC/USDT spot. Les cinq scenarios utilisent la même capture, les mêmes paramètres d’entrée et de sortie et un budget d’achat variable. Chaque scénario atteint 10 cycles sur chacune des 19 minutes complètes de la capture. Les statistiques cumulent les cycles clôturés sur toute la capture, y compris les minutes partielles.

| Multiplicateur de notionnel | Budget d’achat (USDT) | Cycles clos | P&L brut après spread et slippage (USDT) | P&L net réalisé (USDT) |
| --- | ---: | ---: | ---: | ---: |
| 1× | 250 | 232 | −11,53 | −127,40 |
| 2× | 500 | 232 | −23,25 | −255,00 |
| 3× | 750 | 231 | −34,62 | −380,75 |
| 5× | 1 250 | 231 | −58,17 | −635,06 |
| 10× | 2 500 | 230 | −117,79 | −1 266,57 |

À 250 USDT d’exposition, la perte moyenne de 0,5491 USDT par cycle correspond à −0,22 % d’une marge initiale de 250 USDT ou −2,20 % d’une marge de 25 USDT, avant surcoût d’emprunt. Augmenter le notionnel amplifie aussi la perte en USDT, avec un effet supplémentaire du carnet sur les prix et la fréquence d’exécution.

Le script mesure le P&L notionnel avec 10 pb de commission et 1 pb de slippage par côté. L’intérêt hypothétique de 1 pb/heure s’applique au principal où celui-ci est immobilisé dans un cycle clos. Le capital de simulation reste celui du portefeuille spot, sans règles de maintenance, de liquidation, ni tarification propre au compte. La capture ne contient pas de prix, carnet ou funding des perpétuels. Ces résultats décrivent une capture courte et la variante de cadence actuelle.

Les modalités de financement diffèrent selon le produit. [Intérêts du margin isolé](https://www.binance.com/en/support/faq/detail/0135c8c00a4240f695ee71a0d18efb08) · [Liquidation sur marge](https://www.binance.com/en/support/faq/detail/c08f0ef718214f40b651a2018ce1f71b) · [Funding des perpétuels](https://www.binance.com/en/support/faq/detail/360033525031)
