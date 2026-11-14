# Pression du carnet Polymarket

Le benchmark compare cinq variantes sur les mêmes marchés à 250, 500 et 1 000 ms. Il sépare les probabilités de la décision d’achat et du prix trouvé après le délai.

| Variante | Correction du logit du carnet |
| --- | --- |
| Carnet | Référence zéro |
| Pression instantanée | 0,60 × pression au moment de la décision |
| Pression persistante | 0,60 × moyenne de la pression à −5 s et à la décision |
| Impulsion | 0,35 × impulsion du flux agressif Binance (10/30 s) |
| Combinaison | Somme des corrections persistante et impulsion |

Pour chaque issue, la pression normalise l’écart de quantité entre bid et ask dans une bande de deux cents autour des meilleurs prix. Chaque niveau est pondéré par `1 / (1 + distance / 0,01)`. La pression du marché est la demi-différence entre Up et Down. Les deux snapshots exigent les deux issues, une réception et un timestamp source antérieurs au point mesuré, moins d’une seconde de retard et le même segment de connexion. La combinaison exige aussi l’impulsion Binance, et toutes les variantes sont évaluées sur cette intersection. Les fenêtres sans intersection sont recensées par l’écart entre `eligible` et `comparable`.

Le coût d’entrée inclut la profondeur pour 10 parts, les frais et le stress de 0,005 USDC par part. Le premier carnet observé après délai doit encore offrir la marge minimale de 0,04 USDC par part. Le Brier et son écart au carnet se mesurent sur les issues réglées. Les remplissages, rejets de prix ou taille et observations inconnues sont explicites. Le net ne porte que sur les fills simulés, et les inconnues restent visibles.

Bloc prospectif à partir du 14 novembre 2026 à 21 h 45 (Paris). L’empreinte du benchmark et celle du banc source sont enregistrées avant le début. Une inscription tardive entraîne des résultats rétrospectifs. Le benchmark renseigne les variantes dans **Vue détaillée → Flux Binance**. Il reste descriptif, sans promotion automatique.

```powershell
node poly_pressure.mjs --watch
node poly_pressure.mjs --export > data/polymarket-v2/pressure.ndjson
python -B docs/render_edge_report.py outputs/VisualTrader-Rapport-Pression.mp4 --markout data/polymarket-v2/markout.json --pressure data/polymarket-v2/pressure.json
```

Le premier replay trouve **un marché entièrement comparable sur 22 réglés**, sans fill dans les cinq variantes. À 500 ms, le carnet seul donne un Brier de 0,00039, contre 0,00056 pour l’impulsion et 0,00137 pour la combinaison. L’intersection est le premier facteur à améliorer avant d’interpréter l’écart de score. Les carnets peuvent manquer à l’ancienne date, être trop anciens ou dépourvus d’un côté près d’une issue très probable.
