# Banc d’essai VisualTrader · Polymarket BTC Up/Down

Dans `Polymarket.cmd`, l’aperçu affiche le P&L réglé de Quant Skew, les fills, la couverture du test et une estimation quotidienne quand l’échantillon le permet. **Vue détaillée** ouvre le graphique, le journal, les décisions, le banc et les cohortes. Le chiffre quotidien correspond à la moyenne du P&L stressé des journées UTC complètes, avec une fourchette empirique par blocs de deux jours. Avant qualification, l’estimation affichée concerne la variante Consensus, choisie à l’avance. Les quatre portefeuilles contrefactuels sont indépendants.

## Hypothèses et preuves

| Variante | Hypothèse |
| --- | --- |
| Quant Skew | Référence REST historique rejouée sur le même carnet et avec le même stress que les nouveaux signaux |
| Écart au TWAP d’ouverture | Comparer les moyennes de 60 clôtures Binance 1 s précédant l’ouverture et précédant le signal, puis corriger le logit du carnet dans une plage bornée |
| Consensus BTC + carnet | Entrer seulement du côté où se recoupent l’écart au TWAP d’ouverture, le momentum 30 s et le carnet |
| Paire Up + Down | Observer si les deux jambes synchrones coûtent assez peu après frais. Le rapport donne aussi le stress d’une seule jambe remplie. Le potentiel de double exécution reste exploratoire |

Le banc relie le journal REST, les chandelles Binance et le WebSocket CLOB par ouverture et identifiant de marché. Il lit une fois les trames du marché, traite le paquet WebSocket entier, exige un carnet pré-signal et rejette toute reprise après une coupure située entre décision et observation. Les observations sont sauvegardées avant règlement pour survivre à la rotation du carnet. Les jambes de la paire doivent être observées à moins de 100 ms l’une de l’autre, en horloge source et en réception locale. Pour chaque test, le premier prix admissible est comparé au seuil. Une profondeur insuffisante vaut rejet. Une absence de preuve d’exécution vaut inconnue. Les cohortes à 500 ms croisent côté, volatilité, accord momentum/skew et spread. Les prix de règlement proviennent du journal officiel, et la moyenne Binance reste un proxy. [Flux TWAP officiel](https://docs.polymarket.com/market-data/realtime-data#twap-prices) · [Frais](https://docs.polymarket.com/trading/fees)

La fenêtre prospective v1 va du 14 novembre 2026 à 21 h 10 au 28 novembre 2026 à 21 h 10, heure de Paris. L’empreinte inclut le manifeste et le code d’évaluation, de capture et du journal source. Le premier enregistrement de cette empreinte doit précéder le début du bloc. Seuls les deux signaux directionnels nouveaux sont éligibles à la qualification. Elle demande, aux trois latences (250, 500, 1 000 ms), au moins 95 % de fenêtres couvertes et de tentatives observables, 30 fills et 10 jours avec fills. Le bas de la fourchette empirique du net stressé et le résultat avec pénalité maximale pour les fenêtres manquantes doivent être positifs à la clôture du bloc. La fourchette reste descriptive. Le benchmark donne aussi la différence nette avec Skew sur les observations comparables.

## Cloner une expérience

```powershell
Copy-Item docs/poly-edge-policy.json data/poly-edge-experience.json
# Choisir une nouvelle version et des bornes UTC alignées sur cinq minutes.
node poly_edge.mjs --policy data/poly-edge-experience.json --output data/polymarket-v2/experience --watch
node poly_edge.mjs --policy data/poly-edge-experience.json --output data/polymarket-v2/experience --export > data/polymarket-v2/experience.ndjson
```

Le manifeste permet de faire varier la taille, les marges, le stress et les seuils d’échantillonnage. Chaque sortie a son propre verrou SQLite. `--paper` et `--clob` permettent une répétition sur deux archives compatibles. `--export` produit une ligne JSON par fenêtre avec signaux, timestamps, observations, décision et coûts à chaque latence, phase du test et règlement. Pour porter le protocole sur un autre domaine, raccorder des tables de décisions, carnets et règlements qui respectent le contrat d’entrée. Le code actuel suppose deux issues exclusives, un paiement binaire et cinq minutes par fenêtre.

Le croisement exploratoire avec Binance Spot ajoute le déséquilibre du volume agressif sur les 30 secondes précédant le signal. Il exige 25 secondes actives et coupe sur les deux horloges, côté Binance et à la réception locale. Les agrégats comparent achat, vente et équilibre (seuil 20 %), avec le nombre de marchés, la fréquence Up et le P&L Skew à 500 ms. Les fenêtres sans preuve suffisante restent inconnues.

Le benchmark recompute quatre probabilités sur les mêmes marchés. Carnet seul, déséquilibre 30 s, impulsion (déséquilibre 10 s moins 30 s), et addition des deux corrections au logit du carnet. Il mesure Brier, tentatives, inconnues, fills et P&L stressé sur le même replay. Le worker renouvelle son rapport toutes les cinq minutes avec une empreinte propre et un début prospectif distinct, le 14 novembre à 21 h 20 heure de Paris. Il conserve les résultats exploratoires antérieurs dans `prior`. Ce benchmark ne qualifie ni n’active de stratégie.

```powershell
node poly_edge.mjs --export | python -B poly_spot_join.py
node poly_edge.mjs --export | python -B poly_spot_join.py --rows > data/polymarket-v2/spot-joined.ndjson
python -B poly_spot_join.py --watch data/polymarket-v2/spot-benchmark.json
```

La vue simplifiée convertit le P&L en euros au taux indicatif USD/EUR de la BCE (approximation 1 USDC ≈ 1 USD). Le taux est rafraîchi en arrière-plan et la conversion est masquée au-delà de sept jours. Une estimation admissible est affichée par heure, jour et 30 jours par extrapolation linéaire du P&L quotidien stressé. Le rapport vidéo versionné est généré avec Python, Pillow et FFmpeg. [Change de référence BCE](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

```powershell
python -B docs/render_edge_report.py outputs/VisualTrader-Rapport.mp4 --preview outputs/VisualTrader-Apercu.png
```

## Sortie avant règlement

L’onglet **Sorties** montre le markout exécutable de la position après 250 ms, 1 s, 5 s et 15 s, à partir de la réception du fill d’entrée simulé. Chaque horizon représente une revente alternative de la position entière. Le replay balaie les bids du premier état complet qui dépasse le délai en temps source et en réception, avec une seconde de grâce. Il retranche les frais des deux jambes et ajoute le stress de la politique à chaque jambe. Un carnet trop mince vaut manque de profondeur. Une coupure ou un carnet absent vaut inconnue. Les moyennes et le net cumulé portent uniquement sur les sorties cotées et gardent leur dénominateur. La sortie est contrefactuelle et le carnet historique ne reflète pas la consommation de profondeur par notre ordre d’entrée.

Le worker reprend les entrées prouvées dans l’export du banc et enregistre les observations compactes avant rotation du CLOB. Il calcule des scénarios descriptifs de sortie, sans changer les règles figées du bloc prospectif. Le benchmark distingue les marchés antérieurs et postérieurs au seuil de l’expérience de flux.

```powershell
node poly_markout.mjs --watch
node poly_markout.mjs --export > data/polymarket-v2/markout.ndjson
python -B docs/render_edge_report.py outputs/VisualTrader-Rapport-Sorties.mp4 --markout data/polymarket-v2/markout.json
```

## 10 indispensables

1. **Frais et coût exécutable** ✓ Calcul par niveau et stress de 0,5 cent supplémentaire par part et par jambe.
2. **Cadre prospectif gelé** ✓ Empreinte du code et de la politique, enregistrement avant ouverture, date de clôture.
3. **Vérité terrain** ✓ Règlement officiel. Le TWAP Chainlink en cours de marché reste à raccorder.
4. **Rejeu causal** ✓ Carnet pré-signal, latence, paquets atomiques et preuve conservée.
5. **Couverture** ✓ Compter les marchés absents, carnets absents, règlements en attente et exécutions inconnues.
6. **Benchmarks** ✓ Cash zéro, Skew à exécution comparable et trois latences. Comparaison Brier carnet/Skew dans l’aperçu.
7. **Estimation robuste au manque de données** ✓ Fourchette empirique, pénalité de couverture et estimation masquée en échantillon court.
8. **Contrôle de synchronisation** Partiel. Les deux timestamps sont conservés et bornés. La divergence horloge locale/source et la continuité hors reconnexion restent à mesurer indépendamment.
9. **Exploitation légère** ✓ Worker indépendant, SQLite, cache d’observations, export granulaire et aperçu natif.
10. **Preuve de rentabilité** En collecte. Le test peut conclure à l’absence de candidat.

## 10 améliorations suivantes

1. Collecter le TWAP authentifié et mesurer l’erreur du proxy au début et à la fin de chaque marché.
2. Vérifier la continuité du carnet avec des snapshots REST indépendants et mesurer les dérives temporelles.
3. Mesurer la vitesse, la RAM et l’espace disque sur des sessions complètes et aux heures d’activité élevée.
4. Ajouter des archives brutes compressées, indexées et vérifiables pour les reprises de recherche au-delà de la rétention courante.
5. Rejouer plusieurs tailles et les fills partiels. Mesurer séparément le coût d’une seconde jambe retardée.
6. Confirmer sur plusieurs journées le markout et les coûts de sortie désormais publiés à quatre délais.
7. Vérifier les asymétries Up/Down et court/long avec des fenêtres de confirmation et des corrections de tests multiples.
8. Implémenter un modèle maker avec scénarios de file, rejets et annulations puis le comparer au taker.
9. Extraire un adaptateur générique pour d’autres contrats et pour les données Binance spot. Mesurer leur transférabilité sur des dates appariées.
10. Ajouter filtre de cohorte, fenêtre de replay depuis le banc, courbe de P&L journalier et rapport de dérive de calibration.
