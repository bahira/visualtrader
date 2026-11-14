# Pression du carnet Polymarket

Le benchmark compare cinq variantes sur les mêmes marchés à 250, 500 et 1 000 ms. Il sépare les probabilités de la décision d’achat et du prix trouvé après le délai.

| Variante | Correction du logit du carnet |
| --- | --- |
| Carnet | Référence zéro |
| Pression instantanée | 0,60 × pression au moment de la décision |
| Pression persistante | 0,60 × moyenne de la pression à −5 s et à la décision |
| Impulsion | 0,35 × impulsion du flux agressif Binance (10/30 s) |
| Combinaison | Somme des corrections persistante et impulsion |

Pour chaque issue, la pression normalise l’écart de quantité entre bid et ask dans une bande de deux cents autour des meilleurs prix. Chaque niveau est pondéré par `1 / (1 + distance / 0,01)`. La pression du marché est la demi-différence entre Up et Down. Les deux snapshots exigent les deux issues, une réception strictement antérieure au point mesuré, des données de moins d’une seconde et le même segment de connexion. Le timestamp source peut devancer la réception de 100 ms au plus, pour tenir compte du décalage mesuré entre horloges. L’impulsion Binance est bornée entre −1 et +1. Toutes les variantes sont évaluées sur l’intersection avec cette impulsion. Les fenêtres absentes sont recensées par l’écart entre `eligible` et `comparable`.

Le coût d’entrée inclut la profondeur pour 10 parts, les frais et le stress de 0,005 USDC par part. Le premier carnet observé après délai doit encore offrir la marge minimale de 0,04 USDC par part. Le Brier et son écart au carnet se mesurent sur les issues réglées. Les remplissages, rejets de prix ou taille et observations inconnues sont explicites. Le net ne porte que sur les fills simulés, et les inconnues restent visibles.

Bloc prospectif à partir du 14 novembre 2026 à 21 h 45 (Paris). L’empreinte du benchmark et celle du banc source sont enregistrées avant le début. Une inscription tardive entraîne des résultats rétrospectifs. Le benchmark renseigne les variantes dans **Vue détaillée → Flux Binance**. Il reste descriptif, sans promotion automatique.

```powershell
node poly_pressure.mjs --watch
node poly_pressure.mjs --export > data/polymarket-v2/pressure.ndjson
python -B docs/render_edge_report.py outputs/VisualTrader-Rapport-Pression.mp4 --markout data/polymarket-v2/markout.json --pressure data/polymarket-v2/pressure.json
```

L’audit initial a relevé des timestamps source jusqu’à 21 ms après la décision pour des trames déjà reçues avant elle. La tolérance a été corrigée avant l’ouverture du bloc prospectif. Le rapport affiche le nombre de marchés entièrement comparables à côté du score. Les carnets peuvent manquer à l’ancienne date, être trop anciens ou dépourvus d’un côté près d’une issue très probable.

### Premier benchmark après correction

Six marchés historiques entièrement comparables sur 23 réglés. Au délai de 500 ms, on observe les résultats suivants.

| Variante | Brier | Fills | Net stressé |
| --- | ---: | ---: | ---: |
| Carnet | 0,14095 | 0 | 0 USDC |
| Pression instantanée | 0,18340 | 2 | −5,62 USDC |
| Pression persistante | 0,16533 | 2 | −5,62 USDC |
| Impulsion | 0,13118 | 0 | 0 USDC |
| Combinaison | 0,15400 | 1 | −3,04 USDC |

L’impulsion améliore légèrement le score de prévision sur ce petit échantillon. Sa seule tentative à 500 ms est rejetée par le carnet post-latence. Les deux variantes de pression et leur combinaison déclenchent des achats simulés dont le résultat est négatif. L’évaluation prospective doit établir si ces écarts se reproduisent.
