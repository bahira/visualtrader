# ERRF Phoenix dans VisualTrader

Le runtime intègre le noyau sech à 19 coefficients (alpha 2) et la détection causale d’inflexion de la stratégie ERRF Phoenix. Sur le flux spot, les inflexions sont calculées sur des clôtures 1 s après 25 bougies consécutives. Le portefeuille expérimental reprend les règles de cadence et filtre les entrées sur le dernier biais haussier. Un biais baissier suspend les nouvelles entrées. Les sorties continuent. La poche n’utilise ni ventes à découvert ni levier.

## Replay de contrôle

```powershell
node app.mjs --mode replay --session 3 --end-seq 335859 --batch
```

Session Binance Spot 3, 19,54 minutes. Deux portefeuilles de 10 000 USDT, budget par entrée de 250 USDT, 10 pb taker et 1 pb de slippage par côté, profondeur et latence simulées.

| Poche | Cycles | P&L net | Net par cycle | Minutes avec au moins 10 cycles |
| --- | ---: | ---: | ---: | ---: |
| Cadence | 232 | −127,40 USDT | −0,5491 USDT | 19/19 |
| Cadence + filtre Phoenix | 111 | −60,44 USDT | −0,5445 USDT | 1/19 |

Les deux variantes ont enregistré zéro cycle gagnant sur cet échantillon. Le filtre a réduit l’exposition et la perte totale, avec peu de changement du net moyen. La comparaison n’est pas une mesure de performance à long terme.

## Résultats historiques distincts

Importer une archive locale Freqtrade, puis relancer le client. Seuls les agrégats sont stockés dans le répertoire de données local.

```powershell
python docs/import_phoenix.py 'C:/Users/Yuri/Documents/PineScripts/freqtrade/user_data/backtest_results/backtest-result-2026-11-09_11-49-37.zip'
```

L’onglet **Archive 4 h** montre les résultats du backtest futures d’origine. Il couvre BTC, ETH et LINK, à 2×, avec 2 270 cycles sur près de cinq ans. Le rendement du portefeuille est +733,14 % et le drawdown maximal 27,65 %. Le profit factor est 1,19. BTC a contribué +1 040,96 USDT sur +7 331,42 USDT au total. Les années 2023 et 2024 sont négatives. Le réglage de l’archive a été retenu après comparaison sur la même période. L’archive est consultée sans config, identifiants, clé, ni lancement du bot. Ce résultat est extrait du backtest existant. Il n’a pas été recalculé par Freqtrade dans cette intégration.
