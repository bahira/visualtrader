# Microstructure BTC/USDT · recherche HFT

## Résultat

Aucune variante ne satisfait simultanément le profit net, le stress et la cible de 10 cycles/minute. La politique de comparaison garde le cash comme référence. Aucun nouveau signal n’est activé.

| Stratégie sur les sessions réservées 4 et 5 | Cycles chiffrés | P&L net |
| --- | ---: | ---: |
| Cadence VisualTrader, replay du moteur | 237 | −128,89 USDT |
| Meilleur candidat de validation, ridge 3 s | 9 | −5,07 USDT |
| Même candidat, stress | 9 | −5,59 USDT |
| Même candidat, commissions hypothétiques nulles | 9 | −0,57 USDT |
| Entrées passives au bid, sorties taker | 135 | −76,14 USDT |
| Entrées passives filtrées par déséquilibre | 56 | −31,86 USDT |
| Entrées passives, frais hypothétiques 0/2 pb | 135 | −15,48 USDT |
| Cash | 0 | 0 USDT |

Les sessions 4 et 5 totalisent 20,05 minutes. La cadence existante atteint environ 11,8 cycles/minute et verse 118,87 USDT de commissions. Le candidat ridge obtient environ 0,45 cycle/minute. Le scénario hors frais conserve profondeur, spread, latence et glissement. Les chiffres passifs incluent 4 sorties non chiffrables pour l’entrée non filtrée, exclues du P&L affiché.

Le recensement a examiné 54 287 couples signal/horizon complets sur les deux sessions réservées. Aucun ne couvre les coûts à 10 pb de commission par côté, sur les horizons de 0,5 à 15 s et aux délais testés. Ces observations se recouvrent et ne sont pas des trades indépendants. Le 99e percentile de la hausse du mid à 15 s atteint 9,23 pb et 10,91 pb selon le bloc, pour un coût aller-retour de plus de 22 pb dans le scénario de base.

## Protocole reproductible

```powershell
$env:OPENBLAS_NUM_THREADS='1'
python -B microstructure.py --freeze docs/microstructure-capture.json
python -B -m unittest discover -s test -p test_microstructure.py
node app.mjs --mode replay --session 4 --end-seq 381351 --batch
node app.mjs --mode replay --session 5 --end-seq 519027 --batch
```

Le script lit SQLite en lecture seule. L’apprentissage est limité aux sessions 1–2, la sélection à la session 3 et l’évaluation aux sessions 4–5. La grille comprend 120 variantes de seuil, horizon et famille. Les variables au moment du signal incluent les déséquilibres de profondeur sur 1, 5 et 20 niveaux, un OFI dérivé de snapshots, le flux signé des transactions, le déplacement pondéré du mid, le spread et le momentum court. La régression ridge prédit un mouvement du mid. La décision retient un seuil en validation après coûts. Le meilleur candidat de validation est négatif à −8,50 USDT sur 15 cycles et échoue avant promotion.

Le nominal est 250 USDT. Le scénario taker de base utilise 250 ms de latence simulée à chaque jambe, 10 pb de commission et 1 pb de glissement par côté. Le stress passe à 500 ms et 2 pb de glissement par côté. Les prix balayent la profondeur affichée, à quantité approximée par 250 USDT divisés par le mid au signal. Un cycle occupe le portefeuille jusqu’à sa sortie. Les chemins chevauchant une lacune du carnet sont comptés à part. Le P&L et le drawdown sont réalisés, aux sorties chiffrables.

L’entrée passive poste au bid observé, attend au maximum une seconde après arrivée et exige une vente agressive ultérieure strictement sous le prix limite. La sortie traverse le carnet après trois secondes et la latence simulée. Le modèle ne connaît ni la priorité de file, ni la latence d’annulation, ni les exécutions partielles. La traversée observée sert d’approximation de fill. Les coûts réduits sont des scénarios hypothétiques, indépendants de tout compte.

## Recherche et limites

Les travaux sur l’imbalance motivent la prédiction du prochain mouvement de prix. Une prédiction directionnelle et un P&L exécutable sont deux mesures distinctes. Avec des snapshots à 100 ms, l’OFI calculé est une approximation et le carnet ne permet pas de reconstituer une file maker. La capture représente un peu moins de 55 minutes et plusieurs redémarrages au cours d’une même période de marché. Elle ne permet pas une conclusion multi-régimes ou une revendication SOTA.

- Gould et Bonart, [Queue Imbalance as a One-Tick-Ahead Price Predictor](https://arxiv.org/abs/1512.03492).
- Cont, Kukanov et Stoikov, [The Price Impact of Order Book Events](https://arxiv.org/abs/1011.6402).
- Xu, Gould et Howison, [Multi-Level Order-Flow Imbalance](https://arxiv.org/abs/1907.06230).
- [Flux publics Binance Spot](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams).
