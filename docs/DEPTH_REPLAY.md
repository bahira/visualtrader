# Carnet différentiel et replay

Le collecteur archive les deltas, les transactions, bookTicker et les snapshots REST dans le même fichier local. Il amorce le carnet sur le snapshot, ignore les deltas anciens, applique les quantités absolues et invalide le carnet à la première rupture d’identifiant. Un nouveau snapshot relance la synchronisation. Les meilleurs prix et quantités sont comparés à bookTicker uniquement à identifiant exact.

Le convertisseur SQLite émet des snapshots top 20 au moment où ils deviennent reconstructibles. Les deltas antérieurs au snapshot appliqués en rattrapage ne changent pas le passé. Les ruptures et snapshots de reprise créent des séparateurs pour les modèles de replay.

```powershell
node depth_capture.mjs --seconds 75
node depth_replay.mjs data/depth/1794677150066.ndjson data/depth/replay-1794677150066.sqlite
python -B two_sided_study.py --db data/depth/replay-1794677150066.sqlite --frozen data/two-sided.json --out data/depth/frozen-1794677150066.json
```

Le premier enregistrement de 75 s produit 739 états valides, 8 485 transactions et 73 concordances exactes sur 73 comparaisons avec bookTicker. Aucun saut de séquence n’a été observé. Sur ce nouveau bloc, avec paramètres gelés, le scénario 10 pb réalise un cycle et −0,2275 USDT face à l’inventaire passif. Le scénario maker gratuit réalise deux cycles et +0,1937 USDT, dont environ 0,10 USDT d’écart de frais de liquidation. En stress, celui-ci tombe à +0,0051 USDT. Le test favorise la qualité de mesure. Il ne fournit pas de validation statistique ou de parité L3.

[Documentation publique Binance](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
## Contrôle du modèle de file

Le scénario de sensibilité comptabilise aussi les transactions agressives observées exactement au prix coté, après avoir retranché la quantité affichée devant notre ordre à son arrivée. Le volume exécuté strictement au-delà du prix est pris en compte séparément. Les annulations de la file ne donnent aucun crédit. Les niveaux hors du meilleur bid/ask continuent d’utiliser le scénario de traversée, faute de quantité visible à l’arrivée dans ce replay.

Sur le premier bloc, cette variante passe d’un à deux cycles au tarif standard et le résultat passe de −0,2275 à −0,4320 USDT. Sur le second bloc de 90 s, elle ne termine aucun cycle au tarif standard. À zéro commission maker, la deuxième capture termine un cycle et perd −0,1809 USDT. Les paramètres proviennent du rapport précédent et n’ont pas été ajustés sur ces nouvelles traces. La quantité agrégée et les trades publics ne suffisent pas pour connaître la place individuelle dans la file.
