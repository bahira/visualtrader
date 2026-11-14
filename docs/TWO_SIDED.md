# Cotation bid/ask simultanée

90 configurations de largeur, délai de recotation, biais de flux et ajustement d’inventaire. Chaque bloc part avec un lot spot d’environ 100 USDT. Le portefeuille utilise zéro à deux lots de BTC et compare sa liquidation à celle du même lot conservé passivement. Chaque côté coté peut être rempli pendant la fenêtre. Une exécution exige du volume agressif strictement au-delà de la limite après l’arrivée, sans simulation individuelle de la file. La décision de recoter intervient après le délai d’annulation. Les traversées de lacunes sont journalisées, et le drawdown est calculé sur les snapshots.

| Commission maker hypothétique | Développement | Validation | Test final | Stress final | Cycles/min sur le test final |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 pb | −0,956 | −2,338 | −0,600 | −0,188 | 0,36 |
| 2 pb | −0,157 | −0,586 | −0,280 | −0,029 | 0,36 |
| 0 pb | +0,166 | −0,491 | +0,188 | +0,194 | 0,36 |

P&L en USDT par rapport à l’inventaire passif, liquidation comprise. Les segments successifs de la session 5 durent 14,89, 31,81 et 5,62 minutes. Les paramètres sont choisis sur le premier. Le dernier bloc commence après la fin du [test maker précédent](MAKER_STUDY.md). Le scénario sans commission gagne 0,088 USDT sur le bloc final avant l’écart de commission de liquidation et ne termine que deux cycles. Le meilleur débit observé parmi toute la grille d’entraînement est de 7,25 cycles/minute. Aucun candidat ne franchit le seuil de promotion. Un délai de 500 ms et un glissement final de 2 pb constituent le stress, contre 250 ms et 1 pb en base.

Le flux public différentiel, les transactions et le meilleur bid/ask sont capturés en NDJSON. Le collecteur compte les sauts d’identifiants entre messages reçus. Il ne reconstruit pas encore de carnet initial et ne fournit pas de données d’ordres L3. La vérification de 15 secondes donne 142 mises à jour différentielles, 1 332 transactions et 2 996 mises à jour du top of book, sans saut observé ni débordement d’écriture. Ces traces sont locales.

```powershell
python -B two_sided_study.py
node depth_capture.mjs --seconds 60
python -B -m unittest discover -s test -p test_two_sided_study.py
```
